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
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

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
