import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { loadShape, lintErrors, shapeSummary, compile } from "../src/compiler/index.ts";
import type { Shape } from "../src/compiler/index.ts";
import { createWorkspace } from "../src/mastra/index.ts";
import { GateDecision, SurfaceMap, Directive } from "../src/contracts/whisper.ts";

// Model-free integration coverage for edge-walk's resolved shape, co-located
// schemas, and the GateDecision shape that activates the CLI gate path.

const WF = join(process.cwd(), "builtin/workflows/edge-walk/action.yaml");

describe("edge-walk — resolved shape (read-only 3-step adversarial walk)", () => {
  let shape: Shape;
  beforeAll(async () => {
    shape = (await loadShape(WF, process.cwd()))._unsafeUnwrap();
  });

  it("resolves cleanly to recon → expand → judge, all agent steps", () => {
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.steps.map((s) => s.name)).toEqual(["recon", "expand", "judge"]);
    expect(shape.steps.every((s) => s.type === "agent")).toBe(true);
  });

  it("is structurally read-only: every step's tools are the read-only workspace triad", () => {
    const [recon, expand, judge] = shape.steps;
    expect(recon!.tools).toEqual(["search_content", "view", "find_files"]);
    expect(expand!.tools).toEqual(["search_content", "view"]);
    expect(judge!.tools).toEqual(["view", "search_content"]);
    // no write/exec tool name appears in any allowlist.
    const writeish = ["execute_command", "write", "edit", "apply_patch"];
    for (const s of shape.steps)
      expect(s.tools.some((t) => writeish.includes(t))).toBe(false);
  });

  it("force-pops the adversarial pack skills per step", () => {
    const [recon, expand, judge] = shape.steps;
    expect(recon!.skills).toEqual(["code-search", "repository-recon"]);
    expect(expand!.skills).toEqual(["seam-taxonomy"]);
    expect(judge!.skills).toEqual(["adjudication"]);
  });

  it("carries the locked continuation-skip condition on recon+expand, never on judge", () => {
    const skip =
      "prior == null || prior.surface_map == null || prior_workflow != 'edge-walk' || prior.surface_map.revision_hash != revision";
    expect(shape.steps[0]!.condition?.source).toBe(skip);
    expect(shape.steps[1]!.condition?.source).toBe(skip);
    // the judge ALWAYS runs — no condition — so a continuation-skip still adjudicates.
    expect(shape.steps[2]!.condition).toBeUndefined();
  });

  it("wires a linear depends chain and generous-first per-step budgets", () => {
    expect(shape.steps[0]!.depends).toEqual([]);
    expect(shape.steps[1]!.depends).toEqual(["recon"]);
    expect(shape.steps[2]!.depends).toEqual(["expand"]);
    expect(shape.steps.map((s) => s.maxSteps)).toEqual([18, 14, 16]);
  });

  it("gives the judge an env-var model override and no literal model (NAVI_JUDGE_MODEL ?? default)", () => {
    const judge = shapeSummary(shape).steps[2]!;
    expect(judge.modelEnv).toBe("NAVI_JUDGE_MODEL");
    // recon/expand declare no modelEnv (they run on the default model).
    expect(shapeSummary(shape).steps[0]!.modelEnv).toBeNull();
    expect(shapeSummary(shape).steps[1]!.modelEnv).toBeNull();
    // with NAVI_JUDGE_MODEL unset in this test env, the judge resolves to the default.
    expect(judge.model).toBe(shape.defaultModel);
  });

  it("displays the static initial obligation policy line", () => {
    expect(shape.description?.endsWith("initial obligation policy: integration-completeness.")).toBe(true);
  });

  it("declares a single json-typed required `input` arg", () => {
    // The whole stdin object binds to `input`. The `json` type
    // token makes the compiler validate it as z.unknown() so Mastra's input
    // validation accepts the object instead of rejecting it as a
    // non-string; revision/prior/prior_workflow still ride through
    // argsSchema's passthrough.
    expect(shape.args).toHaveLength(1);
    expect(shape.args[0]).toMatchObject({ name: "input", type: "json", required: true });
  });
});

describe("edge-walk — the three co-located schema refs resolve to honest shapes", () => {
  let shape: Shape;
  beforeAll(async () => {
    shape = (await loadShape(WF, process.cwd()))._unsafeUnwrap();
  });

  it("recon outputs flat wiring facts (scalars, string arrays, arrays of flat records)", () => {
    expect(shape.steps[0]!.outputFields).toEqual([
      "subject",
      "entry_points",
      "callers",
      "claimed_locations",
      "claimed_on_traced_path",
      "bypasses",
      "not_found",
    ]);
  });

  it("expand outputs the canonical SurfaceMap (re-exported, single source of truth)", () => {
    const out = shape.steps[1]!.output;
    expect(shape.steps[1]!.outputFields).toEqual(["surfaces", "seams", "unknowns", "revision_hash"]);
    // a valid SurfaceMap parses through the step's resolved schema, and vice versa.
    const sm = { surfaces: ["handler.ts:21"], seams: ["orphaned: x"], unknowns: [], revision_hash: "abc" };
    expect(out.safeParse(sm).success).toBe(true);
    expect(SurfaceMap.safeParse(sm).success).toBe(true);
    // seams are string entries — an object entry is rejected (the flash-model trap).
    expect(out.safeParse({ ...sm, seams: [{ kind: "x", cue: "y" }] }).success).toBe(false);
  });

  it("the judge composite is a GateDecision extended with directives/findings/surface_map", () => {
    expect(shape.steps[2]!.outputFields).toEqual([
      "gate",
      "reason",
      "blocking_directive_ids",
      "non_blocking_risks",
      "human_escalation",
      "confidence",
      "directives",
      "findings",
      "surface_map",
    ]);
  });

  it("GateDecision.safeParse succeeds on a valid judge output — the CLI whisper-path shape key", () => {
    const out = shape.steps[2]!.output;
    const directive = {
      id: "d-x-1",
      type: "trace-runtime-path",
      priority: 1,
      severity: "blocking" as const,
      status: "open" as const,
      reason: "orphaned",
      action: "trace it",
      targets: ["handler.ts"],
      required_evidence: ["a call path"],
      completion_criteria: ["a live call site"],
      stop_conditions: ["no trigger"],
      issued_at: "2026-07-19T00:00:00.000Z",
    };
    const composite = {
      gate: "DIRECT" as const,
      reason: "the seam is unproven",
      blocking_directive_ids: ["d-x-1"],
      non_blocking_risks: [],
      human_escalation: null,
      confidence: 0.6,
      directives: [directive],
      findings: [],
    };
    // the composite is judge-valid, its directives are Directive-valid, AND a plain
    // GateDecision.safeParse (extras stripped) succeeds — the exact check runGatePath
    // uses to activate the gate-derived exit/next/SessionState path.
    expect(out.safeParse(composite).success).toBe(true);
    expect(Directive.safeParse(directive).success).toBe(true);
    expect(GateDecision.safeParse(composite).success).toBe(true);
  });
});

describe("edge-walk — compiles to a committed workflow (skills.only pop resolves)", () => {
  it("builds three fresh agents, one per step, with the pack skills present", async () => {
    const shape = (await loadShape(WF, process.cwd()))._unsafeUnwrap();
    // the real workspace roots skill discovery at the repo, where the four popped
    // pack skills live — so this also pins that code-search/repository-recon/
    // seam-taxonomy/adjudication all resolve by name.
    const c = await compile(shape, { thread: "ew-test", resource: "cli" }, createWorkspace(process.cwd()));
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    expect(workflow.serializedStepGraph.length).toBe(3);
    expect(Object.keys(agents).sort()).toEqual([
      "edge-walk.expand",
      "edge-walk.judge",
      "edge-walk.recon",
    ]);
  });
});
