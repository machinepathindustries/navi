// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { z } from "zod";
import { match, P } from "ts-pattern";
import { compileCondition, type Predicate } from "./condition.ts";
import { COMMAND_OUTPUT, outputSchema, resolveSchemaRef, TEXT_OUTPUT } from "./output-schema.ts";
import { dependsOf, type StepSpec, type WorkflowSpec } from "./spec.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_MODEL } from "../mastra/agents/navi.ts";
import { isDeepseek, resolveSettings, type ModelSettings } from "../mastra/model-settings.ts";
import { WORKSPACE_TOOL_NAMES, isWorkspaceToolName, type WorkspaceToolName } from "../mastra/workspace-tools.ts";

// The `--shape` diagnostic object is the same artifact the compiler executes.
// It is
// pure (no Agent construction, no model call), so `--shape` can print it for
// free. The model falls back to NAVI_MODEL/default, maxSteps mirrors the agent
// default, and output is uncapped.
// Building is async ONLY because a `.ts`-file `output:` reference is resolved by
// dynamic import at plan time (still model-free); an inline/no-output step never
// awaits anything real. `dir` is the action.yaml's own directory — what a schema
// reference resolves relative to (`process.cwd()` default for spec-string tests
// that carry no such reference).

export type LintFinding = { level: "error" | "warn"; step?: string; message: string };

export type ResolvedArg = {
  name: string;
  type: "string" | "json"; // json binds stdin as one value; string is positional
  required: boolean;
  default: unknown;
  description?: string | undefined;
};

// Discriminated on `type` so match(rs.type).with("agent"/"command") narrows the
// payload: agent carries prompt (command absent), command carries command (prompt
// absent). lintStep already refuses the missing payload key; resolveStep coerces
// so the DU is always populated and compile.ts can drop `?? ""` fallbacks.
//
// `actionDir` is the absolute directory containing action.yaml. A relative
// directory would make sibling scripts resolve against the consumer workspace:
// steps shell out with the USER's cwd (compile.ts runCommand never sets cwd —
// code-review/pre-pr-review/web-search depend on workspace cwd for `git diff` /
// curl), so relative script paths like `node builtin/workflows/…/parse-*.mjs`
// resolve against the consumer repo, not the action. Carried on every step
// (agent included) so the per-step shape stays uniform; compile only injects it
// as NAVI_ACTION_DIR on command spawns. It is per-step rather than INSTALL_ROOT
// so consumer-tier workflows receive their own directory.
type ResolvedStepBase = {
  name: string;
  model: string;
  modelEnv?: string | undefined; // optional environment override for model
  maxSteps: number;
  tools: WorkspaceToolName[]; // allowlist; empty = ZERO workspace tools (activeTools: [])
  skills: string[]; // skills.only; empty = all available skills
  depends: string[];
  condition?: { source: string; predicate: Predicate } | undefined;
  output: z.ZodTypeAny; // compiled Zod schema (TEXT_OUTPUT when none declared)
  outputFields: string[];
  settings: ModelSettings; // effective model settings (managed baseline + step overrides)
  promptSize: number; // chars of prompt/command — the plan-time payload size
  actionDir: string; // absolute dir of the owning action.yaml (NAVI_ACTION_DIR on command spawn)
};

export type ResolvedStep =
  | (ResolvedStepBase & { type: "agent"; prompt: string; command?: never })
  | (ResolvedStepBase & { type: "command"; command: string; prompt?: never });

export type Shape = {
  name: string;
  description?: string | undefined;
  args: ResolvedArg[];
  steps: ResolvedStep[];
  lint: LintFinding[];
  defaultModel: string;
};

function resolvedModel(): string {
  return process.env.NAVI_MODEL ?? DEFAULT_MODEL;
}

// Input keys the CLI injects on every run:
// `revision` (git HEAD, model-free), `prior` (the last SessionState on `-t`), and
// `prior_workflow` (the immediately preceding typed turn's workflow).
// They are RESERVED — a workflow arg of the same name would be silently shadowed
// by the injection at runtime (or shadow it), so declaring one is a loud compile
// error here rather than a mystery at run time. This is the tiny lint the arg
// names already flow through (resolveArgs), kept beside the step-wiring lints so
// `--shape` surfaces it and compile.ts refuses on it, exactly like every other
// error-level finding.
const RESERVED_ARG_NAMES = new Set(["revision", "prior", "prior_workflow"]);

export async function buildShape(spec: WorkflowSpec, dir: string = process.cwd()): Promise<Shape> {
  const defaultModel = resolvedModel();
  const lint: LintFinding[] = [];
  const names = new Set(spec.steps.map((s) => s.name));
  const seenBefore = new Set<string>();
  const dependedOn = new Set<string>();

  for (const name of Object.keys(spec.args ?? {}).filter((n) => RESERVED_ARG_NAMES.has(n)))
    lint.push({ level: "error", message: `arg "${name}" is a reserved input key injected by the CLI — rename it` });

  const steps: ResolvedStep[] = [];
  for (const s of spec.steps) {
    lintStep(s, lint, names, seenBefore, dependedOn);
    seenBefore.add(s.name);
    steps.push(await resolveStep(s, defaultModel, lint, dir));
  }

  return {
    name: spec.name,
    description: spec.description,
    args: resolveArgs(spec),
    steps,
    lint,
    defaultModel,
  };
}

function resolveArgs(spec: WorkflowSpec): ResolvedArg[] {
  return Object.entries(spec.args ?? {}).map(([name, a]) => ({
    name,
    type: a.type ?? "string",
    required: a.required ?? false,
    default: a.default,
    description: a.description,
  }));
}

// One resolver for all three output forms, returning the compiled schema AND its
// honest field names together — a `.ts` reference's fields come from the resolved
// object's shape keys, never from `Object.keys` of the raw spec (which for a
// string path would be character indices). A broken reference is pushed as an
// error-level lint finding (compile.ts refuses; `--shape` shows it), not a throw.
async function resolveOutput(
  s: StepSpec,
  lint: LintFinding[],
  dir: string,
): Promise<{ schema: z.ZodTypeAny; fields: string[] }> {
  // Three forms, one match on the `output:` value: absent ⇒ the text contract; a
  // string ⇒ a `.ts` schema reference (resolved by import); a map ⇒ the inline
  // token grammar. Either resolver failing pushes an error-level lint finding and
  // falls back to the text contract — the same shape, never a throw.
  const textOutput = () => ({ schema: TEXT_OUTPUT, fields: ["text"] });
  const failWith = (message: string) => {
    lint.push({ level: "error", step: s.name, message });
    return textOutput();
  };
  return match(s.type)
    .with("command", async () => ({ schema: COMMAND_OUTPUT, fields: ["stdout", "stderr", "exitCode"] }))
    .with("agent", async () =>
      match(s.output)
        .with(undefined, async () => textOutput())
        .with(P.string, async (ref) =>
          (await resolveSchemaRef(ref, dir)).match(
            (resolved): { schema: z.ZodTypeAny; fields: string[] } => resolved,
            (message) => failWith(`output: ${message}`),
          ),
        )
        .otherwise(async (fields) =>
          outputSchema(fields).match(
            (schema): { schema: z.ZodTypeAny; fields: string[] } => ({ schema, fields: Object.keys(fields) }),
            (message) => failWith(message),
          ),
        ),
    )
    .exhaustive();
}

async function resolveStep(
  s: StepSpec,
  defaultModel: string,
  lint: LintFinding[],
  dir: string,
): Promise<ResolvedStep> {
  const { schema: output, fields: outputFields } = await resolveOutput(s, lint, dir);
  // A declared modelEnv whose environment variable is set wins;
  // else the literal `model:`; else the run default. `||` throughout so an unset
  // or empty env var falls through (not just an absent `modelEnv`). Resolved once,
  // model-free, at plan time — the same string `--shape` prints and compile.ts
  // hands to the Agent constructor (compile.ts:178). `modelEnv` itself is surfaced
  // only diagnostically, so the shape shows WHICH env var was consulted.
  const model = (s.modelEnv && process.env[s.modelEnv]) || s.model || defaultModel;

  const condition = match(s.condition)
    .with(undefined, () => undefined)
    .otherwise((expr) =>
      compileCondition(expr).match<{ source: string; predicate: Predicate } | undefined>(
        (predicate) => ({ source: expr, predicate }),
        (message) => {
          lint.push({ level: "error", step: s.name, message: `condition: ${message}` });
          return undefined;
        },
      ),
    );

  // DeepSeek-native settings on a non-deepseek model are a loud wiring error, not a
  // silent drop: the compiler would otherwise resolve the
  // model, discard the option, and run — a config that lies about what it does.
  // `??` picks the first DEFINED of the two native knobs, so "neither declared"
  // is exactly `undefined` — one match arm instead of a compound boolean guard.
  match({ deepseek: isDeepseek(model), native: s.settings?.thinking ?? s.settings?.reasoningEffort })
    .with({ deepseek: false, native: P.not(undefined) }, () =>
      lint.push({
        level: "error",
        step: s.name,
        message: `settings.thinking/reasoningEffort are DeepSeek-only, but model is "${model}"`,
      }),
    )
    .otherwise(() => 0);

  // tools: YAML boundary is string[]. FILTERING with the isWorkspaceToolName type
  // guard EARNS the closed WorkspaceToolName[] type instead of asserting it — an
  // unknown entry is dropped from the resolved plan (and still reported by lintStep
  // as an error, so compile refuses the shape). This makes the type honest in
  // exactly the case the lint exists to catch, with no `as` cast.
  const tools = (s.tools ?? []).filter(isWorkspaceToolName);
  // Resolve actionDir here so command steps never interpret a relative workflow
  // directory against the consumer cwd.
  const actionDir = match(isAbsolute(dir))
    .with(true, () => dir)
    .with(false, () => resolvePath(dir))
    .exhaustive();
  const base = {
    name: s.name,
    model,
    modelEnv: s.modelEnv,
    maxSteps: s.maxSteps ?? DEFAULT_MAX_STEPS,
    tools,
    skills: s.skills?.only ?? [],
    depends: dependsOf(s),
    condition,
    output,
    outputFields,
    settings: resolveSettings(model, s.settings ?? {}),
    promptSize: (s.prompt ?? s.command ?? "").length,
    actionDir,
  };
  // Coerce the missing payload side so the DU is always populated; lintStep has
  // already refused a missing prompt/command as an error-level finding.
  return match(s.type)
    .with("agent", () => ({ ...base, type: "agent" as const, prompt: s.prompt ?? "" }))
    .with("command", () => ({ ...base, type: "command" as const, command: s.command ?? "" }))
    .exhaustive();
}

// Broken-wiring detection. Errors block execution
// (compile.ts refuses); warns are advisory and still run.
function lintStep(
  s: StepSpec,
  lint: LintFinding[],
  names: Set<string>,
  seenBefore: Set<string>,
  dependedOn: Set<string>,
): void {
  match(s.type)
    .with("agent", () => {
      // Fold absent and empty values into one pattern.
      match(s.prompt ?? "")
        .with("", () => lint.push({ level: "error", step: s.name, message: "agent step needs a prompt" }))
        .otherwise(() => 0);
      match(s.command ?? "")
        .with("", () => 0)
        .otherwise(() => lint.push({ level: "error", step: s.name, message: "agent step cannot set command" }));
      // A `tools:` entry must be a REGISTERED workspace tool key. Mastra's per-call
      // `activeTools` filter is EXACT string match, so a typo'd name resolves to
      // ZERO tools and silently ships a toolless/under-tooled agent — the opposite
      // of the no-silent-degradation rule. Refuse it here and name the valid
      // vocabulary, whose single owner is shared with the
      // createWorkspace() remap (workspace-tools.ts), so allowed names can never
      // drift from the names actually registered.
      for (const t of (s.tools ?? []).filter((t) => !isWorkspaceToolName(t)))
        lint.push({
          level: "error",
          step: s.name,
          message: `unknown tool "${t}" in tools: — not a registered workspace tool (valid: ${WORKSPACE_TOOL_NAMES.join(", ")}); an unknown name resolves to zero tools (silent toolless step)`,
        });
      // Absent or empty `tools:` means zero tools (compile.ts
      // agentStreamToolOptions), not all workspace tools. That
      // silent-degradation failure mode is real: a step that needs `view` but
      // ships with none will not crash; the model fills gaps from training data.
      // WARNING not error — some steps genuinely want no tools (sharpen, web-
      // search synthesize). Name the step so `--shape` surfaces it (renderShape
      // lint: block). Mirrors the LOUD unknown-tool convention above.
      match((s.tools ?? []).length)
        .with(0, () =>
          lint.push({
            level: "warn",
            step: s.name,
            message: `step "${s.name}" has no tools: — will run with zero workspace tools`,
          }),
        )
        .otherwise(() => 0);
      // skills.only is enforced at compile time: each named skill's
      // full body is force-popped into the step agent's instructions
      // (compile.ts resolvePoppedSkills). A missing skill name is a loud compile
      // error there, not a lint warning here.
    })
    .with("command", () => {
      match(s.command ?? "")
        .with("", () => lint.push({ level: "error", step: s.name, message: "command step needs a command" }))
        .otherwise(() => 0);
      for (const [field] of (
        [
          ["prompt", s.prompt],
          ["tools", s.tools],
          ["skills", s.skills],
          ["model", s.model],
          ["modelEnv", s.modelEnv],
          ["output", s.output],
          ["maxSteps", s.maxSteps],
          ["settings", s.settings],
        ] as const
      ).filter(([, present]) => present !== undefined))
        lint.push({ level: "error", step: s.name, message: `command step cannot set ${field}` });
    })
    .exhaustive();

  for (const dep of dependsOf(s)) {
    // Unknown takes precedence over out-of-order: a name that is not a step
    // cannot also be classified as a later step.
    match({ known: names.has(dep), seen: seenBefore.has(dep) })
      .with({ known: false }, () =>
        lint.push({ level: "error", step: s.name, message: `depends on unknown step "${dep}"` }),
      )
      .with({ known: true, seen: false }, () =>
        lint.push({ level: "error", step: s.name, message: `depends on later step "${dep}" (deps must precede)` }),
      )
      .otherwise(() => 0);
    match(dependedOn.has(dep))
      .with(true, () =>
        lint.push({
          level: "error",
          step: s.name,
          message: `fan-out on "${dep}" is parallel — named parallel steps are not supported`,
        }),
      )
      .with(false, () => 0)
      .exhaustive();
    dependedOn.add(dep);
  }
  match(dependsOf(s).length > 1)
    .with(true, () =>
      lint.push({ level: "error", step: s.name, message: "multi-dependency (fan-in) is not supported" }),
    )
    .with(false, () => 0)
    .exhaustive();
}

export function lintErrors(shape: Shape): LintFinding[] {
  return shape.lint.filter((f) => f.level === "error");
}

// A plain, JSON-serializable projection of the shape — the payload for
// `--shape --json` and the stable surface tests assert against (the live Zod
// schema objects don't serialize meaningfully). This is the same resolved plan
// the compiler executes, minus the runtime closures.
export function shapeSummary(shape: Shape) {
  return {
    name: shape.name,
    description: shape.description,
    defaultModel: shape.defaultModel,
    args: shape.args,
    steps: shape.steps.map((s) => ({
      name: s.name,
      type: s.type,
      model: s.model,
      modelEnv: s.modelEnv ?? null,
      maxSteps: s.maxSteps,
      tools: s.tools,
      skills: s.skills,
      depends: s.depends,
      condition: s.condition?.source ?? null,
      output: s.outputFields,
      settings: s.settings,
      promptSize: s.promptSize,
    })),
    lint: shape.lint,
  };
}
