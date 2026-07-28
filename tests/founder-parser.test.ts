import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { parseVerdict } from "../builtin/workflows/founder/parse-verdict.mjs";
import VerdictSchema from "../builtin/workflows/founder/verdict.schema.ts";

// The founder emission step writes plain markdown; parse-verdict.mjs turns it
// into the verdict object deterministically. These fixtures are the hostile
// shapes the RLM actually produces (preamble glued onto the first header, glued
// headers mid-stream) plus the structural violations that MUST fail honestly
// (missing/duplicate/out-of-order header, non-enum verdict). A parse that
// succeeds must also validate against the real Zod schema — that ties the
// dependency-free parser to the schema so they cannot drift.

const WELL_FORMED = `## Verdict
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

function expectValid(md: string) {
  const r = parseVerdict(md);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  // The parser's output must satisfy the shipped schema, every time.
  expect(VerdictSchema.safeParse(r.value).success).toBe(true);
  return r.value;
}

describe("founder verdict parser — well-formed", () => {
  it("parses the five sections and validates against the schema", () => {
    const v = expectValid(WELL_FORMED);
    expect(v.verdict).toBe("GO");
    expect(v.take).toMatch(/honest-degradation/);
    expect(v.grounding_points).toHaveLength(2);
    expect(v.decision_rules).toHaveLength(1);
    expect(v.what_not_to_do).toHaveLength(1);
  });

  it("accepts REFINE and REJECT verdicts", () => {
    expect(expectValid(WELL_FORMED.replace("GO", "REFINE")).verdict).toBe("REFINE");
    expect(expectValid(WELL_FORMED.replace("GO", "REJECT")).verdict).toBe("REJECT");
  });
});

describe("founder verdict parser — hostile but recoverable (must parse)", () => {
  it("strips narration glued onto the first header with no newline", () => {
    // The exact failure the brief flagged: "…to be thorough.## Verdict".
    const glued = `Let me ground this to be thorough.${WELL_FORMED}`;
    const v = expectValid(glued);
    expect(v.verdict).toBe("GO");
    // The preamble must not leak into the take.
    expect(v.take).not.toMatch(/thorough/);
  });

  it("tolerates a header glued to the end of a previous section", () => {
    const glued = WELL_FORMED.replace("never a fabricated one.\n", "never a fabricated one.");
    // Collapse the blank line before ## Grounding points so it butts the take.
    const tighter = glued.replace("fabricated one.\n\n## Grounding", "fabricated one.## Grounding");
    const v = expectValid(tighter);
    expect(v.verdict).toBe("GO");
    expect(v.grounding_points.length).toBeGreaterThan(0);
  });

  it("tolerates case and extra inter-word whitespace in headers", () => {
    const messy = WELL_FORMED.replace("## Grounding points", "## grounding  points").replace(
      "## What not to do",
      "## WHAT NOT TO DO",
    );
    expect(expectValid(messy).verdict).toBe("GO");
  });

  it("ignores a wrapping code fence", () => {
    const fenced = "```markdown\n" + WELL_FORMED + "```\n";
    expect(expectValid(fenced).verdict).toBe("GO");
  });
});

describe("founder verdict parser — structural violations (must fail honestly)", () => {
  const failWith = (md: string) => {
    const r = parseVerdict(md);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("fails when a header is missing", () => {
    const missing = WELL_FORMED.replace("## Decision rules\n- Degrade to an honest Blocked, never invent sources.\n", "");
    expect(failWith(missing)).toMatch(/missing "## Decision rules"/);
  });

  it("fails when a header is duplicated", () => {
    const dup = WELL_FORMED + "\n## Take\nA second take.\n";
    expect(failWith(dup)).toMatch(/## Take.*exactly once/);
  });

  it("fails when headers are out of order", () => {
    const swapped = `## Take
one sentence.

## Verdict
GO

## Grounding points
- a

## Decision rules
- b

## What not to do
- c
`;
    expect(failWith(swapped)).toMatch(/out of order/);
  });

  it("fails when the verdict is not one of the three", () => {
    const bad = WELL_FORMED.replace("GO\n", "MAYBE\n");
    expect(failWith(bad)).toMatch(/GO, REFINE, REJECT/);
  });

  it("fails when the take is empty", () => {
    const empty = WELL_FORMED.replace("The honest-degradation design is right — a missing key returns a Blocked answer, never a fabricated one.", "");
    expect(failWith(empty)).toMatch(/## Take is empty/);
  });

  it("fails on empty input", () => {
    expect(failWith("")).toMatch(/missing "## Verdict"/);
  });
});

// A parser that stays inert produces exit 0 and an EMPTY stdout, which the
// command step reports as success and the run reports as "complete" with no
// gate. That is silent success — the one failure mode these parsers exist to
// prevent — so the entrypoint guard is worth a test of its own.
//
// The trigger is a symlinked path: `import.meta.url` is always resolved, while
// `process.argv[1]` is whatever the caller typed. On macOS every mkdtemp path
// (/var/... → /private/var/...) is symlinked, and so is a bun/npm global
// install. A raw string comparison of the two silently fails.
describe("parser entrypoint guard survives a symlinked invocation path", () => {
  const PARSERS = [
    ["founder", "builtin/workflows/founder/parse-verdict.mjs", WELL_FORMED],
    [
      "sharpen",
      "builtin/workflows/sharpen/parse-sharpen.mjs",
      [
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
      ].join("\n"),
    ],
  ] as const;

  for (const [name, rel, input] of PARSERS) {
    it(`${name}: emits its object from a symlinked directory, not silence`, () => {
      const dir = mkdtempSync(join(tmpdir(), `navi-symlink-${name}-`));
      const real = join(dir, "real");
      mkdirSync(real);
      copyFileSync(join(process.cwd(), rel), join(real, basename(rel)));
      // The bug needs a path whose literal spelling differs from its realpath. macOS
      // mkdtemp gives that for free (/var → /private/var); Linux /tmp realpaths to
      // itself. Asserting the platform happened to provide it was a macOS-only test
      // wearing portable clothes — in the Linux container it would fail for a reason
      // having nothing to do with the code under test. So MAKE the symlink.
      const linked = join(dir, "via-link");
      symlinkSync(real, linked);
      const copy = join(linked, basename(rel));
      expect(realpathSync(copy)).not.toBe(copy);

      const r = spawnSync(process.execPath, [copy], { input, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
