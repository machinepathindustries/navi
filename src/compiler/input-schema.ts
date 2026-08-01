// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match } from "ts-pattern";
import { Result, ok, err } from "neverthrow";
import { zodIssues } from "../contracts/whisper.ts";
import type { Shape } from "./shape.ts";

// One owner for the workflow's compiled input boundary. A JSON arg remains
// permissive when it declares no schema, preserving every existing workflow;
// an attached schema narrows only that arg. Passthrough retains the CLI's
// reserved revision/prior/prior_workflow keys.
export function workflowInputSchema(shape: Shape): z.ZodTypeAny {
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const arg of shape.args) {
    const base = match(arg.type)
      .with("json", () => arg.inputSchema ?? z.unknown())
      .with("string", () => z.string())
      .exhaustive();
    fields[arg.name] = match<boolean, z.ZodTypeAny>(arg.required)
      .with(true, () => base)
      .otherwise(() => base.optional());
  }
  return z.object(fields).passthrough();
}

// The CLI calls this after binding but before it resolves/mints a session. Keep
// the original object rather than applying schema transforms here; Mastra owns
// its normal compiled-schema parse when the workflow actually starts.
export function validateWorkflowInput(
  shape: Shape,
  inputData: Record<string, unknown>,
): Result<Record<string, unknown>, string> {
  return match(workflowInputSchema(shape).safeParse(inputData))
    .with({ success: true }, () => ok<Record<string, unknown>, string>(inputData))
    .with({ success: false }, ({ error }) =>
      err<Record<string, unknown>, string>(`input schema failure: ${zodIssues(error)}`),
    )
    .exhaustive();
}
