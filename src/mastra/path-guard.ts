// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Vendored/internal path guard — ONE owner for both the Workspace
// beforeToolCall hook (src/mastra/index.ts) and bare-query toolsets that
// read the filesystem outside the Workspace (src/search/*).
//
// This is Navi's filesystem security boundary: case-folded segment matching,
// navi.db-* sidecar rules,
// resolveExisting() realpath containment, PATH_KEYS-gated escape check so
// search regexes are never path-checked. Speed tools (parallel_view /
// multi_search / preflight / prefetch) route through these same primitives
// via resolveContainedPath / pathHasDeniedSegment / deniedRgGlobs — never a
// parallel denylist copy.

import { realpathSync, existsSync } from "node:fs";
import { basename, dirname, join, isAbsolute, sep } from "node:path";
import { match, P } from "ts-pattern";
import { Result, ok, err } from "neverthrow";
import { errStr } from "../err.ts";

// Directory segments denied as exact case-folded matches. Authored HERE only —
// consumers import helpers; they never re-list the names.
const DENIED_SEGMENTS = new Set(["node_modules", "external", ".git"]);

// LibSQL/SQLite db files: a segment equal to a db name OR one of its `<name>-*`
// journal/wal/shm sidecars. The dash boundary keeps `navi.dbutil` OUT of the net.
const DENIED_DB_NAMES = ["navi.db"];

// Environment files can contain provider credentials. Deny the exact `.env`
// basename and every `.env.*` variant, except the deliberately public
// `.env.example` template. Case-folding happens in isDeniedSegment, so this also
// covers case-insensitive filesystems without broad substring matching:
// `.environment`, `.envrc`, and `.env-example` remain readable.
const ENV_BASENAME = ".env";
const PUBLIC_ENV_TEMPLATE = `${ENV_BASENAME}.example`;

function isDeniedEnvName(segment: string): boolean {
  return match(segment)
    .with(PUBLIC_ENV_TEMPLATE, () => false)
    .with(ENV_BASENAME, () => true)
    .when((name) => name.startsWith(`${ENV_BASENAME}.`), () => true)
    .otherwise(() => false);
}

// rg --glob exclusions: directory segments only (navi.db is a file stem, not a
// tree). Keep this list derived from the same owner — never hand-typed at call sites.
export const DENIED_RG_SEGMENTS = ["node_modules", "external", ".git", "navi.db"] as const;

function isDeniedSegment(segment: string): boolean {
  const seg = segment.toLowerCase();
  return (
    DENIED_SEGMENTS.has(seg) ||
    DENIED_DB_NAMES.some((db) => seg === db || seg.startsWith(`${db}-`)) ||
    isDeniedEnvName(seg)
  );
}

// True iff any path segment of `value` is denied (case-folded). Quotes and
// punctuation are boundaries so a quoted path cannot evade the basename rule.
export function pathHasDeniedSegment(value: string): boolean {
  return value
    .split(/[\s/\\'"`;|&()<>=]+/)
    .filter(Boolean)
    .some(isDeniedSegment);
}

const realpath = Result.fromThrowable(
  (p: string) => realpathSync(p),
  errStr,
);

// True iff `absPath` is exactly `basePath` or a descendant (separator boundary, so
// a sibling worktree sharing a name prefix — navi vs navi-copy — is
// NOT contained). Both sides should be realpath'd when they exist.
export function isContainedIn(basePath: string, absPath: string): boolean {
  const base = stripTrailingSep(basePath);
  const abs = stripTrailingSep(absPath);
  return abs === base || abs.startsWith(base + sep);
}

// Drop ONE trailing separator so `/a/b/` and `/a/b` compare equal.
function stripTrailingSep(p: string): string {
  return match(p)
    .with(P.string.endsWith(sep), (s) => s.slice(0, -1))
    .otherwise((s) => s);
}

// Canonicalize a path even when its LEAF does not exist yet: realpath the nearest
// existing ancestor (so a symlinked root — macOS /tmp -> /private/tmp — is resolved),
// then re-append the not-yet-existing tail. Without this, basePath realpaths while a
// nonexistent candidate leaf stays under the raw symlink name, and a legitimately-
// contained path is wrongly judged an escape on the prefix mismatch.
// The walk-up is a fixpoint, so BOTH termination tests live in the loop condition
// (`exists` carries the last probe, so the loop still costs exactly one existsSync
// per level — no extra syscall) and the two post-loop outcomes are resolved by
// match(): an existing ancestor was found, or the walk reached the filesystem root
// with nothing existing. Not recursion — JS has no TCO and a deep path would blow
// the stack on a security boundary.
// Exported for src/db-home.ts: the reserved-home refusal needs the same symlink-safe
// canonicalization for a navi.db that does not exist yet (ONE owner, never a copy).
export function resolveExisting(p: string): string {
  let dir = p;
  let exists = existsSync(dir);
  const tail: string[] = [];
  while (!exists && dirname(dir) !== dir) {
    tail.unshift(basename(dir));
    dir = dirname(dir);
    exists = existsSync(dir);
  }
  return match(exists)
    .with(false, () => p) // walked to the filesystem root with nothing existing
    .with(true, () => {
      const realDir = realpath(dir).unwrapOr(dir);
      return match(tail.length)
        .with(0, () => realDir)
        .otherwise(() => join(realDir, ...tail));
    })
    .exhaustive();
}

// A lone path token (no interior whitespace) that escapes the workspace tree once
// resolved (nearest existing ancestor realpath'd). Whitespace-bearing free text is
// never containment-checked here. CALLER (findGuardViolation) further restricts
// this to path-bearing arg keys so a search regex is never resolved as a path.
export function escapesWorkspace(basePath: string, value: string): boolean {
  // match() arms are lazy, so an empty/whitespace-bearing value never reaches the
  // resolveExisting walk — same short-circuit the guard `if` had.
  return match(value === "" || /\s/.test(value))
    .with(true, () => false)
    .with(false, () => {
      const abs = resolveExisting(absoluteOrJoined(basePath, value));
      const base = realpath(basePath).unwrapOr(basePath);
      return !isContainedIn(base, abs);
    })
    .exhaustive();
}

// An absolute value stands alone; a relative one is resolved against the workspace.
function absoluteOrJoined(basePath: string, value: string): string {
  return match(isAbsolute(value))
    .with(true, () => value)
    .with(false, () => join(basePath, value))
    .exhaustive();
}

export type GuardHit = { target: string; kind: "denied" | "escape" };

// The traversal/containment check fires ONLY on genuine path-bearing args.
// Workspace tool path keys: `path`, `cwd`, and `paths` (forward-safety). Every
// OTHER string arg is a pattern/query/flag — containment-checking those over-
// refuses a legitimate search whose regex is path-shaped or sits under a
// symlinked `-w` root. Agent shell is structurally absent
// because the workspace has no sandbox; trusted YAML command steps do not pass
// through this hook. Result-producing search tools enforce the same policy on
// the paths they return.
const PATH_KEYS = new Set(["path", "paths", "cwd"]);

// A path whose spelling is harmless may still be a symlink to a denied file.
// Canonicalize only genuine path args: command/query/pattern strings retain the
// existing raw segment scan and are never reinterpreted as filesystem paths.
function resolvedPathHasDeniedSegment(basePath: string, value: string): boolean {
  return match(value === "")
    .with(true, () => false)
    .with(false, () =>
      pathHasDeniedSegment(resolveExisting(absoluteOrJoined(basePath, value))),
    )
    .exhaustive();
}

function searchesAllHiddenFiles(input: unknown, toolName: string | undefined): boolean {
  return match({
    search:
      toolName === "search_content" ||
      toolName === "mastra_workspace_grep",
    object: typeof input === "object" && input !== null,
  })
    .with({ search: true, object: true }, () =>
      (input as Record<string, unknown>).includeHidden === true,
    )
    .otherwise(() => false);
}

// Inspect one workspace tool call. A broad hidden-file grep is refused before
// Mastra walks the tree: unlike navi's custom search tools, the native grep has
// no exclusion hook for `.env*`, so `includeHidden: true` could otherwise return
// credentials from a consumer repo that does not gitignore them. Mastra's
// installed implementation skips dotfiles when `includeHidden` is false; an
// explicit `.env` path is denied below. Accept both the remapped and raw tool
// names so a framework hook naming change cannot disarm this check.
export function findGuardViolation(
  input: unknown,
  basePath: string,
  toolName?: string,
): GuardHit | undefined {
  const entries = stringEntries(input);
  // Four lazy checks, denied first (it still wins): broad hidden traversal, raw
  // spelling, resolved path target, then escape.
  return match(searchesAllHiddenFiles(input, toolName))
    .with(true, (): GuardHit => ({ target: "includeHidden=true", kind: "denied" }))
    .otherwise(() =>
      match(
        entries.find(
          ([key, value]) => PATH_KEYS.has(key) && pathHasDeniedSegment(value),
        ),
      )
        .with(P.nonNullable, ([, value]): GuardHit => ({ target: value, kind: "denied" }))
        .otherwise(() =>
          match(
            entries.find(
              ([key, value]) =>
                PATH_KEYS.has(key) && resolvedPathHasDeniedSegment(basePath, value),
            ),
          )
            .with(P.nonNullable, ([, value]): GuardHit => ({
              target: value,
              kind: "denied",
            }))
            .otherwise(() =>
              match(
                entries.find(
                  ([key, value]) =>
                    PATH_KEYS.has(key) && escapesWorkspace(basePath, value),
                ),
              )
                .with(P.nonNullable, ([, value]): GuardHit => ({
                  target: value,
                  kind: "escape",
                }))
                .otherwise(() => undefined),
            ),
        ),
    );
}

// Every string value carried by a tool-call input object. Path-list tools use
// `paths: string[]`, so flatten those members under the original key: the same
// PATH_KEYS policy then checks each path independently. Other values have no
// filesystem meaning here and contribute no entries.
function stringEntries(input: unknown): [string, string][] {
  return match(typeof input === "object" && input !== null)
    .with(false, (): [string, string][] => [])
    .with(true, () =>
      Object.entries(input as Record<string, unknown>).flatMap(([key, value]) =>
        match(value)
          .with(P.string, (text): [string, string][] => [[key, text]])
          .with(P.array(P.string), (texts) =>
            texts.map((text): [string, string] => [key, text]),
          )
          .otherwise((): [string, string][] => []),
      ),
    )
    .exhaustive();
}

export type ResolvePathErr =
  | { kind: "denied"; target: string }
  | { kind: "escape"; target: string }
  | { kind: "missing"; target: string }
  | { kind: "io"; message: string };

// Resolve a workspace-relative (or absolute-but-contained) path for a speed-tool
// read. Same denylist + resolveExisting containment as the Workspace hook —
// order: deny-list on raw → join → deny-list on joined → resolveExisting →
// containment → existence.
export function resolveContainedPath(
  basePath: string,
  rel: string,
): Result<string, ResolvePathErr> {
  // Each guard is a Result step; andThen/map are lazy, so a denied `rel` never
  // reaches the resolveExisting walk or the existsSync probe (same short-circuit
  // the guard `if`s had, same order).
  return refuseWhen<ResolvePathErr>(pathHasDeniedSegment(rel), { kind: "denied", target: rel })
    .map(() => absoluteOrJoined(basePath, rel))
    .andThen((joined) =>
      refuseWhen<ResolvePathErr>(pathHasDeniedSegment(joined), {
        kind: "denied",
        target: rel,
      }).map(() => resolveExisting(joined)),
    )
    .andThen((abs) =>
      refuseWhen<ResolvePathErr>(pathHasDeniedSegment(abs), {
        kind: "denied",
        target: rel,
      }).map(() => abs),
    )
    .andThen((abs) =>
      refuseWhen<ResolvePathErr>(!isContainedIn(realpath(basePath).unwrapOr(basePath), abs), {
        kind: "escape",
        target: rel,
      }).map(() => abs),
    )
    .andThen((abs) =>
      refuseWhen<ResolvePathErr>(!existsSync(abs), { kind: "missing", target: rel }).map(() => abs),
    )
    // Prefer realpath of an existing leaf when possible (symlink-consistent).
    .map((abs) => realpath(abs).unwrapOr(abs));
}

// A guard as a value: Err(e) when the refusal condition holds, Ok otherwise.
function refuseWhen<E>(refused: boolean, e: E): Result<void, E> {
  return match(refused)
    .with(true, () => err<void, E>(e))
    .with(false, () => ok<void, E>(undefined))
    .exhaustive();
}

// Human-facing refusal text and stderr log, matching the Workspace hook.
export function refuseDenied(target: string): string {
  console.error(`navi: blocked tool call targeting ${target}`);
  return `Blocked: refusing to access "${target}" (vendored/internal path).`;
}

export function formatResolveErr(e: ResolvePathErr): string {
  return match(e)
    .with({ kind: "denied" }, ({ target }) => refuseDenied(target))
    .with({ kind: "escape" }, ({ target }) => {
      console.error(`navi: blocked tool call targeting ${target}`);
      return `Blocked: refusing to access "${target}" (path escapes workspace).`;
    })
    .with({ kind: "missing" }, ({ target }) => `unavailable: missing "${target}"`)
    .with({ kind: "io" }, ({ message }) => `unavailable: ${message}`)
    .exhaustive();
}

// rg --glob exclusions derived from the ONE denylist owner (never hand-typed).
// Broad search deliberately excludes `.env.example` too: ripgrep exclusions
// cannot safely express "exclude every `.env.*` except this one" without a
// positive include that would discard ordinary source files. Direct view still
// allows the public template through isDeniedEnvName.
export function deniedRgGlobs(): string[] {
  const deniedTrees = DENIED_RG_SEGMENTS.flatMap((seg) => [
    `-g`,
    `!${seg}/**`,
    `-g`,
    `!**/${seg}/**`,
  ]);
  const deniedEnvFiles = [ENV_BASENAME, `${ENV_BASENAME}.*`].flatMap((name) => [
    `-g`,
    `!${name}`,
    `-g`,
    `!**/${name}`,
  ]);
  return ["--glob-case-insensitive", ...deniedTrees, ...deniedEnvFiles];
}

// Drop any rg hit whose path names a denied segment (case-insensitive + sidecar).
export function filterAllowedHits<T extends { path: string }>(hits: T[]): T[] {
  return hits.filter((h) => !pathHasDeniedSegment(h.path));
}
