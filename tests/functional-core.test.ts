import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This is the canonical copy of the source banner. scripts/control-flow.mjs
// enforces the code invariant; this test keeps every product file pointed at the
// same public contributor contract.
export const BANNER = `// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.`;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

// The failure message IS the fix: it names the file and prints the block to paste.
const fix = (file: string, problem: string) =>
  `\n${file}: ${problem}\n\nPaste this block at line 1 (line 2 if the file opens with a shebang), exactly once, byte-for-byte:\n\n${BANNER}\n`;

const SRC_FILES = walk(join(ROOT, "src"))
  .map((f) => relative(ROOT, f))
  .sort();

describe("functional core — every src file carries the contributor banner", () => {
  it("discovers at least one src file", () => {
    expect(SRC_FILES.length).toBeGreaterThan(0);
  });

  it.each(SRC_FILES)("%s opens with the canonical banner, exactly once", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    // A shebang must stay on line 1; the banner takes line 2 in that one case.
    const body = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;

    expect(body.startsWith(BANNER), fix(file, "missing the banner at the top")).toBe(true);
    expect(text.split(BANNER).length - 1, fix(file, "carries the banner more than once")).toBe(1);
  });
});
