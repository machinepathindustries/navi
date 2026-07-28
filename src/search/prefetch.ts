// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Deterministic MAP prefetch reads ranked candidates from disk without a model.
// Every open goes through resolveContainedPath, and ranking is query-relative.

import { readFileSync } from "node:fs";
import { match } from "ts-pattern";
import { Result } from "neverthrow";
import type { PreflightHit } from "./preflight.ts";
import { formatResolveErr, pathHasDeniedSegment, resolveContainedPath } from "../mastra/path-guard.ts";
import { errStr } from "../err.ts";
import { foldWeights, type Weighted } from "./weights.ts";

export type PrefetchedWindow = {
  path: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  text: string;
};

// Bounded MAP prefetch reads at most six hit files. Larger architecture questions
// still require the model's repository tools.
export const MAX_PREFETCH_FILES = 6;
const MAX_FILES = MAX_PREFETCH_FILES;
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 80;
const MAX_FILE_BYTES = 400_000;

const readText = Result.fromThrowable(
  (abs: string) => readFileSync(abs, "utf8"),
  errStr,
);

// Weights table + foldWeights, NOT match(): these predicates are ADDITIVE — several
// fire at once on the same path and their weights SUM (a `src/` test file takes both
// the +5 and the −5). match() selects exactly ONE arm, so using it here would
// silently change which files get prefetched.
const PATH_WEIGHTS: Weighted<string> = [
  [(p) => p.startsWith("src/"), 5],
  [(p) => p.startsWith("builtin/"), 4],
  [(p) => p.startsWith("docs/"), 1],
  [(p) => p.includes("search/preflight") || p.includes("search/prefetch"), -15],
  [(p) => p.includes(".test.") || p.includes("/tests/"), -5],
  [(p) => p.endsWith(".md"), -1],
];

// Per-term bonuses, also additive: a dotted term can match BOTH its literal form
// and its slash form in the same path, and every qualifying term contributes.
const TERM_PATH_WEIGHTS: Weighted<{ readonly path: string; readonly term: string }> = [
  [({ path, term }) => path.includes(term), 10],
  [({ path, term }) => path.includes(term.replace(/\./g, "/")), 4],
];

// Score paths against query terms, never product-specific topic names. Pure and
// IO-free; this score controls which files reach prefetch.
export function pathPrefetchScore(path: string, lines: number[], terms: string[]): number {
  const p = path.replace(/^\.\//, "");
  const lower = p.toLowerCase();
  // Terms under 4 chars are too generic to earn a path bonus at all.
  const termScore = terms
    .filter((t) => t.length >= 4)
    .reduce((sum, t) => sum + foldWeights(TERM_PATH_WEIGHTS, { path: lower, term: t.toLowerCase() }), 0);
  return foldWeights(PATH_WEIGHTS, p) + termScore + Math.min(lines.length, 5);
}

// The three rejection guards as a table (pure predicates over the path, no IO),
// so "keep" is one `.some` instead of three early returns. Order is irrelevant —
// each predicate is total and side-effect-free — and `.some` still short-circuits.
const HIT_PATH_REJECTS: ((p: string) => boolean)[] = [
  (p) => pathHasDeniedSegment(p),
  (p) => p.includes(".test.") || p.includes("/tests/"),
  (p) => p.endsWith(".md"),
];

function keepHitPath(path: string): boolean {
  return !HIT_PATH_REJECTS.some((reject) => reject(path));
}

// Pure in-memory grouping preserves hit order and each path's line order.
// A relaxed pass runs only when strict filtering leaves no candidates.
function groupHitsByPath(hits: PreflightHit[]): Map<string, number[]> {
  const admits = (h: PreflightHit, strict: boolean): boolean =>
    !pathHasDeniedSegment(h.path) && (!strict || keepHitPath(h.path));
  const group = (accepted: PreflightHit[]): Map<string, number[]> => {
    const byPath = new Map<string, number[]>();
    for (const h of accepted) {
      const lines = byPath.get(h.path) ?? [];
      lines.push(h.line);
      byPath.set(h.path, lines);
    }
    return byPath;
  };
  const strict = group(hits.filter((h) => admits(h, true)));
  return match(strict.size)
    .with(0, () => group(hits.filter((h) => admits(h, false))))
    .otherwise(() => strict);
}

// Shared window geometry for MAP and judge prefetch. Exported so both paths use
// the same bounded reader.
export function windowAroundAnchors(
  path: string,
  content: string,
  anchors: number[],
  opts?: { before?: number; after?: number; maxBytes?: number },
): PrefetchedWindow | null {
  const maxBytes = opts?.maxBytes ?? MAX_FILE_BYTES;
  // Reject oversized content before splitting it into lines.
  return match(content.length > maxBytes)
    .with(true, (): PrefetchedWindow | null => null)
    .with(false, (): PrefetchedWindow | null => {
      const lines = content.split(/\r?\n/);
      return match(lines.length)
        .with(0, (): PrefetchedWindow | null => null)
        .otherwise(() => {
          const before = opts?.before ?? CONTEXT_BEFORE;
          const after = opts?.after ?? CONTEXT_AFTER;
          const safeAnchors = match(anchors)
            .with([], () => [1])
            .otherwise((a) => a);
          const maxA = Math.max(...safeAnchors);
          // Bound a multi-anchor window: if a term recurs as both an early reference and a far
          // later assignment, don't balloon the window to the whole file — cover the LATER
          // cluster (usually the definitive assignment/override) plus context.
          // Near anchors still span fully.
          const minA = Math.max(Math.min(...safeAnchors), maxA - 200);
          const lineStart = Math.max(1, minA - before);
          const lineEnd = Math.min(lines.length, maxA + after);
          const text = lines
            .slice(lineStart - 1, lineEnd)
            .map((ln, i) => `${lineStart + i}|${ln}`)
            .join("\n");
          return { path, lineStart, lineEnd, totalLines: lines.length, text };
        });
    })
    .exhaustive();
}

// Path-guarded peek of a single file window. Model-free; Result-style via null on miss.
export function peekFileWindow(
  basePath: string,
  path: string,
  anchors: number[],
  opts?: { before?: number; after?: number },
): PrefetchedWindow | null {
  // Failure is an intentional collapse to null (best-effort prefetch).
  return resolveContainedPath(basePath, path)
    .mapErr(formatResolveErr)
    .andThen((abs) => readText(abs).mapErr((m) => m))
    .map((content) => windowAroundAnchors(path, content, anchors, opts))
    .match((w) => w, () => null);
}

function windowFor(path: string, content: string, anchors: number[]): PrefetchedWindow | null {
  return windowAroundAnchors(path, content, anchors);
}

export function prefetchTopHits(
  basePath: string,
  hits: PreflightHit[],
  maxFiles = MAX_FILES,
): PrefetchedWindow[] {
  const terms = [...new Set(hits.map((h) => h.term))];
  const byPath = groupHitsByPath(hits);
  const order = [...byPath.entries()]
    .map(([path, lines]) => ({ path, lines, score: pathPrefetchScore(path, lines, terms) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.path);

  // BOUNDED IO: cap the in-memory path order before opening files. The map performs
  // at most maxFiles reads; the following null filter is pure.
  return order
    .slice(0, maxFiles)
    .map((path) => {
      const anchors = byPath.get(path) ?? [1];
      // Failure is an intentional collapse to null (best-effort prefetch).
      return resolveContainedPath(basePath, path)
        .mapErr(formatResolveErr)
        .andThen((abs) => readText(abs).mapErr((m) => m))
        .map((content) => windowFor(path, content, anchors))
        .match((win) => win, () => null);
    })
    .filter((w): w is PrefetchedWindow => w !== null);
}

export function renderPrefetchBlock(windows: PrefetchedWindow[], durationMs: number): string {
  return match(windows)
    .with([], () =>
      [
        "## Deterministic MAP prefetch",
        "(no files prefetched — use tools to open candidates)",
        `prefetch ${durationMs}ms`,
      ].join("\n"),
    )
    .otherwise((ws) => {
      const parts = [
        "## Deterministic MAP prefetch (model-free file windows)",
        "These are REAL file contents read from disk at query time — same evidence a",
        "`view` tool would return for these line ranges. You MAY cite lines inside these",
        "windows without another view ONLY when they actually answer the question.",
        "If the prefetched windows do not answer the question, say so and search further",
        "— never stretch a prefetched line into relevance.",
        "For lines outside a window, call view/search_content/parallel_view.",
        "Do NOT re-open the same window. Prefer answering when two independent lanes",
        "are already present and on-topic.",
        `Prefetched ${ws.length} file(s) · ${durationMs}ms`,
        "",
      ];
      for (const w of ws) {
        parts.push(`### ${w.path} (lines ${w.lineStart}–${w.lineEnd} of ${w.totalLines})`);
        parts.push("```");
        parts.push(w.text);
        parts.push("```");
        parts.push("");
      }
      return parts.join("\n");
    });
}
