// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { fileURLToPath } from "node:url";
import { resolve, join, sep, basename, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { match, P } from "ts-pattern";
import { Result } from "neverthrow";

// The executable prefix needed to re-invoke this process. `next.command` is
// composed from the actual runtime rather than a hardcoded executable:
//   - under tsx (dev/source checkout): the absolute `<repo>/node_modules/.bin/tsx
//     <repo>/src/cli.ts` form (node can't run .ts directly, so the tsx bin is required);
//   - launched as the PACKAGED bin (`…/bin/navi.mjs` or `…/node_modules/.bin/navi`
//     from an npm install): the portable bare command `navi`.
// The result must be runnable verbatim so continuations preserve `-t` and stay in
// the same session.
//
// Every emitted token passes through shellQuote so the command pastes into
// /bin/sh with the intended argv.
//
// Most branches are pure over argv + execArgv. The project-local branch also
// resolves the wrapper and launcher to prove an environment hint names the fixed
// `.agents/bin/navi` link owned by this running package.

// POSIX shell quoting for one argv token in `next.command`. Shell-safe tokens are
// emitted as-is. Every other token is single-quoted, with embedded single quotes
// escaped as `'\''`, so it remains one literal argument. The empty string quotes
// to `''`.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellQuote(token: string): string {
  return match(SHELL_SAFE.test(token))
    .with(true, () => token)
    .with(false, () => `'${token.replace(/'/g, "'\\''")}'`)
    .exhaustive();
}

// fileURLToPath throws on a malformed URL — wrap it at the third-party boundary
// so a malformed `file:` element is skipped rather than thrown across
// invocationPrefix.
const fileUrlToPath = Result.fromThrowable(
  (u: string) => fileURLToPath(u),
  () => undefined,
);

const realpath = Result.fromThrowable(
  (p: string) => realpathSync(p),
  () => undefined,
);

// The filesystem path a single execArgv element carries, or undefined when it carries
// none. Handles BOTH shapes node produces for the tsx loader flags:
//   - SPLIT form  — `--import`, then the value as the NEXT element (bare `--import`
//     here yields undefined; the value element is parsed on its own iteration);
//   - COMBINED form — `--import=file://…` / `--require=…` / `--loader=…` as ONE
//     element, stripped of its leading `--flag=` prefix before parsing.
// A `file:` value is converted with fileURLToPath; a plain absolute path passes
// through. Pure (no filesystem access) so the helper stays unit-testable over
// synthetic argv.
function loaderPathOf(raw: string): string | undefined {
  // `--flag=value` carries its value on the same element. indexOf returns -1 for
  // a non-flag element, leaving the whole value intact.
  const value = match(raw.startsWith("--"))
    .with(true, () => raw.slice(raw.indexOf("=") + 1))
    .with(false, () => raw)
    .exhaustive();
  return match(value)
    .when(
      (v) => v === "" || v.startsWith("--"), // a bare flag / no value on this element
      () => undefined,
    )
    .when(
      (v) => v.startsWith("file:"),
      (v) => fileUrlToPath(v).match((p) => p, () => undefined),
    )
    .otherwise((v) => v);
}

// The tsx executable that loaded this process, or undefined when navi is NOT running
// under tsx. tsx re-execs node with its loader on `process.execArgv` — a
// `--require <…>/node_modules/tsx/dist/preflight.cjs` and an
// `--import file://<…>/node_modules/tsx/dist/loader.mjs` — regardless of how tsx
// itself was located (direct path, PATH lookup, `npm run`); the loader's presence is
// invariant to the invocation shape (its equals-vs-split encoding is not, which
// loaderPathOf normalizes). From the loader's own absolute path we reconstruct the
// sibling `node_modules/.bin/tsx` bin rather than the node binary in argv[0].
// First matching element wins.
function tsxBinFrom(execArgv: readonly string[]): string | undefined {
  const marker = `${sep}node_modules${sep}tsx${sep}`;
  return execArgv
    .flatMap((raw) =>
      match<string | undefined, string[]>(loaderPathOf(raw))
        .with(undefined, () => [])
        .otherwise((p) =>
          match(p.indexOf(marker))
            .with(-1, (): string[] => [])
            .otherwise((idx) => [join(p.slice(0, idx) + `${sep}node_modules`, ".bin", "tsx")]),
        ),
    )
    .at(0);
}

// The bare command name an installed navi answers to, when THIS process was launched as
// a durable packaged bin (`…/bin/navi.mjs`, `…/.bin/navi`, or `…/.bin/navi-cli`
// on PATH). That bare name is the portable, consumer-correct self-steering form:
// exactly what the parent naturally re-runs, so navi's own next.command MATCHES the
// parent's continuations without embedding a machine-specific package path.
// npm can preserve either the package entry or a generated `.bin` symlink in argv[1].
// The package entry has the canonical `navi` stem; an explicit `navi-cli` symlink keeps
// that alias.
// Returns undefined for any other entry (a bespoke `dist/cli.js`, a raw
// `src/cli.ts`), which keeps its own absolute-entry form.
// Pure over its input (basename/dirname only — no filesystem access), so it stays
// unit-testable; whether `navi` actually resolves on PATH is the install's contract, not
// this function's to probe (a source checkout uses the tsx branch above, not this one).
function portableBinName(entryPath: string): string | undefined {
  const parent = basename(dirname(entryPath));
  const stem = basename(entryPath).replace(/\.[cm]?[jt]s$/, "");
  return match({ parent, stem })
    .with(
      { parent: P.union("bin", ".bin"), stem: P.union("navi", "navi-cli") },
      ({ stem: command }): string | undefined => command,
    )
    .otherwise(() => undefined);
}

type NpmInvocation = {
  command?: string | undefined;
  lifecycleEvent?: string | undefined;
};

// `npx` adds the project's node_modules/.bin to PATH only for the child process.
// A continuation that says bare `navi` can therefore work DURING the run and fail
// when the user pastes it into the next shell command. npm identifies this launch
// with two fixed values; the emitted prefix is a constant, never environment text.
function npxBinName(invocation: NpmInvocation): string | undefined {
  return match(invocation)
    .with(
      { command: "exec", lifecycleEvent: "npx" },
      (): string | undefined =>
        "npm exec --offline --package=@machinepath/navi -- navi-cli",
    )
    .otherwise(() => undefined);
}

// `navi install` also provides a project-local launcher for source-checkout
// users who deliberately have no global `navi` on PATH. The canonical shell
// wrapper preserves the path it was invoked through in NAVI_INVOKED_AS and the
// package root it resolved in NAVI_INSTALL_ROOT. Honor the hint only when all
// three realpaths agree with this running package and the hint has the one fixed
// `.agents/bin/navi` shape. An arbitrary environment value can never turn into
// a handed command.
function localInstalledBin(
  entryPath: string,
  invokedAs: string | undefined = process.env.NAVI_INVOKED_AS,
  installRootHint: string | undefined = process.env.NAVI_INSTALL_ROOT,
): string | undefined {
  return match({ invokedAs, installRootHint })
    .with({ invokedAs: P.string, installRootHint: P.string }, ({ invokedAs: hinted, installRootHint: root }) => {
      const entryRoot = realpath(join(dirname(entryPath), "..")).unwrapOr("");
      const hintedRoot = realpath(root).unwrapOr("");
      const wrapper = realpath(join(hintedRoot, "bin", "navi-local")).unwrapOr("");
      const invokedTarget = realpath(hinted).unwrapOr("");
      const fixedSuffix = `${sep}.agents${sep}bin${sep}navi`;
      return match(
        entryRoot !== "" &&
          entryRoot === hintedRoot &&
          wrapper !== "" &&
          invokedTarget === wrapper &&
          hinted.endsWith(fixedSuffix),
      )
        .with(true, () => shellQuote(resolve(hinted)))
        .with(false, () => undefined)
        .exhaustive();
    })
    .otherwise(() => undefined);
}

// The executable command prefix that re-invokes this process. Under tsx it is
// `<abs>/node_modules/.bin/tsx <abs>/src/cli.ts`; a packaged bin uses its portable
// command name; another directly executable entry uses its absolute script path.
// Every token is shell-quoted. argv[1] is the entry script; argv[0] is intentionally
// ignored.
export function invocationPrefix(
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
  npmInvocation: NpmInvocation = {
    command: process.env.npm_command,
    lifecycleEvent: process.env.npm_lifecycle_event,
  },
): string {
  const rawEntry = resolve(argv[1] ?? "");
  const entry = shellQuote(rawEntry);
  return match(tsxBinFrom(execArgv))
    .with(P.string, (tsx) => `${shellQuote(tsx)} ${entry}`)
    .otherwise(
      () =>
        localInstalledBin(rawEntry) ??
        npxBinName(npmInvocation) ??
        portableBinName(rawEntry) ??
        entry,
    );
}

// Quick answers hand a low-confidence result to the tool-backed deep lane on the
// same session and workspace. Keep that argv contract in a pure builder.
// `prefix` defaults to this process's runnable invocation; callers may inject a
// stable prefix when testing the exact rendered command.
export function deepHandoffCommand(
  query: string,
  sessionId: string,
  workspace: string | undefined,
  prefix: string = invocationPrefix(),
): string {
  return [
    prefix,
    shellQuote(query),
    ...match(workspace)
      .with(P.union(undefined, ""), (): string[] => [])
      .otherwise((dir) => ["-w", shellQuote(dir)]),
    "-t",
    shellQuote(sessionId),
    "--deep",
  ].join(" ");
}
