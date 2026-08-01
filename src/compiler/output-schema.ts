// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { match, P } from "ts-pattern";
import { Result, ResultAsync, ok, err, errAsync } from "neverthrow";
import { errStr } from "../err.ts";

// Inline `output:` field tokens → a Zod object schema. The token grammar is a
// closed set: a scalar (`string`/`number`/`boolean`), an array of one
// (`string[]`…), each optionally suffixed `?` for optional. Anything else is a
// compile error, not a silent `z.any()`, so an unrecognized token fails loudly.
// A `.ts` file reference is resolved by `resolveSchemaRef` below.

// The default output shape for a step with no declared `output:` — an agent
// step still produces text, so its contract is honestly `{ text: string }`.
export const TEXT_OUTPUT = z.object({ text: z.string() });

// A `type: command` step's contract is fixed by the subprocess it runs, not by
// an author-declared schema (shape.ts forbids `output:` on command steps).
export const COMMAND_OUTPUT = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});

function scalar(token: string): Result<z.ZodTypeAny, string> {
  return match(token)
    .with("string", () => ok<z.ZodTypeAny, string>(z.string()))
    .with("number", () => ok<z.ZodTypeAny, string>(z.number()))
    .with("boolean", () => ok<z.ZodTypeAny, string>(z.boolean()))
    .otherwise(() => err<z.ZodTypeAny, string>(`unknown output type "${token}"`));
}

function fieldType(raw: string): Result<z.ZodTypeAny, string> {
  const optional = raw.endsWith("?");
  const base = match(optional)
    .with(true, () => raw.slice(0, -1))
    .with(false, () => raw)
    .exhaustive()
    .trim();
  const isArray = base.endsWith("[]");
  const inner = match(isArray)
    .with(true, () => base.slice(0, -2))
    .with(false, () => base)
    .exhaustive();
  // The two suffix flags are ONE closed 2x2 dispatch, so the wrapping order
  // (array inside optional) is stated once and exhaustively.
  return scalar(inner).map((t) =>
    match<{ isArray: boolean; optional: boolean }, z.ZodTypeAny>({ isArray, optional })
      .with({ isArray: true, optional: true }, () => z.array(t).optional())
      .with({ isArray: true, optional: false }, () => z.array(t))
      .with({ isArray: false, optional: true }, () => t.optional())
      .with({ isArray: false, optional: false }, () => t)
      .exhaustive(),
  );
}

// The fold preserves Object.entries order and stops at the first invalid field.
export function outputSchema(spec: Record<string, string>): Result<z.ZodTypeAny, string> {
  return Object.entries(spec)
    .reduce<Result<Record<string, z.ZodTypeAny>, string>>(
      (acc, [field, token]) =>
        acc.andThen((shape) =>
          fieldType(token)
            .mapErr((e) => `output.${field}: ${e}`)
            .map((t) => ({ ...shape, [field]: t })),
        ),
      ok({}),
    )
    .map((shape) => z.object(shape));
}

// A resolved output: the compiled Zod schema plus its honest field names — the
// keys the compiler keys structured-output off (compile.ts `runAgent`).
export type ResolvedOutput = { schema: z.ZodTypeAny; fields: string[] };

// Resolve any default-exported Zod schema relative to action.yaml. JSON input
// arguments use the schema directly; output references narrow it to a Zod object
// below so outputFields remain knowable. Importing a schema is model-free.
export function resolveZodSchemaRef(ref: string, dir: string): ResultAsync<z.ZodTypeAny, string> {
  const abs = match(isAbsolute(ref))
    .with(true, () => ref)
    .with(false, () => resolvePath(dir, ref))
    .exhaustive();
  // Lazy by construction: the dynamic import only exists inside the arm where the
  // file is known to be there, so a missing schema still never runs a module.
  return match(existsSync(abs))
    .with(false, () =>
      errAsync<z.ZodTypeAny, string>(`schema file not found: "${ref}" (looked at ${abs})`),
    )
    .with(true, () =>
      ResultAsync.fromPromise(
        import(pathToFileURL(abs).href) as Promise<unknown>,
        (e) => `cannot import schema "${ref}": ${errStr(e)}`,
      ).andThen((mod) => pickSchema(mod, ref)),
    )
    .exhaustive();
}

// A `.ts` output reference must still default-export a Zod OBJECT schema. This
// is the escape hatch for shapes the inline grammar cannot express; its object
// keys are the honest `outputFields`.
export function resolveSchemaRef(ref: string, dir: string): ResultAsync<ResolvedOutput, string> {
  return resolveZodSchemaRef(ref, dir).andThen((schema) =>
    match(schema)
      .with(P.instanceOf(z.ZodObject), (objectSchema) =>
        ok<ResolvedOutput, string>({ schema: objectSchema, fields: Object.keys(objectSchema.shape) }),
      )
      .otherwise(() =>
        err<ResolvedOutput, string>(
          `schema "${ref}" default export is not a Zod object schema (a z.array/z.enum must be a FIELD inside z.object({ … }))`,
        ),
      ),
  );
}

// The three outcomes of a default export are a closed set — absent, a Zod
// schema, anything else — so they are three arms in declaration order.
function pickSchema(mod: unknown, ref: string): Result<z.ZodTypeAny, string> {
  return match((mod as { default?: unknown }).default)
    .with(undefined, () =>
      err<z.ZodTypeAny, string>(`schema "${ref}" has no default export — export a Zod schema as default`),
    )
    .with(P.instanceOf(z.ZodType), (schema) => ok<z.ZodTypeAny, string>(schema))
    .otherwise(() =>
      err<z.ZodTypeAny, string>(
        `schema "${ref}" default export is not a Zod schema`,
      ),
    );
}
