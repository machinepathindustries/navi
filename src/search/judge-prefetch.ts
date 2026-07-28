// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// DETERMINISTIC pre-pass (no model): derive cited locations from the event +
// prior SessionState + recon/expand surfaces, peek real current file bytes, and
// inject a clearly-labeled head-start block into the edge-walk judge prompt.
//
// Safety rails:
// - Hybrid: judge KEEPS view + search_content; an incomplete/missing window
//   must fall back to re-read, never force a false verdict.
// - Honesty: label prefetched bytes as a head start, never a verdict or evidence.
//   The adjudication skill still makes the independent weak-vs-strong decision.
// - DEFAULT-ON: enabled unless NAVI_JUDGE_PREFETCH is "0"/"off"/"false" (an
//   emergency disable, not an opt-in).
// - Scope: edge-walk judge step only (wired in compile.ts).
//
// Peek/window helpers: reuse src/search/prefetch.ts. Parse + dedupe + inject
// orchestration lives HERE.

import { match, P } from "ts-pattern";
import { peekFileWindow, type PrefetchedWindow } from "./prefetch.ts";
import { pathHasDeniedSegment } from "../mastra/path-guard.ts";

export type CiteLocation = {
  uri: string;
  /** Inclusive 1-based line; omitted/undefined = whole-file-bounded peek. */
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  /** Where this cite was derived from (debug / stderr). */
  source: string;
};

export type JudgePrefetchResult = {
  locations: CiteLocation[];
  windows: PrefetchedWindow[];
  block: string;
  durationMs: number;
};

// Bounded peeks — same geometry family as MAP prefetch, slightly wider so a
// required_evidence cite at a mid-file line still shows surrounding branch body.
const CTX_BEFORE = 50;
const CTX_AFTER = 100;
/** When only a path is known (targets[], bare filename), cap whole-file peeks. */
const FULL_FILE_MAX_LINES = 250;
const MAX_WINDOWS = 16;
const MAX_BLOCK_CHARS = 180_000;

const CODE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|md|yaml|yml|json|toml|vue|svelte";
// path.ext optional :line or :start-end — used on free-form surfaces / required_evidence.
const LOC_RE = new RegExp(
  String.raw`(?:^|[\s\`"'(\[{,;])((?:[\w.@-]+/)*[\w.@-]+\.(?:${CODE_EXT}))(?::(\d+)(?:-(\d+))?)?`,
  "gi",
);

// NAVI_JUDGE_PREFETCH is an emergency disable: the head start ships enabled;
// only an explicit
// "0"/"off"/"false" turns it off. Scope stays the edge-walk judge step alone.
export function judgePrefetchEnabled(wfName: string, stepName: string): boolean {
  // Read the environment only inside the in-scope workflow/step arm.
  return match({ wfName, stepName })
    .with({ wfName: "edge-walk", stepName: "judge" }, () => {
      const v = (process.env.NAVI_JUDGE_PREFETCH ?? "").trim().toLowerCase();
      return v !== "0" && v !== "off" && v !== "false";
    })
    .otherwise(() => false);
}

function normalizeUri(raw: string): string | null {
  // Strip common wrappers from free text.
  const u = raw.trim().replace(/^\.\//, "").replace(/^['"`([]+|['"`)\]]+$/g, "");
  // URI rejections are ordered from invalid/denied to external and absolute paths.
  return match(u)
    .when(
      (s) => s === "" || pathHasDeniedSegment(s),
      (): string | null => null,
    )
    // Reject pure URL schemes and absolute OS paths outside typical workspace rels.
    .when(
      (s) => /^[a-z]+:\/\//i.test(s),
      (): string | null => null,
    )
    .when(
      (s) => s.startsWith("/") && !s.startsWith("./"),
      (s): string | null => {
        // Keep only if it looks like a workspace-relative path that happened to be absolute-ish.
        // Prefer relative forms; drop absolute absolute paths (path-guard will also refuse escapes).
        const base = s.replace(/^\/+/, "");
        return match(base.includes("."))
          .with(true, (): string | null => base)
          .with(false, (): string | null => null)
          .exhaustive();
      },
    )
    .otherwise((s): string | null => s);
}

/** A numeric field, or undefined when the value is any other type. */
function numField(v: unknown): number | undefined {
  return match(v)
    .with(P.number, (n) => n)
    .otherwise((): number | undefined => undefined);
}

/** A regex capture group as a number; absent/empty group => undefined. */
function groupNumber(raw: string | undefined): number | undefined {
  return match(raw)
    .with(P.nullish, (): number | undefined => undefined)
    .with("", (): number | undefined => undefined)
    .otherwise((s) => Number(s));
}

/** Drop a line number that is absent, below 1, or non-finite. */
function validLine(n: number | undefined): number | undefined {
  return match(n != null && n >= 1 && Number.isFinite(n))
    .with(true, (): number | undefined => n)
    .with(false, (): number | undefined => undefined)
    .exhaustive();
}

/** An end before its start collapses onto the start. */
function clampEnd(ls: number | undefined, le: number | undefined): number | undefined {
  return match(ls != null && le != null && le < ls)
    .with(true, (): number | undefined => ls)
    .with(false, (): number | undefined => le)
    .exhaustive();
}

function pushLoc(
  out: CiteLocation[],
  uriRaw: string,
  lineStart: number | undefined,
  lineEnd: number | undefined,
  source: string,
): void {
  const ls = validLine(lineStart);
  const le = clampEnd(ls, validLine(lineEnd));
  // A denied / unparseable uri contributes nothing: an empty selection pushes nothing.
  // (Line normalization above is pure, so hoisting it past the uri guard is invisible.)
  [normalizeUri(uriRaw)]
    .filter((uri): uri is string => uri !== null)
    .forEach((uri) => out.push({ uri, lineStart: ls, lineEnd: le ?? ls, source }));
}

/** Parse file:line / file:start-end / bare path tokens from free text. */
export function parseLocationsFromText(text: string, source: string): CiteLocation[] {
  // Non-string / empty input yields nothing — the arm is lazy, so the scan never starts.
  return match(typeof text === "string" && text !== "")
    .with(false, (): CiteLocation[] => [])
    .with(true, () => {
      const out: CiteLocation[] = [];
      LOC_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LOC_RE.exec(text)) !== null) {
        const a = groupNumber(m[2]);
        pushLoc(out, m[1]!, a, groupNumber(m[3]) ?? a, source);
      }
      return out;
    })
    .exhaustive();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A record value, or an empty record when it is anything else. */
function asRecord(v: unknown): Record<string, unknown> {
  return [v].filter(isRecord)[0] ?? {};
}

/** The explicit `event` key when present, else the stdin root itself. */
function eventFrom(stdin: Record<string, unknown>): unknown {
  return match("event" in stdin)
    .with(true, (): unknown => stdin.event)
    .with(false, (): unknown => stdin)
    .exhaustive();
}

/** Huge opaque blobs that are never location carriers. */
const SKIP_KEYS = new Set(["turn_history", "parent_events"]);
/** Fields already handled as structured cites — never double-walked. */
const STRUCTURED_KEYS = new Set(["uri", "file", "command"]);

/** Walk any JSON-ish value for uri/file cites + free-text file:line tokens. */
function collectCitesDeep(v: unknown, source: string, out: CiteLocation[], depth = 0): void {
  // Closed dispatch over depth and JSON value shape.
  match({ overDepth: depth > 8, v })
    .with({ overDepth: true }, () => undefined)
    .with({ v: P.nullish }, () => undefined)
    .with({ v: P.string }, ({ v: s }) => {
      out.push(...parseLocationsFromText(s, source));
    })
    .with({ v: P.array() }, ({ v: arr }) => {
      arr.forEach((el, i) => collectCitesDeep(el, `${source}[${i}]`, out, depth + 1));
    })
    .otherwise(({ v: val }) => {
      // Non-record leftovers (number/boolean/function) contribute nothing.
      [val].filter(isRecord).forEach((rec) => collectRecordCites(rec, source, out, depth));
    });
}

// Structured cite shapes are additive: one record may contribute uri, file, and
// command locations. Independent lazy selections preserve all carriers; key walk
// runs last.
function collectRecordCites(
  v: Record<string, unknown>,
  source: string,
  out: CiteLocation[],
  depth: number,
): void {
  // Structured Evidence / plan.citations / finding shapes
  [v.uri]
    .filter((u): u is string => typeof u === "string")
    .forEach((uri) => pushLoc(out, uri, numField(v.line_start), numField(v.line_end), source));
  [v.file]
    .filter((f): f is string => typeof f === "string")
    .forEach((file) => pushLoc(out, file, numField(v.line), numField(v.line), source));
  [v.command]
    .filter((c): c is string => typeof c === "string")
    .forEach((cmd) => out.push(...parseLocationsFromText(cmd, `${source}.command`)));

  Object.entries(v)
    .filter(([k]) => !SKIP_KEYS.has(k) && !STRUCTURED_KEYS.has(k))
    .forEach(([k, val]) => collectCitesDeep(val, `${source}.${k}`, out, depth + 1));
}

/**
 * Derive cited locations from ALL of:
 * - event evidence[] (uri + line ranges; commands for test files)
 * - prior SessionState directives[].required_evidence + targets[] + evidence[]
 * - prior findings[].evidence, surface_map strings
 * - recon/expand step outputs (file:line facts in any string field)
 */
export function deriveCitedLocations(ctx: {
  event?: unknown;
  prior?: unknown;
  recon?: unknown;
  expand?: unknown;
}): CiteLocation[] {
  const raw: CiteLocation[] = [];

  // Each surface is an independent contribution, so its presence guard is a lazy
  // selection over a one-element list — never a branch.
  // 1) Parent event (evidence[] + plan.citations + free-text file:line)
  [ctx.event].filter((v) => v != null).forEach((v) => collectCitesDeep(v, "event", raw));

  // 2) Prior SessionState — founder rail: targets + required_evidence + evidence
  //    (deep walk covers surface_map, findings, directive prose)
  [ctx.prior]
    .filter((v) => v != null)
    .forEach((prior) => {
      collectCitesDeep(prior, "prior", raw);
      // Bare targets that are just "handler.ts" with no extension parse edge cases:
      // ensure directive.targets always register even if LOC_RE is picky.
      collectDirectiveTargets(prior, raw);
    });

  // 3) This-run recon / expand surfaces (file:line facts)
  [ctx.recon]
    .filter((v) => v != null && v !== "")
    .forEach((v) => collectCitesDeep(v, "steps.recon", raw));
  [ctx.expand]
    .filter((v) => v != null && v !== "")
    .forEach((v) => collectCitesDeep(v, "steps.expand", raw));

  return dedupeLocations(raw);
}

/** `v` when it is an array, else an empty array (pure shape read, no dispatch value). */
function asArray(v: unknown): unknown[] {
  return match(v)
    .with(P.array(), (a) => a)
    .otherwise((): unknown[] => []);
}

// Target parsing is pure and in-memory. Only targets with no parsed location fall
// back to a whole-file cite.
function collectDirectiveTargets(prior: unknown, raw: CiteLocation[]): void {
  [prior]
    .filter(isRecord)
    .flatMap((p) => asArray(p.directives))
    .filter(isRecord)
    .filter((d) => Array.isArray(d.targets))
    .forEach((d) => {
      const id = match(d.id)
        .with(P.string, (s) => s)
        .otherwise(() => "?");
      const source = `prior.directive[${id}].targets`;
      asArray(d.targets)
        .filter((t): t is string => typeof t === "string")
        .forEach((t) =>
          [t]
            .filter(() => parseLocationsFromText(t, source).length === 0)
            .forEach((bare) => pushLoc(raw, bare, undefined, undefined, source)),
        );
    });
}

/** Dedupe by (uri, line-range); merge overlapping/adjacent ranges on the same uri. */
export function dedupeLocations(locs: CiteLocation[]): CiteLocation[] {
  type Range = { start: number; end: number; sources: string[] };
  const byUri = new Map<string, { whole: string[]; ranges: Range[] }>();

  for (const loc of locs) {
    const uri = loc.uri;
    // Re-setting the same bucket preserves Map insertion order.
    const bucket = byUri.get(uri) ?? { whole: [], ranges: [] };
    byUri.set(uri, bucket);
    // A cite is either whole-file or a range — a closed two-way dispatch on lineStart.
    match(loc.lineStart)
      .with(P.nullish, () => {
        bucket.whole.push(loc.source);
      })
      .otherwise((start) => {
        bucket.ranges.push({ start, end: loc.lineEnd ?? start, sources: [loc.source] });
      });
  }

  const out: CiteLocation[] = [];
  for (const [uri, bucket] of byUri) {
    // Merge ranges (sort + coalesce overlaps / near-adjacent within 20 lines).
    bucket.ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    // The coalesce is a fold: each range either extends the open one or opens a new
    // one. match() on {last, mergeable} narrows `last` for the extend arm.
    const merged = bucket.ranges.reduce<Range[]>((acc, r) => {
      const last = acc[acc.length - 1];
      match({ last, mergeable: last != null && r.start <= last.end + 20 })
        .with({ mergeable: true, last: P.nonNullable }, ({ last: l }) => {
          l.end = Math.max(l.end, r.end);
          l.sources.push(...r.sources);
        })
        .otherwise(() => {
          acc.push({ ...r, sources: [...r.sources] });
        });
      return acc;
    }, []);

    // Specific ranges supersede a whole-file request. A whole-file-only bucket emits
    // one line-less location; an empty bucket emits nothing.
    match({ whole: bucket.whole.length > 0, merged: merged.length })
      .with({ whole: true, merged: 0 }, () => {
        out.push({ uri, source: bucket.whole[0]! });
      })
      .otherwise(() => {
        merged.forEach((r) =>
          out.push({
            uri,
            lineStart: r.start,
            lineEnd: r.end,
            source: r.sources[0]!,
          }),
        );
      });
  }

  // Stable order: by uri then line
  out.sort((a, b) => a.uri.localeCompare(b.uri) || (a.lineStart ?? 0) - (b.lineStart ?? 0));
  return out;
}

type PeekGeometry = { anchors: number[]; opts: { before: number; after: number } };

/** Window geometry per cite: a line-anchored peek, or a bounded whole-file peek. */
function peekGeometry(lineStart: number | undefined, lineEnd: number | undefined): PeekGeometry {
  return match(lineStart)
    .with(P.nullish, (): PeekGeometry => ({
      anchors: [1],
      opts: { before: 0, after: FULL_FILE_MAX_LINES - 1 },
    }))
    .otherwise((start): PeekGeometry => ({
      anchors: [start, lineEnd ?? start],
      opts: { before: CTX_BEFORE, after: CTX_AFTER },
    }));
}

// Try basename-only if uri was nested incorrectly (e.g. src/handler.ts in a src workspace).
// The peek sits inside a lazy match arm, so a uri with no distinct basename costs NO read.
function peekByBasename(basePath: string, uri: string, geo: PeekGeometry): PrefetchedWindow | null {
  const base = match(uri.includes("/"))
    .with(true, () => uri.split("/").pop()!)
    .with(false, () => "")
    .exhaustive();
  return match(base !== "" && base !== uri)
    .with(true, () => peekFileWindow(basePath, base, geo.anchors, geo.opts))
    .with(false, (): PrefetchedWindow | null => null)
    .exhaustive();
}

export function peekCitedLocations(basePath: string, locations: CiteLocation[]): PrefetchedWindow[] {
  const windows: PrefetchedWindow[] = [];
  const seen = new Set<string>();

  // BOUNDED IO: the loop condition permits at most MAX_WINDOWS successful reads.
  // Basename fallback is lazy and runs only when the primary peek misses.
  let i = 0;
  while (windows.length < MAX_WINDOWS && i < locations.length) {
    const loc = locations[i]!;
    i++;
    const geo = peekGeometry(loc.lineStart, loc.lineEnd);
    const w =
      peekFileWindow(basePath, loc.uri, geo.anchors, geo.opts) ??
      peekByBasename(basePath, loc.uri, geo);
    // Post-read admission is pure: a miss or an already-seen window contributes nothing.
    [w]
      .filter((win): win is PrefetchedWindow => win !== null)
      .filter((win) => !seen.has(`${win.path}:${win.lineStart}-${win.lineEnd}`))
      .forEach((win) => {
        seen.add(`${win.path}:${win.lineStart}-${win.lineEnd}`);
        windows.push(win);
      });
  }
  return windows;
}

/**
 * Exact founder-facing label (honesty rail). NEVER "pre-judged", "verified", or
 * "evidence". Tools remain available; this is a head start only.
 */
export const JUDGE_PREFETCH_HEADER =
  "PRE-FETCHED CONTENT at the cited locations (real current file content — verify further as needed; this is a head start, not a verdict)";

export function renderJudgePrefetchBlock(windows: PrefetchedWindow[], durationMs: number): string {
  return match(windows)
    .with([], () =>
      [
        `## ${JUDGE_PREFETCH_HEADER}`,
        "(no locations could be peeked — use view/search_content to re-read cited files)",
        `prefetch ${durationMs}ms · 0 windows`,
      ].join("\n"),
    )
    .otherwise((ws) => {
      const parts = [
        `## ${JUDGE_PREFETCH_HEADER}`,
        "",
        "These bytes were read model-free from disk at the locations derived from the",
        "event evidence, open directive targets/required_evidence, and recon/expand",
        "surface strings. They are a HEAD START for re-reading — NOT a verdict and",
        "NOT automatically sufficient. Apply the five-check test yourself.",
        "If a needed line is outside these windows, or coverage of a claim is unclear,",
        "call view / search_content yourself. A green test in a window does NOT prove",
        "the directive is satisfied — check what the test actually exercises.",
        `Windows: ${ws.length} · ${durationMs}ms`,
        "",
      ];
      let chars = parts.join("\n").length;
      // Stop rendering after the first chunk that would exceed the character budget.
      let i = 0;
      let truncated = false;
      while (!truncated && i < ws.length) {
        const w = ws[i]!;
        i++;
        const chunk = [
          `### ${w.path} (lines ${w.lineStart}–${w.lineEnd} of ${w.totalLines})`,
          "```",
          w.text,
          "```",
          "",
        ].join("\n");
        match(chars + chunk.length > MAX_BLOCK_CHARS)
          .with(true, () => {
            parts.push(`(truncated: remaining windows omitted to stay under ${MAX_BLOCK_CHARS} chars)`);
            truncated = true;
          })
          .with(false, () => {
            parts.push(chunk);
            chars += chunk.length;
          })
          .exhaustive();
      }
      return parts.join("\n");
    });
}

/**
 * Full assemble from step prompt context (compile.ts buildCtx).
 *
 * buildCtx shape: `{ input: <stdin payload after spread>, steps, prior, revision, ... }`.
 * After `.passthrough()` + reserved inject + spread, `ctx.input` is the stdin object
 * (`{ event: ... }`) and `ctx.prior` is the SessionState (or null).
 */
export function assembleJudgePrefetch(
  basePath: string,
  ctx: Record<string, unknown>,
): JudgePrefetchResult {
  const t0 = Date.now();
  const stdin = asRecord(ctx.input);
  // Prefer explicit event key; fall back to stdin root (bare EvidenceEvent shape).
  const eventVal = eventFrom(stdin);
  const prior = ctx.prior ?? null;
  const steps = asRecord(ctx.steps);
  const recon = steps.recon;
  const expand = steps.expand;

  const locations = deriveCitedLocations({
    event: eventVal,
    prior,
    recon,
    expand,
  });
  const windows = peekCitedLocations(basePath, locations);
  const durationMs = Date.now() - t0;
  const block = renderJudgePrefetchBlock(windows, durationMs);
  return { locations, windows, block, durationMs };
}
