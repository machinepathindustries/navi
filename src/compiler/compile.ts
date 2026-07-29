// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { spawn } from "node:child_process";
import { z } from "zod";
import { match, P } from "ts-pattern";
import { Result, ResultAsync, ok, err } from "neverthrow";
import { Agent } from "@mastra/core/agent";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { Workspace } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import type { ResolvedStep, Shape } from "./shape.ts";
import { lintErrors } from "./shape.ts";
import { toMastraOptions } from "../mastra/model-settings.ts";
import {
  parseStructuredJson,
  schemaRetryProcessor,
} from "../mastra/schema-retry.ts";
import { resolvePoppedSkills } from "../mastra/pop-skills.ts";
import { sessionStateContextFilter } from "../mastra/session-state-context-filter.ts";
import { errStr } from "../err.ts";
import { zodIssues } from "../contracts/whisper.ts";

// Shape → a committed Mastra Workflow and the Agents its steps drive.
// Each step maps 1:1 to a Mastra step; sequencing
// is `.then`, a conditional step is `.branch([[cond, step]])` — no topological
// sorter or parallel condition engine. A lint-blocked shape returns Err, and a
// step failure surfaces as a failed WorkflowResult.

// Mastra does not expose model selection as a per-call stream option, so every
// agent step gets a fresh Agent built with its resolved model.
const BASE_STEP_INSTRUCTIONS = `
You are a single step in a Navi workflow. Follow the step instruction below
exactly and completely, then stop. Use only the tools and skills available to
you. When a structured output is requested, return exactly that shape with real
values — never placeholders. When you make a claim about code, cite the
file:line you actually read. Prefer parallel tool calls when reading or
searching multiple locations in one turn, rather than one at a time.
`;

export type Runtime = { thread: string; resource: string };
export type Compiled = { workflow: ReturnType<typeof createWorkflow>; agents: Record<string, Agent> };

// `compile` is async because a `skills.only` pop reads each named skill's full
// body from the workspace, and every workspace skill read is Promise-based
// (there is no sync skill-read anywhere in @mastra/core). `workspace` is optional
// — a shape with no `skills.only` never touches it; a shape that DOES name skills
// with no workspace (or a workspace with no skills configured) fails with a loud
// compile Err rather than throwing.
export async function compile(
  shape: Shape,
  runtime: Runtime,
  workspace?: Workspace,
): Promise<Result<Compiled, string>> {
  const errs = lintErrors(shape);
  const agents: Record<string, Agent> = {};
  const priorNames: string[] = [];
  const steps: ReturnType<typeof createStep>[] = [];

  // Seed the step walk with the lint verdict so a blocked shape builds no steps.
  let built: Result<null, string> = match<number, Result<null, string>>(errs.length)
    .with(0, () => ok(null))
    .otherwise(() =>
      err(`workflow "${shape.name}" has wiring errors:\n${errs.map((e) => `  - ${e.step ?? "(workflow)"}: ${e.message}`).join("\n")}`),
    );
  // buildStep may read skill bodies, so the loop stops at the first error rather
  // than building later steps eagerly.
  let i = 0;
  while (built.isOk() && i < shape.steps.length) {
    const rs = shape.steps[i]!;
    const stepR = await buildStep(shape.name, rs, runtime, agents, [...priorNames], workspace);
    built = stepR.map((step) => {
      steps.push(step);
      priorNames.push(rs.name);
      return null;
    });
    i++;
  }

  return built.andThen(() => {
    // Fold the linear step list into the builder: `.branch` for a conditional
    // step, `.then` otherwise. Loose typing here is deliberate — steps read their
    // inputs via getInitData/getStepResult (below), not the piped schema, so the
    // chain never hits a schema-mismatch. Cast is the narrowest loosening that
    // still compiles (Mastra builder generic variance across heterogeneous steps);
    // not a hand-rolled builder façade.
    const wf = createWorkflow({
      id: shape.name,
      description: shape.description,
      inputSchema: argsSchema(shape),
      outputSchema: z.unknown(),
    }) as {
      then: (step: ReturnType<typeof createStep>) => typeof wf;
      branch: (steps: [unknown, ReturnType<typeof createStep>][]) => typeof wf;
      commit: () => ReturnType<typeof createWorkflow>;
    };
    for (const { rs, step } of steps.map((step, idx) => ({ rs: shape.steps[idx]!, step })))
      match(rs.condition)
        .with(undefined, () => wf.then(step))
        .otherwise((c) => wf.branch([[condFn(shape.name, rs, c.predicate, [...priorSlice(shape, rs)]), step]]));

    return ok<Compiled, string>({ workflow: wf.commit(), agents });
  });
}

// --- context: what prompts and conditions resolve against ---

type StepCtx = { getInitData: () => unknown; getStepResult: (id: string) => unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function buildCtx(priorNames: string[], p: StepCtx): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const name of priorNames) steps[name] = p.getStepResult(name);
  const init: Record<string, unknown> = match(p.getInitData())
    .with(P.when(isRecord), (r) => r)
    .otherwise(() => ({}));
  return { input: init, steps, ...init };
}

// Wider than isRecord: arrays are indexable so paths such as `steps.hits.0`
// resolve.
const isIndexable = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object";

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) =>
      match(acc)
        .with(P.when(isIndexable), (o) => o[key])
        .otherwise(() => undefined),
    ctx,
  );
}

// `{{ input.topic }}` / `{{ steps.recon.summary }}` — the only templating in the
// DSL. Objects interpolate as JSON; a missing path resolves to an empty string.
function interpolate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) =>
    match(resolvePath(ctx, path))
      .with(P.nullish, () => "")
      .with(P.string, (s) => s)
      .otherwise((v) => JSON.stringify(v)),
  );
}

// skills.only force-pop: shared owner src/mastra/pop-skills.ts (also used by
// bare-query search). Same public reads: workspace.skills.get + formatSkillActivation.

// --- steps ---

async function buildStep(
  wfName: string,
  rs: ResolvedStep,
  runtime: Runtime,
  agents: Record<string, Agent>,
  priorNames: string[],
  workspace: Workspace | undefined,
): Promise<Result<ReturnType<typeof createStep>, string>> {
  // Match on the whole ResolvedStep so the DU narrows payload fields (prompt vs
  // command); match(rs.type) alone only narrows the discriminant expression.
  return match(rs)
    .with({ type: "agent" }, async (rs) => {
      // A step with no `skills.only` does not touch workspace skills. Any pop
      // error short-circuits step construction.
      const poppedR = await match(rs.skills.length)
        .with(0, async () => ok<string, string>(""))
        .otherwise(async () => resolvePoppedSkills(workspace, rs.skills));
      return poppedR.andThen((popped) => {
        const instructions = match(popped)
          .with("", () => BASE_STEP_INSTRUCTIONS)
          .otherwise((p) => `${BASE_STEP_INSTRUCTIONS}\n\n${p}`);
        const agent = new Agent({
          id: `${wfName}.${rs.name}`,
          name: `${wfName}.${rs.name}`,
          instructions,
          model: rs.model,
          memory: new Memory(),
          inputProcessors: [sessionStateContextFilter()],
          // Model settings from the one shared owner (model-settings.ts), so a bare
          // query and a workflow step behave identically on the same model: the
          // managed baseline for v4-flash/v4-pro (temperature 0 + thinking enabled)
          // overlaid with this step's `settings:` overrides, mapped onto Mastra's
          // modelSettings + deepseek providerOptions surfaces. A non-deepseek model
          // carrying deepseek-native options was already refused at lint (shape.ts).
          defaultOptions: {
            maxSteps: rs.maxSteps,
            // Keep parallel tool capacity explicit rather than depending on
            // Mastra's current default.
            toolCallConcurrency: 10,
            ...toMastraOptions(rs.model, rs.settings),
          },
        });
        agents[`${wfName}.${rs.name}`] = agent;
        return ok(
          createStep({
            id: rs.name,
            inputSchema: z.unknown(),
            outputSchema: rs.output,
            execute: async (p) => {
              const ctx = buildCtx(priorNames, p);
              const prompt = interpolate(rs.prompt, ctx);
              return runAgent(agent, rs, prompt, runtime).match(
                (out) => out,
                (message) => {
                  throw new Error(message);
                },
              );
            },
          }),
        );
      });
    })
    .with({ type: "command" }, async (rs) =>
      ok(
        createStep({
          id: rs.name,
          inputSchema: z.unknown(),
          outputSchema: rs.output,
          execute: async (p) => {
            const ctx = buildCtx(priorNames, p);
            const command = interpolate(rs.command, ctx);
            const stdin = match(rs.stdin)
              .with(undefined, () => undefined)
              .otherwise((template) => interpolate(template, ctx));
            // actionDir is the absolute action.yaml dir carried on the resolved
            // step (shape.ts ResolvedStepBase) — inject as NAVI_ACTION_DIR so the
            // shell can resolve sibling scripts without a DSL template binding
            // without setting cwd. Changing cwd would break
            // code-review/pre-pr-review/web-search, which run `git diff`/curl
            // against the USER's workspace cwd.
            return runCommand(command, rs.actionDir, stdin).match(
              (out) => out,
              (message) => {
                throw new Error(message);
              },
            );
          },
        }),
      ),
    )
    .exhaustive();
}

// Structured output gets at most two repair attempts after the initial call.
// This is a runtime safety limit, not a workflow DSL setting.
const MAX_PROCESSOR_RETRIES = 2;

const isTruthy = (v: unknown): boolean => Boolean(v);

// Await the full stream and require a clean stop before trusting its output.
function runAgent(
  agent: Agent,
  rs: ResolvedStep,
  prompt: string,
  runtime: Runtime,
): ResultAsync<unknown, string> {
  return ResultAsync.fromPromise(
    (async () => {
      const declaredOutput = rs.outputFields.length !== 1 || rs.outputFields[0] !== "text";
      const common = {
        memory: { thread: runtime.thread, resource: runtime.resource },
        // Absent or empty `tools:` means zero workspace tools.
        // Mastra's filter is presence-keyed, not length-keyed: `activeTools != null`
        // filters the ToolSet by exact name match, so present-and-empty `[]` is
        // zero tools, while OMITTING the key means all tools (confirmed
        // @mastra/core dist prepareToolsAndToolChoice — chunk-77JDY5O7.js:120;
        // same path cli.ts already uses for the tool-free quick/grade lanes).
        // Always pass the key so the DSL can express "no tools" at all.
        ...agentStreamToolOptions(rs.tools),
      };
      // Branch rather than conditionally spread `structuredOutput`: it is the
      // discriminant of the stream-options union, so it must be literally
      // present-or-absent for the overload to resolve. A schema-bearing step also
      // gets the generic self-correcting retry processor: it
      // validates each emission against the SAME schema and re-asks the model with
      // its own Zod errors on failure, composed with the direct `structuredOutput`
      // call. Exhaustion produces a readable failure. Retry notices go to stderr
      // so stdout remains machine-readable.
      const stream = await match(declaredOutput)
        .with(true, () =>
          agent.stream(prompt, {
            ...common,
            structuredOutput: structuredOutputOptions(rs.output),
            outputProcessors: [
              schemaRetryProcessor({
                stepName: rs.name,
                schema: rs.output,
                maxRetries: MAX_PROCESSOR_RETRIES,
                notify: (n) => process.stderr.write(`navi: output schema retry ${n} for step "${rs.name}"\n`),
              }),
            ],
            maxProcessorRetries: MAX_PROCESSOR_RETRIES,
          }),
        )
        .with(false, () => agent.stream(prompt, common))
        .exhaustive();
      let text = "";
      for await (const chunk of stream.textStream) text += chunk;
      const finishReason = await stream.finishReason;
      // A "tripwire" here is the schema-retry processor giving up after the cap:
      // name it clearly so exit-1 diagnostics read as "the model never produced a
      // valid emission", not an opaque finishReason. Checked before stream.error
      // because the composed native validator also populates stream.error on the
      // same exhaustion; the tripwire message is the readable one.
      // Validate the terminal state in order: retry exhaustion, stream error,
      // then clean stop.
      match(finishReason)
        .with("tripwire", (): never => {
          throw new Error(
            `step "${rs.name}" blocked: schema-retry exhausted (tripwire) — the model never produced an emission satisfying the declared output schema after ${MAX_PROCESSOR_RETRIES} retries`,
          );
        })
        .otherwise(() => undefined);
      // Mastra exposes stream.error as a truthy failure signal.
      match(stream.error)
        .with(P.when(isTruthy), (e): never => {
          throw e;
        })
        .otherwise(() => undefined);
      match(finishReason)
        .with("stop", () => undefined)
        .otherwise((fr): never => {
          throw new Error(`step "${rs.name}" blocked: finishReason=${fr}`);
        });
      // LAZY: the false arm must not await stream.object — a text-only stream has
      // no structured object to resolve.
      return await match(declaredOutput)
        .with(false, async (): Promise<unknown> => ({ text }))
        .with(true, async (): Promise<unknown> =>
          resolveStructuredObject(rs.name, await stream.object, text, rs.output).match(
            (v) => v,
            (message): never => {
              throw new Error(message);
            },
          ),
        )
        .exhaustive();
    })(),
    errStr,
  );
}

// A structured step that stops cleanly but resolves to null or undefined is a
// failure, never a successful empty result.
export function requireStructuredObject(stepName: string, obj: unknown): Result<unknown, string> {
  const blocked = (what: string): string =>
    `step "${stepName}" blocked: structured output resolved to ${what} despite finishReason=stop — the model produced no schema object (silent-success guard)`;
  // null and undefined are separate arms so the message still names WHICH one;
  // every other value — including 0, "" and false — is a legitimate object.
  return match(obj)
    .with(null, () => err<unknown, string>(blocked("null")))
    .with(undefined, () => err<unknown, string>(blocked("undefined")))
    .otherwise((o) => ok<unknown, string>(o));
}

function validateStructuredCandidate(
  stepName: string,
  source: "adapter object" | "prompt-injected JSON",
  value: unknown,
  schema: z.ZodTypeAny,
): Result<unknown, string> {
  return match(schema.safeParse(value))
    .with({ success: true }, ({ data }) => ok<unknown, string>(data))
    .with({ success: false }, ({ error }) =>
      err<unknown, string>(
        `step "${stepName}" blocked: ${source} failed the declared schema (${zodIssues(error)})`,
      ),
    )
    .exhaustive();
}

// Prompt-injected JSON is the provider-portable path, but adapters disagree about
// stream.object: some leave it undefined, and some expose a partial/invalid object
// while the emitted text contains the complete JSON. Treat both as candidates for
// the SAME declared schema, in adapter-first order. Invalid or missing JSON remains
// a loud Err, preserving the silent-success wall.
export function resolveStructuredObject(
  stepName: string,
  obj: unknown,
  text: string,
  schema: z.ZodTypeAny,
): Result<unknown, string> {
  const fromAdapter = requireStructuredObject(stepName, obj).andThen((value) =>
    validateStructuredCandidate(stepName, "adapter object", value, schema),
  );
  return fromAdapter.orElse((adapterFailure) =>
    parseStructuredJson(text)
      .mapErr(
        (message) =>
          `step "${stepName}" blocked: prompt-injected JSON was invalid (${message})`,
      )
      .andThen((value) =>
        validateStructuredCandidate(stepName, "prompt-injected JSON", value, schema),
      )
      .mapErr((textFailure) => `${adapterFailure}; ${textFailure}`),
  );
}

// The options fragment runAgent spreads into agent.stream/generate — ALWAYS a
// present `activeTools` key. Empty array is the Mastra-native zero-tools signal
// (see runAgent comment); tests assert this shape, not only ResolvedStep.tools.
// Mutable string[] matches AgentExecutionOptions.activeTools (Mastra types refuse
// readonly arrays).
export function agentStreamToolOptions(tools: readonly string[]): { activeTools: string[] } {
  return { activeTools: [...tools] };
}

// Mastra's installed-version guide documents that provider-native response
// formats differ: some reject schemas alongside tools, while others complete a
// tool-free structured call with an undefined object. Navi therefore uses one
// portable path for every provider. Prompt injection asks for JSON; the generic
// final safeParse enforces the declared schema locally. Workflow steps may also
// add the schema-retry processor; callers that should fail closed need not retry.
export function structuredOutputOptions(
  schema: z.ZodTypeAny,
): { schema: z.ZodTypeAny; jsonPromptInjection: true; errorStrategy: "warn" } {
  // "warn" is safe only because resolveStructuredObject refuses to return until
  // either Mastra's object or the emitted JSON text passes this exact schema.
  return { schema, jsonPromptInjection: true, errorStrategy: "warn" };
}

// Spawn a command step. cwd is INTENTIONALLY unset — the child inherits the
// process cwd (the consumer workspace where the user ran `navi`). code-review's
// `git diff`, pre-pr-review, and web-search depend on that. Relative sibling
// Sibling parser scripts and consumer-tier command steps
// that shells out to a script next to its action.yaml) resolve via the
// NAVI_ACTION_DIR env var instead: shell-native `$NAVI_ACTION_DIR/…`, zero DSL
// work for built-in and consumer tiers alike. Do not set cwd or special-case
// individual workflows. actionDir is absolute (shape.ts resolveStep).
function runCommand(command: string, actionDir: string, stdin?: string): ResultAsync<unknown, string> {
  return ResultAsync.fromPromise(
    new Promise<unknown>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        env: { ...process.env, NAVI_ACTION_DIR: actionDir },
      });
      let stdout = "";
      let stderr = "";
      let stdinError: unknown;
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      match(stdin)
        .with(undefined, () => undefined)
        .otherwise((input) => {
          // A command may intentionally exit 0 without consuming its input
          // (web-search does this when no provider key is configured). Record
          // write errors until `close`, when the child's exit status is known.
          // EPIPE plus exit 0 is an ordinary early close; every other stdin
          // error still fails the step.
          child.stdin.on("error", (error) => {
            stdinError = error;
          });
          child.stdin.end(input);
        });
      // A nonzero exit or signal termination fails the step. Node reports a
      // signal-terminated child with code === null. exitCode is emitted only for
      // a clean exit.
      // Read at close time, not at wiring time — `stderr` is still accumulating.
      const tail = (): string =>
        match(stderr.trim())
          .with("", () => "")
          .otherwise((s) => `: ${s}`);
      child.on("close", (code, signal) =>
        match({ code, stdinError })
          .with({ code: null }, () =>
            reject(new Error(`killed by signal ${signal ?? "unknown"}${tail()}`)),
          )
          .with({ code: 0, stdinError: undefined }, ({ code: exitCode }) =>
            resolve({ stdout, stderr, exitCode }),
          )
          .with({ code: 0, stdinError: { code: "EPIPE" } }, ({ code: exitCode }) =>
            resolve({ stdout, stderr, exitCode }),
          )
          .with({ code: 0 }, ({ stdinError: error }) =>
            reject(new Error(`stdin failed: ${errStr(error)}${tail()}`)),
          )
          .otherwise(({ code: exitCode }) =>
            reject(new Error(`exited ${exitCode}${tail()}`)),
          ),
      );
    }),
    (e) => `command failed: ${errStr(e)}`,
  );
}

// --- schemas / conditions ---

function argsSchema(shape: Shape): z.ZodTypeAny {
  const fields: Record<string, z.ZodTypeAny> = {};
  for (const a of shape.args) {
    // A `json` arg binds the whole stdin JSON value. z.unknown() lets Mastra
    // accept objects instead of coercing the workflow input to a string.
    // The token never enforces z.object() — a workflow's own usage carries shape.
    const base = match(a.type)
      .with("json", () => z.unknown())
      .with("string", () => z.string())
      .exhaustive();
    fields[a.name] = match<boolean, z.ZodTypeAny>(a.required)
      .with(true, () => base)
      .otherwise(() => base.optional());
  }
  return z.object(fields).passthrough();
}

function priorSlice(shape: Shape, rs: ResolvedStep): string[] {
  const idx = shape.steps.findIndex((s) => s.name === rs.name);
  return shape.steps.slice(0, Math.max(0, idx)).map((s) => s.name);
}

function condFn(
  _wfName: string,
  _rs: ResolvedStep,
  predicate: (ctx: Record<string, unknown>) => boolean,
  priorNames: string[],
) {
  return async (p: StepCtx) => predicate(buildCtx(priorNames, p));
}
