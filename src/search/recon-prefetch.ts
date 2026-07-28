// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// DETERMINISTIC pre-pass (no model): derive subject terms + known cite paths
// from the event and prior SessionState, run the same INDEX preflight + MAP
// prefetch as bare-query (src/search/preflight.ts + prefetch.ts), and inject
// ranked hit-windows into edge-walk recon (and expand where it helps).
//
// Safety rails:
// - Hybrid: recon/expand KEEP search_content / view / find_files; this is only
//   a head start so mapping lands in fewer exploratory tool rounds.
// - Honesty: prefetched windows are CANDIDATES / real file content to VERIFY —
//   never proof. Hit-list alone is NOT evidence. Recon must still cite what it
//   actually confirmed (ReconOutput contract unchanged).
// - Toggle: DEFAULT-ON. NAVI_RECON_PREFETCH is an EMERGENCY-DISABLE — enabled
//   unless set to "0"/"off"/"false".
// - Scope: edge-walk recon + expand only.
//
// No parallel machinery: reuses buildPreflightDigest + prefetchTopHits +
// peekFileWindow. Orchestration (term seed + inject) lives HERE.

import { match, P } from "ts-pattern";
import { buildPreflightDigest, extractSearchTerms, type PreflightHit } from "./preflight.ts";
import {
  peekFileWindow,
  prefetchTopHits,
  type PrefetchedWindow,
} from "./prefetch.ts";
import { pathHasDeniedSegment } from "../mastra/path-guard.ts";

export type ReconPrefetchResult = {
  terms: string[];
  hits: PreflightHit[];
  windows: PrefetchedWindow[];
  block: string;
  durationMs: number;
  step: "recon" | "expand";
};

const MAX_PREFETCH_FILES = 6;
const MAX_BLOCK_CHARS = 120_000;
/** Bare-path peeks (prior targets / plan citation uris without a line). */
const BARE_PATH_MAX_LINES = 200;
const CTX_BEFORE = 40;
const CTX_AFTER = 80;

const CODE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|md|yaml|yml|json|toml|vue|svelte";
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s\`"'(\[{,;])((?:[\w.@-]+/)*[\w.@-]+\.(?:${CODE_EXT}))(?::(\d+)(?:-(\d+))?)?`,
  "gi",
);

// NAVI_RECON_PREFETCH is an emergency disable: the mapping head start ships
// enabled; only an explicit
// "0"/"off"/"false" turns it off. Scope stays edge-walk recon + expand alone.
export function reconPrefetchEnabled(wfName: string, stepName: string): boolean {
  // Read the environment only inside the in-scope workflow/step arm.
  return match({ wfName, stepName })
    .with({ wfName: "edge-walk", stepName: P.union("recon", "expand") }, () => {
      const v = (process.env.NAVI_RECON_PREFETCH ?? "").trim().toLowerCase();
      return v !== "0" && v !== "off" && v !== "false";
    })
    .otherwise(() => false);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A record value, or an empty record when it is anything else. */
function asRecord(v: unknown): Record<string, unknown> {
  return [v].filter(isRecord)[0] ?? {};
}

/** `v` when it is an array, else an empty array. */
function asArray(v: unknown): unknown[] {
  return match(v)
    .with(P.array(), (a) => a)
    .otherwise((): unknown[] => []);
}

/** A numeric field, or undefined when the value is any other type. */
function numField(v: unknown): number | undefined {
  return match(v)
    .with(P.number, (n) => n)
    .otherwise((): number | undefined => undefined);
}

// High-signal keys first; skip bulk noise that pollutes term extraction.
// Order is load-bearing (it is the order terms reach extractSearchTerms):
// the preferred keys, then the plan / evidence / directives containers.
const TEXT_KEYS = [
  "task",
  "summary",
  "claim",
  "uri",
  "file",
  "command",
  "targets",
  "required_evidence",
  "completion_criteria",
  "reason",
  "action",
  "note",
  "path",
  "plan",
  "evidence",
  "directives",
  "citations",
  "findings",
];

/** Collect free-text / structured strings that name the task subject. */
function pushText(parts: string[], v: unknown, depth = 0): void {
  // Closed dispatch over depth and JSON value shape.
  match({ overDepth: depth > 6, v })
    .with({ overDepth: true }, () => undefined)
    .with({ v: P.nullish }, () => undefined)
    .with({ v: P.string }, ({ v: s }) => {
      // A blank string contributes nothing — an empty selection pushes nothing.
      [s].filter((t) => t.trim() !== "").forEach((t) => parts.push(t));
    })
    .with({ v: P.array() }, ({ v: arr }) => {
      arr.forEach((el) => pushText(parts, el, depth + 1));
    })
    .otherwise(({ v: val }) => {
      [val]
        .filter(isRecord)
        .forEach((rec) =>
          TEXT_KEYS.filter((k) => k in rec).forEach((k) => pushText(parts, rec[k], depth + 1)),
        );
    });
}

type SeedCite = {
  uri: string;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
};

function normalizeUri(raw: string): string | null {
  const u = raw.trim().replace(/^\.\//, "").replace(/^['"`([]+|['"`)\]]+$/g, "");
  // URI rejections are ordered from invalid/denied to external and absolute paths.
  return match(u)
    .when(
      (s) => s === "" || pathHasDeniedSegment(s),
      (): string | null => null,
    )
    .when(
      (s) => /^[a-z]+:\/\//i.test(s),
      (): string | null => null,
    )
    .when(
      (s) => s.startsWith("/") && !s.startsWith("./"),
      (s): string | null => {
        const base = s.replace(/^\/+/, "");
        return match(base.includes("."))
          .with(true, (): string | null => base)
          .with(false, (): string | null => null)
          .exhaustive();
      },
    )
    .otherwise((s): string | null => s);
}

/** A regex capture group as a number; absent/empty group => undefined. */
function groupNumber(raw: string | undefined): number | undefined {
  return match(raw)
    .with(P.nullish, (): number | undefined => undefined)
    .with("", (): number | undefined => undefined)
    .otherwise((s) => Number(s));
}

function collectPathSeeds(text: string, out: SeedCite[]): void {
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const a = groupNumber(m[2]);
    const b = groupNumber(m[3]);
    // Denied or unparseable URIs contribute nothing.
    [normalizeUri(m[1]!)]
      .filter((uri): uri is string => uri !== null)
      .forEach((uri) => out.push({ uri, lineStart: a, lineEnd: b ?? a }));
  }
}

/**
 * Seed cite paths from event plan citations / evidence + prior directive
 * targets (founder rail) so the head-start peeks the parent's claimed files
 * even when free-text term extraction is thin.
 */
export function collectSeedCites(ctx: {
  event?: unknown;
  prior?: unknown;
  recon?: unknown;
}): SeedCite[] {
  const seeds: SeedCite[] = [];
  const texts: string[] = [];
  pushText(texts, ctx.event);
  pushText(texts, ctx.prior);
  [ctx.recon].filter((v) => v != null && v !== "").forEach((v) => pushText(texts, v));

  for (const t of texts) collectPathSeeds(t, seeds);

  // Structured event plan.citations + evidence[]
  walkStructured(ctx.event, seeds);
  walkStructured(ctx.prior, seeds);
  walkStructured(ctx.recon, seeds);

  // Bare prior.directive.targets always register
  collectDirectiveTargets(ctx.prior, seeds);

  // Pure in-memory dedupe by URI and line range; first spelling wins.
  const keys = seeds.map((s) => `${s.uri}:${s.lineStart ?? ""}-${s.lineEnd ?? ""}`);
  return seeds.filter((_, i) => keys.indexOf(keys[i]!) === i);
}

/** Keys that are never location carriers (huge opaque blobs). */
const SKIP_KEYS = new Set(["turn_history", "parent_events"]);

function walkStructured(v: unknown, seeds: SeedCite[], depth = 0): void {
  // Closed dispatch over depth and JSON value shape.
  match({ overDepth: depth > 8, v })
    .with({ overDepth: true }, () => undefined)
    .with({ v: P.nullish }, () => undefined)
    .with({ v: P.array() }, ({ v: arr }) => {
      arr.forEach((el) => walkStructured(el, seeds, depth + 1));
    })
    .otherwise(({ v: val }) => {
      [val].filter(isRecord).forEach((rec) => structuredSeeds(rec, seeds, depth));
    });
}

// Cite shapes are additive: one record may contribute uri, file, and path+line.
// Independent lazy selections preserve all carriers; the recursive key walk runs last.
function structuredSeeds(v: Record<string, unknown>, seeds: SeedCite[], depth: number): void {
  [v.uri]
    .filter((u): u is string => typeof u === "string")
    .map(normalizeUri)
    .filter((uri): uri is string => uri !== null)
    .forEach((uri) =>
      seeds.push({ uri, lineStart: numField(v.line_start), lineEnd: numField(v.line_end) }),
    );
  [v.file]
    .filter((f): f is string => typeof f === "string")
    .map(normalizeUri)
    .filter((uri): uri is string => uri !== null)
    .forEach((uri) => seeds.push({ uri, lineStart: numField(v.line), lineEnd: numField(v.line) }));
  [v.path]
    .filter((p): p is string => typeof p === "string" && typeof v.line === "number")
    .map(normalizeUri)
    .filter((uri): uri is string => uri !== null)
    .forEach((uri) => seeds.push({ uri, lineStart: numField(v.line), lineEnd: numField(v.line) }));

  Object.entries(v)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .forEach(([, val]) => walkStructured(val, seeds, depth + 1));
}

// A normalizable directive target registers as a whole-file seed; other targets
// fall back to the free-text path scan.
function collectDirectiveTargets(prior: unknown, seeds: SeedCite[]): void {
  [prior]
    .filter(isRecord)
    .flatMap((p) => asArray(p.directives))
    .filter(isRecord)
    .filter((d) => Array.isArray(d.targets))
    .forEach((d) =>
      asArray(d.targets)
        .filter((t): t is string => typeof t === "string")
        .forEach((t) =>
          match(normalizeUri(t))
            .with(P.string, (uri) => {
              seeds.push({ uri });
            })
            .otherwise(() => {
              collectPathSeeds(t, seeds);
            }),
        ),
    );
}

/**
 * Compose the free-text query for preflight term extraction:
 * event subject prose + prior targets + (expand) recon surface strings.
 */
export function buildSubjectQuery(ctx: {
  event?: unknown;
  prior?: unknown;
  recon?: unknown;
  step: "recon" | "expand";
}): string {
  const parts: string[] = [];
  pushText(parts, ctx.event);
  pushText(parts, ctx.prior);
  [ctx.recon]
    .filter((v) => ctx.step === "expand" && v != null && v !== "")
    .forEach((v) => pushText(parts, v));
  // Append seed paths so extractSearchTerms / rg sees file basenames + symbols
  // even when prose is vague ("call-record repair" without repairCallRecord).
  for (const s of collectSeedCites(ctx)) {
    parts.push(s.uri);
    const base = basenameOf(s.uri);
    [base].filter((b) => b !== "").forEach((b) => parts.push(b.replace(/\.[^.]+$/, "")));
  }
  return parts.join("\n");
}

/** Last path segment; a uri with no slash IS its own basename. */
function basenameOf(uri: string): string {
  return match(uri.includes("/"))
    .with(true, () => uri.split("/").pop()!)
    .with(false, () => uri)
    .exhaustive();
}

type PeekGeometry = { anchors: number[]; opts: { before: number; after: number } };

/** Window geometry per seed: a line-anchored peek, or a bounded bare-path peek. */
function seedGeometry(s: SeedCite): PeekGeometry {
  return match(s.lineStart)
    .with(P.nullish, (): PeekGeometry => ({
      anchors: [1],
      opts: { before: 0, after: BARE_PATH_MAX_LINES - 1 },
    }))
    .otherwise((start): PeekGeometry => ({
      anchors: [start, s.lineEnd ?? start],
      opts: { before: CTX_BEFORE, after: CTX_AFTER },
    }));
}

// Basename retry, in a lazy match arm: a uri with no distinct basename costs NO read.
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

function peekSeedWindows(basePath: string, seeds: SeedCite[]): PrefetchedWindow[] {
  const windows: PrefetchedWindow[] = [];
  const seen = new Set<string>();
  // BOUNDED IO — the MAX_PREFETCH_FILES cap lives in the LOOP CONDITION, so a seed is
  // only read while the budget is unspent; an eager `.filter()/.slice(N)` would peek
  // EVERY seed (recon prefetch runs on every edge-walk mapping step). The `??` retry
  // is lazy as well: the basename read happens only when the primary peek missed.
  let i = 0;
  while (windows.length < MAX_PREFETCH_FILES && i < seeds.length) {
    const s = seeds[i]!;
    i++;
    const geo = seedGeometry(s);
    const w =
      peekFileWindow(basePath, s.uri, geo.anchors, geo.opts) ?? peekByBasename(basePath, s.uri, geo);
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

function mergeWindows(primary: PrefetchedWindow[], secondary: PrefetchedWindow[]): PrefetchedWindow[] {
  const seen = new Set(primary.map((w) => `${w.path}:${w.lineStart}-${w.lineEnd}`));
  const out = [...primary];
  // These windows are already read, so admission performs no IO. The loop condition
  // preserves first-seen order while enforcing the cap.
  let i = 0;
  while (out.length < MAX_PREFETCH_FILES && i < secondary.length) {
    const w = secondary[i]!;
    i++;
    const key = `${w.path}:${w.lineStart}-${w.lineEnd}`;
    // Prefer one window per path when ranges heavily overlap — keep first (seed-priority).
    // Already have this path from seeds AND in `out`? skip the duplicate path.
    const dupePath =
      [...seen].some((k) => k.startsWith(`${w.path}:`)) && out.some((x) => x.path === w.path);
    [w]
      .filter(() => !dupePath && !seen.has(key))
      .forEach((win) => {
        seen.add(key);
        out.push(win);
      });
  }
  return out.slice(0, MAX_PREFETCH_FILES);
}

/**
 * Exact founder-facing honesty label. NEVER "verified" / "proof" / "evidence".
 * Prefetch is a head start; recon tools + ReconOutput contract stay unchanged.
 */
export const RECON_PREFETCH_HEADER =
  "RECON HEAD-START: ranked candidate hit-windows (model-free — CANDIDATES to VERIFY, not proof)";

const HONESTY_GUIDANCE = [
  "These windows were read model-free from disk at query time (same bytes a view",
  "tool would return for those line ranges). They are a HEAD START so you spend",
  "fewer exploratory tool rounds — NOT proof of wiring and NOT a seam verdict.",
  "Honesty rail: the hit-list is NOT evidence. Cite only locations you actually",
  "confirmed for THIS recon/expand mission (production trigger, callers,",
  "claimed_on_traced_path, seams). Prefer these windows first when they cover",
  "the subject; do NOT re-open the same window. If a needed path is missing or",
  "a claim is unclear, use search_content / view / find_files as usual.",
].join("\n");

export function renderReconPrefetchBlock(
  windows: PrefetchedWindow[],
  hits: PreflightHit[],
  terms: string[],
  durationMs: number,
  step: "recon" | "expand",
): string {
  const hitDigest = match(hits)
    .with([], () => "(no INDEX hits — use tools for candidate discovery)")
    .otherwise((hs) =>
      hs
        .slice(0, 12)
        .map((h) => `- \`${h.path}:${h.line}\` [term=\`${h.term}\`] ${h.text.trim().slice(0, 120)}`)
        .join("\n"),
    );

  // One label, one owner: the terms line renders identically in both arms.
  const termsLabel = match(terms.length)
    .with(0, () => "(none)")
    .otherwise(() => terms.map((t) => `\`${t}\``).join(", "));

  return match(windows)
    .with([], () =>
      [
        `## ${RECON_PREFETCH_HEADER}`,
        HONESTY_GUIDANCE,
        `step=${step} · terms: ${termsLabel} · prefetch ${durationMs}ms · 0 windows`,
        "",
        "### Candidate INDEX hits (NOT evidence alone)",
        hitDigest,
      ].join("\n"),
    )
    .otherwise((ws) => {
      const parts = [
        `## ${RECON_PREFETCH_HEADER}`,
        "",
        HONESTY_GUIDANCE,
        `step=${step} · terms: ${termsLabel} · windows: ${ws.length} · ${durationMs}ms`,
        "",
        "### Candidate INDEX hits (NOT evidence alone — prefer the windows below when present)",
        hitDigest,
        "",
        "### Prefetched file windows (real current content — verify for your mission)",
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
          `#### ${w.path} (lines ${w.lineStart}–${w.lineEnd} of ${w.totalLines})`,
          "```",
          w.text,
          "```",
          "",
        ].join("\n");
        match(chars + chunk.length > MAX_BLOCK_CHARS)
          .with(true, () => {
            parts.push(`(truncated: remaining windows omitted under ${MAX_BLOCK_CHARS} chars — open with tools if needed)`);
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
 * buildCtx: `{ input: <stdin>, steps, prior, revision, ... }`.
 */
export function assembleReconPrefetch(
  basePath: string,
  ctx: Record<string, unknown>,
  step: "recon" | "expand",
): ReconPrefetchResult {
  const t0 = Date.now();
  const stdin = asRecord(ctx.input);
  // Prefer explicit event key; fall back to stdin root (bare EvidenceEvent shape).
  const eventVal = match("event" in stdin)
    .with(true, (): unknown => stdin.event)
    .with(false, (): unknown => stdin)
    .exhaustive();
  const prior = ctx.prior ?? null;
  const steps = asRecord(ctx.steps);
  // Only the expand step folds in the recon surface — a closed two-value dispatch.
  const recon = match(step)
    .with("expand", (): unknown => steps.recon)
    .with("recon", (): unknown => undefined)
    .exhaustive();

  const subjectCtx = { event: eventVal, prior, recon, step };
  const query = buildSubjectQuery(subjectCtx);
  const seeds = collectSeedCites(subjectCtx);

  // INDEX preflight — same owner as bare-query.
  const digest = buildPreflightDigest(query, basePath, {
    termsPerQuery: 6,
    hitsPerTerm: 4,
    maxHits: 10,
  });
  // Also fold extractSearchTerms over seed basenames so thin events still hit.
  const seedTerms = extractSearchTerms(seeds.map((s) => s.uri).join(" "), 4);
  const terms = [...new Set([...digest.terms, ...seedTerms])];

  // MAP prefetch from ranked hits + seed peeks (cited plan locations / targets).
  const hitWindows = prefetchTopHits(basePath, digest.hits, MAX_PREFETCH_FILES);
  const seedWindows = peekSeedWindows(basePath, seeds);
  // Seed windows first (parent claims / directive targets), then fill from MAP hits.
  const windows = mergeWindows(seedWindows, hitWindows);

  const durationMs = Date.now() - t0;
  const block = renderReconPrefetchBlock(windows, digest.hits, terms, durationMs, step);
  return {
    terms,
    hits: digest.hits,
    windows,
    block,
    durationMs,
    step,
  };
}
