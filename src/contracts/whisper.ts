// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match } from "ts-pattern";
import { Gate, SessionStatus } from "./envelope.ts";
import { VerdictSchema } from "./verdict.ts";

// Stateful review contracts share Gate and SessionStatus from envelope.ts.
// Opaque labels remain strings, probabilities are bounded numbers, line and exit
// values are integers, and raw parent events stay unknown.

export { Gate, SessionStatus };

// One-line gloss of a ZodError's issues (`path: message; path: message`). The ONE
// owner of the contract-validation-failure format, so the CLI's gate-output
// extraction (cli.ts) and session-state's malformed-SessionState wording (session-state.ts)
// cannot drift.
// A root-level issue (empty path) reads as "(root)".
export function zodIssues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// Null-tolerant boundary rule for the model-emitted judge composite. A model
// behind a JSON-schema-advertising harness routinely serializes "no value" as an
// explicit `null` — the auto-injected schema even advertises the field's existence,
// inviting it. At this boundary, a field accepts null and
// NORMALIZES it to absent (undefined) at the parse boundary, before anything
// downstream reads. The CONTRACT SEMANTICS are unchanged — still optional, still
// `string`/`number` when present; the inferred key stays optional and the output is
// never null — so persisted SessionState and emitted envelopes remain absent
// rather than null. This widens only model input, not what Navi
// stores or emits. Applied uniformly to that family ONLY: the optional fields of the
// schemas composing the judge output (Evidence + Finding here; the composite's own
// `surface_map` in judge.schema.ts). NOT applied to `.nullable()` fields — those
// (GateDecision.human_escalation, SessionState.surface_map) keep their explicit-null
// semantics — nor to non-model DSL/arg optionals elsewhere in the codebase.
export function modelOptional<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullish().transform((v) => v ?? undefined);
}

// Judgment strings are non-empty.
// `.min(1)` on the fields that carry the judge's actual REASONING closes a
// silent-success gap in which an empty placeholder could be stored as content.
// Two shapes:
//   - REQUIRED judgment strings (GateDecision.reason, Finding.summary,
//     Directive.reason/action) get a plain `.min(1)`: absent already fails (required),
//     now '' fails too.
//   - MODEL-OPTIONAL judge-composite strings (Evidence.command/uri,
//     Finding.file/suggested_resolution) become `modelOptional(z.string().min(1))`:
//     absent/null still normalize to undefined (the field is genuinely optional), but
//     a present '' now fails the inner `.min(1)` and routes to the schema-failure path.
// The retry processor can repair a first-attempt violation; exhaustion still
// exits as a failure. Applied only to
// the eight named fields — opaque labels (type/severity/category) and non-judgment
// strings keep plain `z.string()`; `fresh_for_revision` (a hash the CLI never reasons
// over) stays `modelOptional(z.string())`.

// --- Evidence — closed kind enum. A snapshot value. --------------------------
// `claim_supported` reads as the boolean "does this evidence support the claim".
// `fresh_for_revision` carries the revision hash the evidence is fresh for.
export const Evidence = z.object({
  kind: z.enum(["source_location", "call_path", "command_result", "test_result"]),
  uri: modelOptional(z.string().min(1)), // non-empty when present (see min(1) note above)
  line_start: modelOptional(z.number().int()),
  line_end: modelOptional(z.number().int()),
  command: modelOptional(z.string().min(1)), // non-empty when present
  exit_code: modelOptional(z.number().int()),
  claim_supported: z.boolean(),
  fresh_for_revision: modelOptional(z.string()), // a hash the CLI never reasons over — left un-tightened
});
export type Evidence = z.infer<typeof Evidence>;

// --- Directive ---------------------------------------------------------------
// `type` and `priority` are intentionally open, so `type` is an
// opaque string label and `priority` a numeric rank (no invented enum).
// `required_evidence` / `completion_criteria` are ≥1 descriptor strings (what
// the directive requires), distinct from actual Evidence objects.
export const Directive = z.object({
  id: z.string(),
  type: z.string(),
  priority: z.number(),
  severity: z.enum(["blocking", "non_blocking"]),
  status: z.enum([
    "open",
    "acknowledged",
    "satisfied",
    "rejected",
    "superseded",
    "expired",
    "blocked",
  ]),
  reason: z.string().min(1), // non-empty judgment string (see min(1) note above)
  action: z.string().min(1), // non-empty judgment string
  targets: z.array(z.string()),
  required_evidence: z.array(z.string()).min(1),
  completion_criteria: z.array(z.string()).min(1),
  stop_conditions: z.array(z.string()),
  issued_at: z.string(),
});
export type Directive = z.infer<typeof Directive>;

// --- Finding — judge output snapshot; no status machine. `severity` and
// `category` remain opaque strings (distinct from Directive.severity).
// `confidence`
// is the 0-1 probability.
export const Finding = z.object({
  id: z.string(),
  file: modelOptional(z.string().min(1)), // non-empty when present
  line: modelOptional(z.number().int()),
  severity: z.string(),
  category: z.string(),
  summary: z.string().min(1), // non-empty judgment string
  evidence: z.array(Evidence),
  confidence: z.number().min(0).max(1),
  suggested_resolution: modelOptional(z.string().min(1)), // non-empty when present
});
export type Finding = z.infer<typeof Finding>;

// --- Handoff — optional COMPLETE-arm sibling (sibling of directives/findings/
// surface_map on the judge composite). Names ONE successor catalog flow + ONE
// positional request string. This is a generic handoff, not a routing layer:
// a single `{ flow, request }` is the whole contract. The model never emits
// shell; the CLI validates `flow` against
// the live catalog (active workflows only) and renders
// `${invocationPrefix()} run ${shellQuote(flow)} ${shellQuote(request)}`. Both
// fields are non-empty so a present-but-blank handoff is a loud validation
// failure (same absent-vs-invalid discipline as the other siblings), not a
// fabricated empty command. No optional fields, no `or`, no multi-successor
// list — if a flow needs a DAG, that is a different design (and a STOP).
export const Handoff = z.object({
  flow: z.string().min(1), // catalog workflow name the CLI will re-validate; never trusted as shell
  request: z.string().min(1), // positional arg text for the successor; shell-quoted at render time
});
export type Handoff = z.infer<typeof Handoff>;

// --- SurfaceMap — embedded and replaced wholesale. Element structure of the
// three arrays is unstated, so they are opaque string lists.
export const SurfaceMap = z.object({
  surfaces: z.array(z.string()),
  seams: z.array(z.string()),
  unknowns: z.array(z.string()),
  revision_hash: z.string(),
});
export type SurfaceMap = z.infer<typeof SurfaceMap>;

// --- GateDecision — the judge's disposition. `human_escalation` is a nullable
// message (opaque string or null). `confidence` is bounded to 0-1.
export const GateDecision = z.object({
  gate: Gate,
  reason: z.string().min(1), // non-empty judgment string (see min(1) note above)
  blocking_directive_ids: z.array(z.string()),
  non_blocking_risks: z.array(z.string()),
  human_escalation: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type GateDecision = z.infer<typeof GateDecision>;

// --- SessionTurn — one durable record per invocation on a session. ----------
// A verdict is not a gate: founder's GO / REFINE / REJECT contract and the
// whisper gate contract answer different questions and remain distinct all the
// way into storage. Plain successes and failures are recorded too, so a session
// id printed by any run is always resolvable by `navi session show`.
const SessionTurnBase = {
  run_id: z.string().nullable(),
  workflow: z.string().nullable(),
};

export const SessionTurn = z.discriminatedUnion("kind", [
  z.object({
    ...SessionTurnBase,
    kind: z.literal("gate"),
    decision: GateDecision,
  }),
  z.object({
    ...SessionTurnBase,
    kind: z.literal("verdict"),
    decision: VerdictSchema,
  }),
  z.object({
    ...SessionTurnBase,
    kind: z.literal("plain"),
    summary: z.string(),
  }),
  z.object({
    ...SessionTurnBase,
    kind: z.literal("failure"),
    reason: z.string(),
  }),
]);
export type SessionTurn = z.infer<typeof SessionTurn>;

// --- SessionState — the message-resident session of record.
export const SESSION_SCHEMA_VERSION = "navi.session.v2" as const;

// `parent_events` is append-only raw, so untyped (`z.unknown()`).
// `turn_history` is the append-only invocation record: plain
// answers, founder-style verdicts, whisper gates, and failures all live on the
// same session without translating one contract into another.
export const SessionState = z.object({
  schema_version: z.literal(SESSION_SCHEMA_VERSION),
  session_id: z.string(),
  task: z.string(),
  parent_events: z.array(z.unknown()),
  surface_map: SurfaceMap.nullable(),
  directives: z.array(Directive),
  findings: z.array(Finding),
  evidence: z.array(Evidence),
  turn_history: z.array(SessionTurn),
  status: SessionStatus,
});
export type SessionState = z.infer<typeof SessionState>;

// --- EvidenceEvent — the parent's evidence-return input. A light
// STRUCTURAL gate only: a directive id and a non-empty list of typed Evidence.
// Deliberately permissive beyond structure — whether the evidence actually
// proves anything is judge discipline (the judge re-reads the cited locations);
// a schema cannot detect fabrication. Garbage ({}, wrong types, empty evidence[])
// is rejected pre-model (exit 4).
export const EvidenceEvent = z.object({
  directive_id: z.string(),
  evidence: z.array(Evidence).min(1),
});
export type EvidenceEvent = z.infer<typeof EvidenceEvent>;

// Pure gate → exit-code map:
// 0 = CLEAR/DIRECT/REPAIR/COMPLETE, 2 = BLOCKED, 3 = ESCALATE. Exhaustive over
// all six Gate members at compile time (ts-pattern `.exhaustive()`). Exit 1
// (runtime failure) and exit 4 (schema failure) are NOT gate-derived and are not
// modelled here — see envelope.ts `exitFor` for the null-gate runtime path.
export function exitForGate(gate: z.infer<typeof Gate>): 0 | 2 | 3 {
  return match(gate)
    .with("CLEAR", "DIRECT", "REPAIR", "COMPLETE", () => 0 as const)
    .with("BLOCKED", () => 2 as const)
    .with("ESCALATE", () => 3 as const)
    .exhaustive();
}
