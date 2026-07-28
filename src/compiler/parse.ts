// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { readFileSync } from "node:fs";
import { match } from "ts-pattern";
import { Result, ok, err } from "neverthrow";
import { parse as parseYaml } from "yaml";
import { WorkflowSpec } from "./spec.ts";
import { errStr } from "../err.ts";

// Read + parse + schema-validate an action.yaml into a typed WorkflowSpec.
// Every fallible boundary (fs, YAML, Zod) is wrapped so nothing throws across
// the compiler seam. Diagnostics distinguish read, YAML, and schema failures.

const readFile = Result.fromThrowable(
  (path: string) => readFileSync(path, "utf8"),
  (e) => `cannot read ${errStr(e)}`,
);

const parseText = Result.fromThrowable(
  (text: string) => parseYaml(text) as unknown,
  (e) => `invalid YAML: ${errStr(e)}`,
);

export function parseSpecText(text: string): Result<WorkflowSpec, string> {
  // safeParse is a discriminated union — both arms matched exhaustively, so
  // `data`/`error` are each only reachable on the arm that actually carries one.
  return parseText(text).andThen((raw) =>
    match(WorkflowSpec.safeParse(raw))
      .with({ success: true }, ({ data }) => ok<WorkflowSpec, string>(data))
      .with({ success: false }, ({ error }) =>
        err<WorkflowSpec, string>(`invalid workflow: ${error.issues.map(issueLine).join("; ")}`),
      )
      .exhaustive(),
  );
}

export function parseSpecFile(path: string): Result<WorkflowSpec, string> {
  return readFile(path).andThen(parseSpecText);
}

function issueLine(i: { path: PropertyKey[]; message: string }): string {
  const at = match(i.path)
    .with([], () => "(root)")
    .otherwise((path) => path.join("."));
  return `${at}: ${i.message}`;
}
