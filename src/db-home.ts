// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Database paths are resolved before LibSQLStore is constructed. This lets Navi
// reject unsafe overrides and create the default directory before libsql opens
// a file. src/ephemeral.ts must set NAVI_DB before this module is imported.
//
// The default ledger lives at ~/.navi-home/navi.db rather than following cwd.

import { mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { Result } from "neverthrow";
import { match, P } from "ts-pattern";

const NAVI_HOME_DIR = ".navi-home";

// An empty HOME must not turn the ledger path into a cwd-relative path.
// os.homedir() may also read HOME, so userInfo() is the final fallback.
const passwdHome = Result.fromThrowable(
  () => userInfo().homedir,
  () => "no home directory for this user",
);

function home(): string {
  return match([process.env.HOME, homedir()])
    .with([P.string.minLength(1), P._], ([h]) => h)
    .with([P._, P.string.minLength(1)], ([, h]) => h)
    .otherwise(() => passwdHome().unwrapOr(""));
}

// A missing absolute home fails closed rather than creating state in the cwd.
function assertAbsoluteHome(dir: string): string {
  return match(isAbsolute(dir))
    .with(true, () => dir)
    .with(false, (): string => {
      console.error(
        `Blocked: cannot locate your home directory (HOME=${JSON.stringify(process.env.HOME ?? null)}), ` +
          `so there is nowhere safe to keep the session ledger. ` +
          `Set HOME, or point NAVI_DB at an absolute path.`,
      );
      process.exit(1);
    })
    .exhaustive();
}

// NAVI_DB accepts libsql URLs as well as local paths.
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

export function localPathOf(url: string): string | undefined {
  return match(url.match(SCHEME_RE))
    .with(P.nullish, () => stripQuery(url))
    .otherwise((m) =>
      match(m[1]!.toLowerCase())
        .with("file", () => stripQuery(stripFileScheme(url)))
        .otherwise(() => undefined),
    );
}

// `appendSessionState` commits the state message and thread cache through a
// retained companion @libsql/client Client while Mastra keeps its own
// LibSQLStore client. An in-memory SQLite URL gives those clients two unrelated
// databases, so accepting one would make a successful run disappear from the
// session ledger. `--ephemeral` already provides the intended behavior with a
// temporary FILE shared by both clients and removed on exit.
function isInMemoryDbUrl(url: string): boolean {
  const local = localPathOf(url)?.trim().toLowerCase();
  const modeMemory = match(url.match(SCHEME_RE)?.[1]?.toLowerCase())
    .with("file", () => /[?&]mode=memory(?:&|$)/i.test(url))
    .otherwise(() => false);
  return local === ":memory:" || modeMemory;
}

function stripFileScheme(url: string): string {
  const noScheme = url.slice(url.indexOf(":") + 1);
  return match(noScheme.startsWith("//"))
    .with(true, () => noScheme.slice(2))
    .with(false, () => noScheme)
    .exhaustive();
}

function stripQuery(p: string): string {
  const q = p.indexOf("?");
  return match(q >= 0)
    .with(true, () => p.slice(0, q))
    .with(false, () => p)
    .exhaustive();
}

function refuseInMemory(): never {
  console.error(
    "Blocked: NAVI_DB cannot use an in-memory SQLite URL — navi's atomic " +
      "session ledger needs a database file shared by two clients. " +
      "Use --ephemeral for throwaway state; it creates a temporary file and removes it on exit.",
  );
  process.exit(1);
}

export function resolveDbUrl(): string {
  return match(process.env.NAVI_DB)
    .with(P.string, (url) => {
      match(isInMemoryDbUrl(url))
        .with(true, () => refuseInMemory())
        .with(false, () => undefined)
        .exhaustive();
      return url;
    })
    .otherwise(() => defaultDbUrl());
}

function defaultDbUrl(): string {
  const dir = assertAbsoluteHome(join(home(), NAVI_HOME_DIR));
  const dest = join(dir, "navi.db");
  mkdirSync(dir, { recursive: true });
  return `file:${dest}`;
}
