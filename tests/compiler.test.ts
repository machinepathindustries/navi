import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { Mastra } from "@mastra/core";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";
import { parseSpecFile, parseSpecText } from "../src/compiler/parse.ts";
import { buildShape, lintErrors, shapeSummary, compile, loadShape, resolveWorkflowPath } from "../src/compiler/index.ts";
import {
  requireStructuredObject,
  resolveStructuredObject,
  agentStreamToolOptions,
  structuredOutputOptions,
} from "../src/compiler/compile.ts";
import { createWorkspace } from "../src/mastra/index.ts";
import { resolveSettings, toMastraOptions } from "../src/mastra/model-settings.ts";
import {
  READ_ONLY_WORKSPACE_TOOLS,
  WORKSPACE_TOOL_NAMES,
} from "../src/mastra/workspace-tools.ts";
import { DEEP_SEARCH_TOOL_NAMES } from "../src/search/tools.ts";
import { parseVerdict } from "../builtin/workflows/founder/parse-verdict.mjs";
import { parseSharpen } from "../builtin/workflows/sharpen/parse-sharpen.mjs";

const FIXTURE = join(process.cwd(), "tests/fixtures/hello-two-step/action.yaml");

// buildShape is async: a `.ts`-file `output:` reference is resolved by dynamic
// import at plan time (model-free). Spec-string fixtures carry no such reference,
// so `await` here is trivial — it only bites when a step points at a real file.
async function shapeFrom(yaml: string) {
  return buildShape(parseSpecText(yaml)._unsafeUnwrap());
}

describe("compiler — the fixture's real topology", () => {
  let shape: Awaited<ReturnType<typeof buildShape>>;
  beforeAll(async () => {
    shape = await buildShape(parseSpecFile(FIXTURE)._unsafeUnwrap());
  });

  it("resolves the two-step chain with defaults and schemas", () => {
    expect(shape.steps.map((s) => s.name)).toEqual(["extract", "summarize"]);
    expect(shape.steps.every((s) => s.type === "agent")).toBe(true);
    // The default gives every step a 50-step budget.
    expect(shape.steps.map((s) => s.maxSteps)).toEqual([50, 50]);
    // linear depends is resolved, not invented.
    expect(shape.steps[1]!.depends).toEqual(["extract"]);
    // declared output schemas become real Zod objects.
    expect(shape.steps[0]!.output.safeParse({ description: "d", keywords: ["k"] }).success).toBe(true);
    expect(shape.steps[0]!.output.safeParse({ description: "d" }).success).toBe(false);
    expect(lintErrors(shape)).toHaveLength(0);
  });

  it("compiles to a committed Mastra workflow with an agent per agent-step", async () => {
    const c = await compile(shape, { thread: "c1", resource: "cli" });
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    // serializedStepGraph introspects the topology WITHOUT executing.
    expect(workflow.serializedStepGraph.length).toBe(2);
    expect(Object.keys(agents).sort()).toEqual(["hello-two-step.extract", "hello-two-step.summarize"]);
    // per-step model resolves from NAVI_MODEL/default (no per-call override exists).
    expect(agents["hello-two-step.extract"]!.id).toBe("hello-two-step.extract");
  });

  it("shapeSummary is a stable JSON-safe projection of the same plan", () => {
    const s = shapeSummary(shape);
    expect(JSON.parse(JSON.stringify(s)).steps.map((x: { name: string }) => x.name)).toEqual([
      "extract",
      "summarize",
    ]);
  });
});

describe("compiler — broken wiring is caught before any model call", () => {
  it("flags an agent step with no prompt and refuses to compile", async () => {
    const shape = await shapeFrom(`
name: bad
steps:
  - name: s
    type: agent
`);
    expect(lintErrors(shape).some((e) => /needs a prompt/.test(e.message))).toBe(true);
    expect((await compile(shape, { thread: "c", resource: "cli" })).isErr()).toBe(true);
  });

  it("flags an unknown / forward dependency", async () => {
    const forward = await shapeFrom(`
name: bad
steps:
  - name: a
    type: agent
    prompt: hi
    depends: b
  - name: b
    type: agent
    prompt: hi
`);
    expect(lintErrors(forward).some((e) => /later step/.test(e.message))).toBe(true);

    const unknown = await shapeFrom(`
name: bad
steps:
  - name: a
    type: agent
    prompt: hi
    depends: ghost
`);
    expect(lintErrors(unknown).some((e) => /unknown step/.test(e.message))).toBe(true);
  });

  it("flags unsupported parallel fan-out", async () => {
    const shape = await shapeFrom(`
name: bad
steps:
  - name: root
    type: agent
    prompt: hi
  - name: a
    type: agent
    prompt: hi
    depends: root
  - name: b
    type: agent
    prompt: hi
    depends: root
`);
    expect(lintErrors(shape).some((e) => /fan-out/.test(e.message))).toBe(true);
  });

  it("rejects an unknown output type token", async () => {
    const shape = await shapeFrom(`
name: bad
steps:
  - name: s
    type: agent
    prompt: hi
    output:
      x: widget
`);
    expect(lintErrors(shape).some((e) => /unknown output type/.test(e.message))).toBe(true);
  });

  it("forbids agent-only fields on a command step", async () => {
    const shape = await shapeFrom(`
name: bad
steps:
  - name: s
    type: command
    command: echo hi
    model: x/y
`);
    expect(lintErrors(shape).some((e) => /command step cannot set model/.test(e.message))).toBe(true);
  });
});

describe("compiler — a co-located .ts Zod schema reference", () => {
  const SR = "tests/fixtures/schema-ref/action.yaml";
  const SR_DIR = join(process.cwd(), "tests/fixtures/schema-ref");

  it("resolves the reference into an object schema whose keys are the honest outputFields", async () => {
    const shape = (await loadShape(SR, process.cwd()))._unsafeUnwrap();
    expect(lintErrors(shape)).toHaveLength(0);
    const review = shape.steps[0]!;
    // outputFields come from the resolved object's shape keys — not Object.keys
    // of the raw string path (which would be character indices).
    expect(review.outputFields).toEqual(["findings", "verdict"]);
    // shapeSummary (the --shape projection) carries the same resolved fields.
    expect(shapeSummary(shape).steps[0]!.output).toEqual(["findings", "verdict"]);
  });

  it("proves z.array(z.object) and z.enum end to end against the compiled schema", async () => {
    const shape = (await loadShape(SR, process.cwd()))._unsafeUnwrap();
    const out = shape.steps[0]!.output;
    // a valid finding array + enum verdict parses;
    expect(
      out.safeParse({
        findings: [{ file: "a.ts", line: 3, severity: "high", summary: "leak" }],
        verdict: "REFINE",
      }).success,
    ).toBe(true);
    // an empty findings array is legal (the schema requires the array, not items);
    expect(out.safeParse({ findings: [], verdict: "GO" }).success).toBe(true);
    // an out-of-enum verdict is rejected;
    expect(out.safeParse({ findings: [], verdict: "MAYBE" }).success).toBe(false);
    // a finding missing a required field is rejected.
    expect(out.safeParse({ findings: [{ file: "a.ts" }], verdict: "GO" }).success).toBe(false);
  });

  it("compiles to a committed workflow (the schema drives the step's structured output)", async () => {
    const shape = (await loadShape(SR, process.cwd()))._unsafeUnwrap();
    const c = await compile(shape, { thread: "c", resource: "cli" });
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    expect(workflow.serializedStepGraph.length).toBe(1);
    expect(Object.keys(agents)).toEqual(["schema-ref.review"]);
  });

  it("a missing schema file is a loud wiring error, not a throw — compile refuses", async () => {
    const shape = await buildShape(
      parseSpecText(`
name: broken
steps:
  - name: s
    type: agent
    prompt: hi
    output: ./does-not-exist.schema.ts
`)._unsafeUnwrap(),
      process.cwd(),
    );
    expect(lintErrors(shape).some((e) => /not found/.test(e.message))).toBe(true);
    expect((await compile(shape, { thread: "c", resource: "cli" })).isErr()).toBe(true);
  });

  it("a schema file with no default export is rejected loudly", async () => {
    const shape = await buildShape(
      parseSpecText(`
name: nodefault
steps:
  - name: s
    type: agent
    prompt: hi
    output: no-default.schema.ts
`)._unsafeUnwrap(),
      SR_DIR,
    );
    expect(lintErrors(shape).some((e) => /no default export/.test(e.message))).toBe(true);
  });

  it("a default export that is not a Zod object is rejected loudly", async () => {
    const shape = await buildShape(
      parseSpecText(`
name: notobject
steps:
  - name: s
    type: agent
    prompt: hi
    output: not-an-object.schema.ts
`)._unsafeUnwrap(),
      SR_DIR,
    );
    expect(lintErrors(shape).some((e) => /not a Zod object schema/.test(e.message))).toBe(true);
  });
});

describe("compiler — a command step runs a real subprocess (no model)", () => {
  async function runCmd(shape: Awaited<ReturnType<typeof shapeFrom>>, inputData: Record<string, unknown> = {}) {
    const c = (await compile(shape, { thread: "c", resource: "cli" }))._unsafeUnwrap();
    const m = new Mastra({
      workflows: { [shape.name]: c.workflow },
      storage: new LibSQLStore({ id: "test", url: ":memory:" }),
    });
    const run = await m.getWorkflowById(shape.name).createRun();
    return (await run.start({ inputData })) as {
      status: string;
      steps: Record<string, { status: string; output?: { stdout: string; exitCode: number } }>;
    };
  }

  it("captures stdout / exitCode from the committed workflow", async () => {
    const result = await runCmd(
      await shapeFrom(`
name: echoer
steps:
  - name: shout
    type: command
    command: echo hello-navi
`),
    );
    expect(result.status).toBe("success");
    const out = result.steps.shout!.output!;
    expect(out.stdout.trim()).toBe("hello-navi");
    expect(out.exitCode).toBe(0);
  });

  it("a nonzero exit code fails the workflow — no silent success", async () => {
    const result = await runCmd(
      await shapeFrom(`
name: boomer
steps:
  - name: boom
    type: command
    command: exit 7
`),
    );
    expect(result.status).toBe("failed");
  });

  // A signal-killed child (Node close event code===null) must be a
  // FAILURE, not coalesced to exit 0. `kill -9 $$` makes the spawned shell terminate
  // by SIGKILL (verified: close → {code:null, signal:"SIGKILL"}); the workflow must fail.
  it("a signal-killed child fails the workflow — code===null is never exit 0", async () => {
    const result = await runCmd(
      await shapeFrom(`
name: signalled
steps:
  - name: killed
    type: command
    command: kill -9 $$
`),
    );
    expect(result.status).toBe("failed");
  });

  it("condition: compiles to native .branch() — false skips the step, the chain continues", async () => {
    const gated = await shapeFrom(`
name: gated
steps:
  - name: root
    type: command
    command: echo root
  - name: gate
    type: command
    depends: root
    condition: "input.go == true"
    command: echo gate-ran
  - name: tail
    type: command
    depends: gate
    command: echo tail
`);
    // condition false → the branch step is skipped entirely, later steps still run.
    const skipped = await runCmd(gated, { go: false });
    expect(skipped.status).toBe("success");
    expect(skipped.steps.gate).toBeUndefined();
    expect(skipped.steps.tail!.status).toBe("success");
    // condition true → the branch step runs and produces its output.
    const ran = await runCmd(gated, { go: true });
    expect(ran.status).toBe("success");
    expect(ran.steps.gate!.output!.stdout.trim()).toBe("gate-ran");
  });
});

// Command spawns inject the absolute action.yaml
// directory so sibling scripts resolve when the user ran `navi` from a foreign cwd.
// cwd itself stays the process/workspace cwd — code-review/pre-pr-review/web-search
// depend on that for `git diff`/curl. Per-step (not INSTALL_ROOT): consumer-tier
// workflows under a different directory get THEIR own dir.
describe("compiler — NAVI_ACTION_DIR on command spawn (action-relative scripts)", () => {
  async function runCmd(shape: Awaited<ReturnType<typeof buildShape>>, inputData: Record<string, unknown> = {}) {
    const c = (await compile(shape, { thread: "c", resource: "cli" }))._unsafeUnwrap();
    const m = new Mastra({
      workflows: { [shape.name]: c.workflow },
      storage: new LibSQLStore({ id: "test-action-dir", url: ":memory:" }),
    });
    const run = await m.getWorkflowById(shape.name).createRun();
    return (await run.start({ inputData })) as {
      status: string;
      steps: Record<string, { status: string; output?: { stdout: string; exitCode: number } }>;
    };
  }

  it("sets NAVI_ACTION_DIR on a command spawn and the value is ABSOLUTE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-action-dir-"));
    try {
      // Relative dir into buildShape — resolveStep must still absolute it before the
      // spawn, or a relative NAVI_ACTION_DIR would just move the MODULE_NOT_FOUND.
      const shape = await buildShape(
        parseSpecText(`
name: env-probe
steps:
  - name: print
    type: command
    command: printf '%s' "$NAVI_ACTION_DIR"
`)._unsafeUnwrap(),
        dir,
      );
      expect(isAbsolute(shape.steps[0]!.actionDir)).toBe(true);
      const result = await runCmd(shape);
      expect(result.status).toBe("success");
      const printed = result.steps.print!.output!.stdout;
      expect(isAbsolute(printed)).toBe(true);
      expect(printed).toBe(shape.steps[0]!.actionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("differs correctly between a builtin and a consumer-tier fixture workflow (per-step)", async () => {
    const builtinPath = join(process.cwd(), "builtin/workflows/founder/action.yaml");
    const consumerPath = join(process.cwd(), "tests/fixtures/echo-command/action.yaml");
    const builtin = (await loadShape(builtinPath, process.cwd()))._unsafeUnwrap();
    const consumer = (await loadShape(consumerPath, process.cwd()))._unsafeUnwrap();
    const bDir = builtin.steps.find((s) => s.type === "command")!.actionDir;
    const cDir = consumer.steps.find((s) => s.type === "command")!.actionDir;
    expect(isAbsolute(bDir)).toBe(true);
    expect(isAbsolute(cDir)).toBe(true);
    expect(bDir).toBe(join(process.cwd(), "builtin/workflows/founder"));
    expect(cDir).toBe(join(process.cwd(), "tests/fixtures/echo-command"));
    expect(bDir).not.toBe(cDir);
  });

  it("a command step that does NOT reference the var keeps workspace cwd (no cwd change)", async () => {
    // code-review/pre-pr-review style: resolve against the USER workspace, not the
    // action dir. pwd must match process.cwd() — if spawn set cwd: actionDir this
    // would fail.
    const shape = await buildShape(
      parseSpecText(`
name: cwd-probe
steps:
  - name: where
    type: command
    command: pwd
`)._unsafeUnwrap(),
      join(process.cwd(), "builtin/workflows/code-review"),
    );
    const result = await runCmd(shape);
    expect(result.status).toBe("success");
    // Compare canonical paths so a symlinked temporary directory and its real
    // location still prove the same thing: the spawn kept the workspace cwd.
    expect(realpathSync(result.steps.where!.output!.stdout.trim()).toLowerCase()).toBe(
      realpathSync(process.cwd()).toLowerCase(),
    );
  });

  it("founder + sharpen parse scripts produce identical output via $NAVI_ACTION_DIR", () => {
    // Match the action.yaml invocation exactly: node "$NAVI_ACTION_DIR/…" with a
    // single-quoted heredoc. The result must equal the parser module's direct output.
    const founderMd = `## Verdict
GO

## Take
The honest-degradation design is right — a missing key returns a Blocked answer, never a fabricated one.

## Grounding points
- The command step branches on key presence and emits a skip sentinel.
- The synthesis step returns a Blocked answer when the JSON is a skip/error.

## Decision rules
- Degrade to an honest Blocked, never invent sources.

## What not to do
- Do not wire a silent fallback that fabricates results.
`;
    // READY (not ASK): ASK stamps issued_at = new Date(), so shell vs direct would
    // disagree on the clock; READY has no directives and is fully deterministic.
    const sharpenMd = `## Read
The idea is now a concrete onboarding wedge: a first-run orientation that lists flows and when to reach for each.

## Gate
READY

## Question
NONE

## Why
All five dimensions are answered enough to write a founder-ready brief.

## Bring back
NONE

## Brief
Ship a first-run orientation for cold agents: when \`navi\` is invoked with no args in a repo that has not been oriented, print the available flows and a one-line when-to-use for each (including sharpen vs founder vs founder-advice), then exit 0. Out of scope: interactive wizard, repo indexing, or rewriting existing help. Kill if agents already reach the right flow from the catalog alone within one attempt.

## Confidence
high

## Grounding
semantic-only
`;
    // Shell form the action.yaml actually uses — cwd is foreign so a relative
    // path would MODULE_NOT_FOUND without NAVI_ACTION_DIR.
    const runParser = (actionDir: string, script: string, md: string) => {
      const shell = spawnSync(
        "/bin/sh",
        ["-c", `node "$NAVI_ACTION_DIR/${script}" <<'__NAVI_TEST_MD__'\n${md}\n__NAVI_TEST_MD__`],
        {
          cwd: tmpdir(),
          env: { ...process.env, NAVI_ACTION_DIR: actionDir },
          encoding: "utf8",
        },
      );
      expect(shell.status).toBe(0);
      expect(shell.stderr).toBe("");
      return shell.stdout;
    };

    const founderDir = join(process.cwd(), "builtin/workflows/founder");
    const sharpenDir = join(process.cwd(), "builtin/workflows/sharpen");
    const founderOut = runParser(founderDir, "parse-verdict.mjs", founderMd);
    const sharpenOut = runParser(sharpenDir, "parse-sharpen.mjs", sharpenMd);
    const founderDirect = parseVerdict(founderMd);
    const sharpenDirect = parseSharpen(sharpenMd);
    expect(founderDirect.ok).toBe(true);
    expect(sharpenDirect.ok).toBe(true);
    if (!founderDirect.ok || !sharpenDirect.ok) throw new Error("direct parse failed");
    expect(JSON.parse(founderOut)).toEqual(founderDirect.value);
    expect(JSON.parse(sharpenOut)).toEqual(sharpenDirect.value);
  });
});

// The structured-agent success path guards that stream.object is
// defined. A clean finishReason "stop" with an undefined/null resolved object (the
// structuredOutput errorStrategy "warn" shape) is a LOUD failure, never a silent
// COMPLETE at exit 0. The guard is a pure Result (ok/err), so it is testable without a
// model; runAgent applies it on the `await stream.object` return and rethrows an Err
// inside its own fromPromise.
describe("compiler — structured-output definedness guard", () => {
  it("returns Err when the structured object is undefined despite a clean finish", () => {
    const r = requireStructuredObject("judge", undefined);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toMatch(/silent-success guard/);
      expect(r.error).toMatch(/undefined/);
    }
  });

  it("returns Err when the structured object is null", () => {
    const r = requireStructuredObject("judge", null);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toMatch(/silent-success guard/);
      expect(r.error).toMatch(/null/);
    }
  });

  it("passes a real object through unchanged (the honest success path)", () => {
    const obj = { gate: "CLEAR", directives: [] };
    const r = requireStructuredObject("judge", obj);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(obj);
    // falsy-but-defined values are NOT silent success — they pass.
    expect(requireStructuredObject("s", 0)._unsafeUnwrap()).toBe(0);
    expect(requireStructuredObject("s", "")._unsafeUnwrap()).toBe("");
    expect(requireStructuredObject("s", false)._unsafeUnwrap()).toBe(false);
  });

  it("recovers an undefined adapter object only from schema-valid emitted JSON", () => {
    const schema = z.object({ findings: z.array(z.string()) });
    expect(
      resolveStructuredObject("review", undefined, '{"findings":["one"]}', schema)._unsafeUnwrap(),
    ).toEqual({ findings: ["one"] });
    expect(
      resolveStructuredObject(
        "review",
        undefined,
        '```json\n{"findings":["fenced"]}\n```',
        schema,
      )._unsafeUnwrap(),
    ).toEqual({ findings: ["fenced"] });
  });

  it("keeps invalid prompt-injected JSON behind the silent-success wall", () => {
    const schema = z.object({ findings: z.array(z.string()) });
    const malformed = resolveStructuredObject("review", undefined, "not json", schema);
    const wrongShape = resolveStructuredObject("review", undefined, '{"findings":1}', schema);
    expect(malformed.isErr()).toBe(true);
    expect(wrongShape.isErr()).toBe(true);
    if (wrongShape.isErr()) expect(wrongShape.error).toMatch(/declared schema/);
  });

  it("recovers from an invalid adapter object when emitted JSON satisfies the schema", () => {
    const schema = z.object({ findings: z.array(z.string()) });
    const resolved = resolveStructuredObject(
      "review",
      { findings: 1 },
      '{"findings":["complete text"]}',
      schema,
    );
    expect(resolved._unsafeUnwrap()).toEqual({ findings: ["complete text"] });
  });

  it("keeps a schema-valid adapter object ahead of emitted JSON", () => {
    const schema = z.object({ findings: z.array(z.string()) });
    expect(
      resolveStructuredObject(
        "review",
        { findings: ["adapter"] },
        '{"findings":["text"]}',
        schema,
      )._unsafeUnwrap(),
    ).toEqual({ findings: ["adapter"] });
  });

  it("fails honestly when neither adapter object nor emitted JSON satisfies the schema", () => {
    const schema = z.object({ findings: z.array(z.string()) });
    const resolved = resolveStructuredObject(
      "review",
      { findings: 1 },
      '{"findings":2}',
      schema,
    );
    expect(resolved.isErr()).toBe(true);
    if (resolved.isErr()) {
      expect(resolved.error).toMatch(/adapter object failed the declared schema/);
      expect(resolved.error).toMatch(/prompt-injected JSON failed the declared schema/);
    }
  });
});

// skills.only is force-popped: the named skill's full body lands unconditionally
// in the step agent's instructions at compile time (keyless — getInstructions()
// reads back the static string with no model call).
describe("compiler — skills.only force-pops full skill bodies", () => {
  async function instructionsOf(yaml: string, stepId: string, ws?: ReturnType<typeof createWorkspace>) {
    const shape = await shapeFrom(yaml);
    const c = await compile(shape, { thread: "c", resource: "cli" }, ws ?? createWorkspace(process.cwd()));
    const agent = c._unsafeUnwrap().agents[stepId]!;
    const back = await agent.getInstructions();
    return typeof back === "string" ? back : JSON.stringify(back);
  }

  // Reference bodies are hydrated into instructions because activeTools is an
  // exact allowlist and does not expose Mastra's skill_read tool. The first case
  // verifies this independently of workspace placement.
  it("hydrates a popped skill's reference BODIES, in-repo, with no workspace override", async () => {
    const text = await instructionsOf(
      `
name: judgey
steps:
  - name: judge
    type: agent
    prompt: judge it
    skills:
      only: [founder]
`,
      "judgey.judge",
    );
    expect(text).toMatch(/## references\/rubrics\.md/);
    expect(text).toMatch(/force multiplier/i);
    // doctrine/promotion.md says it is "not part of the v1 verdict path — do not
    // wire it into a live judgment", so it lives OUTSIDE references/. Mastra only
    // discovers references|scripts|assets, so the directory choice is the whole
    // mechanism. This asserts a future file dropped into references/ cannot
    // silently re-enter the verdict path unnoticed.
    expect(text).not.toMatch(/unit of evidence: an anchor/i);
  });

  it("hydrates references against a FOREIGN basePath, where skill.path is absolute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-skillref-"));
    const text = await instructionsOf(
      `
name: judgey
steps:
  - name: judge
    type: agent
    prompt: judge it
    skills:
      only: [founder]
`,
      "judgey.judge",
      createWorkspace(dir),
    );
    // The builtin tier anchors at INSTALL_ROOT, so from here skill.path is an
    // absolute path — the one case getReference has to pass through unchanged.
    expect(text).toMatch(/## references\/rubrics\.md/);
    expect(text).toMatch(/force multiplier/i);
  });

  it("the RUN workspace registers no skills, so no absolute <location> is injected", () => {
    // The blocked read a cold agent hit was Mastra's SkillsProcessor announcing
    // each skill's absolute location to every workspace-bound agent. Skill
    // discovery is unusable at run time anyway (activeTools is always present and
    // the tool vocabulary is closed), so the run Mastra takes a skills-free
    // workspace while compile() keeps the full one.
    const dir = mkdtempSync(join(tmpdir(), "navi-runws-"));
    expect(createWorkspace(dir).skills).toBeDefined();
    expect(createWorkspace(dir, { skills: false }).skills).toBeUndefined();
  });

  it("prepends the named skill's FULL body into the step agent's instructions", async () => {
    const text = await instructionsOf(
      `
name: popper
steps:
  - name: search
    type: agent
    prompt: find X
    skills:
      only: [code-search]
`,
      "popper.search",
    );
    // the base step contract is still present,
    expect(text).toMatch(/single step in a Navi workflow/);
    // AND the code-search skill's full body is unconditionally injected.
    expect(text).toMatch(/RLM Code Search/);
    expect(text).toMatch(/INDEX/);
    expect(text).toMatch(/REDUCE/);
    // edge-walk pops this same skill into a schema-bound recon step. The
    // standalone Markdown answer contract must not compete with ReconOutput.
    expect(text).toMatch(/structured output schema or names a specific return shape/);
    expect(text).toMatch(/return exactly the requested shape/);
  });

  it("a step with no skills.only gets the base instructions only (others stay discoverable)", async () => {
    const text = await instructionsOf(
      `
name: plain
steps:
  - name: s
    type: agent
    prompt: hi
`,
      "plain.s",
    );
    expect(text).toMatch(/single step in a Navi workflow/);
    expect(text).not.toMatch(/RLM Code Search/);
  });

  it("skills.only naming an unknown skill is a loud compile Err, not a throw", async () => {
    const shape = await shapeFrom(`
name: popper
steps:
  - name: s
    type: agent
    prompt: hi
    skills:
      only: [no-such-skill]
`);
    const c = await compile(shape, { thread: "c", resource: "cli" }, createWorkspace(process.cwd()));
    expect(c.isErr()).toBe(true);
    expect(c._unsafeUnwrapErr()).toMatch(/no-such-skill/);
  });

  it("skills.only with no workspace configured is a loud compile Err", async () => {
    const shape = await shapeFrom(`
name: popper
steps:
  - name: s
    type: agent
    prompt: hi
    skills:
      only: [code-search]
`);
    const c = await compile(shape, { thread: "c", resource: "cli" });
    expect(c.isErr()).toBe(true);
  });
});

// Per-step model settings: the flat provider-agnostic
// `settings:` block resolves to effective settings (managed baseline + overrides)
// and maps onto Mastra's two surfaces; deepseek-native options on a non-deepseek
// model are a loud lint error, never a silent drop.
describe("compiler — per-step model settings + the non-deepseek lint", () => {
  it("resolveSettings applies the managed baseline for v4-flash/v4-pro and lets overrides win", () => {
    const unlistedDeepSeekModel = ["deepseek", "unlisted-model"].join("/");
    // the two reference models share the conservative baseline.
    expect(resolveSettings("deepseek/deepseek-v4-flash")).toEqual({ temperature: 0, thinking: "enabled" });
    expect(resolveSettings("deepseek/deepseek-v4-pro")).toEqual({ temperature: 0, thinking: "enabled" });
    // Unlisted DeepSeek variants and non-DeepSeek models get NO managed defaults.
    expect(resolveSettings(unlistedDeepSeekModel)).toEqual({});
    expect(resolveSettings("anthropic/claude-x")).toEqual({});
    // explicit overrides win over the baseline.
    expect(resolveSettings("deepseek/deepseek-v4-flash", { temperature: 0.7, reasoningEffort: "high" })).toEqual({
      temperature: 0.7,
      thinking: "enabled",
      reasoningEffort: "high",
    });
  });

  it("toMastraOptions routes temperature → modelSettings and thinking/effort → deepseek providerOptions", () => {
    expect(
      toMastraOptions("deepseek/deepseek-v4-flash", { temperature: 0, thinking: "disabled", reasoningEffort: "max" }),
    ).toEqual({
      modelSettings: { temperature: 0 },
      providerOptions: { deepseek: { thinking: { type: "disabled" }, reasoningEffort: "max" } },
    });
    // a non-deepseek model never gets a fabricated deepseek namespace (the lint
    // upstream is what catches author intent; this only refuses to invent one).
    expect(toMastraOptions("anthropic/claude-x", { temperature: 0.3 })).toEqual({
      modelSettings: { temperature: 0.3 },
    });
    // only present fields are emitted — no undefined reaches the wire.
    expect(toMastraOptions("deepseek/deepseek-v4-flash", {})).toEqual({});
  });

  it("a step with no settings inherits the model's managed baseline as effective settings", async () => {
    const shape = await shapeFrom(`
name: baseline
steps:
  - name: s
    type: agent
    prompt: hi
`);
    // default model is the reference v4-flash → temperature 0 + thinking enabled.
    expect(shape.steps[0]!.settings).toEqual({ temperature: 0, thinking: "enabled" });
    expect(lintErrors(shape)).toHaveLength(0);
  });

  it("a per-step settings block overrides the baseline and surfaces in --shape", async () => {
    const shape = await shapeFrom(`
name: tuned
steps:
  - name: s
    type: agent
    prompt: hi
    settings:
      temperature: 0.5
      thinking: disabled
      reasoningEffort: high
`);
    expect(shape.steps[0]!.settings).toEqual({ temperature: 0.5, thinking: "disabled", reasoningEffort: "high" });
    expect(lintErrors(shape)).toHaveLength(0);
    // shapeSummary (the --shape projection) carries the resolved settings.
    expect(shapeSummary(shape).steps[0]!.settings).toEqual({
      temperature: 0.5,
      thinking: "disabled",
      reasoningEffort: "high",
    });
  });

  it("deepseek-native settings on a non-deepseek model are a loud lint error, and compile refuses", async () => {
    const shape = await shapeFrom(`
name: mismatch
steps:
  - name: s
    type: agent
    prompt: hi
    model: anthropic/claude-x
    settings:
      thinking: enabled
`);
    expect(lintErrors(shape).some((e) => /DeepSeek-only, but model is "anthropic\/claude-x"/.test(e.message))).toBe(
      true,
    );
    expect((await compile(shape, { thread: "c", resource: "cli" })).isErr()).toBe(true);
  });

  it("a plain temperature override on a non-deepseek model is fine (generic setting, no lint)", async () => {
    const shape = await shapeFrom(`
name: generic-temp
steps:
  - name: s
    type: agent
    prompt: hi
    model: anthropic/claude-x
    settings:
      temperature: 0.2
`);
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.steps[0]!.settings).toEqual({ temperature: 0.2 });
  });

  it("a command step cannot set a settings block", async () => {
    const shape = await shapeFrom(`
name: badcmd
steps:
  - name: s
    type: command
    command: echo hi
    settings:
      temperature: 0
`);
    expect(lintErrors(shape).some((e) => /command step cannot set settings/.test(e.message))).toBe(true);
  });
});

// Per-step modelEnv is an optional StepSpec field naming the environment
// variable to consult before the literal `model:`. Resolution
// is model-free (plan-time process.env read in shape.ts), so these tests stub env
// vars in-process and restore them; no model call. Mirrors the environment
// discipline in tests/cli.test.ts (there via subprocess env; here in-process
// because buildShape runs in the test process).
describe("compiler — per-step modelEnv resolution", () => {
  const JUDGE_ENV = "NAVI_TEST_JUDGE_MODEL";

  it("modelEnv whose env var is SET wins over the literal model: and the default", async () => {
    const saved = process.env[JUDGE_ENV];
    process.env[JUDGE_ENV] = "deepseek/deepseek-v4-pro";
    try {
      const shape = await shapeFrom(`
name: judged
steps:
  - name: judge
    type: agent
    prompt: adjudicate
    model: deepseek/deepseek-v4-flash
    modelEnv: ${JUDGE_ENV}
`);
      expect(lintErrors(shape)).toHaveLength(0);
      const judge = shape.steps[0]!;
      expect(judge.model).toBe("deepseek/deepseek-v4-pro"); // env value wins
      expect(judge.modelEnv).toBe(JUDGE_ENV); // the consulted var name is surfaced
      // --shape projection carries BOTH the resolved model and which env var was read.
      expect(shapeSummary(shape).steps[0]!.model).toBe("deepseek/deepseek-v4-pro");
      expect(shapeSummary(shape).steps[0]!.modelEnv).toBe(JUDGE_ENV);
    } finally {
      if (saved === undefined) delete process.env[JUDGE_ENV];
      else process.env[JUDGE_ENV] = saved;
    }
  });

  it("modelEnv whose env var is UNSET falls through to the literal model:", async () => {
    const saved = process.env[JUDGE_ENV];
    delete process.env[JUDGE_ENV];
    try {
      const shape = await shapeFrom(`
name: judged
steps:
  - name: judge
    type: agent
    prompt: adjudicate
    model: deepseek/deepseek-v4-pro
    modelEnv: ${JUDGE_ENV}
`);
      const judge = shape.steps[0]!;
      expect(judge.model).toBe("deepseek/deepseek-v4-pro"); // literal wins when env absent
      expect(judge.modelEnv).toBe(JUDGE_ENV); // name still surfaced even though unused
    } finally {
      if (saved !== undefined) process.env[JUDGE_ENV] = saved;
    }
  });

  it("no modelEnv and no model: resolves to the run default (NAVI_MODEL ?? default)", async () => {
    const shape = await shapeFrom(`
name: plain
steps:
  - name: s
    type: agent
    prompt: hi
`);
    expect(shape.steps[0]!.model).toBe(shape.defaultModel);
    expect(shape.steps[0]!.modelEnv).toBeUndefined();
    expect(shapeSummary(shape).steps[0]!.modelEnv).toBeNull(); // additive: JSON null when unset
  });

  it("modelEnv set but env var unset AND no model: still falls through to the default", async () => {
    const saved = process.env[JUDGE_ENV];
    delete process.env[JUDGE_ENV];
    try {
      const shape = await shapeFrom(`
name: judged
steps:
  - name: judge
    type: agent
    prompt: adjudicate
    modelEnv: ${JUDGE_ENV}
`);
      expect(shape.steps[0]!.model).toBe(shape.defaultModel);
    } finally {
      if (saved !== undefined) process.env[JUDGE_ENV] = saved;
    }
  });

  it("a command step cannot set modelEnv (loud lint, compile refuses)", async () => {
    const shape = await shapeFrom(`
name: badcmd
steps:
  - name: s
    type: command
    command: echo hi
    modelEnv: ${JUDGE_ENV}
`);
    expect(lintErrors(shape).some((e) => /command step cannot set modelEnv/.test(e.message))).toBe(true);
    expect((await compile(shape, { thread: "c", resource: "cli" })).isErr()).toBe(true);
  });
});

// The `tools:` allowlist is the per-step workspace surface:
// declared list → ResolvedStep.tools → agent.stream({ activeTools }) verbatim.
// Absent/empty tools: is ZERO tools (activeTools: []), never the full workspace
// set. The Workspace tool-name remap (src/mastra/index.ts) still governs whether
// those names resolve to real tool keys at run time.
describe("compiler — tools: allowlist (default-zero + activeTools passthrough)", () => {
  it("a step's declared tools: lands in ResolvedStep.tools unchanged", async () => {
    const shape = await shapeFrom(`
name: scoped
steps:
  - name: recon
    type: agent
    prompt: locate entry points
    tools: [search_content, view, find_files]
`);
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.steps[0]!.tools).toEqual(["search_content", "view", "find_files"]);
    // the --shape projection echoes the same allowlist verbatim.
    expect(shapeSummary(shape).steps[0]!.tools).toEqual(["search_content", "view", "find_files"]);
    // and the stream options fragment runAgent spreads is the same list (the
    // actual option passed to the agent — not just the shape field).
    expect(agentStreamToolOptions(shape.steps[0]!.tools)).toEqual({
      activeTools: ["search_content", "view", "find_files"],
    });
  });

  it("a step with no tools: resolves to ZERO tools (activeTools: [], not omitted)", async () => {
    const shape = await shapeFrom(`
name: unscoped
steps:
  - name: s
    type: agent
    prompt: hi
`);
    expect(shape.steps[0]!.tools).toEqual([]);
    // present-and-empty is the Mastra-native zero-tools signal; omitting the key
    // would mean ALL tools (prepareToolsAndToolChoice: activeTools != null filter).
    expect(agentStreamToolOptions(shape.steps[0]!.tools)).toEqual({ activeTools: [] });
    expect(Object.hasOwn(agentStreamToolOptions(shape.steps[0]!.tools), "activeTools")).toBe(true);
  });

  it("uses one prompt-injected structured-output contract across providers", () => {
    const schema = z.object({ answer: z.string() });
    expect(structuredOutputOptions(schema)).toEqual({
      schema,
      jsonPromptInjection: true,
      errorStrategy: "warn",
    });
  });

  it("a zero-tool agent step gets a compile WARNING naming the step (not an error)", async () => {
    const shape = await shapeFrom(`
name: unscoped-warn
steps:
  - name: ask
    type: agent
    prompt: pure interrogation
`);
    const zeroTool = shape.lint.filter((f) => /zero workspace tools/.test(f.message));
    expect(zeroTool).toHaveLength(1);
    expect(zeroTool[0]!.level).toBe("warn");
    expect(zeroTool[0]!.step).toBe("ask");
    expect(zeroTool[0]!.message).toMatch(/step "ask"/);
    // warning is advisory — compile still accepts; lintErrors is empty.
    expect(lintErrors(shape)).toHaveLength(0);
    expect((await compile(shape, { thread: "t", resource: "cli" })).isOk()).toBe(true);
  });

  it("a step WITH tools: does not fire the zero-tool warning", async () => {
    const shape = await shapeFrom(`
name: scoped-no-warn
steps:
  - name: recon
    type: agent
    prompt: locate entry points
    tools: [view, search_content]
`);
    expect(shape.lint.some((f) => /zero workspace tools/.test(f.message))).toBe(false);
    expect(lintErrors(shape)).toHaveLength(0);
  });

  // A typo'd tools: entry matches no registered workspace tool key, so under
  // Mastra's exact-match activeTools filter it resolves to ZERO tools — a silent
  // toolless step. The compiler refuses it loudly at compile time
  // error, never silent drop"), naming the bad entry and the valid vocabulary.
  it("a tools: entry outside the workspace vocabulary is a loud compile error naming it", async () => {
    const shape = await shapeFrom(`
name: tools-typo
steps:
  - name: s
    type: agent
    prompt: hi
    tools: [serch_kontent, view]
`);
    const errs = lintErrors(shape);
    // the bogus name is named in the error; the correctly-spelled sibling is not flagged.
    expect(errs.some((e) => /unknown tool "serch_kontent" in tools:/.test(e.message))).toBe(true);
    expect(errs.some((e) => /unknown tool "view"/.test(e.message))).toBe(false);
    // the error carries the valid vocabulary so the author can self-correct.
    const msg = errs.find((e) => /serch_kontent/.test(e.message))!.message;
    for (const valid of ["view", "search_content", "find_files"]) expect(msg).toContain(valid);
    // and it is error-level, so compile() refuses the whole workflow.
    expect((await compile(shape, { thread: "t", resource: "cli" })).isErr()).toBe(true);
  });

  // No sandbox means Mastra cannot register current or future process tools.
  // Trusted static shell belongs to a YAML command step instead.
  it("agent-controlled shell is structurally absent from the workspace", async () => {
    expect(READ_ONLY_WORKSPACE_TOOLS.length).toBeGreaterThan(0);
    for (const t of READ_ONLY_WORKSPACE_TOOLS) expect(WORKSPACE_TOOL_NAMES).toContain(t);
    expect(DEEP_SEARCH_TOOL_NAMES).toEqual([
      ...READ_ONLY_WORKSPACE_TOOLS,
      "parallel_view",
      "multi_search",
    ]);
    const workspace = createWorkspace(process.cwd(), { skills: false });
    expect(workspace.sandbox).toBeUndefined();
    const tools = Object.keys(await createWorkspaceTools(workspace)).sort();
    expect(tools).toEqual([...WORKSPACE_TOOL_NAMES].sort());
    expect(tools).not.toContain("mastra_workspace_execute_command");
    expect(tools).not.toContain("mastra_workspace_get_process_output");
    expect(tools).not.toContain("mastra_workspace_kill_process");
  });

  it("the five built-in flows resolve to the shared read-only tools list", async () => {
    const expected = [...READ_ONLY_WORKSPACE_TOOLS];
    const flows: { name: string; step: string }[] = [
      { name: "founder", step: "judge" },
      { name: "founder-advice", step: "counsel" },
      { name: "code-search", step: "search" },
      { name: "code-review", step: "review" },
      { name: "pre-pr-review", step: "review" },
    ];
    for (const { name, step } of flows) {
      const shape = (await loadShape(name, process.cwd()))._unsafeUnwrap();
      const agent = shape.steps.find((s) => s.name === step);
      expect(agent, `${name}.${step} missing`).toBeDefined();
      expect(agent!.type).toBe("agent");
      expect(agent!.tools, `${name}.${step} tools`).toEqual(expected);
      // The shared allowlist itself must remain non-empty.
      expect(agent!.tools.length).toBeGreaterThan(0);
      // no zero-tool warning on an explicitly tooled step.
      expect(shape.lint.some((f) => f.step === step && /zero workspace tools/.test(f.message))).toBe(false);
    }
  });
});

// The `json` argument type:
// a json-typed arg binds a whole JSON VALUE (edge-walk's --stdin `input`), compiled
// to z.unknown() so Mastra's input validation ACCEPTS the object instead of rejecting
// it as a non-string. A plain arg defaults to `string`, unchanged. Keyless: the run
// tests use a command step (no model).
describe("compiler — the `json` arg-type token (edge-walk's structured input)", () => {
  async function runStatus(yaml: string, inputData: Record<string, unknown>): Promise<string> {
    const shape = await shapeFrom(yaml);
    const c = (await compile(shape, { thread: "j", resource: "cli" }))._unsafeUnwrap();
    const m = new Mastra({
      workflows: { [shape.name]: c.workflow },
      storage: new LibSQLStore({ id: "test-json", url: ":memory:" }),
    });
    const run = await m.getWorkflowById(shape.name).createRun();
    try {
      return ((await run.start({ inputData })) as { status: string }).status;
    } catch {
      // an input-validation throw is also a rejection — normalize to "failed".
      return "failed";
    }
  }

  it("resolves `type: json` onto the arg; an undeclared type defaults to string", async () => {
    const shape = await shapeFrom(`
name: typed-args
args:
  input:
    type: json
    required: true
  label:
    required: false
steps:
  - name: s
    type: command
    command: echo ok
`);
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.args.find((a) => a.name === "input")?.type).toBe("json");
    expect(shape.args.find((a) => a.name === "label")?.type).toBe("string");
    // the type surfaces in the --shape projection (additive, keyless).
    const summarized = shapeSummary(shape).args as { name: string; type: string }[];
    expect(summarized.find((a) => a.name === "input")?.type).toBe("json");
  });

  it("a json arg ACCEPTS an object input — Mastra input validation passes", async () => {
    const status = await runStatus(
      `
name: json-accepts
args:
  input:
    type: json
    required: true
steps:
  - name: s
    type: command
    command: echo ok
`,
      { input: { event: { kind: "plan" }, nested: [1, 2, 3] } },
    );
    expect(status).toBe("success");
  });

  it("a default string arg rejects an object input", async () => {
    // This proves the json token unblocks object binding without loosening the
    // default string validator.
    const status = await runStatus(
      `
name: string-rejects
args:
  input:
    required: true
steps:
  - name: s
    type: command
    command: echo ok
`,
      { input: { event: { kind: "plan" } } },
    );
    expect(status).not.toBe("success");
  });
});

// resolveWorkflowPath roots the builtin tier at the navi install root, not
// basePath. A built-in workflow resolves by name against any `-w` target.
// Keyless: pure path resolution, no compile/model.
describe("compiler — resolveWorkflowPath anchors the builtin tier at the install root", () => {
  const BUILTIN_SUFFIX = "builtin/workflows/edge-walk/action.yaml";

  it("resolves a builtin workflow by name against an EXTERNAL basePath", () => {
    const external = mkdtempSync(join(tmpdir(), "navi-wf-ext-"));
    try {
      const r = resolveWorkflowPath("edge-walk", external);
      expect(r.isOk()).toBe(true);
      const path = r._unsafeUnwrap();
      // resolved from the navi install tree, NOT the external dir.
      expect(path.endsWith(BUILTIN_SUFFIX)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(external)).toBe(false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("resolves in-repo when install root equals basePath", () => {
    const r = resolveWorkflowPath("edge-walk", process.cwd());
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBe(join(process.cwd(), BUILTIN_SUFFIX));
  });

  it("an unknown workflow name against an external dir is a loud error", () => {
    const external = mkdtempSync(join(tmpdir(), "navi-wf-ext2-"));
    try {
      const r = resolveWorkflowPath("no-such-workflow-xyz", external);
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr()).toMatch(/unknown workflow "no-such-workflow-xyz"/);
      // error enumerates every tier searched so a missing pin is diagnosable
      expect(r._unsafeUnwrapErr()).toMatch(/\.agents\/workflows/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("resolves a pinned workflow by name from .agents/workflows (consumer basePath)", () => {
    // hermetic: a flow only under the consumer's pinned tier, not the real contrib tree
    const external = mkdtempSync(join(tmpdir(), "navi-wf-pinned-"));
    try {
      const pinnedDir = join(external, ".agents/workflows/triage");
      mkdirSync(pinnedDir, { recursive: true });
      writeFileSync(
        join(pinnedDir, "action.yaml"),
        "name: triage\ndescription: pinned fixture\nsteps: []\n",
      );
      const r = resolveWorkflowPath("triage", external);
      expect(r.isOk()).toBe(true);
      const path = r._unsafeUnwrap();
      expect(path).toBe(join(external, ".agents/workflows/triage/action.yaml"));
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("project workflow shadows pinned of the same name in resolveWorkflowPath", () => {
    const external = mkdtempSync(join(tmpdir(), "navi-wf-shadow-"));
    try {
      for (const [tier, body] of [
        [".navi/workflows/delta", "name: delta\ndescription: project\nsteps: []\n"],
        [".agents/workflows/delta", "name: delta\ndescription: pinned\nsteps: []\n"],
      ] as const) {
        mkdirSync(join(external, tier), { recursive: true });
        writeFileSync(join(external, tier, "action.yaml"), body);
      }
      const r = resolveWorkflowPath("delta", external);
      expect(r.isOk()).toBe(true);
      expect(r._unsafeUnwrap()).toBe(join(external, ".navi/workflows/delta/action.yaml"));
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
