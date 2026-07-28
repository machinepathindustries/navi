// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// =============================================================================
// LOAD `.env` BEFORE src/mastra/index.ts constructs the store. A project-local
// launcher may run from any cwd. Its wrapper supplies validated project and
// install roots, so the project file loads first and the install file is a
// fallback. Without a valid project hint, cwd keeps the normal CLI behavior.
// An already-set process variable still beats every file.
//
// Two rules are deliberate:
//   1. AN ALREADY-SET VARIABLE ALWAYS WINS. `DEEPSEEK_API_KEY=x navi …`, a CI
//      secret, and `--ephemeral`'s NAVI_DB must never be silently overridden by
//      a file someone forgot was there. That is why this does not use
//      process.loadEnvFile, which assigns unconditionally.
//   2. A missing or malformed file is silent because `.env` is optional.
// =============================================================================

import { readFileSync, realpathSync } from "node:fs";
import { parseEnv } from "node:util";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "neverthrow";
import { match, P } from "ts-pattern";

// node:util's parser, so there is no hand-rolled dotenv grammar to get wrong on
// quotes, `export ` prefixes, or multi-line values.
const readEnvFile = Result.fromThrowable(
  (path: string) => parseEnv(readFileSync(path, "utf8")),
  () => "unreadable" as const,
);
const realpath = Result.fromThrowable(
  (path: string) => realpathSync(path),
  () => undefined,
);
const MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadEnvFile(dir: string = process.cwd()): string[] {
  return readEnvFile(join(dir, ".env")).match(
    (parsed) =>
      Object.entries(parsed)
        // Explicit environment beats the file, always. Filtering rather than
        // branching keeps this a single expression and makes the rule visible.
        .filter(([k, v]) => process.env[k] === undefined && typeof v === "string")
        .map(([k, v]) => {
          process.env[k] = v as string;
          return k;
        }),
    () => [],
  );
}

// Only the canonical wrapper may select an install-root file. A caller-provided
// NAVI_INSTALL_ROOT is ignored unless it resolves to this running package.
export function validatedInstallRoot(
  hint: string | undefined,
  moduleRoot: string = MODULE_ROOT,
): string | undefined {
  return match(hint)
    .with(P.string, (candidate) => {
      const hinted = realpath(candidate).unwrapOr("");
      const current = realpath(moduleRoot).unwrapOr("");
      return match(hinted !== "" && hinted === current)
        .with(true, () => current)
        .with(false, () => undefined)
        .exhaustive();
    })
    .otherwise(() => undefined);
}

export function validatedProjectRoot(
  projectHint: string | undefined,
  invokedAsHint: string | undefined,
  installRootHint: string | undefined,
  moduleRoot: string = MODULE_ROOT,
): string | undefined {
  const installRoot = validatedInstallRoot(installRootHint, moduleRoot);
  return match({ projectHint, invokedAsHint, installRoot })
    .with(
      { projectHint: P.string, invokedAsHint: P.string, installRoot: P.string },
      ({ projectHint: project, invokedAsHint: invoked, installRoot: install }) => {
        const root = realpath(project).unwrapOr("");
        const launcher = join(root, ".agents", "bin", "navi");
        const wrapper = realpath(join(install, "bin", "navi-local")).unwrapOr("");
        const invokedTarget = realpath(invoked).unwrapOr("");
        const launcherTarget = realpath(launcher).unwrapOr("");
        const invokedParent = realpath(dirname(invoked)).unwrapOr("");
        const invokedPath = join(invokedParent, basename(invoked));
        return match(
          root !== "" &&
            invokedParent !== "" &&
            invokedPath === launcher &&
            wrapper !== "" &&
            invokedTarget === wrapper &&
            launcherTarget === wrapper,
        )
          .with(true, () => root)
          .with(false, () => undefined)
          .exhaustive();
      },
    )
    .otherwise(() => undefined);
}

export function loadEnvFiles(
  installRootHint: string | undefined = process.env.NAVI_INSTALL_ROOT,
  cwd: string = process.cwd(),
  moduleRoot: string = MODULE_ROOT,
  projectRootHint: string | undefined = process.env.NAVI_PROJECT_ROOT,
  invokedAsHint: string | undefined = process.env.NAVI_INVOKED_AS,
): string[] {
  const projectRoot = validatedProjectRoot(
    projectRootHint,
    invokedAsHint,
    installRootHint,
    moduleRoot,
  );
  const dirs = [
    projectRoot ?? realpath(cwd).unwrapOr(cwd),
    validatedInstallRoot(installRootHint, moduleRoot),
  ]
    .filter((dir): dir is string => typeof dir === "string")
    .filter((dir, index, all) => all.indexOf(dir) === index);
  return dirs.flatMap(loadEnvFile);
}

// Run on import. Only a count is logged; variable names and values never cross
// this boundary.
const loaded = loadEnvFiles();

match(loaded.length)
  .with(0, () => undefined)
  .with(1, () => {
    process.stderr.write("navi: loaded 1 variable from .env\n");
  })
  .otherwise((n) => {
    process.stderr.write(`navi: loaded ${n} variables from .env\n`);
  });
