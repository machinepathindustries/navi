import { describe, it, expect } from "vitest";
import {
  extractSearchTerms,
  buildPreflightDigest,
  scoreHit,
  termWeight,
  type PreflightHit,
} from "../src/search/preflight.ts";
import { prefetchTopHits, renderPrefetchBlock, pathPrefetchScore } from "../src/search/prefetch.ts";
import { buildSearchPrompt, buildSearchInstructions } from "../src/search/instructions.ts";

describe("search preflight", () => {
  it("extracts technical nouns and drops stopwords", () => {
    const terms = extractSearchTerms(
      "how does skills.only force-pop skill bodies into a compiled step agent?",
    );
    expect(terms.map((t) => t.toLowerCase())).toEqual(
      expect.arrayContaining(["skills.only", "force-pop", "skill", "bodies", "compiled", "step"]),
    );
    expect(terms.map((t) => t.toLowerCase())).not.toContain("how");
    expect(terms.map((t) => t.toLowerCase())).not.toContain("does");
  });

  it("preserves casing variants as distinct only by lower-key dedupe", () => {
    const terms = extractSearchTerms("GateDecision gateDecision GATE");
    // first wins; lower-case dupes dropped
    expect(terms.length).toBeGreaterThanOrEqual(1);
    expect(terms.length).toBeLessThanOrEqual(3);
  });

  it("buildPreflightDigest returns hits for real repo terms under basePath", () => {
    const d = buildPreflightDigest("skills.only resolvePoppedSkills formatSkillActivation", process.cwd());
    expect(d.durationMs).toBeLessThan(2000);
    expect(d.terms.length).toBeGreaterThan(0);
    expect(d.hits.length).toBeGreaterThan(0);
    expect(d.hits.length).toBeLessThanOrEqual(16); // primary cap 8 + caller enrichment
    expect(d.text).toContain("Deterministic INDEX preflight");
    // Honesty rail language present
    expect(d.text).toMatch(/not evidence/i);
    expect(d.text).toMatch(/MAP prefetch|FIRST model step|candidate/i);
    // Prefer src/ hits for these symbols
    expect(d.hits.some((h) => h.path.includes("compile.ts") || h.path.includes("src/"))).toBe(true);
  });

  it("buildSearchPrompt places preflight/prefetch before the question (stable template)", () => {
    const p = buildSearchPrompt("where is X?", {
      preflight: "## Deterministic INDEX preflight\n- hit",
      prefetch: "## Deterministic MAP prefetch\ncode",
    });
    expect(p.startsWith("## Deterministic INDEX preflight")).toBe(true);
    expect(p).toContain("## Deterministic MAP prefetch");
    expect(p).toContain("## User question\nwhere is X?");
  });

  it("buildSearchInstructions embeds the popped skill and forbids skill-tool hop", () => {
    const i = buildSearchInstructions("## skill body here");
    expect(i).toContain("ALREADY loaded");
    expect(i).toContain("do NOT call the skill tool");
    expect(i).toContain("parallel_view");
    expect(i).toContain("## skill body here");
  });

  it("prefetchTopHits reads real windows for top preflight hits", () => {
    const d = buildPreflightDigest("resolvePoppedSkills formatSkillActivation", process.cwd());
    const windows = prefetchTopHits(process.cwd(), d.hits, 3);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]!.text.length).toBeGreaterThan(20);
    expect(windows[0]!.lineStart).toBeGreaterThan(0);
    const block = renderPrefetchBlock(windows, 1);
    expect(block).toMatch(/ALREADY READ|REAL file contents/i);
    expect(block).toContain(windows[0]!.path);
  });
});

// ---------------------------------------------------------------------------
// Scoring tables — the ranking pin.
//
// termWeight / scoreHit / pathPrefetchScore decide WHICH evidence the model
// ever sees. A drift here is SILENT: worse answers, still-green feature tests.
// These snapshots pin every weight branch plus multi-predicate stacks over a
// FIXED corpus. If one moves, the ranking moved — fix the code, do NOT
// re-baseline the snapshot.
//
// Note these predicates are ADDITIVE (several fire and their weights sum), so
// the implementation is a weights table + fold, never a match() that would
// select exactly one arm.
// ---------------------------------------------------------------------------

const hit = (term: string, path: string, text: string, line = 10): PreflightHit => ({
  term,
  path,
  line,
  text,
});

const TERM_CORPUS: string[] = [
  "loop",                  // WEAK_TERMS
  "match",                 // WEAK_TERMS
  "Loop",                  // WEAK_TERMS, case-insensitive
  "gate",                  // plain, short
  "abcdef",                // len 6 — no length bonus
  "abcdefg",               // len 7 — lower bucket
  "abcdefghi",             // len 9 — lower bucket
  "abcdefghij",            // len 10 — upper bucket
  "prefetch",              // len 8
  "skills.only",           // dot + len>=10
  "force-pop",             // dash + len 7..9
  "snake_case_name",       // underscore + len>=10
  "scoreHit",              // camelCase + len 7..9
  "resolvePoppedSkills",   // camelCase + len>=10
  "path.guard.ts",         // dot + len>=10
  "a.b",                   // dot only, len 3
  "MAX_PREFETCH_FILES",    // underscore + len>=10, NOT camelCase
  "edge-walk.ts",          // dash + dot + len>=10
  "buildPreflightDigest",  // camelCase + len>=10
];

const HIT_CORPUS: PreflightHit[] = [
  // single-predicate path prefixes
  hit("gate", "src/cli.ts", "  return 1;"),
  hit("gate", "builtin/skills/x.ts", "  return 1;"),
  hit("gate", "docs/guide.md", "  return 1;"),
  hit("gate", "other/thing.ts", "  return 1;"),
  // "./" prefix stripping
  hit("gate", "./src/cli.ts", "  return 1;"),
  // test / tests penalties
  hit("gate", "src/a.test.ts", "  return 1;"),
  hit("gate", "src/tests/a.ts", "  return 1;"),
  // markdown penalty
  hit("gate", "notes/readme.md", "  return 1;"),
  hit("gate", "docs/reference.md", "  return 1;"),
  // node_modules / external
  hit("gate", "node_modules/pkg/index.ts", "  return 1;"),
  hit("gate", "external/pkg/index.ts", "  return 1;"),
  // path contains the term (+12)
  hit("transcription", "src/transcription/index.ts", "  return 1;"),
  // dotted term matches the slash form (+12)
  hit("skills.only", "src/skills/only/index.ts", "  return 1;"),
  // text contains the term (+2)
  hit("gate", "other/thing.ts", "  const gate = 1;"),
  // assignment-shaped hits (+8)
  hit("gate", "other/thing.ts", "gate = 1"),
  hit("DEFAULT_MODEL", "src/config.ts", 'const DEFAULT_MODEL = "opus";'),
  hit("DEFAULT_MODEL", "src/config.ts", '  "DEFAULT_MODEL": "opus",'),
  hit("model", "src/model.ts", "  this.model: string = compute();"),
  // multi-predicate stacks
  hit("prefetch", "src/search/prefetch.test.ts", "const prefetch = 1;"),
  hit("preflight", "docs/preflight.md", "preflight = 2"),
  hit("scoreHit", "src/search/preflight.ts", "export function scoreHit(h) {"),
  hit("loop", "src/loop/index.ts", "loop = 1"),
  hit("edge-walk", "builtin/workflows/edge-walk.ts", "  const x = 1;"),
  hit("resolvePoppedSkills", "node_modules/x/resolvePoppedSkills.ts", "resolvePoppedSkills = 3"),
];

const PATH_CORPUS: { path: string; lines: number[]; terms: string[] }[] = [
  { path: "src/cli.ts", lines: [1], terms: [] },
  { path: "./src/cli.ts", lines: [1], terms: [] },
  { path: "builtin/skills/x.ts", lines: [1, 2], terms: [] },
  { path: "docs/guide.md", lines: [1], terms: [] },
  { path: "other/thing.ts", lines: [], terms: [] },
  { path: "src/search/preflight.ts", lines: [1], terms: [] },
  { path: "src/search/prefetch.ts", lines: [1], terms: [] },
  { path: "src/a.test.ts", lines: [1], terms: [] },
  { path: "src/tests/a.ts", lines: [1], terms: [] },
  { path: "notes/readme.md", lines: [1], terms: [] },
  // anchor-count contribution, capped at 5
  { path: "src/cli.ts", lines: [1, 2, 3], terms: [] },
  { path: "src/cli.ts", lines: [1, 2, 3, 4, 5], terms: [] },
  { path: "src/cli.ts", lines: [1, 2, 3, 4, 5, 6, 7, 8], terms: [] },
  // a term shorter than 4 chars is skipped entirely
  { path: "src/cli.ts", lines: [1], terms: ["cli"] },
  { path: "src/transcription/index.ts", lines: [1], terms: ["transcription"] },
  // dotted term: literal miss, slash form hit (+4 only)
  { path: "src/skills/only/index.ts", lines: [1], terms: ["skills.only"] },
  // dotted term: BOTH forms present (+10 and +4)
  { path: "src/skills.only/skills/only.ts", lines: [1], terms: ["skills.only"] },
  // several terms all hitting at once
  {
    path: "src/search/preflight.ts",
    lines: [10, 20],
    terms: ["preflight", "search", "src", "scoreHit"],
  },
  // case-insensitive term match against the path
  { path: "src/Transcription/Index.ts", lines: [1], terms: ["transcription"] },
  // md + tests + term hit stacked
  { path: "docs/tests/preflight.md", lines: [1, 2], terms: ["preflight"] },
  { path: "builtin/workflows/edge-walk.ts", lines: [3], terms: ["edge-walk", "workflows"] },
];

describe("scoring tables (ranking pin — additive weights, not dispatch)", () => {
  it("termWeight is stable across every weight branch", () => {
    expect(TERM_CORPUS.map((t) => `${t} => ${termWeight(t)}`)).toMatchInlineSnapshot(`
      [
        "loop => 0.25",
        "match => 0.25",
        "Loop => 0.25",
        "gate => 1",
        "abcdef => 1",
        "abcdefg => 2",
        "abcdefghi => 2",
        "abcdefghij => 3",
        "prefetch => 2",
        "skills.only => 7",
        "force-pop => 6",
        "snake_case_name => 7",
        "scoreHit => 5",
        "resolvePoppedSkills => 6",
        "path.guard.ts => 7",
        "a.b => 5",
        "MAX_PREFETCH_FILES => 7",
        "edge-walk.ts => 7",
        "buildPreflightDigest => 6",
      ]
    `);
  });

  it("scoreHit is stable across every weight branch and stack", () => {
    expect(
      HIT_CORPUS.map((h) => `${h.path} [${h.term}] {${h.text.trim()}} => ${scoreHit(h)}`),
    ).toMatchInlineSnapshot(`
      [
        "src/cli.ts [gate] {return 1;} => 5",
        "builtin/skills/x.ts [gate] {return 1;} => 4",
        "docs/guide.md [gate] {return 1;} => -1",
        "other/thing.ts [gate] {return 1;} => 0",
        "./src/cli.ts [gate] {return 1;} => 5",
        "src/a.test.ts [gate] {return 1;} => 1",
        "src/tests/a.ts [gate] {return 1;} => 1",
        "notes/readme.md [gate] {return 1;} => -2",
        "docs/reference.md [gate] {return 1;} => -1",
        "node_modules/pkg/index.ts [gate] {return 1;} => -20",
        "external/pkg/index.ts [gate] {return 1;} => -20",
        "src/transcription/index.ts [transcription] {return 1;} => 51",
        "src/skills/only/index.ts [skills.only] {return 1;} => 119",
        "other/thing.ts [gate] {const gate = 1;} => 10",
        "other/thing.ts [gate] {gate = 1} => 10",
        "src/config.ts [DEFAULT_MODEL] {const DEFAULT_MODEL = "opus";} => 105",
        "src/config.ts [DEFAULT_MODEL] {"DEFAULT_MODEL": "opus",} => 49",
        "src/model.ts [model] {this.model: string = compute();} => 27",
        "src/search/prefetch.test.ts [prefetch] {const prefetch = 1;} => 46",
        "docs/preflight.md [preflight] {preflight = 2} => 42",
        "src/search/preflight.ts [scoreHit] {export function scoreHit(h) {} => 35",
        "src/loop/index.ts [loop] {loop = 1} => 6.75",
        "builtin/workflows/edge-walk.ts [edge-walk] {const x = 1;} => 96",
        "node_modules/x/resolvePoppedSkills.ts [resolvePoppedSkills] {resolvePoppedSkills = 3} => 12",
      ]
    `);
  });

  it("pathPrefetchScore is stable across every weight branch and stack", () => {
    expect(
      PATH_CORPUS.map(
        (c) =>
          `${c.path} lines=${c.lines.length} terms=[${c.terms.join(",")}] => ${pathPrefetchScore(c.path, c.lines, c.terms)}`,
      ),
    ).toMatchInlineSnapshot(`
      [
        "src/cli.ts lines=1 terms=[] => 6",
        "./src/cli.ts lines=1 terms=[] => 6",
        "builtin/skills/x.ts lines=2 terms=[] => 6",
        "docs/guide.md lines=1 terms=[] => 1",
        "other/thing.ts lines=0 terms=[] => 0",
        "src/search/preflight.ts lines=1 terms=[] => -9",
        "src/search/prefetch.ts lines=1 terms=[] => -9",
        "src/a.test.ts lines=1 terms=[] => 1",
        "src/tests/a.ts lines=1 terms=[] => 1",
        "notes/readme.md lines=1 terms=[] => 0",
        "src/cli.ts lines=3 terms=[] => 8",
        "src/cli.ts lines=5 terms=[] => 10",
        "src/cli.ts lines=8 terms=[] => 10",
        "src/cli.ts lines=1 terms=[cli] => 6",
        "src/transcription/index.ts lines=1 terms=[transcription] => 20",
        "src/skills/only/index.ts lines=1 terms=[skills.only] => 10",
        "src/skills.only/skills/only.ts lines=1 terms=[skills.only] => 20",
        "src/search/preflight.ts lines=2 terms=[preflight,search,src,scoreHit] => 20",
        "src/Transcription/Index.ts lines=1 terms=[transcription] => 20",
        "docs/tests/preflight.md lines=2 terms=[preflight] => 11",
        "builtin/workflows/edge-walk.ts lines=1 terms=[edge-walk,workflows] => 33",
      ]
    `);
  });

  it("ranking ORDER over the corpus is stable (what actually reaches the model)", () => {
    const rankedHits = [...HIT_CORPUS]
      .sort((a, b) => scoreHit(b) - scoreHit(a))
      .map((h) => `${h.path} [${h.term}]`);
    expect(rankedHits).toMatchInlineSnapshot(`
      [
        "src/skills/only/index.ts [skills.only]",
        "src/config.ts [DEFAULT_MODEL]",
        "builtin/workflows/edge-walk.ts [edge-walk]",
        "src/transcription/index.ts [transcription]",
        "src/config.ts [DEFAULT_MODEL]",
        "src/search/prefetch.test.ts [prefetch]",
        "docs/preflight.md [preflight]",
        "src/search/preflight.ts [scoreHit]",
        "src/model.ts [model]",
        "node_modules/x/resolvePoppedSkills.ts [resolvePoppedSkills]",
        "other/thing.ts [gate]",
        "other/thing.ts [gate]",
        "src/loop/index.ts [loop]",
        "src/cli.ts [gate]",
        "./src/cli.ts [gate]",
        "builtin/skills/x.ts [gate]",
        "src/a.test.ts [gate]",
        "src/tests/a.ts [gate]",
        "other/thing.ts [gate]",
        "docs/guide.md [gate]",
        "docs/reference.md [gate]",
        "notes/readme.md [gate]",
        "node_modules/pkg/index.ts [gate]",
        "external/pkg/index.ts [gate]",
      ]
    `);

    const rankedPaths = [...PATH_CORPUS]
      .sort(
        (a, b) =>
          pathPrefetchScore(b.path, b.lines, b.terms) - pathPrefetchScore(a.path, a.lines, a.terms),
      )
      .map((c) => `${c.path} [${c.terms.join(",")}]`);
    expect(rankedPaths).toMatchInlineSnapshot(`
      [
        "builtin/workflows/edge-walk.ts [edge-walk,workflows]",
        "src/transcription/index.ts [transcription]",
        "src/skills.only/skills/only.ts [skills.only]",
        "src/search/preflight.ts [preflight,search,src,scoreHit]",
        "src/Transcription/Index.ts [transcription]",
        "docs/tests/preflight.md [preflight]",
        "src/cli.ts []",
        "src/cli.ts []",
        "src/skills/only/index.ts [skills.only]",
        "src/cli.ts []",
        "src/cli.ts []",
        "./src/cli.ts []",
        "builtin/skills/x.ts []",
        "src/cli.ts [cli]",
        "docs/guide.md []",
        "src/a.test.ts []",
        "src/tests/a.ts []",
        "other/thing.ts []",
        "notes/readme.md []",
        "src/search/preflight.ts []",
        "src/search/prefetch.ts []",
      ]
    `);
  });
});

describe("preflight — code outranks prose without repository-specific paths", () => {
  it("gives a source hit more weight than the same claim in markdown", () => {
    const source = hit("resolveThing", "src/resolve.ts", "resolveThing = createResolver()");
    const prose = hit("resolveThing", "notes/design.md", "resolveThing = createResolver()");
    expect(scoreHit(source)).toBeGreaterThan(scoreHit(prose));
  });
});
