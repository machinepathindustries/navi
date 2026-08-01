import { describe, it, expect } from "vitest";
import {
  RunEnvelope,
  successEnvelope,
  failureEnvelope,
  gateEnvelope,
  sessionStatusForGate,
  renderHuman,
  exitFor,
} from "../src/contracts/envelope.ts";
import { exitForGate } from "../src/contracts/whisper.ts";
import { VerdictSchema } from "../src/contracts/verdict.ts";
import { buildShape } from "../src/compiler/index.ts";
import { parseSpecText } from "../src/compiler/parse.ts";

// buildShape is async (a `.ts` output reference is resolved by dynamic import at
// plan time); this fixture carries no such reference, so the await is trivial.
const shape = await buildShape(
  parseSpecText(`
name: t
steps:
  - name: only
    type: agent
    prompt: hi
`)._unsafeUnwrap(),
);

const base = {
  run_id: "r1",
  session_id: "c1",
  workflow: "t",
  event: "run",
  shape,
  result: { answer: "42", sources: [] }, // stands in for a final step's structured output
  trace: { duration_ms: 5, ranSteps: ["only"] },
  nextCommand: "navi run t -t c1",
};

describe("navi.run.v2 envelope", () => {
  it("a plain success stays active with no gate or verdict and exits 0", () => {
    const env = successEnvelope({ ...base, summary: "done" });
    expect(RunEnvelope.safeParse(env).success).toBe(true);
    expect(env.status).toBe("active");
    expect(env.gate).toBeNull();
    expect(env.verdict).toBeNull();
    expect(env.schema_version).toBe("navi.run.v2");
    expect(env.session_id).toBe("c1");
    expect(exitFor(env)).toBe(0);
    // Review-specific arrays are empty on a plain workflow.
    expect(env.surface_map).toBeNull();
    expect(env.directives).toEqual([]);
    // trace honestly reflects the resolved plan.
    expect(env.trace.steps).toEqual(["only"]);
    expect(env.trace.models).toEqual([shape.defaultModel]);
  });

  it("a failed run has a null gate and exits 1 — never a silent success", () => {
    const env = failureEnvelope({ ...base, reason: "model exploded" });
    expect(RunEnvelope.safeParse(env).success).toBe(true);
    expect(env.gate).toBeNull();
    expect(env.verdict).toBeNull();
    expect(env.status).toBe("failed");
    expect(exitFor(env)).toBe(1);
    expect(env.next.instruction).toMatch(/Return the failure to the controlling agent/);
    expect(env.next.instruction).not.toMatch(/human/i);
  });

  it("maps every gate to its exit code", () => {
    const at = (gate: RunEnvelope["gate"]) => exitFor({ ...successEnvelope({ ...base, summary: "x" }), gate });
    expect(at("CLEAR")).toBe(0);
    expect(at("DIRECT")).toBe(0);
    expect(at("REPAIR")).toBe(0);
    expect(at("COMPLETE")).toBe(0);
    expect(at("BLOCKED")).toBe(2);
    expect(at("ESCALATE")).toBe(3);
    expect(at(null)).toBe(0);
  });

  it("carries the final step's structured output on result (success), null on failure", () => {
    const ok = successEnvelope({ ...base, summary: "done", result: { answer: "42", sources: [] } });
    expect(RunEnvelope.safeParse(ok).success).toBe(true);
    expect(ok.result).toEqual({ answer: "42", sources: [] });
    // still schema-valid and version-stable — result is additive + nullable.
    expect(ok.schema_version).toBe("navi.run.v2");

    const failed = failureEnvelope({ ...base, reason: "model exploded" });
    expect(failed.result).toBeNull();
    expect(RunEnvelope.safeParse(failed).success).toBe(true);
  });

  it("human rendering ends with the literal next.command line", () => {
    const env = successEnvelope({ ...base, summary: "done" });
    const lines = renderHuman(env).split("\n");
    expect(lines.at(-1)).toBe(env.next.command);
  });

  it("renders the result block after the trace and before next (JSON-shaped, honest)", () => {
    const env = successEnvelope({ ...base, summary: "done", result: { answer: "42", sources: [] } });
    const out = renderHuman(env);
    const lines = out.split("\n");
    const resultIdx = lines.indexOf("result:");
    const traceIdx = lines.findIndex((l) => l.startsWith("trace:"));
    const nextIdx = lines.indexOf(env.next.instruction);
    expect(resultIdx).toBeGreaterThan(traceIdx);
    expect(resultIdx).toBeLessThan(nextIdx);
    // JSON-shaped, not paraphrased.
    expect(out).toContain(`"answer": "42"`);
    // last line is still the literal next.command.
    expect(lines.at(-1)).toBe(env.next.command);
    // a null result (failure) renders no result block.
    expect(renderHuman(failureEnvelope({ ...base, reason: "boom" }))).not.toContain("result:");
  });

  it("non-gate plain path has an exact stable rendering", () => {
    // Plain output is a public CLI contract. confidence is null → plain.
    const env = successEnvelope({ ...base, summary: "done", result: { answer: "42", sources: [] } });
    expect(env.confidence).toBeNull();
    expect(env.gate).toBeNull();
    const model = shape.defaultModel;
    expect(renderHuman(env)).toBe(
      [
        "done",
        "",
        "status: active  gate: —",
        `trace: 1 step(s) · ${model} · 5ms`,
        "",
        "result:",
        `{`,
        `  "answer": "42",`,
        `  "sources": []`,
        `}`,
        "",
        "Workflow complete. Continue with your task.",
        "",
        "navi run t -t c1",
      ].join("\n"),
    );
  });

  it("rejects a structurally invalid envelope", () => {
    const env = successEnvelope({ ...base, summary: "done" }) as Record<string, unknown>;
    expect(RunEnvelope.safeParse({ ...env, schema_version: "navi.run.v1" }).success).toBe(false);
    expect(RunEnvelope.safeParse({ ...env, gate: "MAYBE" }).success).toBe(false);
  });

  it("rejects an envelope carrying both a gate and a verdict", () => {
    const env = successEnvelope({ ...base, summary: "done" });
    expect(RunEnvelope.safeParse({ ...env, gate: "CLEAR", verdict: "GO" }).success).toBe(false);
  });
});

// The `next` block is verdict-aware when the final result carries a `verdict`
// field — keyed on the FIELD (any workflow emitting one), never the workflow name
// No NextBlock schema change is needed; this stays a thin ts-pattern branch.
describe("navi.run.v2 envelope — verdict-aware next", () => {
  const withResult = (result: unknown) => successEnvelope({ ...base, summary: "done", result });
  // Full VerdictSchema shape (RUN seam validates the whole object; partials are
  // not-a-verdict). Mirrors what Founder / the json-command fixture emit.
  const verdict = (over: Record<string, unknown>) => ({
    take: "decision",
    grounding_points: [] as string[],
    decision_rules: [] as string[],
    what_not_to_do: [] as string[],
    ...over,
  });

  it("trims verdict text and rejects whitespace-only entries", () => {
    const valid = {
      verdict: "GO",
      take: "  ship it  ",
      grounding_points: ["  grounded  "],
      decision_rules: ["  decide once  "],
      what_not_to_do: ["  do not widen scope  "],
    };
    expect(VerdictSchema.parse(valid)).toEqual({
      verdict: "GO",
      take: "ship it",
      grounding_points: ["grounded"],
      decision_rules: ["decide once"],
      what_not_to_do: ["do not widen scope"],
    });
    for (const invalid of [
      { ...valid, take: " \t " },
      { ...valid, grounding_points: [" \t "] },
      { ...valid, decision_rules: [" \t "] },
      { ...valid, what_not_to_do: [" \t "] },
    ]) {
      expect(VerdictSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("GO proceeds as scoped with no re-run (command null)", () => {
    const env = withResult(verdict({ verdict: "GO", take: "ship it" }));
    expect(RunEnvelope.safeParse(env).success).toBe(true);
    expect(env.status).toBe("complete");
    expect(env.gate).toBeNull();
    expect(env.verdict).toBe("GO");
    expect(exitFor(env)).toBe(0);
    expect(env.next.instruction).toBe("Verdict GO — proceed as scoped.");
    expect(env.next.command).toBeNull();
  });

  it("REFINE names the fix from decision_rules and bakes the -t re-run command", () => {
    const env = withResult(
      verdict({
        verdict: "REFINE",
        decision_rules: ["tighten the schema first", "then re-run"],
        what_not_to_do: ["do not ship"],
      }),
    );
    expect(env.status).toBe("awaiting_parent");
    expect(env.gate).toBeNull();
    expect(env.verdict).toBe("REFINE");
    expect(exitFor(env)).toBe(0);
    expect(env.next.instruction).toBe("Verdict REFINE — address the fix, then re-run: tighten the schema first");
    expect(env.next.command).toBe(base.nextCommand);
  });

  it("REFINE falls back to what_not_to_do when decision_rules is empty", () => {
    const env = withResult(verdict({ verdict: "REFINE", decision_rules: [], what_not_to_do: ["do not ship as-is"] }));
    expect(env.next.instruction).toMatch(/avoid — do not ship as-is/);
  });

  it("REJECT stops the work (command null)", () => {
    const env = withResult(verdict({ verdict: "REJECT", take: "wrong approach" }));
    expect(env.status).toBe("complete");
    expect(env.gate).toBeNull();
    expect(env.verdict).toBe("REJECT");
    expect(exitFor(env)).toBe(0);
    expect(env.next.instruction).toBe("Verdict REJECT — stop; do not proceed.");
    expect(env.next.command).toBeNull();
  });

  it("a result with no verdict field keeps the default continuation next", () => {
    const env = withResult({ answer: "42" });
    expect(env.next.instruction).toBe("Workflow complete. Continue with your task.");
    expect(env.next.command).toBe(base.nextCommand);
  });

  it("an out-of-enum verdict value is treated as no verdict (default next), never a fabricated branch", () => {
    const env = withResult({ verdict: "MAYBE" });
    expect(env.next.instruction).toBe("Workflow complete. Continue with your task.");
    expect(env.next.command).toBe(base.nextCommand);
  });
});

// The gate-derived envelope for a run whose final step
// emitted a GateDecision. Gate + status + the gate-aware `next` are derived from the
// disposition; the whisper judgment fields are carried through. Shape-keyed at the
// CLI (this builder receives the already-validated pieces), never workflow-name-keyed.
describe("navi.run.v2 envelope — gate-derived whisper path", () => {
  const directive = {
    id: "d1",
    type: "trace-runtime-path",
    priority: 1,
    severity: "blocking",
    status: "open",
    reason: "the function is defined but never invoked at runtime",
    action: "produce a call path from an entry point to repairCallRecord()",
    targets: ["src/handler.ts"],
    required_evidence: ["call_path"],
    completion_criteria: ["a live call site is cited"],
    stop_conditions: [],
    issued_at: "2026-07-19T00:00:00.000Z",
  };
  const CONTINUATION_CMD = "navi run t --json --stdin -t c1";
  const gateEnv = (gate: RunEnvelope["gate"] & string, over: Record<string, unknown> = {}) =>
    gateEnvelope({
      ...base,
      summary: `${gate} — a reason`,
      result: { gate, reason: "a reason" },
      gate,
      surface_map: { surfaces: [], seams: [], unknowns: [], revision_hash: "r1" },
      directives: [directive],
      findings: [],
      evidence: [],
      confidence: 0.6,
      blockingDirectiveIds: ["d1"],
      whisperCommand: CONTINUATION_CMD,
      ...over,
    });

  it("sessionStatusForGate maps every gate exhaustively", () => {
    expect(sessionStatusForGate("CLEAR")).toBe("clear");
    expect(sessionStatusForGate("DIRECT")).toBe("awaiting_parent");
    expect(sessionStatusForGate("REPAIR")).toBe("awaiting_parent");
    expect(sessionStatusForGate("BLOCKED")).toBe("blocked");
    expect(sessionStatusForGate("ESCALATE")).toBe("escalated");
    expect(sessionStatusForGate("COMPLETE")).toBe("complete");
  });

  it("derives gate + status, carries the whisper fields, and validates against navi.run.v2", () => {
    const env = gateEnv("DIRECT");
    expect(RunEnvelope.safeParse(env).success).toBe(true);
    expect(env.gate).toBe("DIRECT");
    expect(env.verdict).toBeNull();
    expect(env.status).toBe("awaiting_parent");
    expect(env.confidence).toBe(0.6);
    expect(env.directives).toHaveLength(1);
    expect(env.surface_map).toMatchObject({ revision_hash: "r1" });
    expect(env.schema_version).toBe("navi.run.v2");
  });

  it("exits by gate via exitForGate (CLEAR/DIRECT/REPAIR/COMPLETE→0, BLOCKED→2, ESCALATE→3)", () => {
    for (const g of ["CLEAR", "DIRECT", "REPAIR", "COMPLETE"] as const) {
      const env = gateEnv(g);
      expect(exitForGate(env.gate!)).toBe(0);
      expect(exitFor(env)).toBe(0);
    }
    const blocked = gateEnv("BLOCKED");
    const escalated = gateEnv("ESCALATE");
    expect(exitForGate(blocked.gate!)).toBe(2);
    expect(exitFor(blocked)).toBe(2);
    expect(exitForGate(escalated.gate!)).toBe(3);
    expect(exitFor(escalated)).toBe(3);
  });

  it("DIRECT/REPAIR next = the first blocking directive's action + required_evidence + the --stdin -t command", () => {
    for (const g of ["DIRECT", "REPAIR"] as const) {
      const env = gateEnv(g);
      expect(env.next.instruction).toBe("produce a call path from an entry point to repairCallRecord()");
      expect(env.next.return).toEqual(["call_path"]);
      expect(env.next.command).toBe(CONTINUATION_CMD);
    }
  });

  it("CLEAR proceeds, BLOCKED returns to the controller, and only ESCALATE names the human", () => {
    expect(gateEnv("CLEAR").next.instruction).toMatch(/CLEAR — proceed/);
    expect(gateEnv("CLEAR").next.command).toBe(CONTINUATION_CMD);
    expect(gateEnv("BLOCKED").next.instruction).toMatch(/BLOCKED — return .* controlling agent/);
    expect(gateEnv("BLOCKED").next.instruction).toMatch(/produce a call path/);
    expect(gateEnv("BLOCKED").next.return).toEqual(["call_path"]);
    expect(gateEnv("BLOCKED").next.instruction).not.toMatch(/human/i);
    expect(gateEnv("BLOCKED").next.command).toBe(CONTINUATION_CMD);
    expect(gateEnv("ESCALATE").next.instruction).toMatch(/ESCALATE — surface to the human/);
    expect(gateEnv("ESCALATE").next.command).toBe(CONTINUATION_CMD);
  });

  it("COMPLETE is resolved with a null command", () => {
    const env = gateEnv("COMPLETE");
    expect(env.next.instruction).toMatch(/COMPLETE — the session is resolved/);
    expect(env.next.command).toBeNull();
  });

  it("DIRECT gate human render: question block, NO raw JSON, next command, --json pointer", () => {
    // Human output surfaces the ask first; the complete object stays on --json.
    const env = gateEnv("DIRECT");
    const out = renderHuman(env);
    expect(out).toMatch(/^── t ──/);
    expect(out).toContain("DIRECT — a reason");
    expect(out).toMatch(/DIRECT · 1 open/);
    expect(out).toContain("── what it's asking ──");
    expect(out).toContain("produce a call path from an entry point to repairCallRecord()");
    expect(out).toContain("why:  the function is defined but never invoked at runtime");
    expect(out).toContain("bring back:");
    expect(out).toContain("- call_path");
    expect(out).toContain("── next ──");
    expect(out).toContain(CONTINUATION_CMD);
    expect(out).toContain("full detail: --json");
    // Raw JSON dump of the GateDecision is gone from the human path.
    expect(out).not.toContain("result:");
    expect(out).not.toContain("completion_criteria");
    expect(out).not.toContain('"blocking_directive_ids"');
    expect(out).not.toMatch(/\{\s*"gate":\s*"DIRECT"/);
  });

  it("COMPLETE gate with no directives omits the asking block", () => {
    const env = gateEnv("COMPLETE", { directives: [], blockingDirectiveIds: [] });
    const out = renderHuman(env);
    expect(out).toMatch(/^── t ──/);
    expect(out).toContain("COMPLETE — a reason");
    expect(out).toMatch(/\n {2}COMPLETE\n/); // gate line, no "· n open"
    expect(out).not.toContain("what it's asking");
    expect(out).not.toContain("bring back:");
    expect(out).toContain("── next ──");
    expect(out).toContain("Gate COMPLETE — the session is resolved.");
    expect(out).toContain("full detail: --json");
    expect(out).not.toContain("result:");
  });

  it("gate human render surfaces findings tightly when present", () => {
    const env = gateEnv("DIRECT", {
      findings: [
        {
          id: "f1",
          severity: "high",
          category: "wiring",
          summary: "repairCallRecord is never reached",
          evidence: [],
          confidence: 0.8,
        },
      ],
    });
    const out = renderHuman(env);
    expect(out).toContain("── findings ──");
    expect(out).toContain("high · repairCallRecord is never reached");
  });

  it("falls back to a generic instruction when the blocking directive has no action", () => {
    const env = gateEnv("DIRECT", { directives: [{ id: "d1", severity: "blocking" }], blockingDirectiveIds: ["d1"] });
    expect(env.next.instruction).toBe("Address the open directive.");
    expect(env.next.return).toEqual([]);
  });

  // The human renderer surfaces human_escalation when no directive is present
  // and keeps next.instruction when a command is available.
  it("ESCALATE human render surfaces human_escalation and keeps the instruction", () => {
    const question =
      "Should the first-run orientation be opt-in via a flag, or the default for bare navi?";
    const env = gateEnv("ESCALATE", {
      directives: [],
      blockingDirectiveIds: [],
      result: {
        gate: "ESCALATE",
        reason: "scope fork only a human can pick",
        blocking_directive_ids: [],
        non_blocking_risks: [],
        human_escalation: question,
        confidence: 0.6,
      },
      summary: "ESCALATE — scope fork only a human can pick",
    });
    const out = renderHuman(env);
    // (a) the escalation question is visible — not buried / not missing.
    expect(out).toContain("what the human must decide");
    expect(out).toContain(question);
    // (b) instruction is not dropped when a command exists.
    expect(out).toContain("Gate ESCALATE — surface to the human for a decision.");
    expect(out).toContain(CONTINUATION_CMD);
    // Still human-first: no raw GateDecision JSON dump.
    expect(out).not.toContain("result:");
    expect(out).not.toContain("completion_criteria");
  });

  it("CLEAR human render shows the instruction above the command", () => {
    const env = gateEnv("CLEAR", { directives: [], blockingDirectiveIds: [] });
    const out = renderHuman(env);
    const instr = "Gate CLEAR — proceed; verify at your next checkpoint.";
    expect(out).toContain(instr);
    expect(out).toContain(CONTINUATION_CMD);
    // Instruction appears before the command in the next block.
    const nextIdx = out.indexOf("── next ──");
    const instrIdx = out.indexOf(instr);
    const cmdIdx = out.indexOf(CONTINUATION_CMD);
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    expect(instrIdx).toBeGreaterThan(nextIdx);
    expect(cmdIdx).toBeGreaterThan(instrIdx);
  });

  it("DIRECT human render does not repeat the directive action under next", () => {
    const env = gateEnv("DIRECT");
    const out = renderHuman(env);
    const action = "produce a call path from an entry point to repairCallRecord()";
    // Shown once in the ask block.
    expect(out).toContain(action);
    expect(out.split(action).length - 1).toBe(1);
    expect(out).toContain(CONTINUATION_CMD);
  });
});
