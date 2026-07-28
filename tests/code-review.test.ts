import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { parseSpecFile } from "../src/compiler/parse.ts";
import { buildShape, loadShape, lintErrors, shapeSummary, compile } from "../src/compiler/index.ts";
import type { Shape } from "../src/compiler/index.ts";
import type { WorkflowSpec } from "../src/compiler/spec.ts";

// Model-free integration coverage for the code-review shape and schema.

const WF = join(process.cwd(), "builtin/workflows/code-review/action.yaml");

describe("code-review — shape + frozen finding schema", () => {
  let shape: Shape;
  beforeAll(async () => {
    shape = (await loadShape(WF, process.cwd()))._unsafeUnwrap();
  });

  it("resolves cleanly: a command diff-collector then an agent reviewer", () => {
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.steps.map((s) => s.name)).toEqual(["collect_diff", "review"]);
    expect(shape.steps[0]!.type).toBe("command");
    expect(shape.steps[1]!.type).toBe("agent");
    // the reviewer depends on the collected diff, and gets the shared read-only
    // tools list (READ_ONLY_WORKSPACE_TOOLS) so it can read surrounding context
    // without shell. An absent tools list grants zero workspace tools.
    expect(shape.steps[1]!.depends).toEqual(["collect_diff"]);
    expect(shape.steps[1]!.tools).toEqual([
      "view",
      "search_content",
      "find_files",
      "mastra_workspace_file_stat",
    ]);
    // the range arg has a sane default so a bare `run code-review` is valid.
    expect(shape.args.map((a) => ({ name: a.name, required: a.required, default: a.default }))).toEqual([
      { name: "range", required: false, default: "HEAD" },
    ]);
  });

  it("the .ts schema reference resolves to the honest outputFields (summary + findings)", () => {
    const review = shape.steps[1]!;
    expect(review.outputFields).toEqual(["summary", "findings"]);
    // --shape carries the same resolved fields (model-free projection).
    expect(shapeSummary(shape).steps[1]!.output).toEqual(["summary", "findings"]);
  });

  it("freezes the finding contract: {file, line, severity∈low|medium|high, category, summary}", () => {
    const out = shape.steps[1]!.output;
    // a full, valid finding set parses;
    expect(
      out.safeParse({
        summary: "1 file changed; 1 correctness issue",
        findings: [
          { file: "src/cli.ts", line: 42, severity: "high", category: "correctness", summary: "off-by-one" },
        ],
      }).success,
    ).toBe(true);
    // an empty findings list with an honest note is legal (the empty-diff path);
    expect(out.safeParse({ summary: "nothing to review", findings: [] }).success).toBe(true);
    // the severity enum is frozen — an out-of-set value is rejected (gate guard);
    expect(
      out.safeParse({
        summary: "x",
        findings: [{ file: "a.ts", line: 1, severity: "critical", category: "correctness", summary: "y" }],
      }).success,
    ).toBe(false);
    // a non-numeric line is rejected;
    expect(
      out.safeParse({
        summary: "x",
        findings: [{ file: "a.ts", line: "1", severity: "high", category: "correctness", summary: "y" }],
      }).success,
    ).toBe(false);
    // a finding missing a required contract field (category) is rejected;
    expect(
      out.safeParse({ summary: "x", findings: [{ file: "a.ts", line: 1, severity: "high", summary: "y" }] })
        .success,
    ).toBe(false);
    // and the top-level must carry a summary (the empty-diff note has a home).
    expect(
      out.safeParse({ findings: [{ file: "a.ts", line: 1, severity: "high", category: "c", summary: "y" }] })
        .success,
    ).toBe(false);
  });

  it("compiles to a committed workflow (schema drives the reviewer's structured output)", async () => {
    const c = await compile(shape, { thread: "cr", resource: "cli" });
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    expect(workflow.serializedStepGraph.length).toBe(2);
    // only the agent step gets a fresh Agent; the command step needs none.
    expect(Object.keys(agents)).toEqual(["code-review.review"]);
  });
});

// The diff-collector is the security-critical, model-free part of this workflow,
// so it gets a real keyless run — using the EXACT command string from the shipped
// action.yaml (no duplication), wrapped as a one-step command workflow.
describe("code-review — the diff collector is injection-safe and honest on empty", () => {
  let collectSpec: WorkflowSpec;
  beforeAll(() => {
    const full = parseSpecFile(WF)._unsafeUnwrap();
    // isolate collect_diff into its own single-step workflow, verbatim.
    collectSpec = { name: "collect-only", args: full.args, steps: [full.steps[0]!] } as WorkflowSpec;
  });

  async function runRange(range: string) {
    const shape = await buildShape(collectSpec);
    const c = (await compile(shape, { thread: "c", resource: "cli" }))._unsafeUnwrap();
    const m = new Mastra({
      workflows: { [shape.name]: c.workflow },
      storage: new LibSQLStore({ id: "cr-test", url: ":memory:" }),
    });
    const run = await m.getWorkflowById(shape.name).createRun();
    return (await run.start({ inputData: { range } })) as {
      status: string;
      steps: Record<string, { status: string; output?: { stdout: string; stderr: string; exitCode: number } }>;
    };
  }

  it("an empty range (HEAD..HEAD) succeeds with empty stdout — honest, no fabrication", async () => {
    const r = await runRange("HEAD..HEAD");
    expect(r.status).toBe("success");
    expect(r.steps.collect_diff!.output!.stdout).toBe("");
    expect(r.steps.collect_diff!.output!.exitCode).toBe(0);
  });

  it("a shell-injection range fails at git (tokens reach git as revs, never the shell)", async () => {
    // If the shell parsed this, `git diff HEAD` would succeed and `echo pwned`
    // would run separately → the workflow would SUCCEED. It fails instead, which
    // proves "HEAD;", "echo", "pwned" all went to git as literal revisions.
    const r = await runRange("HEAD; echo pwned");
    expect(r.status).toBe("failed");
  });

  it("an option-injection range (leading dash) is refused by the guard", async () => {
    // --output=… would make git WRITE a file; the guard rejects any dash token
    // (a real revision never starts with "-") before git ever runs.
    const r = await runRange("--output=/tmp/navi-pwned");
    expect(r.status).toBe("failed");
  });
});
