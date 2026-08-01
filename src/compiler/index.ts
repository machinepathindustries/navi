// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { match, P } from "ts-pattern";
import { Result, ResultAsync, ok, err, errAsync } from "neverthrow";
import { parseSpecFile } from "./parse.ts";
import { buildShape, type Shape } from "./shape.ts";

export { buildShape, shapeSummary } from "./shape.ts";
export type { Shape, ResolvedStep, LintFinding } from "./shape.ts";
export { lintErrors } from "./shape.ts";
export { compile, resolveStructuredObject, structuredOutputOptions } from "./compile.ts";
export type { Compiled, Runtime } from "./compile.ts";
export { validateWorkflowInput, workflowInputSchema } from "./input-schema.ts";

// Built-in content is rooted at the installed package, never at the target
// workspace selected by `-w`, so shipped workflows run against external repos.
const INSTALL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Resolve `navi run <name>` to action.yaml. A direct path is honored; otherwise
// <name> walks project > pinned > builtin — same order as SKILL_SOURCES and
// WORKFLOW_TIERS in src/catalog.ts, which must stay mirrored. Project and pinned
// tiers root at basePath; builtins root at INSTALL_ROOT so they resolve against
// any `-w` target.
export function resolveWorkflowPath(nameOrPath: string, basePath: string): Result<string, string> {
  const tiers = [
    { dir: ".navi/workflows", base: basePath },
    { dir: ".agents/workflows", base: basePath },
    { dir: "builtin/workflows", base: INSTALL_ROOT },
  ];
  const looksLikePath =
    nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml") || nameOrPath.includes("/");
  return match(looksLikePath)
    .with(true, () => {
      const abs = match(isAbsolute(nameOrPath))
        .with(true, () => nameOrPath)
        .with(false, () => join(basePath, nameOrPath))
        .exhaustive();
      return match(existsSync(abs))
        .with(true, () => ok<string, string>(abs))
        .with(false, () => err<string, string>(`no action.yaml at ${nameOrPath}`))
        .exhaustive();
    })
    // First tier whose candidate exists wins — `.find` IS the tier-order search.
    .with(false, () =>
      match(tiers.map(({ dir, base }) => join(base, dir, nameOrPath, "action.yaml")).find((c) => existsSync(c)))
        .with(P.string, (candidate) => ok<string, string>(candidate))
        .with(undefined, () =>
          err<string, string>(
            `unknown workflow "${nameOrPath}" (looked in ${tiers.map((t) => `${t.dir}/${nameOrPath}/`).join(", ")}) — run \`navi catalog\` to list available flows`,
          ),
        )
        .exhaustive(),
    )
    .exhaustive();
}

// Async because `buildShape` is: a step whose `output:` is a `.ts` reference is
// resolved by dynamic import at plan time, relative to the action.yaml's own
// directory (`dirname(path)`). Still model-free — this is the `--shape` path too.
export function loadShape(nameOrPath: string, basePath: string): ResultAsync<Shape, string> {
  return resolveWorkflowPath(nameOrPath, basePath).asyncAndThen((path) =>
    parseSpecFile(path).match(
      (spec) => ResultAsync.fromSafePromise(buildShape(spec, dirname(path))),
      (message) => errAsync<Shape, string>(message),
    ),
  );
}
