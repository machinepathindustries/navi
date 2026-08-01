// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match, P } from "ts-pattern";
import { THINKING_MODES, REASONING_EFFORTS } from "../mastra/model-settings.ts";

// The workflow DSL is a closed Zod schema.
// `.strict()` everywhere is deliberate: an unknown field is a typo or a
// field with no consumer, never something to accept silently.

// A workflow input argument. A `string` arg (the default) is positional-bound in
// the CLI (joined argv text). A `json` arg binds a whole JSON VALUE via --stdin —
// `json` is used by flows that accept structured input. It validates as
// z.unknown() unless that argument opts into a co-located `schema:` reference:
// the token still means "a JSON value, not positional prose", while the flow can
// own its specific boundary without imposing one global object grammar.
export const ArgSpec = z
  .object({
    // "string" (default) | "json". Only a json-typed arg opts into the
    // z.unknown() binding.
    type: z.enum(["string", "json"]).optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    // Optional only for `type: json`; shape.ts reports a loud wiring error when
    // a string arg attempts to attach one. Resolved relative to action.yaml.
    schema: z.string().min(1).optional(),
  })
  .strict();
export type ArgSpec = z.infer<typeof ArgSpec>;

// Output schema, one of two forms:
//   - a map of field name → type token (the inline grammar; see output-schema.ts)
//   - a string: a path to a co-located `.ts` file that default-exports a Zod
//     OBJECT schema for shapes the inline grammar cannot express, such as
//     finding-object arrays and verdict enums. The path resolves relative
//     to the action.yaml's own directory; no logic belongs in schema files.
// Record is tried first so a YAML map matches it and a YAML string falls through
// to the path form; neither shape can match the other, so the union is clean.
export const OutputSpec = z.union([z.record(z.string(), z.string()), z.string()]);
export type OutputSpec = z.infer<typeof OutputSpec>;

// Model-tuning knobs for an agent step live in one nested block rather than
// competing with step-identity fields. Flat + provider-agnostic on purpose —
// `thinking: enabled`, not Mastra's nested `providerOptions.deepseek.thinking.type`;
// the compiler owns the remap (compile.ts → toMastraOptions). `temperature` is
// generic; `thinking`/`reasoningEffort` are DeepSeek-native and are a loud lint
// error on a non-deepseek model (shape.ts) — never a silent drop. `maxSteps`
// deliberately stays flat (a step-budget property, not a model-behavior knob).
export const SettingsSpec = z
  .object({
    temperature: z.number().optional(),
    // Enum vocabulary derives from model-settings.ts's exported tuples (its ONE
    // owner), never re-typed here — a new variant there flows in automatically.
    thinking: z.enum(THINKING_MODES).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();
export type SettingsSpec = z.infer<typeof SettingsSpec>;

export const StepSpec = z
  .object({
    name: z.string().min(1),
    type: z.enum(["agent", "command"]),
    prompt: z.string().optional(),
    command: z.string().optional(),
    stdin: z.string().optional(),
    tools: z.array(z.string()).optional(),
    skills: z.object({ only: z.array(z.string()).optional() }).strict().optional(),
    model: z.string().optional(),
    // Per-step model override. Names the environment variable to consult before
    // `model:`; explicit opt-in per step so no two workflows
    // are silently coupled by a shared step name (founder and edge-walk both have
    // a step literally named `judge`). Resolution happens in shape.ts against
    // process.env, never through a YAML template engine.
    modelEnv: z.string().optional(),
    depends: z.union([z.string(), z.array(z.string())]).optional(),
    condition: z.string().optional(),
    output: OutputSpec.optional(),
    maxSteps: z.number().int().positive().optional(),
    settings: SettingsSpec.optional(),
  })
  .strict();
export type StepSpec = z.infer<typeof StepSpec>;

export const WorkflowSpec = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    args: z.record(z.string(), ArgSpec).optional(),
    steps: z.array(StepSpec).min(1),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

// Normalize `depends` to an array once, so downstream code has one shape.
export function dependsOf(step: StepSpec): string[] {
  // `P.array()` (any array) is the exact ts-pattern spelling of `Array.isArray`,
  // so a hand-built spec can never fall off the end of the match.
  return match(step.depends)
    .with(undefined, (): string[] => [])
    .with(P.array(), (deps) => deps)
    .otherwise((dep) => [dep]);
}
