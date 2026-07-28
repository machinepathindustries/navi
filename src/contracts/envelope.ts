// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match, P } from "ts-pattern";
import type { Shape } from "../compiler/index.ts";
// Type-only import avoids an envelope↔whisper runtime cycle. RunEnvelope keeps
// z.unknown() on these fields; gateEnvelope tightens its function parameters.
import type { Directive, Finding, Evidence, SurfaceMap } from "./whisper.ts";
import { VerdictCode, VerdictSchema, type Verdict } from "./verdict.ts";
// Human look — same vocabulary as session-view (rule / bold / dim / accent / status).
// ANSI is garnish only; plain text carries full structure.
import { rule, dim, accent, paintCode, statusCode } from "../style.ts";

// The `navi.run.v2` envelope has one version owner. Plain workflows populate
// identity, disposition, `next`, and trace; judging workflows also populate the
// structured review fields.

export const Gate = z.enum(["CLEAR", "DIRECT", "REPAIR", "BLOCKED", "ESCALATE", "COMPLETE"]);
export type Gate = z.infer<typeof Gate>;

export const SessionStatus = z.enum([
  "new",
  "active",
  "awaiting_parent",
  "clear",
  "blocked",
  "escalated",
  "complete",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const NextBlock = z.object({
  instruction: z.string(),
  return: z.array(z.string()), // evidence the parent should bring back
  command: z.string().nullable(), // the literal next command (thread id baked in)
  when: z.string(),
});

export const Trace = z.object({
  steps: z.array(z.string()),
  models: z.array(z.string()),
  tools: z.array(z.string()),
  duration_ms: z.number(),
});

export const RunEnvelope = z
  .object({
    schema_version: z.literal("navi.run.v2"),
    run_id: z.string(),
    session_id: z.string(), // = Mastra thread id
    workflow: z.string(),
    event: z.string(),
    status: SessionStatus,
    gate: Gate.nullable(),
    verdict: VerdictCode.nullable(),
    summary: z.string(),
    surface_map: z.unknown().nullable(),
    directives: z.array(z.unknown()),
    findings: z.array(z.unknown()),
    evidence: z.array(z.unknown()),
    confidence: z.number().nullable(),
    // The final step's validated output, carried as-is. Intermediate outputs and
    // review artifacts remain on their dedicated fields.
    result: z.unknown().nullable(),
    next: NextBlock,
    trace: Trace,
  })
  .superRefine((env, ctx) =>
    match({ gate: env.gate, verdict: env.verdict })
      .with({ gate: P.not(null), verdict: P.not(null) }, () =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verdict"],
          message: "gate and verdict are mutually exclusive",
        }),
      )
      .otherwise(() => undefined),
  );
export type RunEnvelope = z.infer<typeof RunEnvelope>;

// A failed run exits 1; BLOCKED exits 2;
// ESCALATE exits 3; every other valid envelope exits 0.
export function exitFor(env: RunEnvelope): 0 | 1 | 2 | 3 {
  return match([env.status, env.gate])
    .with(["failed", P._], () => 1 as const)
    .with([P._, "BLOCKED"], () => 2 as const)
    .with([P._, "ESCALATE"], () => 3 as const)
    .otherwise(() => 0 as const);
}

const WHISPER_EMPTY = {
  surface_map: null,
  directives: [],
  findings: [],
  evidence: [],
  confidence: null,
};

export type BuildInputs = {
  run_id: string;
  session_id: string;
  workflow: string;
  event: string;
  shape: Shape;
  trace: { duration_ms: number; ranSteps: string[] };
  nextCommand: string;
};

// A plain run stays active. A valid founder-style verdict supplies its own
// disposition without fabricating a whisper gate.
// The return type annotation is the guard: TypeScript rejects a drifted shape at
// compile time, so this seam never needs a throwing `.parse()`.
export function successEnvelope(inp: BuildInputs & { summary: string; result: unknown }): RunEnvelope {
  const verdict = verdictOf(inp.result);
  return {
    schema_version: "navi.run.v2",
    run_id: inp.run_id,
    session_id: inp.session_id,
    workflow: inp.workflow,
    event: inp.event,
    status: match(verdict)
      .with({ verdict: "REFINE" }, () => "awaiting_parent" as const)
      .with({ verdict: P.union("GO", "REJECT") }, () => "complete" as const)
      .with(null, () => "active" as const)
      .exhaustive(),
    gate: null,
    verdict: verdict?.verdict ?? null,
    summary: inp.summary,
    ...WHISPER_EMPTY,
    result: inp.result,
    next: nextFor(verdict, inp.nextCommand),
    trace: traceOf(inp),
  };
}

// The self-steering `next` block. Default: continue on the same session at the next
// checkpoint. But when the final `result` carries a `verdict` (GO|REFINE|REJECT) —
// keyed on the FIELD, so ANY workflow emitting a verdict gets the behavior, never
// keyed on workflow name. The block becomes
// verdict-aware: GO proceeds with no re-run, REFINE names the fix and includes
// the -t re-run command, and REJECT stops. The instruction wording is verdict-generic
// (not "Founder …"): the mechanism is field-keyed, so hardcoding one workflow's
// name would misattribute the verdict on the day a second emitter lands.
function nextFor(verdict: Verdict | null, nextCommand: string): z.infer<typeof NextBlock> {
  const cont = {
    instruction: "Workflow complete. Continue with your task.",
    return: [],
    command: nextCommand,
    when: "at your next checkpoint",
  };
  return match(verdict)
    .with(null, () => cont)
    .with({ verdict: "GO" }, () => ({
      instruction: "Verdict GO — proceed as scoped.",
      return: [],
      command: null,
      when: "now",
    }))
    .with({ verdict: "REFINE" }, (data) => ({
      instruction: `Verdict REFINE — address the fix, then re-run: ${refineFix(data)}`,
      return: [],
      command: nextCommand,
      when: "after addressing the fix",
    }))
    .with({ verdict: "REJECT" }, () => ({
      instruction: "Verdict REJECT — stop; do not proceed.",
      return: [],
      command: null,
      when: "now",
    }))
    .exhaustive();
}

function verdictOf(result: unknown): Verdict | null {
  return match(VerdictSchema.safeParse(result))
    .with({ success: true }, ({ data }) => data)
    .with({ success: false }, () => null)
    .exhaustive();
}

// Name the concrete fix from the verdict's own decision_rules / what_not_to_do
// (whichever carries content first), so REFINE's instruction is actionable rather
// than generic. Falls back to a plain re-run instruction when neither is present.
function refineFix(v: Verdict): string {
  return match([firstString(v.decision_rules), firstString(v.what_not_to_do)])
    .with([P.string, P._], ([rule]) => rule)
    .with([P.nullish, P.string], ([, avoid]) => `avoid — ${avoid}`)
    .otherwise(() => "see the verdict's decision rules and what-not-to-do");
}

function firstString(arr: unknown): string | undefined {
  const first = match(arr)
    .with(P.array(), (a) => a[0])
    .otherwise(() => undefined);
  return match(first)
    .with(P.string, (s) => s)
    .otherwise(() => undefined);
}

// --- gate-derived envelope ---------------------------------------------------
// The whisper path: a run whose FINAL step emitted a GateDecision. The CLI does
// the shape-keyed detection + liberal sibling extraction (cli.ts) and hands this
// builder the already-validated pieces — this module owns only the envelope
// assembly, so it never imports the whisper contracts (which import Gate/SessionStatus
// from HERE — importing back would be a cycle). Gate and SessionStatus are defined in
// this file, so sessionStatusForGate lives here too, as the ONE owner both this
// envelope and session-state's SessionState assembly consult (session-state.ts imports it).

// Gate → SessionStatus, exhaustive over all six Gate members at compile time
// (ts-pattern `.exhaustive()`). DIRECT and REPAIR both leave the session awaiting the
// parent's evidence; the other four map 1:1 to their disposition.
export function sessionStatusForGate(gate: Gate): z.infer<typeof SessionStatus> {
  return match(gate)
    .with("CLEAR", () => "clear" as const)
    .with("DIRECT", "REPAIR", () => "awaiting_parent" as const)
    .with("BLOCKED", () => "blocked" as const)
    .with("ESCALATE", () => "escalated" as const)
    .with("COMPLETE", () => "complete" as const)
    .exhaustive();
}

// A GateDecision-bearing success (exit 0/2/3 via exitForGate). Derives the gate,
// the session status, and a gate-aware `next` block from the judge's disposition;
// carries the whisper judgment (surface_map/directives/findings/evidence/confidence)
// the CLI extracted. Return type is the compile-time guard (never .parse() across
// this seam). Function params are the real review types (CLI
// already Zod-validated them); the RunEnvelope schema still declares these fields
// loosely as z.unknown().
//
// `handoff` is the CLI-resolved COMPLETE successor (catalog-validated flow name +
// already-rendered command), or null when absent/unknown. It is NOT the raw
// model sibling — the model never supplies free-form instruction text or shell.
export function gateEnvelope(
  inp: BuildInputs & {
    summary: string;
    result: unknown;
    gate: Gate;
    surface_map: SurfaceMap | null;
    directives: Directive[];
    findings: Finding[];
    evidence: Evidence[];
    confidence: number;
    blockingDirectiveIds: string[];
    whisperCommand: string;
    // null/undefined = no COMPLETE handoff.
    handoff?: { flow: string; command: string } | null;
  },
): RunEnvelope {
  return {
    schema_version: "navi.run.v2",
    run_id: inp.run_id,
    session_id: inp.session_id,
    workflow: inp.workflow,
    event: inp.event,
    status: sessionStatusForGate(inp.gate),
    gate: inp.gate,
    verdict: null,
    summary: inp.summary,
    surface_map: inp.surface_map ?? null,
    directives: inp.directives,
    findings: inp.findings,
    evidence: inp.evidence,
    confidence: inp.confidence,
    result: inp.result,
    next: nextForGate(
      inp.gate,
      inp.directives,
      inp.blockingDirectiveIds,
      inp.whisperCommand,
      inp.handoff ?? null,
    ),
    trace: traceOf(inp),
  };
}

// The gate-aware `next` block is present on every gate:
// DIRECT/REPAIR → the (first blocking) directive's action + required_evidence +
// the continuation command; CLEAR → proceed-and-checkpoint on the same session;
// BLOCKED/ESCALATE → surface-to-human, then re-run after resolution; COMPLETE →
// resolved, command null UNLESS the CLI resolved a catalog-validated handoff
// (applies to COMPLETE only and never competes with another continuation). The
// `command` is the derived-prefix string the CLI baked in — composed from navi's
// OWN invocation (invocationPrefix, each token shellQuote'd), never a hardcoded
// `navi` literal. Directives are typed
// Directive[] (already validated). Pure + total: every arm returns a NextBlock.
function firstBlockingDirective(directives: Directive[], blockingIds: string[]): Directive | undefined {
  // First id (in the judge's own order) that names a real directive wins; then the
  // first blocking-severity directive; then the first directive at all.
  const named = blockingIds.map((id) => directives.find((d) => d.id === id)).find((d) => d !== undefined);
  return named ?? directives.find((d) => d.severity === "blocking") ?? directives[0];
}

function nextForGate(
  gate: Gate,
  directives: Directive[],
  blockingIds: string[],
  command: string,
  handoff: { flow: string; command: string } | null,
): z.infer<typeof NextBlock> {
  return match(gate)
    .with("DIRECT", "REPAIR", () => {
      const d = firstBlockingDirective(directives, blockingIds);
      // Handle an absent directive or a blank action with one clear fallback.
      const action = match(d?.action?.trim())
        .with(P.string.minLength(1), (a) => a)
        .otherwise(() => "Address the open directive.");
      const ret = d?.required_evidence ?? [];
      // Handoffs apply only to COMPLETE; other gates keep their continuation.
      return { instruction: action, return: ret, command, when: "at your next checkpoint" };
    })
    .with("CLEAR", () => ({
      instruction: "Gate CLEAR — proceed; verify at your next checkpoint.",
      return: [],
      command,
      when: "at your next checkpoint",
    }))
    .with("BLOCKED", () => ({
      instruction: "Gate BLOCKED — surface to the human; do not proceed.",
      return: [],
      command,
      when: "after the human resolves the block",
    }))
    .with("ESCALATE", () => ({
      instruction: "Gate ESCALATE — surface to the human for a decision.",
      return: [],
      command,
      when: "after the human decides",
    }))
    .with("COMPLETE", () =>
      // A valid handoff supplies the CLI-rendered successor command and names the
      // flow. Without a handoff, the session resolves with no command.
      match(handoff)
        .with(null, () => ({
          instruction: "Gate COMPLETE — the session is resolved.",
          return: [] as string[],
          command: null,
          when: "now",
        }))
        .otherwise((h) => ({
          instruction: `Gate COMPLETE — continue with \`${h.flow}\`.`,
          return: [] as string[],
          command: h.command,
          when: "now",
        })),
    )
    .exhaustive();
}

// A failed run has a null gate and exits 1.
export function failureEnvelope(inp: BuildInputs & { reason: string }): RunEnvelope {
  return {
    schema_version: "navi.run.v2",
    run_id: inp.run_id,
    session_id: inp.session_id,
    workflow: inp.workflow,
    event: inp.event,
    status: "failed",
    gate: null,
    verdict: null,
    summary: `Run failed: ${inp.reason}`,
    ...WHISPER_EMPTY,
    result: null, // no final step produced an output
    next: {
      instruction: `Run failed (${inp.reason}). Surface to the human; do not treat the task as complete.`,
      return: [],
      command: inp.nextCommand,
      when: "after resolving the failure",
    },
    trace: traceOf(inp),
  };
}

function traceOf(inp: BuildInputs): z.infer<typeof Trace> {
  const models = [...new Set(inp.shape.steps.map((s) => s.model))];
  const tools = [...new Set(inp.shape.steps.flatMap((s) => s.tools))];
  return { steps: inp.trace.ranSteps, models, tools, duration_ms: inp.trace.duration_ms };
}

// Human-readable rendering has two shapes, selected by data rather than workflow
// name:
//
//  1. Whisper/gate path — `gate` present AND `confidence` is a number. gateEnvelope
//     always fills confidence; plain success/failure leave it null. That is the
//     envelope's own tell that a real GateDecision drove this run (not a plain
//     workflow COMPLETE). It shows the summary, gate, forcing question, and next
//     command. The complete object remains available through `--json`.
//
//  2. Plain path — everything else (founder/code-search/failure): summary,
//     status/gate, trace, optional JSON result, instruction, and next command.
//
// `--json` is owned by the CLI (JSON.stringify the envelope) — this function is
// the human path only and must not change the machine envelope shape.
export function renderHuman(env: RunEnvelope): string {
  return match(env)
    .with({ gate: P.not(null), confidence: P.number }, (e) => renderGateHuman(e))
    .otherwise((e) => renderPlainHuman(e));
}

// Plain (non-whisper) human render. Tests pin this format independently of the
// gate-path renderer.
function renderPlainHuman(env: RunEnvelope): string {
  const disposition = match({ gate: env.gate, verdict: env.verdict })
    .with({ verdict: P.not(null) }, ({ verdict }) => `verdict: ${verdict}`)
    .otherwise(({ gate }) => `gate: ${gate ?? "—"}`);
  return [
    `${env.summary}`,
    ``,
    `status: ${env.status}  ${disposition}`,
    `trace: ${env.trace.steps.length} step(s) · ${env.trace.models.join(", ") || "—"} · ${env.trace.duration_ms}ms`,
    // Both optional blocks are spreads of an empty-or-populated array, so the
    // line order is the literal order of this list — no conditional pushes.
    ...match(env.result)
      .with(P.nullish, (): string[] => [])
      .otherwise((result) => [``, `result:`, JSON.stringify(result, null, 2)]),
    ``,
    env.next.instruction,
    ...match(env.next.command)
      .with(P.union(null, ""), (): string[] => [])
      .otherwise((command) => [``, command]),
  ].join("\n");
}

// TTY gate for stdout human renders (same convention as session-view).
const isTty = (): boolean => process.stdout.isTTY === true;

// Shape of a directive as carried on the envelope (z.unknown[] at the schema
// seam). We only need the fields the asking block prints — action/reason/
// required_evidence — plus severity for "first blocking" selection.
type AskDirective = {
  action: string;
  reason: string;
  required_evidence: string[];
  severity?: string;
  status?: string;
};

function asAskDirective(d: unknown): AskDirective | null {
  // Optional severity/status are read off the same object after the required
  // fields match — keeps the pattern arm thin and avoids fabricating defaults.
  return match(d)
    .with(
      {
        action: P.string.minLength(1),
        reason: P.string.minLength(1),
        required_evidence: P.array(P.string),
      },
      (x) => {
        const rec = x as {
          action: string;
          reason: string;
          required_evidence: string[];
          severity?: unknown;
          status?: unknown;
        };
        return {
          action: rec.action,
          reason: rec.reason,
          required_evidence: rec.required_evidence,
          ...match(rec.severity)
            .with(P.string, (severity) => ({ severity }))
            .otherwise(() => ({})),
          ...match(rec.status)
            .with(P.string, (status) => ({ status }))
            .otherwise(() => ({})),
        };
      },
    )
    .otherwise(() => null);
}

// First blocking directive (judge order), else first directive-shaped entry —
// mirrors firstBlockingDirective on the typed path, but over the envelope's
// z.unknown[] directives (no whisper import at the render seam).
function firstAskDirective(directives: unknown[]): AskDirective | undefined {
  const parsed = directives.flatMap((d) =>
    match(asAskDirective(d))
      .with(null, () => [] as AskDirective[])
      .otherwise((x) => [x]),
  );
  return parsed.find((d) => d.severity === "blocking") ?? parsed[0];
}

function openDirectiveCount(directives: unknown[]): number {
  return directives.filter((d) =>
    match(d)
      .with({ status: "open" }, () => true)
      .otherwise(() => false),
  ).length;
}

// One tight line per finding — severity · summary. Full objects stay on --json.
function findingLine(f: unknown): string | null {
  return match(f)
    .with(
      { summary: P.string.minLength(1), severity: P.string },
      ({ summary, severity }) => `${severity} · ${summary}`,
    )
    .with({ summary: P.string.minLength(1) }, ({ summary }) => summary)
    .otherwise(() => null);
}

// human_escalation lives on the GateDecision carried as `result` (gate path
// sets result = gateOutput). Not a top-level envelope field — do not invent one.
function humanEscalationOf(result: unknown): string | null {
  return match(result)
    .with(
      { human_escalation: P.string.minLength(1) },
      ({ human_escalation }) => human_escalation,
    )
    .otherwise(() => null);
}

// Whisper/gate human render. Visual vocabulary from style.ts so this looks like
// the same product as `navi session list` / `navi story` (labeled rules, status color).
function renderGateHuman(env: RunEnvelope & { gate: Gate; confidence: number }): string {
  const tty = isTty();
  const gatePainted = paintCode(statusCode(env.gate), env.gate, tty);
  const openN = openDirectiveCount(env.directives);
  // `· n open` only when something is still open — same silence-on-zero as session list.
  const gateLine = match(openN > 0)
    .with(true, () => `  ${gatePainted} · ${openN} open`)
    .with(false, () => `  ${gatePainted}`)
    .exhaustive();

  // "what it's asking" only when directives exist. CLEAR/COMPLETE with an empty
  // array skip the section entirely — never print an empty rule block.
  const askBlock = match(env.directives)
    .with([], () => [] as string[])
    .otherwise((dirs) =>
      match(firstAskDirective(dirs))
        .with(P.nullish, () => [] as string[])
        .otherwise((d) => [
          ``,
          rule("what it's asking"),
          `  ${d.action}`,
          ``,
          `  why:  ${d.reason}`,
          ...match(d.required_evidence.length)
            .with(0, () => [] as string[])
            .otherwise(() => [
              `  bring back:`,
              ...d.required_evidence.map((e) => `    - ${e}`),
            ]),
        ]),
    );

  // ESCALATE lanes may carry their question in human_escalation with no
  // directives. Prefer the directive-based ask block when it exists.
  const escalateBlock = match({ ask: askBlock, q: humanEscalationOf(env.result) })
    .with(
      { ask: [], q: P.string.minLength(1) },
      ({ q }) => [``, rule("what the human must decide"), `  ${q}`],
    )
    .otherwise(() => [] as string[]);

  const findingLines = env.findings.flatMap((f) =>
    match(findingLine(f))
      .with(null, () => [] as string[])
      .otherwise((line) => [`  ${line}`]),
  );
  const findingsBlock = match(findingLines)
    .with([], () => [] as string[])
    .otherwise((lines) => [``, rule("findings"), ...lines]);

  // Next: instruction states the purpose; command is the copy-paste action when
  // present (CLEAR/ESCALATE continuation or COMPLETE handoff). On DIRECT/REPAIR
  // the instruction IS the directive action already shown in the ask block —
  // print the command only there so the same sentence does not appear twice.
  const instructionAlreadyInAsk = match(firstAskDirective(env.directives))
    .with({ action: P.string.minLength(1) }, ({ action }) => action === env.next.instruction)
    .otherwise(() => false);
  const nextLines = match(env.next.command)
    .with(P.union(null, ""), () => [`  ${env.next.instruction}`])
    .otherwise((command) =>
      match(instructionAlreadyInAsk)
        .with(true, () => [`  ${accent(command, tty)}`])
        .with(false, () => [`  ${env.next.instruction}`, `  ${accent(command, tty)}`])
        .exhaustive(),
    );

  return [
    rule(env.workflow),
    `  ${env.summary}`,
    ``,
    gateLine,
    ...askBlock,
    ...escalateBlock,
    ...findingsBlock,
    ``,
    rule("next"),
    ...nextLines,
    ``,
    dim(`  full detail: --json`, tty),
  ].join("\n");
}
