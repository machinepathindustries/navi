import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { parseSpecFile } from "../src/compiler/parse.ts";
import { buildShape, loadShape, lintErrors, shapeSummary, compile } from "../src/compiler/index.ts";
import type { Shape } from "../src/compiler/index.ts";
import type { WorkflowSpec } from "../src/compiler/spec.ts";

// Model-free integration coverage for the pre-pr-review shape, schema, and
// security-sensitive diff collector.

const WF = join(process.cwd(), "builtin/workflows/pre-pr-review/action.yaml");

describe("pre-pr-review — shape + frozen readiness schema", () => {
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
    // the base arg has a sane default so a bare `run pre-pr-review` reviews vs main.
    expect(shape.args.map((a) => ({ name: a.name, required: a.required, default: a.default }))).toEqual([
      { name: "base", required: false, default: "main" },
    ]);
  });

  it("the .ts schema reference resolves to the honest outputFields", () => {
    const review = shape.steps[1]!;
    expect(review.outputFields).toEqual(["summary", "readiness", "coverage", "findings"]);
    // --shape carries the same resolved fields (model-free projection).
    expect(shapeSummary(shape).steps[1]!.output).toEqual(["summary", "readiness", "coverage", "findings"]);
  });

  it("freezes the readiness contract: readiness∈ready|not_ready + code-review-compatible findings", () => {
    const out = shape.steps[1]!.output;
    // a full, valid readiness verdict with a finding parses;
    expect(
      out.safeParse({
        summary: "Not ready — fix 1 high-severity finding before the PR",
        readiness: "not_ready",
        coverage: "Complete: all 3 files reviewed in full.",
        findings: [
          { file: "src/cli.ts", line: 42, severity: "high", category: "correctness", summary: "off-by-one" },
        ],
      }).success,
    ).toBe(true);
    // a clean/ready branch with an empty findings list is legal;
    expect(
      out.safeParse({
        summary: "Ready to open the PR",
        readiness: "ready",
        coverage: "Complete: all 12 files reviewed in full.",
        findings: [],
      }).success,
    ).toBe(true);
    // readiness is a frozen binary enum — an out-of-set value is rejected;
    expect(
      out.safeParse({ summary: "x", readiness: "maybe", coverage: "y", findings: [] }).success,
    ).toBe(false);
    // the finding severity enum is frozen (same vocabulary as code-review);
    expect(
      out.safeParse({
        summary: "x",
        readiness: "not_ready",
        coverage: "y",
        findings: [{ file: "a.ts", line: 1, severity: "critical", category: "correctness", summary: "z" }],
      }).success,
    ).toBe(false);
    // a finding missing a required contract field (category) is rejected;
    expect(
      out.safeParse({
        summary: "x",
        readiness: "ready",
        coverage: "y",
        findings: [{ file: "a.ts", line: 1, severity: "high", summary: "z" }],
      }).success,
    ).toBe(false);
    // and every top-level field is required (readiness/coverage have a home).
    expect(out.safeParse({ summary: "x", findings: [] }).success).toBe(false);
  });

  it("shares one finding schema with code-review", async () => {
    const crWF = join(process.cwd(), "builtin/workflows/code-review/action.yaml");
    const cr = (await loadShape(crWF, process.cwd()))._unsafeUnwrap();
    const finding = {
      file: "src/x.ts",
      line: 7,
      severity: "medium" as const,
      category: "simplification",
      summary: "same finding shape across both review workflows",
    };
    // a finding valid for code-review is valid for pre-pr-review and vice versa,
    // so a caller consumes both workflows' findings uniformly.
    const crOut = cr.steps[1]!.output;
    const ppOut = shape.steps[1]!.output;
    expect(crOut.safeParse({ summary: "s", findings: [finding] }).success).toBe(true);
    expect(
      ppOut.safeParse({ summary: "s", readiness: "ready", coverage: "c", findings: [finding] }).success,
    ).toBe(true);
  });

  it("compiles to a committed workflow (schema drives the reviewer's structured output)", async () => {
    const c = await compile(shape, { thread: "ppr", resource: "cli" });
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    expect(workflow.serializedStepGraph.length).toBe(2);
    // only the agent step gets a fresh Agent; the command step needs none.
    expect(Object.keys(agents)).toEqual(["pre-pr-review.review"]);
  });
});

// The diff collector is the security-critical, model-free part of this workflow,
// so it gets a real keyless run — using the EXACT command string from the shipped
// action.yaml (no duplication), wrapped as a one-step command workflow.
describe("pre-pr-review — the diff collector is injection-safe, bounded, and honest", () => {
  let collectSpec: WorkflowSpec;
  beforeAll(() => {
    const full = parseSpecFile(WF)._unsafeUnwrap();
    // isolate collect_diff into its own single-step workflow, verbatim.
    collectSpec = { name: "collect-only", args: full.args, steps: [full.steps[0]!] } as WorkflowSpec;
  });

  async function runBase(base: string) {
    const shape = await buildShape(collectSpec);
    const c = (await compile(shape, { thread: "c", resource: "cli" }))._unsafeUnwrap();
    const m = new Mastra({
      workflows: { [shape.name]: c.workflow },
      storage: new LibSQLStore({ id: "ppr-test", url: ":memory:" }),
    });
    const run = await m.getWorkflowById(shape.name).createRun();
    return (await run.start({ inputData: { base } })) as {
      status: string;
      steps: Record<string, { status: string; output?: { stdout: string; stderr: string; exitCode: number } }>;
    };
  }

  it("an empty branch diff (base=HEAD) succeeds and reports files_changed:0 honestly", async () => {
    const r = await runBase("HEAD");
    expect(r.status).toBe("success");
    const out = r.steps.collect_diff!.output!;
    expect(out.exitCode).toBe(0);
    // the machine META header is present and honest about zero changes.
    const meta = JSON.parse(out.stdout.split("\n")[0]!.replace(/^PRE-PR-REVIEW-META /, "")) as {
      files_changed: number;
      bounded: boolean;
    };
    expect(meta.files_changed).toBe(0);
    expect(meta.bounded).toBe(false);
  });

  it("a large branch diff bounds honestly: stat inventory complete, diff capped, gap named", async () => {
    // Build a scratch repository with a synthetic diff larger than the budget so
    // the bounding path is deterministic and independent of this checkout's
    // current branch. collect_diff runs git in process.cwd(), so the test changes
    // into the scratch repository for this run and restores cwd in `finally`.
    const dir = mkdtempSync(join(tmpdir(), "navi-ppr-largediff-"));
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    const prevCwd = process.cwd();
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      // base commit: one small file, on a named ref the collector will diff against.
      writeFileSync(join(dir, "README.md"), "base\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "base"]);
      git(["branch", "diff-base"]);
      // HEAD: many sizable files so the unified diff exceeds the 200KB budget →
      // some files land STAT-ONLY (bounded=true) while every file stays in the
      // complete `--stat` inventory. 60 files × ~5KB ≈ 300KB > 200KB budget.
      mkdirSync(join(dir, "src"));
      const body = Array.from({ length: 140 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
      for (let i = 0; i < 60; i++) writeFileSync(join(dir, "src", `f${i}.ts`), `${body}\n`);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "large change"]);

      process.chdir(dir);
      const r = await runBase("diff-base");
      process.chdir(prevCwd);

      expect(r.status).toBe("success");
      const out = r.steps.collect_diff!.output!;
      const meta = JSON.parse(out.stdout.split("\n")[0]!.replace(/^PRE-PR-REVIEW-META /, "")) as {
        files_changed: number;
        bounded: boolean;
        files_reviewed_in_full: number;
        files_stat_only: string[];
      };
      // the synthetic diff is large, so the bounded path triggers deterministically:
      expect(meta.files_changed).toBe(60);
      expect(meta.bounded).toBe(true);
      // the honest arithmetic holds — full + stat-only = total, and the gap is named.
      expect(meta.files_reviewed_in_full + meta.files_stat_only.length).toBe(meta.files_changed);
      expect(meta.files_stat_only.length).toBeGreaterThan(0);
      // the complete stat inventory is always present, even when the diff is bounded.
      expect(out.stdout).toContain("FILE INVENTORY");
      expect(out.stdout).toContain("BOUNDED to");
    } finally {
      if (process.cwd() !== prevCwd) process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a base starting with a dash is refused by the guard (arg-smuggled git flag)", async () => {
    // --output=… would make git WRITE a file; the guard rejects a dash-leading
    // base (a real ref never starts with "-") before git ever runs.
    const r = await runBase("--output=/tmp/navi-ppr-pwned");
    expect(r.status).toBe("failed");
  });

  it("a whitespace-bearing base fails closed", async () => {
    const r = await runBase("main --output=/tmp/x");
    expect(r.status).toBe("failed");
  });

  it("a shell-injection base is inert: the token reaches git literally, never the shell", async () => {
    // If the shell parsed this, `touch` would run separately. It fails at git
    // instead (the token is one literal, unknown revision), proving no shell exec.
    const r = await runBase("main$(touch /tmp/navi-ppr-pwned)");
    expect(r.status).toBe("failed");
  });

  it("a bad/unknown base fails the step (honest, no silent success)", async () => {
    const r = await runBase("no-such-ref-xyz-navi");
    expect(r.status).toBe("failed");
  });
});
