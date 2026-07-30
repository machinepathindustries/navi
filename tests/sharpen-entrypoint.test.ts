import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { parseSpecFile } from "../src/compiler/parse.ts";
import { buildShape, compile } from "../src/compiler/index.ts";

const PARSER = "builtin/workflows/sharpen/parse-sharpen.mjs";
const INPUT = [
  "## Read",
  "the idea",
  "## Gate",
  "ASK",
  "## Question",
  "what breaks?",
  "## Why",
  "because",
  "## Bring back",
  "an answer",
  "## Brief",
  "none",
  "## Confidence",
  "medium",
  "## Grounding",
  "semantic-only",
].join("\n");

describe("sharpen parser entrypoint", () => {
  it("runs the shipped gate command through the compiled workflow", async () => {
    const actionPath = join(process.cwd(), dirname(PARSER), "action.yaml");
    const gate = parseSpecFile(actionPath)._unsafeUnwrap().steps.find((step) => step.name === "gate");
    expect(gate).toBeDefined();
    const { depends: _, ...standaloneGate } = gate!;
    const shape = await buildShape(
      {
        name: "sharpen-gate-probe",
        args: { payload: { required: true } },
        steps: [{ ...standaloneGate, stdin: "{{ input.payload }}" }],
      },
      dirname(actionPath),
    );
    const compiled = (await compile(shape, { thread: "sharpen", resource: "cli" }))._unsafeUnwrap();
    const mastra = new Mastra({
      workflows: { [shape.name]: compiled.workflow },
      storage: new LibSQLStore({ id: "sharpen-gate-test", url: ":memory:" }),
    });
    const run = await mastra.getWorkflowById(shape.name).createRun();
    const result = await run.start({ inputData: { payload: INPUT } });
    expect(result.status).toBe("success");
    expect(JSON.parse((result.steps.gate!.output as { stdout: string }).stdout)).toMatchObject({
      gate: "DIRECT",
    });
  });

  it("emits its object from a symlinked invocation path", () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-symlink-sharpen-"));
    try {
      const real = join(dir, "real");
      mkdirSync(real);
      copyFileSync(join(process.cwd(), PARSER), join(real, basename(PARSER)));

      const linked = join(dir, "via-link");
      symlinkSync(real, linked);
      const copy = join(linked, basename(PARSER));
      expect(realpathSync(copy)).not.toBe(copy);

      const result = spawnSync(process.execPath, [copy], {
        input: INPUT,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
