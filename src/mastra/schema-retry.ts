// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match, P } from "ts-pattern";
import { Result } from "neverthrow";
import type { OutputProcessor, ProcessOutputStepArgs } from "@mastra/core/processors";
import { zodIssues } from "../contracts/whisper.ts";
import { errStr } from "../err.ts";

// The single generic structured-output retry processor.
// For an agent step that declares an output schema, validate EVERY model emission
// against THAT schema; on a Zod (or JSON-parse) failure, abort WITH RETRY carrying
// the model's own field-path errors, so Mastra removes the rejected message,
// re-asks the model with a `[Processor Feedback]` note (the model's own
// re-statement given its errors — re-ask, never coercion), and re-invokes — up to
// `maxRetries` times. Exhaustion resolves the stream's finishReason to "tripwire",
// which compile.ts turns into exit 1.
//
// Uniform across every schema-bearing agent step (recon, expand, judge …) — no
// per-workflow/per-step DSL surface. The adapter call uses `errorStrategy: "warn"`
// only to keep prompt-injected JSON portable; compile.ts then requires either the
// adapter object or emitted JSON text to pass this exact schema, so warn cannot
// become silent success. Fallback values remain prohibited fabrication.
// `maxRetries` is supplied by the runtime, never exposed as a workflow setting.
// A text-only step passes `schema: undefined`, so the processor does nothing.
// `notify` is the human-facing stderr retry
// notice, injected so the processor stays free of process I/O and unit-testable.

// JSON.parse is wrapped at the boundary.
const parseJson = Result.fromThrowable(
  (raw: string) => JSON.parse(raw) as unknown,
  errStr,
);

// Some direct providers obey the JSON contract but wrap the single payload in a
// Markdown fence or one sentence of narration. Accept exactly one JSON fence,
// object, or array embedded in prose, then
// keep the same JSON.parse + Zod validation boundary. The outside text may not
// contain another matching delimiter, so two payloads still fail rather than
// making Navi guess which one the model meant.
function structuredJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const exact = match(trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i))
    .with(P.nullish, () => trimmed)
    .otherwise((fence) =>
      match(fence[1])
        .with(P.string, (body) => body.trim())
        .otherwise(() => trimmed),
    );
  return match(exact === trimmed)
    .with(false, () => exact)
    .with(true, () =>
      match(trimmed.match(/^([^`]*)```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```([^`]*)$/i))
        .with(P.nonNullable, (fence) =>
          match(fence[2])
            .with(P.string, (body) => body.trim())
            .otherwise(() => trimmed),
        )
        .otherwise(() =>
          match([
            trimmed.match(/^([^{}]*)(\{[\s\S]*\})([^{}]*)$/),
            trimmed.match(/^([^\[\]]*)(\[[\s\S]*\])([^\[\]]*)$/),
          ])
            .with([P.nonNullable, P._], ([object]) =>
              match(object[2])
                .with(P.string, (body) => body.trim())
                .otherwise(() => trimmed),
            )
            .with([P.nullish, P.nonNullable], ([, array]) =>
              match(array[2])
                .with(P.string, (body) => body.trim())
                .otherwise(() => trimmed),
            )
            .otherwise(() => trimmed),
        ),
    )
    .exhaustive();
}

export function parseStructuredJson(raw: string): Result<unknown, string> {
  return parseJson(structuredJsonPayload(raw));
}

// null = the emission satisfies the schema; a string = the terse issues to re-ask
// with. `zodIssues` (src/contracts/whisper.ts) is the ONE formatter owner, so the
// re-ask text and the CLI's own contract-failure wording can't drift.
function schemaIssues(schema: z.ZodTypeAny, raw: string): string | null {
  return parseStructuredJson(raw).match(
    // safeParse IS a discriminated union — matching both arms exhaustively means
    // the compiler, not a truthiness test, proves `error` is only read on failure.
    (value) =>
      match(schema.safeParse(value))
        .with({ success: true }, (): string | null => null)
        .with({ success: false }, ({ error }) => zodIssues(error))
        .exhaustive(),
    (message) => `not valid JSON (${message})`,
  );
}

export type SchemaRetryProcessorParams = {
  stepName: string;
  // The step's declared output schema; undefined for a text-only step (no-op).
  schema: z.ZodTypeAny | undefined;
  // Runtime constant passed from the call site, never a workflow setting.
  maxRetries: number;
  // Human-facing "retry n" notice sink (stderr in production; a spy in tests).
  notify?: (attempt: number) => void;
};

export function schemaRetryProcessor(params: SchemaRetryProcessorParams): OutputProcessor {
  const { stepName, schema, maxRetries, notify } = params;
  return {
    id: `navi.schema-retry.${stepName}`,
    processOutputStep(args: ProcessOutputStepArgs) {
      // Two pass-through cases, one pattern each:
      //  - a text-only step (no schema) has nothing to validate, so nothing to retry;
      //  - `processOutputStep` runs after EVERY step in the agentic loop, but the
      //    structured answer is ONLY the model's final text emission. A tool-using
      //    agent (the judge re-reads its cited evidence) finishes intermediate steps
      //    with `finishReason: "tool-calls"` and carries NO answer text — validating
      //    those would abort the grounding loop before an answer ever exists. Validate
      //    only the terminal "stop" step; any other terminal reason (length/error) is
      //    left to compile.ts's top-level finishReason guard as an honest exit.
      return match({ schema, finishReason: args.finishReason })
        .with({ schema: P.nonNullable, finishReason: "stop" }, ({ schema: declared }) =>
          match(schemaIssues(declared, (args.text ?? "").trim()))
            // Emission satisfies the schema — leave the messages untouched.
            .with(null, () => args.messageList)
            .otherwise((issues) => {
              // A retry only actually fires while under the cap; notify precisely so the
              // human sees "retry 1"…"retry <maxRetries>" and never a phantom final one
              // (the exhausting attempt is reported by compile.ts's tripwire exit instead).
              match(args.retryCount < maxRetries)
                .with(true, () => notify?.(args.retryCount + 1))
                .with(false, () => undefined)
                .exhaustive();
              // Always abort WITH retry: under the cap Mastra re-asks; at the cap Mastra
              // converts it to a tripwire and exit 1.
              // `abort` is typed `=> never`, so returning it keeps this arm's type honest.
              return args.abort(`step "${stepName}" schema validation failed: ${issues}`, { retry: true });
            }),
        )
        .otherwise(() => args.messageList);
    },
  };
}
