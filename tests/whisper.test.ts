import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  Gate,
  Evidence,
  Directive,
  Finding,
  SurfaceMap,
  GateDecision,
  SessionTurn,
  SessionState,
  EvidenceEvent,
  exitForGate,
} from "../src/contracts/whisper.ts";
import judgeComposite from "../builtin/workflows/edge-walk/judge.schema.ts";

// Round-trip contract: a valid fixture object survives
// parse → JSON.stringify → JSON.parse → parse again, deep-equal to the first
// parse. Proves each schema is JSON-serializable and stable across the CLI
// boundary (session state is message-resident JSON; envelopes are `--json`).
function roundTrip<T extends z.ZodType>(schema: T, fixture: z.input<T>): z.output<T> {
  const first = schema.parse(fixture);
  const again = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(again).toEqual(first);
  return first;
}

// --- shared fixtures ---------------------------------------------------------
const evidenceFull: z.input<typeof Evidence> = {
  kind: "test_result",
  uri: "file:///repo/handler.integration.test.ts",
  line_start: 12,
  line_end: 30,
  command: "npm test -- handler.integration",
  exit_code: 0,
  claim_supported: true,
  fresh_for_revision: "deadbeefcafef00d",
};

const directiveFull: z.input<typeof Directive> = {
  id: "dir-1",
  type: "trace",
  priority: 1,
  severity: "blocking",
  status: "open",
  reason: "handler.ts never calls repairCallRecord — runtime path missing",
  action: "trace the call path from handler.ts to repairCallRecord",
  targets: ["src/handler.ts", "src/repair.ts"],
  required_evidence: ["call site in handler.ts", "call_path handler→repair"],
  completion_criteria: ["a call_path evidence linking handler to repair"],
  stop_conditions: ["repair.ts deleted"],
  issued_at: "2026-07-18T12:00:00Z",
};

const findingFull: z.input<typeof Finding> = {
  id: "find-1",
  file: "src/handler.ts",
  line: 42,
  severity: "high",
  category: "integration-completeness",
  summary: "repairCallRecord is implemented and unit-tested but never wired in",
  evidence: [evidenceFull],
  confidence: 0.92,
  suggested_resolution: "call repairCallRecord() from handler.ts and add an integration test",
};

const surfaceMapFull: z.input<typeof SurfaceMap> = {
  surfaces: ["src/handler.ts", "src/repair.ts"],
  seams: ["handler.ts → repairCallRecord (unwired)"],
  unknowns: ["is repairCallRecord reachable from any other entry point?"],
  revision_hash: "deadbeefcafef00d",
};

const gateDecisionFull: z.input<typeof GateDecision> = {
  gate: "DIRECT",
  reason: "missing runtime wiring; direct a trace before completion",
  blocking_directive_ids: ["dir-1"],
  non_blocking_risks: ["repair.ts has no timeout guard"],
  human_escalation: null,
  confidence: 0.83,
};

const sessionTurnFull: z.input<typeof SessionTurn> = {
  kind: "gate",
  run_id: "run-1",
  workflow: "edge-walk",
  decision: gateDecisionFull,
};

const sessionStateFull: z.input<typeof SessionState> = {
  schema_version: "navi.session.v2",
  session_id: "thread-abc",
  task: "complete the repair-call wiring",
  parent_events: [{ type: "plan", body: "claims done citing repair.ts + unit test" }],
  surface_map: surfaceMapFull,
  directives: [directiveFull],
  findings: [findingFull],
  evidence: [evidenceFull],
  turn_history: [sessionTurnFull],
  status: "active",
};

const evidenceEventFull: z.input<typeof EvidenceEvent> = {
  directive_id: "dir-1",
  evidence: [evidenceFull],
};

// --- round-trip every schema -------------------------------------------------
describe("whisper contracts — round-trip every schema", () => {
  it("Evidence round-trips (all fields)", () => roundTrip(Evidence, evidenceFull));
  it("Evidence round-trips (minimal — only required kind + claim_supported)", () =>
    roundTrip(Evidence, { kind: "source_location", claim_supported: false }));
  it("Directive round-trips", () => roundTrip(Directive, directiveFull));
  it("Finding round-trips", () => roundTrip(Finding, findingFull));
  it("SurfaceMap round-trips", () => roundTrip(SurfaceMap, surfaceMapFull));
  it("GateDecision round-trips (null human_escalation)", () => roundTrip(GateDecision, gateDecisionFull));
  it("GateDecision round-trips (string human_escalation)", () =>
    roundTrip(GateDecision, { ...gateDecisionFull, gate: "ESCALATE", human_escalation: "needs a human to confirm scope" }));
  it("SessionTurn round-trips", () => roundTrip(SessionTurn, sessionTurnFull));
  it("SessionState round-trips (with surface_map)", () => roundTrip(SessionState, sessionStateFull));
  it("SessionState round-trips (null surface_map, empty lists)", () =>
    roundTrip(SessionState, {
      ...sessionStateFull,
      surface_map: null,
      directives: [],
      findings: [],
      evidence: [],
      turn_history: [],
      parent_events: [],
      status: "new",
    }));
  it("EvidenceEvent round-trips", () => roundTrip(EvidenceEvent, evidenceEventFull));
});

// --- model-boundary null-tolerance: the judge-composite family's OPTIONAL fields
// ACCEPT an explicit `null` from the model and NORMALIZE it to absent (undefined) at
// the parse boundary, so nothing downstream (SessionState, envelope) ever stores or
// emits `null` where the shape is absent-or-value. `.nullable()` fields
// (human_escalation, SessionState.surface_map) keep their explicit-null semantics and
// are NOT touched (covered by the round-trip + reject blocks).
describe("review contracts — model optionals normalize null → absent", () => {
  const absentKeys = (o: unknown, keys: string[]) => {
    const re = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    for (const k of keys) expect(k in re, `serialized JSON must omit "${k}"`).toBe(false);
  };

  it("Finding: file/line/suggested_resolution = null all parse to undefined and serialize away", () => {
    const parsed = Finding.parse({ ...findingFull, file: null, line: null, suggested_resolution: null });
    expect(parsed.file).toBeUndefined();
    expect(parsed.line).toBeUndefined();
    expect(parsed.suggested_resolution).toBeUndefined();
    absentKeys(parsed, ["file", "line", "suggested_resolution"]);
  });

  it("Finding: a present string value is preserved unchanged (semantics unwidened)", () => {
    const parsed = Finding.parse({ ...findingFull, suggested_resolution: "call it from handler.ts" });
    expect(parsed.suggested_resolution).toBe("call it from handler.ts");
  });

  it("Evidence: every optional = null normalizes to absent (only kind + claim_supported remain)", () => {
    const parsed = Evidence.parse({
      kind: "call_path",
      claim_supported: true,
      uri: null,
      line_start: null,
      line_end: null,
      command: null,
      exit_code: null,
      fresh_for_revision: null,
    });
    expect(Object.keys(JSON.parse(JSON.stringify(parsed))).sort()).toEqual(["claim_supported", "kind"]);
  });

  it("judge composite: findings[].suggested_resolution = null parses and the key is absent in the emitted output", () => {
    // The exact shape the CLI's gate detection + emission carries (judge.schema.ts).
    const composite = judgeComposite.parse({
      ...gateDecisionFull,
      gate: "CLEAR",
      directives: [directiveFull],
      findings: [{ ...findingFull, file: null, line: null, suggested_resolution: null }],
      // surface_map omitted — the judge is told to omit it
    });
    expect(composite.findings[0].suggested_resolution).toBeUndefined();
    const reFinding = JSON.parse(JSON.stringify(composite)).findings[0] as Record<string, unknown>;
    for (const k of ["file", "line", "suggested_resolution"]) expect(k in reFinding).toBe(false);
  });

  it("judge composite: surface_map = null normalizes to absent (the composite's own optional)", () => {
    const composite = judgeComposite.parse({ ...gateDecisionFull, directives: [], findings: [], surface_map: null });
    expect(composite.surface_map).toBeUndefined();
    absentKeys(composite, ["surface_map"]);
  });

  it("z.array(Finding) (the envelope's findings path) normalizes null optionals", () => {
    // extractWhisperFields validates rec.findings with exactly this array schema.
    const findings = z.array(Finding).parse([{ ...findingFull, suggested_resolution: null, file: null, line: null }]);
    expect(findings[0].suggested_resolution).toBeUndefined();
    absentKeys(findings[0], ["file", "line", "suggested_resolution"]);
  });

  it("persisted SessionState: a finding with null optionals is stored absent, never as null", () => {
    const state = SessionState.parse({
      ...sessionStateFull,
      findings: [{ ...findingFull, file: null, line: null, suggested_resolution: null }],
    });
    const reFinding = JSON.parse(JSON.stringify(state)).findings[0] as Record<string, unknown>;
    for (const k of ["file", "line", "suggested_resolution"]) expect(k in reFinding).toBe(false);
  });
});

// --- one rejected-invalid case per schema ------------------------------------
describe("whisper contracts — reject structurally invalid objects", () => {
  it("Evidence: rejects an out-of-enum kind", () =>
    expect(Evidence.safeParse({ ...evidenceFull, kind: "screenshot" }).success).toBe(false));
  it("Evidence: rejects a missing claim_supported", () => {
    const { claim_supported, ...noClaim } = evidenceFull;
    expect(Evidence.safeParse(noClaim).success).toBe(false);
  });
  it("Directive: rejects an empty required_evidence[]", () =>
    expect(Directive.safeParse({ ...directiveFull, required_evidence: [] }).success).toBe(false));
  it("Directive: rejects an empty completion_criteria[]", () =>
    expect(Directive.safeParse({ ...directiveFull, completion_criteria: [] }).success).toBe(false));
  it("Directive: rejects an out-of-enum severity", () =>
    expect(Directive.safeParse({ ...directiveFull, severity: "critical" }).success).toBe(false));
  it("Directive: rejects an out-of-enum status", () =>
    expect(Directive.safeParse({ ...directiveFull, status: "done" }).success).toBe(false));
  it("Finding: rejects a confidence above 1", () =>
    expect(Finding.safeParse({ ...findingFull, confidence: 1.5 }).success).toBe(false));
  it("SurfaceMap: rejects a missing revision_hash", () => {
    const { revision_hash, ...noHash } = surfaceMapFull;
    expect(SurfaceMap.safeParse(noHash).success).toBe(false);
  });
  it("GateDecision: rejects an out-of-enum gate", () =>
    expect(GateDecision.safeParse({ ...gateDecisionFull, gate: "MAYBE" }).success).toBe(false));
  it("GateDecision: rejects a missing human_escalation (nullable, not optional)", () => {
    const { human_escalation, ...noEsc } = gateDecisionFull;
    expect(GateDecision.safeParse(noEsc).success).toBe(false);
  });
  it("SessionState: rejects an out-of-enum status", () =>
    expect(SessionState.safeParse({ ...sessionStateFull, status: "paused" }).success).toBe(false));
  it("SessionState: rejects any schema version other than navi.session.v2", () =>
    expect(SessionState.safeParse({ ...sessionStateFull, schema_version: "other" }).success).toBe(false));
});

// --- empty-string judgment fields: both directions ---------------------------
// REQUIRED judgment strings reject ''. MODEL-OPTIONAL judge-composite strings
// reject a PRESENT '' so the retry processor re-asks, while absent/null normalize
// to undefined and remain genuinely optional.
describe("whisper contracts — reject empty-string judgment fields", () => {
  it("REQUIRED strings reject '' (GateDecision.reason, Finding.summary, Directive.reason/action)", () => {
    expect(GateDecision.safeParse({ ...gateDecisionFull, reason: "" }).success).toBe(false);
    expect(Finding.safeParse({ ...findingFull, summary: "" }).success).toBe(false);
    expect(Directive.safeParse({ ...directiveFull, reason: "" }).success).toBe(false);
    expect(Directive.safeParse({ ...directiveFull, action: "" }).success).toBe(false);
  });

  it("MODEL-OPTIONAL strings reject a PRESENT '' (Evidence.command/uri, Finding.file/suggested_resolution)", () => {
    expect(Evidence.safeParse({ ...evidenceFull, command: "" }).success).toBe(false);
    expect(Evidence.safeParse({ ...evidenceFull, uri: "" }).success).toBe(false);
    expect(Finding.safeParse({ ...findingFull, file: "" }).success).toBe(false);
    expect(Finding.safeParse({ ...findingFull, suggested_resolution: "" }).success).toBe(false);
  });

  it("MODEL-OPTIONAL strings still accept absent/null → undefined (optionality preserved)", () => {
    // The tightening is on PRESENT-but-empty only; genuine absence is unaffected.
    const absent = Evidence.parse({ kind: "call_path", claim_supported: true });
    expect(absent.command).toBeUndefined();
    expect(absent.uri).toBeUndefined();
    const nulled = Finding.parse({ ...findingFull, file: null, suggested_resolution: null });
    expect(nulled.file).toBeUndefined();
    expect(nulled.suggested_resolution).toBeUndefined();
    // fresh_for_revision was deliberately NOT tightened (a hash, never judgment): '' passes.
    expect(Evidence.safeParse({ ...evidenceFull, fresh_for_revision: "" }).success).toBe(true);
  });

  it("the judge composite carries the tightening: a '' judgment field fails safeParse (the retry-processor path)", () => {
    // The composite is built from these schemas (judge.schema.ts), so a ''-emission at
    // the highest-stakes step fails validation → schemaRetryProcessor aborts WITH retry
    // and the judge re-states, rather than the invisible placeholder being stored.
    const good = judgeComposite.safeParse({ ...gateDecisionFull, directives: [directiveFull], findings: [findingFull] });
    expect(good.success).toBe(true);
    expect(judgeComposite.safeParse({ ...gateDecisionFull, reason: "", directives: [], findings: [] }).success).toBe(false);
    expect(
      judgeComposite.safeParse({
        ...gateDecisionFull,
        directives: [],
        findings: [{ ...findingFull, suggested_resolution: "" }],
      }).success,
    ).toBe(false);
  });
});

// --- exitForGate: exhaustive over all six Gate members ------------------------
describe("exitForGate — gate-derived exit map", () => {
  it("CLEAR/DIRECT/REPAIR/COMPLETE → 0", () => {
    for (const g of ["CLEAR", "DIRECT", "REPAIR", "COMPLETE"] as const) expect(exitForGate(g)).toBe(0);
  });
  it("BLOCKED → 2", () => expect(exitForGate("BLOCKED")).toBe(2));
  it("ESCALATE → 3", () => expect(exitForGate("ESCALATE")).toBe(3));
  it("covers every Gate member with a valid exit code (no gate unmapped)", () => {
    for (const g of Gate.options) expect([0, 2, 3]).toContain(exitForGate(g));
    expect(Gate.options).toHaveLength(6);
  });
});

// --- EvidenceEvent: structural input gate ------------------------------------
describe("EvidenceEvent — light structural input gate", () => {
  it("accepts a minimal valid event (directive_id + one typed evidence)", () => {
    const ev = EvidenceEvent.safeParse({
      directive_id: "dir-1",
      evidence: [{ kind: "source_location", uri: "file:///repo/repair.ts", claim_supported: true }],
    });
    expect(ev.success).toBe(true);
  });
  it("is permissive beyond structure — extra keys do not fail it (judge, not schema, judges proof)", () => {
    const ev = EvidenceEvent.safeParse({
      directive_id: "dir-1",
      evidence: [{ kind: "call_path", claim_supported: true, note: "trusted claim" }],
      parent_note: "I believe this is done",
    });
    expect(ev.success).toBe(true);
  });
  it("rejects garbage: empty object", () => expect(EvidenceEvent.safeParse({}).success).toBe(false));
  it("rejects an empty evidence[]", () =>
    expect(EvidenceEvent.safeParse({ directive_id: "dir-1", evidence: [] }).success).toBe(false));
  it("rejects wrong types (directive_id must be a string)", () =>
    expect(EvidenceEvent.safeParse({ directive_id: 7, evidence: [evidenceFull] }).success).toBe(false));
  it("rejects an evidence element with an out-of-enum kind", () =>
    expect(
      EvidenceEvent.safeParse({ directive_id: "dir-1", evidence: [{ kind: "hunch", claim_supported: true }] }).success,
    ).toBe(false));
});
