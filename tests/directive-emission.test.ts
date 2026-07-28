import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Directive } from "../src/contracts/whisper.ts";
import JudgeComposite from "../builtin/workflows/edge-walk/judge.schema.ts";

// Pins the continuation-emission contract. A satisfied directive must retain its
// schema-required arrays or emission fails loudly. These tests prove the
// schema GUARD (empty required arrays are rejected) and that the guidance's two
// valid shapes — satisfied-with-preserved-arrays and omitted — both pass.

// The exact terms the session's open directive was opened against; a CLEAR must
// PRESERVE these verbatim on the satisfied directive, never blank them.
const OPEN_REQUIRED_EVIDENCE = [
  "handler.ts showing a runtime call to repairCallRecord on the dirty-record branch",
  "an integration test result fresh for the current revision covering a salvageable record",
];
const OPEN_COMPLETION_CRITERIA = [
  "re-read handler.ts:27 confirming the call is on a real trigger path",
];

function baseDirective(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "d-repair-1",
    type: "integration-completeness",
    priority: 1,
    severity: "blocking" as const,
    status: "open" as const,
    reason: "the repair path is defined but its runtime wiring is unproven",
    action: "trace repairCallRecord from a real trigger and prove the integration test is fresh",
    targets: ["handler.ts", "repair.ts"],
    required_evidence: OPEN_REQUIRED_EVIDENCE,
    completion_criteria: OPEN_COMPLETION_CRITERIA,
    stop_conditions: [],
    issued_at: "2026-07-20T00:00:00Z",
    ...over,
  };
}

function baseComposite(over: Partial<Record<string, unknown>> = {}) {
  return {
    gate: "CLEAR" as const,
    reason: "strong evidence on a real runtime path closes the open directive",
    blocking_directive_ids: [] as string[],
    non_blocking_risks: [] as string[],
    human_escalation: null,
    confidence: 0.9,
    directives: [] as unknown[],
    findings: [] as unknown[],
    ...over,
  };
}

describe("directive emission guard (the schema is the backstop)", () => {
  it("REJECTS a directive with empty required_evidence — the guard the bug tripped", () => {
    const r = Directive.safeParse(baseDirective({ status: "satisfied", required_evidence: [] }));
    expect(r.success).toBe(false);
  });

  it("REJECTS a directive with empty completion_criteria", () => {
    const r = Directive.safeParse(baseDirective({ status: "satisfied", completion_criteria: [] }));
    expect(r.success).toBe(false);
  });

  it("REJECTS a satisfied directive with BOTH arrays blanked (the exact bug shape)", () => {
    const r = Directive.safeParse(
      baseDirective({ status: "satisfied", required_evidence: [], completion_criteria: [] }),
    );
    expect(r.success).toBe(false);
  });
});

describe("the two valid CLEAR shapes both pass", () => {
  it("shape (a): satisfied directive carried with its ORIGINAL arrays preserved", () => {
    const satisfied = baseDirective({
      status: "satisfied",
      // preserved verbatim from the open directive — never emptied
      required_evidence: OPEN_REQUIRED_EVIDENCE,
      completion_criteria: OPEN_COMPLETION_CRITERIA,
    });
    expect(Directive.safeParse(satisfied).success).toBe(true);
    const composite = JudgeComposite.safeParse(baseComposite({ directives: [satisfied] }));
    expect(composite.success).toBe(true);
  });

  it("shape (b): satisfied directive OMITTED — composite carries directives: []", () => {
    const composite = JudgeComposite.safeParse(baseComposite({ directives: [] }));
    expect(composite.success).toBe(true);
  });

  it("the bug shape is rejected AT THE COMPOSITE too (present-but-invalid directive)", () => {
    const blanked = baseDirective({
      status: "satisfied",
      required_evidence: [],
      completion_criteria: [],
    });
    const composite = JudgeComposite.safeParse(baseComposite({ directives: [blanked] }));
    expect(composite.success).toBe(false);
  });
});

describe("a finding must carry its evidence (guidance-backed)", () => {
  it("the judge prompt requires >=1 evidence per emitted finding, else omit it", () => {
    const yaml = readFileSync(
      join(process.cwd(), "builtin/workflows/edge-walk/action.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/at least one item in its `evidence`/);
    expect(yaml).toMatch(/omit it rather than emit an\s*\n?\s*evidence-less finding/);
  });
});

describe("the founder-directed guidance is present in both surfaces", () => {
  it("adjudication skill states the two-shapes / never-blank rule", () => {
    const skill = readFileSync(
      join(process.cwd(), "builtin/skills/adjudication/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/A satisfied directive keeps its terms/);
    expect(skill).toMatch(/exactly two honest ways to record it, and no third/);
    expect(skill).toMatch(/preserved verbatim, never emptied/);
  });

  it("judge prompt states the two-shapes rule and forbids the empty-array third shape", () => {
    const yaml = readFileSync(
      join(process.cwd(), "builtin/workflows/edge-walk/action.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/ONE\s*\n?\s*of exactly two shapes/);
    expect(yaml).toMatch(/PRESERVED VERBATIM/);
    expect(yaml).toMatch(/OMIT it from `directives` entirely/);
    expect(yaml).toMatch(/NEVER a\s*\n?\s*third shape/);
  });
});
