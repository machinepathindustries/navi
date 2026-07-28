// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { match } from "ts-pattern";
import { DEFAULT_MODEL, DEFAULT_WORKFLOW_MODEL } from "../model-targets.ts";

// One owner for Navi's per-model defaults, explicit overrides, and their mapping
// onto Mastra's typed settings surfaces.

// The enum vocabulary itself lives here as the ONE owner: the literal tuples are
// exported so the DSL schema (spec.ts z.enum) and the CLI flag validation + help
// text (cli.ts) derive from them instead of repeating the literals. The types are
// read from the tuples.
export const THINKING_MODES = ["adaptive", "enabled", "disabled"] as const;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingMode = (typeof THINKING_MODES)[number];
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// The provider-agnostic, flat settings vocabulary navi exposes to authors (the
// action.yaml `settings:` block) and to CLI params. `thinking`/`reasoningEffort`
// are DeepSeek-native; `temperature` is generic. The compiler owns the
// remap onto Mastra's nested provider structure, which workflow authors never see.
export type ModelSettings = {
  // `| undefined` so callers may pass an explicit undefined override (EOPT) — an
  // unset CLI flag arrives exactly that way (cli.ts bare-search passes
  // {thinking, reasoningEffort} straight through). resolveSettings STRIPS
  // undefined-valued keys before layering, so absent and explicit-undefined both
  // mean "no override". A bare spread would let an undefined value delete a
  // managed baseline setting.
  temperature?: number | undefined;
  thinking?: ThinkingMode | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
};

// The managed baseline applies only to the two reference DeepSeek models.
// v4-flash and v4-pro share temperature 0 and
// thinking explicitly enabled. chat/reasoner and every non-deepseek model get no
// Navi-managed defaults.
const MANAGED_DEFAULT_MODELS = new Set([DEFAULT_MODEL, DEFAULT_WORKFLOW_MODEL]);

export function isDeepseek(model: string): boolean {
  return model.startsWith("deepseek/");
}

export function managedDefaults(model: string): ModelSettings {
  return match(MANAGED_DEFAULT_MODELS.has(model))
    .with(true, (): ModelSettings => ({ temperature: 0, thinking: "enabled" }))
    .with(false, (): ModelSettings => ({}))
    .exhaustive();
}

// Optional bare-search override for managed flash/pro models. It is exported for
// explicit callers but is not part of the default settings path.
export function bareSearchThinkingOverride(model: string): ModelSettings {
  return match(MANAGED_DEFAULT_MODELS.has(model))
    .with(true, (): ModelSettings => ({ thinking: "disabled" }))
    .with(false, (): ModelSettings => ({}))
    .exhaustive();
}

// Drop undefined-valued keys, so a spread can never DELETE a baseline field it
// was only meant to leave alone, and so a key is either ABSENT or carries a real
// value (what exactOptionalPropertyTypes asks for — the `Exclude<…, undefined>`
// in the return type states exactly that). Field-agnostic (a new ModelSettings
// key needs no edit here). The single assertion is sound by construction:
// filtering a T's own entries can only yield those same keys, minus undefined.
const definedOnly = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

// Effective settings = the model's managed baseline, overlaid with explicit
// per-step / per-invocation overrides (overrides always win). Only DEFINED
// override keys layer: "flag not passed" must never out-rank the baseline, and a
// plain spread cannot express that (an explicit `undefined` deletes the key).
export function resolveSettings(model: string, overrides: ModelSettings = {}): ModelSettings {
  return { ...managedDefaults(model), ...definedOnly(overrides) };
}

// Bare-search uses the managed baseline plus explicit CLI overrides.
export function resolveBareSearchSettings(
  model: string,
  overrides: ModelSettings = {},
): ModelSettings {
  return resolveSettings(model, overrides);
}

// The Mastra-facing fragment: what gets spread into `Agent({defaultOptions})` or
// an `agent.stream(prompt, {...})` call (deepMerge means partial fragments layer
// correctly onto a lower tier's defaults).
export type MastraModelOptions = {
  modelSettings?: { temperature: number };
  providerOptions?: { deepseek: { thinking?: { type: ThinkingMode }; reasoningEffort?: ReasoningEffort } };
};

// Map Navi's flat settings onto Mastra's two typed surfaces:
// temperature → generic `modelSettings`; thinking/reasoningEffort →
// DeepSeek `providerOptions` (only when the resolved model is deepseek/* — a
// non-deepseek model carrying these is a LOUD lint error upstream (shape.ts), so
// the guard here never silently drops author intent, it only refuses to fabricate
// a deepseek namespace on a model that has none). Only present fields are emitted,
// so `undefined` never reaches the wire.
export function toMastraOptions(model: string, s: ModelSettings): MastraModelOptions {
  // `definedOnly` (this file's own helper) IS the "only present fields are
  // emitted" rule — one owner, applied at both levels, instead of a presence
  // check per key. An all-undefined block yields `{}`, which is how the deepseek
  // namespace stays absent unless a native knob was actually declared.
  const deepseek = definedOnly({
    thinking: match(s.thinking)
      .with(undefined, () => undefined)
      .otherwise((type) => ({ type })),
    reasoningEffort: s.reasoningEffort,
  });
  return definedOnly({
    modelSettings: match(s.temperature)
      .with(undefined, () => undefined)
      .otherwise((temperature) => ({ temperature })),
    providerOptions: match(isDeepseek(model) && Object.keys(deepseek).length > 0)
      .with(true, () => ({ deepseek }))
      .with(false, () => undefined)
      .exhaustive(),
  });
}
