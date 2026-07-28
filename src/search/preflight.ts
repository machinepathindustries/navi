// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Deterministic index preflight for bare code search.
// Model-free: extract target nouns → fan out ripgrep → compact candidate digest.
//
// Fallible IO is Result-wrapped at the boundary; branching uses match().
// Honesty rail: digest is a MAP, not evidence (unless a later prefetch window
// re-reads the same lines as real file bytes).

import { spawnSync } from "node:child_process";
import { match, P } from "ts-pattern";
import { Result, ok, err } from "neverthrow";
import {
  deniedRgGlobs,
  filterAllowedHits,
  pathHasDeniedSegment,
} from "../mastra/path-guard.ts";
import { errStr } from "../err.ts";
import { foldWeights, type Weighted } from "./weights.ts";

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "where", "when",
  "how", "does", "into", "about", "which", "are", "is", "a", "an", "of", "to",
  "in", "on", "or", "by", "as", "be", "it", "its", "you", "your", "can", "do",
  "did", "was", "were", "will", "would", "should", "could", "have", "has", "had",
  "not", "any", "all", "code", "file", "files", "repo", "repository", "project",
  "function", "class", "method", "please", "show", "find", "explain", "trace",
  "work", "works", "working", "implement", "implementation", "using", "used",
  "use", "via", "between", "across", "under", "over", "there", "their", "them",
  "then", "than", "also", "just", "only", "same", "other", "each", "both",
  "such", "like", "need", "needs", "want", "know", "look", "looking",
]);

const GENERIC_SEGMENTS = new Set(["src", "dist", "test", "tests", "docs", "lib", "bin"]);
const WEAK_TERMS = new Set([
  "loop", "case", "skip", "continue", "match", "matches", "when", "then", "with",
]);

// Keep exact technical tokens: camelCase, snake_case, dotted paths, flags.
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_./:-]{2,}/g;
const HIT_LINE_RE = /^(.*?):(\d+):(.*)$/;

export type PreflightHit = {
  term: string;
  path: string;
  line: number;
  text: string;
};

export type PreflightDigest = {
  terms: string[];
  hits: PreflightHit[];
  durationMs: number;
  text: string;
};

// Pure noun extraction; preserves the first spelling of each case-insensitive term.
export function extractSearchTerms(query: string, limit = 8): string[] {
  // All work is in memory: drop stop/generic words, dedupe, then apply the cap.
  const kept = (query.match(TOKEN_RE) ?? []).filter((t) => {
    const lower = t.toLowerCase();
    return !STOP.has(lower) && !GENERIC_SEGMENTS.has(lower);
  });
  const lower = kept.map((t) => t.toLowerCase());
  return kept.filter((_, i) => lower.indexOf(lower[i]!) === i).slice(0, limit);
}

// spawnSync is total for our purposes: error / bad status → Err; exit 0|1 → Ok(stdout).
const runRgStdout = Result.fromThrowable(
  (term: string, basePath: string, rawLimit: number): string => {
    const r = spawnSync(
      "rg",
      [
        "-n", "--no-heading", "--color", "never", "-S",
        // --sort path makes the walk DETERMINISTIC (the default parallel walk
        // returns files in nondeterministic order, so the per-term cap below could
        // keep a different — and wrong — file set run to run; this module is the
        // "deterministic INDEX preflight"). Alphabetical path order also means a
        // subsystem's own files (src/transcription/*) sort together, so the on-path
        // cap keeps the specific files (index.ts, deepgram.ts) not the alphabetical
        // stragglers.
        "--sort", "path",
        "-m", String(rawLimit),
        ...deniedRgGlobs(),
        "-g", "!**/*.{map,lock,min.js}",
        "--", term, ".",
      ],
      { cwd: basePath, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    // Spawn error, successful rg exit (0/1), and failure exit form a closed dispatch.
    // Throws remain inside the Result.fromThrowable boundary.
    return match(r)
      .with({ error: P.nonNullable }, (spawnErr): string => {
        throw spawnErr.error;
      })
      .with({ status: P.union(0, 1) }, (okRun): string => okRun.stdout ?? "")
      .otherwise((badExit): string => {
        throw new Error(`rg exit ${badExit.status}: ${(badExit.stderr ?? "").slice(0, 200)}`);
      });
  },
  errStr,
);

function parseHitLine(term: string, line: string): Result<PreflightHit, string> {
  const m = line.match(HIT_LINE_RE);
  return match(m)
    .with(P.nullish, () => err<PreflightHit, string>("unparseable rg line"))
    .otherwise((groups) =>
      // path (group 1) and text (group 3) are always captured on a HIT_LINE_RE match;
      // narrowing them here EARNS the string type instead of asserting with `!`, and
      // the impossible undefined case returns err rather than crashing on .slice.
      match([groups[1], groups[3]])
        .with([P.string, P.string], ([path, text]) =>
          ok<PreflightHit, string>({ term, path, line: Number(groups[2]), text: text.slice(0, 200) }),
        )
        .otherwise(() => err<PreflightHit, string>("unparseable rg line")),
    );
}

// The strongest specificity signal: the term appears in the file's PATH (a
// `transcription` hit in `src/transcription/index.ts`). Mirrors scoreHit's path
// bonus, including the dotted-path → slash form (`a.b` also matches `a/b`).
function pathMatchesTerm(path: string, term: string): boolean {
  const p = path.toLowerCase();
  const t = term.toLowerCase();
  return p.includes(t) || p.includes(t.replace(/\./g, "/"));
}

// An "assignment-shaped" hit: the term is the DIRECT target of an assignment or typed
// declaration at statement start — `self.X =`, `this.X =`, `X =`, `const|let|var|val X
// =`, `X: T =`. This is the DEFINITIVE site of a value/behavior. It EXCLUDES a
// DEFAULTS/dict entry (`"X": …`, `D['X'] = …` — those start with the container, not the
// term) and a comparison (`X ==`). Keeping this site alongside the first reference
// lets runtime-value queries reach the defining override.
function isAssignmentHit(hit: PreflightHit): boolean {
  const term = hit.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|readonly\\s+)?(?:const\\s+|let\\s+|var\\s+|val\\s+|final\\s+)?(?:self\\.|this\\.)?${term}\\b\\s*(?::[^=\\n]*)?=(?!=)`,
    "i",
  );
  return re.test(hit.text.trim());
}

// Conditional set membership without a branch: an empty selection writes nothing.
function addWhen(when: boolean, set: Set<string>, value: string): void {
  [value].filter(() => when).forEach((v) => set.add(v));
}

function runRg(term: string, basePath: string, maxHits: number): PreflightHit[] {
  // Wider raw set, then path-diversify so one file cannot monopolize a term.
  const rawLimit = Math.max(maxHits * 6, 24);
  return runRgStdout(term, basePath, rawLimit).match(
    (stdout) => {
      // The rg spawn already happened; parsing and denylist filtering below are
      // pure in-memory work. Unparseable lines contribute no hits.
      const parsed = stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) =>
          parseHitLine(term, line).match(
            (hit) => [hit],
            () => [] as PreflightHit[],
          ),
        )
        // Case-insensitive denylist belt (path-guard ONE owner).
        .filter((hit) => !pathHasDeniedSegment(hit.path));

      const pathSeen = new Set<string>();
      const assignSeen = new Set<string>();
      const seen = new Set<string>();
      const ordered: PreflightHit[] = [];
      for (const hit of parsed) {
        const key = `${hit.path}:${hit.line}`;
        const firstForPath = !pathSeen.has(hit.path);
        const assignment = isAssignmentHit(hit);
        // Keep the first hit per path and the file's first assignment-shaped hit.
        // The two anchors let prefetch include both the reference and defining value.
        const keep = !seen.has(key) && (firstForPath || (assignment && !assignSeen.has(hit.path)));
        match(keep)
          .with(false, () => undefined)
          .with(true, () => {
            seen.add(key);
            // Re-marking a path is idempotent; the set records admission only.
            pathSeen.add(hit.path);
            addWhen(assignment, assignSeen, hit.path);
            ordered.push(hit);
          })
          .exhaustive();
      }
      // Per-term cap in rg TRAVERSAL order would drop the on-path file (it sorts
      // alphabetically after other dirs that merely mention the word). Float
      // path-relevant hits ahead of the cap so the specific file survives to the
      // global scoreHit ranking (where its +12 path bonus wins). Stable within
      // each group (filter preserves traversal order).
      const allowed = filterAllowedHits(ordered);
      // Float on-path, assignment, and src/ hits ahead of the per-term cap. These
      // candidates may sort after prose references, but global ranking needs to see
      // them. Filter order remains stable within each group.
      const isPriority = (h: PreflightHit) =>
        pathMatchesTerm(h.path, term) || isAssignmentHit(h) || h.path.replace(/^\.\//, "").startsWith("src/");
      const priority = allowed.filter(isPriority);
      const rest = allowed.filter((h) => !isPriority(h));
      return [...priority, ...rest].slice(0, maxHits);
    },
    // Degrade to empty on rg failure — preflight is best-effort INDEX, not a gate.
    () => [] as PreflightHit[],
  );
}

// Weights table + foldWeights, NOT match(): these predicates are ADDITIVE — several
// fire at once on the same term and their weights SUM (a dotted camelCase name earns
// both). match() selects exactly ONE arm, so using it here would silently change
// retrieval ranking. Only the length bucketing below is a genuine dispatch.
const TERM_WEIGHTS: Weighted<string> = [
  [(t) => t.includes("-") || t.includes(".") || t.includes("_"), 4],
  [(t) => /[a-z][A-Z]/.test(t), 3],
];

// The one real dispatch in this module: the length buckets are MUTUALLY
// EXCLUSIVE (>=10 wins over >=7), so it is a match(), ordered longest-first.
const lengthBonus = (len: number): number =>
  match(len)
    .with(P.number.gte(10), () => 2)
    .with(P.number.gte(7), () => 1)
    .otherwise(() => 0);

// Pure scoring with no IO; this weight directly controls retrieval ranking.
export function termWeight(term: string): number {
  return match(WEAK_TERMS.has(term.toLowerCase()))
    .with(true, () => 0.25)
    .with(false, () => 1 + foldWeights(TERM_WEIGHTS, term) + lengthBonus(term.length))
    .exhaustive();
}

// Path/text signals for one hit. Additive, same reasoning as TERM_WEIGHTS.
type ScoredHit = { readonly hit: PreflightHit; readonly path: string };

const HIT_WEIGHTS: Weighted<ScoredHit> = [
  [({ path }) => path.startsWith("src/"), 5],
  [({ path }) => path.startsWith("builtin/"), 4],
  [({ path }) => path.startsWith("docs/"), 1],
  [({ path }) => path.includes(".test.") || path.includes("/tests/"), -4],
  [({ path }) => path.endsWith(".md"), -2],
  [({ path }) => path.includes("node_modules") || path.includes("external/"), -20],
  [
    ({ path, hit }) =>
      path.toLowerCase().includes(hit.term.toLowerCase().replace(/\./g, "/")) ||
      path.toLowerCase().includes(hit.term.toLowerCase()),
    12,
  ],
  [({ hit }) => hit.text.toLowerCase().includes(hit.term.toLowerCase()), 2],
  // The definitive value site (an assignment/override) outranks a mere reference or
  // a DEFAULTS/dict entry for the same term, so it reaches the top cut and its
  // prefetch window carries the real value.
  [({ hit }) => isAssignmentHit(hit), 8],
];

export function scoreHit(h: PreflightHit): number {
  return foldWeights(HIT_WEIGHTS, { hit: h, path: h.path.replace(/^\.\//, "") }) * termWeight(h.term);
}

// Pure: `hits` is already in memory and scoreHit does no IO, so first-wins dedupe
// is a `.filter` and the cap is a `.slice` — no read is made eager by ranking.
// Rank globally, but seat each term's best hit first so one common term cannot
// consume the digest. Diversity fills the first seats; score fills the remainder.
function rankUnique(hits: PreflightHit[], maxHits: number): PreflightHit[] {
  const ranked = [...hits].sort((a, b) => scoreHit(b) - scoreHit(a));
  const keys = ranked.map((h) => `${h.path}:${h.line}`);
  const unique = ranked.filter((_, i) => keys.indexOf(keys[i]!) === i);
  const seeds = unique.filter((h, i) => unique.findIndex((o) => o.term === h.term) === i);
  const seeded = seeds.slice(0, maxHits);
  const rest = unique.filter((h) => !seeded.includes(h));
  return [...seeded, ...rest].slice(0, maxHits);
}

// Caller-enrichment budget: the loop STOPS spawning rg once this many extra hits
// have been collected (the IO bound this function is written around).
const CALLER_HITS_CAP = 4;

function enrichCallers(
  terms: string[],
  primary: PreflightHit[],
  basePath: string,
  hitsPerTerm: number,
): PreflightHit[] {
  const seen = new Set(primary.map((h) => `${h.path}:${h.line}`));
  const primaryPaths = new Set(primary.slice(0, 2).map((h) => h.path));
  const heads = terms.slice(0, 2);
  const callerHits: PreflightHit[] = [];
  let i = 0;
  // BOUNDED IO: the loop condition prevents another rg spawn once the budget is
  // full. Per-batch filtering is pure because that term's rg process has completed.
  while (callerHits.length < CALLER_HITS_CAP && i < heads.length) {
    const fresh = runRg(heads[i]!, basePath, hitsPerTerm + 4).filter(
      (h) =>
        !primaryPaths.has(h.path) &&
        !h.path.includes(".test.") &&
        !h.path.includes("/tests/") &&
        !seen.has(`${h.path}:${h.line}`),
    );
    // Admit only the remaining budget from this batch.
    const take = fresh.slice(0, CALLER_HITS_CAP - callerHits.length);
    take.forEach((h) => seen.add(`${h.path}:${h.line}`));
    callerHits.push(...take);
    i++;
  }
  return callerHits;
}

// The deterministic INDEX requires ripgrep. Probe once per process so callers can
// distinguish a missing binary from a repository with zero matches.
let rgProbe: boolean | undefined;
export function ripgrepAvailable(): boolean {
  return match(rgProbe)
    .with(P.nullish, () => {
      rgProbe = spawnSync("rg", ["--version"], { encoding: "utf8" }).status === 0;
      return rgProbe;
    })
    .otherwise((v) => v);
}

export function buildPreflightDigest(
  query: string,
  basePath: string,
  opts: { termsPerQuery?: number; hitsPerTerm?: number; maxHits?: number } = {},
): PreflightDigest {
  const t0 = Date.now();
  const termsPerQuery = opts.termsPerQuery ?? 5;
  const hitsPerTerm = opts.hitsPerTerm ?? 4;
  const maxHits = opts.maxHits ?? 8;

  const terms = extractSearchTerms(query, termsPerQuery);
  const all = terms.flatMap((term) => runRg(term, basePath, hitsPerTerm));
  const primary = rankUnique(all, maxHits);
  const callerHits = enrichCallers(terms, primary, basePath, hitsPerTerm);
  const merged = [...primary, ...callerHits].slice(0, maxHits + 4);
  const durationMs = Date.now() - t0;
  return {
    terms,
    hits: merged,
    durationMs,
    text: renderDigest({ terms, hits: merged, durationMs }),
  };
}

function renderDigest(d: {
  terms: string[];
  hits: PreflightHit[];
  durationMs: number;
}): string {
  const header = [
    "## Deterministic INDEX preflight (model-free)",
    "Candidate MAP from local ripgrep. Hit lines alone are NOT evidence — but a",
    "following MAP prefetch block (if present) contains real file windows you may cite.",
    "",
    "When MAP prefetch is present: answer from those windows in the FIRST model step",
    "if two independent lanes are covered. Do not re-open the same windows.",
    "When you still need tools: prefer multi_search / parallel_view compound tools.",
    "",
    `Terms searched: ${match(d.terms)
      .with([], () => "(none extracted)")
      .otherwise((terms) => terms.map((t) => `\`${t}\``).join(", "))}`,
    `Hits shown: ${d.hits.length} · preflight ${d.durationMs}ms`,
    "",
    "### Top candidate hits (defs + refs)",
  ];

  const body = match(d.hits)
    .with([], () => [
      "(no hits — run your own INDEX with spelling/casing variants; do not invent sources)",
    ])
    .otherwise((hits) =>
      hits.map((h) => `- \`${h.path}:${h.line}\` [term=\`${h.term}\`] ${h.text.trim()}`),
    );

  return [...header, ...body].join("\n");
}
