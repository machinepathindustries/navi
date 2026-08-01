import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compile, lintErrors, loadShape } from "../src/compiler/index.ts";
import { createWorkspace } from "../src/mastra/index.ts";

const ACTION = "builtin/workflows/brainstorm/action.yaml";
const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");

const completeArc = {
  gate: "COMPLETE",
  reason: "The alternatives have been expanded, challenged, and hardened.",
  blocking_directive_ids: [],
  non_blocking_risks: [],
  human_escalation: null,
  confidence: 0.88,
  arc: {
    framing: "Find the smallest experiment that tests one observable behavior.",
    candidates: [
      {
        id: "minimal-loop",
        origin: "caller",
        proposal: "Build one conversational transition.",
        distinct_bet: "Prove the real runtime path immediately.",
        strongest_case: "It proves the runtime behavior with minimal surface area.",
        strongest_objection: "A single transition may miss realistic conversation state.",
        disconfirming_signal: "The native runtime cannot expose the transition to an eval.",
        assumptions: ["The framework exposes a transition primitive."],
        evidence: [],
      },
      {
        id: "scripted-probe",
        origin: "generated",
        proposal: "Probe the transition without live audio first.",
        distinct_bet: "Isolate flow behavior from transport and provider latency.",
        strongest_case: "It produces fast deterministic evidence.",
        strongest_objection: "It does not prove the complete voice transport.",
        disconfirming_signal: "The probe bypasses the native flow runtime.",
        assumptions: ["The framework provides an eval harness."],
        evidence: [],
      },
    ],
    challenges: [
      {
        candidate_ids: ["minimal-loop", "scripted-probe"],
        seam: "unit-only proof",
        pressure: "A helper-only test could pass without exercising the runtime transition.",
        hardening: "Require the eval to enter through the framework's real flow boundary.",
        residual_unknown: "The exact generated eval command is not known yet.",
      },
    ],
    deliberation: [
      {
        candidate_id: "minimal-loop",
        disposition: "merge",
        reason: "It owns the real runtime behavior.",
        reconsider_if: null,
      },
      {
        candidate_id: "scripted-probe",
        disposition: "merge",
        reason: "It supplies the smallest behavioral proof.",
        reconsider_if: "The eval bypasses the runtime flow boundary.",
      },
    ],
    convergence: {
      source_candidate_ids: ["minimal-loop", "scripted-probe"],
      synthesis: "Build one runtime transition and prove it through the native eval boundary.",
      why_it_wins: "It combines integrated behavior with a bounded deterministic proof.",
    },
    hardened: {
      title: "One observable conversational transition",
      brief: "Prove one transition through the framework's native runtime and eval boundary.",
      actor: "A local experiment caller",
      desired_change: "Observe a conversation move from an initial node to an end node.",
      smallest_wedge: "One initial node, one transition function, one end node, and one eval.",
      assumptions: ["Provider choice can remain outside the flow logic."],
      constraints: ["Use the framework's current built-in flow API."],
      non_goals: ["No production deployment", "No multi-agent topology"],
      kill_conditions: ["Stop if the framework cannot evaluate a transition without production deployment."],
      settled: ["The eval must drive the native runtime boundary."],
      reopen_if: ["The generated scaffold cannot run its untouched starter eval."],
      controller_next_action: {
        instruction: "Confirm providers, scaffold the smallest native flow, and run its eval.",
        carry_forward: ["The chosen providers", "The one-transition acceptance criterion"],
      },
    },
    grounding_points: [],
  },
  directives: [],
};

const blockingDirective = {
  id: "need-independent-idea",
  type: "investigation",
  priority: 1,
  severity: "blocking",
  status: "open",
  reason: "The caller's unique upstream context determines the real alternative.",
  action: "Produce one independent candidate from the upstream product constraint.",
  targets: [],
  required_evidence: ["One independent candidate and the constraint that motivates it."],
  completion_criteria: ["The returned candidate is meaningfully distinct."],
  stop_conditions: [],
  issued_at: "2026-07-30T00:00:00.000Z",
};

function demandingResult(gate: "DIRECT" | "REPAIR" | "BLOCKED") {
  return {
    ...completeArc,
    gate,
    blocking_directive_ids: [blockingDirective.id],
    arc: {
      ...completeArc.arc,
      convergence: null,
      hardened: null,
    },
    directives: [blockingDirective],
  };
}

function escalationResult(human_escalation: string | null) {
  return {
    ...completeArc,
    gate: "ESCALATE",
    human_escalation,
    arc: {
      ...completeArc.arc,
      convergence: null,
      hardened: null,
    },
  };
}

describe("brainstorm — one atomic caller deliberation", () => {
  it("is one repository-aware Agent with JSON input and no Founder persona", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.args.map(({ name, type, required }) => ({ name, type, required }))).toEqual([
      { name: "input", type: "json", required: true },
    ]);
    expect(shape.args[0]!.schemaRef).toBe("input.schema.ts");
    expect(shape.args[0]!.inputSchema).toBeDefined();
    expect(shape.steps).toHaveLength(1);
    expect(shape.steps[0]).toMatchObject({
      name: "arc",
      type: "agent",
      tools: ["view", "search_content", "find_files", "mastra_workspace_file_stat"],
      skills: ["code-search", "seam-taxonomy"],
      maxSteps: 20,
    });
    expect(shape.steps[0]!.outputFields).toEqual([
      "gate",
      "reason",
      "blocking_directive_ids",
      "non_blocking_risks",
      "human_escalation",
      "confidence",
      "arc",
      "directives",
    ]);

    const compiled = await compile(
      shape,
      { thread: "brainstorm", resource: "cli" },
      createWorkspace(process.cwd()),
    );
    expect(compiled.isOk()).toBe(true);
    expect(Object.keys(compiled._unsafeUnwrap().agents)).toEqual(["brainstorm.arc"]);
  });

  it("documents the caller event and exact continuation payload semantics", () => {
    const yaml = readFileSync(ACTION, "utf8");
    expect(yaml).toMatch(/event\.ideas/);
    expect(yaml).toMatch(/response_to\.directive_id/);
    expect(yaml).toMatch(/response_to\.returns/);
    expect(yaml).toMatch(/--json --stdin -t <session>/);
    expect(yaml).toMatch(/context = known facts\/evidence/);
    expect(yaml).toMatch(/constraints = non-negotiable boundaries/);
    expect(yaml).toMatch(/arc\.hardened\.controller_next_action/);
    expect(yaml).toMatch(/COMPLETE closes the session/);
    expect(yaml).toMatch(/Prefer COMPLETE with assumptions labeled/);
    expect(yaml).toMatch(/could change the winning candidate/);
    expect(yaml).toMatch(/must not recommend another\s+Navi review of the same unchanged premise/);
    expect(yaml).toMatch(/do not turn phases or milestones into\s+review checkpoints/);
  });

  it("accepts valid initial and continuation events at the compiled input boundary", async () => {
    const shape = (await loadShape(ACTION, ROOT))._unsafeUnwrap();
    const schema = shape.args[0]!.inputSchema!;
    expect(
      schema.safeParse({
        event: {
          task: "Find the smallest useful voice-agent experiment",
          ideas: ["Drive one education qualification flow", { alternative: "text-first self-play" }],
          context: [],
          constraints: ["No production lead submission"],
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        event: {
          task: "Find the smallest useful voice-agent experiment",
          ideas: ["Drive one education qualification flow"],
          response_to: {
            directive_id: "need-runtime-boundary",
            returns: [
              {
                requirement: "Name the native runtime boundary",
                value: { boundary: "Pipecat flow transition" },
              },
            ],
          },
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        event: {
          task: "Reject a content-free candidate before spending a model call",
          ideas: [{}],
        },
      }).success,
    ).toBe(false);
  });

  function rejectedBrainstorm(payload: unknown, extraArgs: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "navi-brainstorm-input-"));
    const env = {
      ...process.env,
      NAVI_DB: `file:${join(dir, "navi.db")}`,
      // A dispatch reaching the model would fail on this sentinel target. Exit 4
      // plus an empty ledger proves the arg contract stopped it first.
      NAVI_MODEL: "invalid/no-model-call",
      DEEPSEEK_API_KEY: "",
      OPENROUTER_API_KEY: "",
    };
    try {
      const run = spawnSync(TSX, [CLI, "run", "brainstorm", "--stdin", "--json", ...extraArgs], {
        cwd: ROOT,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 60_000,
        env,
      });
      const sessions = spawnSync(TSX, [CLI, "session", "list", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env,
      });
      return {
        run: { code: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" },
        sessions: { code: sessions.status, stdout: sessions.stdout ?? "", stderr: sessions.stderr ?? "" },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects a malformed initial event before model dispatch or a session write", () => {
    const { run, sessions } = rejectedBrainstorm({ event: { task: "", ideas: [] } });
    expect(run.code).toBe(4);
    expect(run.stderr).toMatch(/input schema failure/);
    expect(run.stderr).toMatch(/input\.event\.(task|ideas)/);
    expect(run.stdout).toBe("");
    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout)).toEqual([]);
  });

  it("rejects a malformed continuation before resolving its session or dispatching a model", () => {
    const { run, sessions } = rejectedBrainstorm(
      {
        event: {
          task: "Harden the experiment",
          ideas: ["One conversational transition"],
          response_to: { directive_id: "need-boundary", returns: [] },
        },
      },
      ["-t", "session-that-must-not-be-resolved"],
    );
    expect(run.code).toBe(4);
    expect(run.stderr).toMatch(/input schema failure/);
    expect(run.stderr).toMatch(/input\.event\.response_to\.returns/);
    expect(run.stderr).not.toMatch(/no session named/);
    expect(run.stdout).toBe("");
    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout)).toEqual([]);
  });

  it("accepts a bounded completed arc and rejects CLEAR or candidate sprawl", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    expect(output.safeParse(completeArc).success).toBe(true);
    expect(output.safeParse({ ...completeArc, gate: "CLEAR" }).success).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        arc: {
          ...completeArc.arc,
          candidates: Array.from({ length: 6 }, (_, i) => ({
            ...completeArc.arc.candidates[0],
            id: `candidate-${i}`,
          })),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts each demanding gate with exactly one matching open directive", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    for (const gate of ["DIRECT", "REPAIR", "BLOCKED"] as const) {
      expect(output.safeParse(demandingResult(gate)).success).toBe(true);
    }
  });

  it("accepts ESCALATE only with a bounded human decision and no directive", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    expect(
      output.safeParse(
        escalationResult("Choose whether the experiment may change an external contract."),
      ).success,
    ).toBe(true);
    expect(output.safeParse(escalationResult(null)).success).toBe(false);
    expect(output.safeParse(escalationResult("   ")).success).toBe(false);
    expect(
      output.safeParse({
        ...escalationResult("Choose whether the contract may change."),
        directives: [blockingDirective],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...escalationResult("Choose whether the contract may change."),
        blocking_directive_ids: [blockingDirective.id],
      }).success,
    ).toBe(false);
  });

  it("rejects COMPLETE without a finished arc or with demanding-gate fields", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    expect(
      output.safeParse({
        ...completeArc,
        arc: { ...completeArc.arc, convergence: null },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        arc: { ...completeArc.arc, hardened: null },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        directives: [blockingDirective],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        blocking_directive_ids: [blockingDirective.id],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        human_escalation: "Ask a human anyway.",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed demanding-gate directive relationships", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    expect(
      output.safeParse({
        ...demandingResult("DIRECT"),
        blocking_directive_ids: [],
        directives: [],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...demandingResult("DIRECT"),
        blocking_directive_ids: ["another-directive"],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...demandingResult("DIRECT"),
        blocking_directive_ids: ["   "],
        directives: [{ ...blockingDirective, id: "   " }],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...demandingResult("REPAIR"),
        directives: [{ ...blockingDirective, status: "satisfied" }],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...demandingResult("BLOCKED"),
        directives: [{ ...blockingDirective, severity: "non_blocking" }],
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...demandingResult("DIRECT"),
        human_escalation: "Ask a human instead.",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate or dangling candidate references", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const output = shape.steps[0]!.output;
    expect(
      output.safeParse({
        ...completeArc,
        arc: {
          ...completeArc.arc,
          candidates: [
            completeArc.arc.candidates[0],
            { ...completeArc.arc.candidates[1], id: completeArc.arc.candidates[0].id },
          ],
          challenges: [{
            ...completeArc.arc.challenges[0],
            candidate_ids: [completeArc.arc.candidates[0].id],
          }],
          deliberation: completeArc.arc.deliberation.map((entry) => ({
            ...entry,
            candidate_id: completeArc.arc.candidates[0].id,
          })),
          convergence: {
            ...completeArc.arc.convergence,
            source_candidate_ids: [completeArc.arc.candidates[0].id],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        arc: {
          ...completeArc.arc,
          challenges: [{ ...completeArc.arc.challenges[0], candidate_ids: ["missing"] }],
        },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        arc: {
          ...completeArc.arc,
          deliberation: [
            { ...completeArc.arc.deliberation[0], candidate_id: "missing" },
            completeArc.arc.deliberation[1],
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...completeArc,
        arc: {
          ...completeArc.arc,
          convergence: {
            ...completeArc.arc.convergence,
            source_candidate_ids: ["missing"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps demanding-gate next actions in directives instead of the arc", async () => {
    const shape = (await loadShape(ACTION, process.cwd()))._unsafeUnwrap();
    const arcShape = shape.steps[0]!.output.shape.arc;
    expect(Object.keys(arcShape.shape)).not.toContain("readiness");
    expect(Object.keys(arcShape.shape)).not.toContain("caller_next");
    expect(Object.keys(arcShape.shape.hardened.unwrap().shape)).toContain(
      "controller_next_action",
    );
  });

  it("states the duplicate-owner escalation boundary without loading Founder", () => {
    const yaml = readFileSync(ACTION, "utf8");
    expect(yaml).toMatch(/Never recommend making a second owner live/);
    expect(yaml).toMatch(/ESCALATE.*explicit human authorization/);
  });
});
