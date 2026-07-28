// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { resolveSettings, toMastraOptions } from "../model-settings.ts";
import { sessionStateContextFilter } from "../session-state-context-filter.ts";
import { DEFAULT_MODEL } from "../../model-targets.ts";

export { DEFAULT_MODEL } from "../../model-targets.ts";

// Step budgets default to 50 so multi-hop repository reads can finish. The
// budget is overridden only by explicit parameters
// — the DSL's per-step `maxSteps` and the bare-query `--max-steps` flag (cli.ts)
// — never by an environment variable.
export const DEFAULT_MAX_STEPS = 50;

const model = process.env.NAVI_MODEL ?? DEFAULT_MODEL;

export const naviAgent = new Agent({
  id: "navi",
  name: "Navi",
  description:
    "Code-search agent. Answers questions about a codebase with cited file:line evidence using the RLM strategy (INDEX, FILTER, MAP, REDUCE).",
  // Bare CLI overrides these per-call with force-popped code-search + preflight
  // (src/cli.ts bareQuery). Studio and direct agent use still
  // sees this baseline — it no longer forces a skill-tool hop before searching;
  // the skill remains discoverable via the workspace skill tools if needed.
  instructions: `
You are Navi, a code-search agent. You answer questions about the codebase in
your workspace with evidence, never from guesswork.

Follow the RLM strategy (INDEX, FILTER, MAP, REDUCE) from the code-search skill
when it is available. Prefer parallel tool calls and large file peeks over
serial single-tool steps. Run the loop quietly — no step-by-step ceremony.

Hard rules:
- Preserve the user's exact target nouns in your first queries; do not degrade
  specific terms into generic ones.
- Every claim in your answer must cite file:line sources you actually read.
- Never claim confidence on zero evidence. If no tools ran or nothing was
  found, say "Blocked" and explain what you needed.
- Answer in this shape:

### Answer
<direct answer with inline file:line citations>

### Sources
<bullet list of file:line references>

### Confidence
<high | medium | low, with one-line justification>
`,
  model,
  // Storage-less: inherits the Mastra-instance-level LibSQLStore (navi.db)
  // registered in src/mastra/index.ts, so thread/message data lands in the
  // same database as everything else (Mastra storage-overview convention).
  memory: new Memory(),
  inputProcessors: [sessionStateContextFilter()],
  // Managed model settings come from the one shared owner (model-settings.ts):
  // v4-flash/v4-pro get temperature 0 plus explicit thinking; other models get
  // no DeepSeek-specific settings. reasoningEffort stays unset by default and is
  // an explicit
  // per-invocation opt-in via `--reasoning-effort` (cli.ts) or a step `settings:`
  // block (the DSL). A per-call `--thinking`/`--max-steps` override deep-merges on
  // top of these defaults.
  defaultOptions: {
    maxSteps: DEFAULT_MAX_STEPS,
    ...toMastraOptions(model, resolveSettings(model)),
  },
});
