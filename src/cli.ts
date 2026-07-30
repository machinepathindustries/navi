#!/usr/bin/env node
// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Side-effect FIRST: --ephemeral must set NAVI_DB before ./mastra/index.ts opens storage.
// FIRST: .env must populate process.env before --ephemeral reads NAVI_DB and
// before mastra/index.ts constructs the store. An explicit env var still wins.
import "./env-file.ts";
import "./ephemeral.ts";

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { match, P } from "ts-pattern";
import { Result, ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
import { Mastra } from "@mastra/core";
import { mastra, createWorkspace, storage, sessionClient } from "./mastra/index.ts";

// navi's INSTALL root — this module is src/cli.ts, so the package root is two
// directories up (same derivation as catalog.ts INSTALL_ROOT). package.json
// lives there; the version string is read once at load, model-free.
const INSTALL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION: string = (
  JSON.parse(readFileSync(join(INSTALL_ROOT, "package.json"), "utf8")) as { version: string }
).version;
import {
  readPriorSessionState,
  forkSessionThread,
  appendSessionState,
  assembleSessionState,
  applyOverride,
  titleFromTask,
} from "./session-state.ts";
import { errStr } from "./err.ts";
import {
  EvidenceEvent,
  Gate,
  SessionStatus,
  GateDecision,
  Directive,
  Finding,
  Handoff,
  SurfaceMap,
  Evidence,
  exitForGate,
  zodIssues,
  type SessionState,
  type SessionTurn,
} from "./contracts/whisper.ts";
import {
  compile,
  loadShape,
  lintErrors,
  shapeSummary,
  structuredOutputOptions,
  type Shape,
} from "./compiler/index.ts";
import { COMMAND_OUTPUT } from "./compiler/output-schema.ts";
import { planInstall, applyInstall, renderInstall, uninstall, resolveTarget } from "./install.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_MODEL, naviAgent } from "./mastra/agents/navi.ts";
import { DEFAULT_WORKFLOW_MODEL } from "./model-targets.ts";
import {
  isDeepseek,
  toMastraOptions,
  resolveSettings,
  THINKING_MODES,
  REASONING_EFFORTS,
  type MastraModelOptions,
  type ReasoningEffort,
  type ThinkingMode,
} from "./mastra/model-settings.ts";
import { buildPreflightDigest, ripgrepAvailable } from "./search/preflight.ts";
import { prefetchTopHits, renderPrefetchBlock } from "./search/prefetch.ts";
import {
  DEEP_SEARCH_TOOL_NAMES,
  makeMultiSearchTool,
  makeParallelViewTool,
} from "./search/tools.ts";
import { buildSearchInstructions, buildSearchPrompt, loadPoppedSkill } from "./search/instructions.ts";
import { buildOneShotInstructions } from "./search/oneshot-instructions.ts";
import {
  buildGraderInstructions,
  GroundingGradeSchema,
} from "./search/grader-instructions.ts";
import { renderGroundingStage, runGroundingStage } from "./search/grounding-stage.ts";
import { buildCatalog, renderCatalog, flowMenu, nextMoves, isSingleRequiredString, argToken } from "./catalog.ts";
import { deepHandoffCommand, invocationPrefix, shellQuote } from "./invocation.ts";
import {
  listSessions,
  showSession,
  storySession,
  parseListFilters,
  renderSessionList,
  renderSessionShow,
  renderStory,
  resolveSessionToken,
  setSessionArchived,
  visibleSessions,
} from "./session-view.ts";
import {
  successEnvelope,
  failureEnvelope,
  gateEnvelope,
  renderHuman,
  exitFor,
  type RunEnvelope,
} from "./contracts/envelope.ts";
import { VerdictSchema } from "./contracts/verdict.ts";
import {
  PROGRESS_MODES,
  resolveProgressMode,
  agentChunkProgress,
  workflowEventProgress,
  type ProgressMode,
} from "./run-progress.ts";
import { rule, accent } from "./style.ts";

// --- fatal exits -----------------------------------------------------------

// The CLI's ONE fatal-unwrap seam. A Result the CLI cannot continue without funnels
// its Err through here: write the message on stderr, exit with the code. `fail` is
// typed `never` (process.exit is), so `r.match((v) => v, (e) => fail(msg, n))` infers
// the ok-type with NO cast — the Result itself is the branch, never an `if (isErr())`.
const fail = (msg: string, code: number): never => {
  process.stderr.write(msg);
  process.exit(code);
};

// Wait for pipe-backed stdout to accept the complete payload before exiting.
// This matters for large JSON session views, which can exceed the pipe buffer.
const writeStdout = (text: string): Promise<void> =>
  new Promise((resolve, reject) =>
    process.stdout.write(text, (error) =>
      match(error)
        .with(P.nullish, () => resolve())
        .otherwise(reject),
    ),
  );

// --- arg parsing -----------------------------------------------------------

// The three bare-query tuning flags capture their raw value here (parseArgs stays
// pure); validation + coercion happens at the point of use in bareQuery, so a bad
// value is an honest usage error before any model call.
type Flags = {
  shape: boolean;
  json: boolean;
  stdin: boolean;
  // Optional flags may be assigned `undefined` by take() when a value is missing
  // (error path); EOPT requires `| undefined` so that write is legal.
  thread?: string | undefined;
  help: boolean;
  // --version / -V: print `navi <version>` from package.json and exit 0, before
  // any front-door/help/model path. Zero model calls.
  version: boolean;
  maxSteps?: string | undefined;
  thinking?: string | undefined;
  reasoningEffort?: string | undefined;
  // Bare-query lane. DEFAULT (no flag) = the QUICK lane: a single tool-free synthesis
  // turn over the deterministic preflight+prefetch context, followed by a terse
  // thinking-off grounding GRADE. Only a validated COMPLETE + no grade stands;
  // every other result prints the exact `--deep` command without auto-escalating.
  // `--deep` runs the deeper, tool-backed agentic lane at full budget instead.
  deep: boolean;
  // -w overrides the workspace root (default cwd) for the bare query, run, and
  // catalog; validation happens at the point of use (resolveBasePath), so a bad
  // dir is an honest usage error before any model call. --fork is a boolean that
  // (with -t) continues on a fresh clone of the given thread, leaving the parent
  // untouched — no source thread to clone without -t, so it's a loud error there.
  workspace?: string | undefined;
  fork: boolean;
  // `session list` native metadata filters — validated against the SessionStatus/Gate
  // enums at the point of use (parseListFilters), so an unknown value is a loud
  // usage error listing the legal values before any DB read.
  status?: string | undefined;
  gate?: string | undefined;
  verdict?: string | undefined;
  // Bare-query stream progress (stderr only). Validated at the point of use in
  // bareQuery against PROGRESS_MODES; undefined defaults via resolveProgressMode
  // (live on a TTY, off otherwise). off|live|jsonl.
  progress?: string | undefined;
  // Parent-agent sovereignty over a DEMANDING gate (DIRECT/REPAIR/BLOCKED/
  // ESCALATE): proceed anyway, but RECORD the override in the session ledger
  // (parent_events + open directives → "rejected"). A value-taking flag — the
  // reason string is what lands in the ledger. Loud usage error when there is
  // nothing to override (CLEAR/COMPLETE, non-gated run, --shape).
  override?: string | undefined;
  // `session list`: include archived sessions. Default list hides them (soft-hide via
  // thread metadata.archived); --all shows every session with a dim archived marker.
  all: boolean;
  // Throwaway memory for this one command (effect already applied at import time
  // via ./ephemeral.ts setting NAVI_DB). Recognized here so the unknown-flag
  // guard does not reject it. Nothing is kept; the scratch db is cleaned on exit.
  ephemeral: boolean;
};

// Every flag navi recognizes. A value-taking flag whose "value" is one of these
// (or end-of-input) is a swallowed flag, not a value — see take() below.
const KNOWN_FLAGS = new Set([
  "--shape",
  "--json",
  "--stdin",
  "--help",
  "-h",
  "--version",
  "-V",
  "-t",
  "-w",
  "--fork",
  "--max-steps",
  "--thinking",
  "--reasoning-effort",
  "--deep",
  "--status",
  "--gate",
  "--verdict",
  "--progress",
  "--override",
  "--all",
  "--ephemeral",
]);

// A REAL value for a value-taking flag: present, and not itself a recognized flag.
// A predicate, so it composes as a `P.when(...)` pattern instead of a guard `if`.
const isFlagValue = (v: string | undefined): v is string => v !== undefined && !KNOWN_FLAGS.has(v);

function parseArgs(argv: string[]): Result<{ positional: string[]; flags: Flags }, string> {
  const positional: string[] = [];
  const flags: Flags = {
    shape: false,
    json: false,
    stdin: false,
    help: false,
    version: false,
    fork: false,
    deep: false,
    all: false,
    ephemeral: false,
  };
  let error: string | null = null;
  for (let i = 0; i < argv.length && error === null; i++) {
    const a = argv[i]!;
    // A value-taking flag must be followed by a REAL value — never another
    // recognized flag or end-of-input. Consuming argv[++i] blindly would swallow
    // the next flag's name as data (e.g. `-t --shape` grabbing "--shape" as a
    // thread id, then firing a real paid model run instead of the model-free
    // --shape preview). Refuse THAT as an honest usage error. A non-flag value that
    // merely starts with "-" (a negative "--max-steps -3") is NOT swallowed here —
    // it passes through to its own value-specific validator, which gives a better
    // message ("must be a positive integer") than a generic missing-value one.
    // take() consumes the value token by incrementing i, so a negative value never
    // re-enters this top-level match as a "flag" (and the unknown-flag check below
    // never sees it). -t alone gets a human hint: it continues a previous session;
    // ids from session list.
    const takeHint = match(a)
      .with(
        "-t",
        () => " (-t <session_id> continues a previous session — ids from: navi session list)",
      )
      .otherwise(() => "");
    const take = (): string | undefined =>
      match(argv[i + 1])
        .with(P.when(isFlagValue), (v) => {
          i++;
          return v;
        })
        .with(undefined, () => {
          error = `${a} requires a value (got end of input)${takeHint}`;
          return undefined;
        })
        .otherwise((v) => {
          error = `${a} requires a value (got "${v}")${takeHint}`;
          return undefined;
        });
    match(a)
      .with("--shape", () => (flags.shape = true))
      .with("--json", () => (flags.json = true))
      .with("--stdin", () => (flags.stdin = true))
      .with("--help", "-h", () => (flags.help = true))
      .with("--version", "-V", () => (flags.version = true))
      .with("-t", () => (flags.thread = take()))
      .with("-w", () => (flags.workspace = take()))
      .with("--fork", () => (flags.fork = true))
      .with("--max-steps", () => (flags.maxSteps = take()))
      .with("--thinking", () => (flags.thinking = take()))
      .with("--reasoning-effort", () => (flags.reasoningEffort = take()))
      .with("--deep", () => (flags.deep = true))
      .with("--status", () => (flags.status = take()))
      .with("--gate", () => (flags.gate = take()))
      .with("--verdict", () => (flags.verdict = take()))
      .with("--progress", () => (flags.progress = take()))
      .with("--override", () => (flags.override = take()))
      .with("--all", () => (flags.all = true))
      // Effect already applied at import time (./ephemeral.ts); record the flag so
      // the unknown-flag guard does not reject it.
      .with("--ephemeral", () => (flags.ephemeral = true))
      // A token that looks like a flag but is not in KNOWN_FLAGS is a LOUD usage
      // error — never a positional that becomes a bare-query model call on the
      // typo text. For example, `navi --verison` must fail before model dispatch.
      // Negative values for value-taking flags never land here: take() already
      // consumed them above.
      .otherwise(() =>
        match(a.startsWith("-"))
          .with(true, () => {
            error = `unknown flag "${a}" — run navi --help for the flag reference`;
          })
          .with(false, () => {
            positional.push(a);
          })
          .exhaustive(),
      );
  }
  return match<string | null, Result<{ positional: string[]; flags: Flags }, string>>(error)
    .with(null, () => ok({ positional, flags }))
    .otherwise((e) => err(e));
}

// The workspace root every command operates against. Default is the current
// directory (the bootstrap "search THIS repo" scenario). `-w <dir>` overrides it —
// absolute or resolved against cwd — and a dir that does not exist or is not a
// directory is a loud usage error BEFORE any model call or workspace build, so a
// typo never silently searches the wrong tree. Threaded through the bare query,
// the run verb, and catalog.
function resolveBasePath(dir: string | undefined): Result<string, string> {
  return match(dir)
    .with(undefined, () => ok<string, string>(process.cwd()))
    .otherwise((d) => {
      const abs = resolve(process.cwd(), d);
      return Result.fromThrowable(
        () => statSync(abs),
        () => `-w: no such directory "${d}"`,
      )().andThen((st) =>
        match(st.isDirectory())
          .with(true, () => ok<string, string>(abs))
          .with(false, () => err<string, string>(`-w: not a directory "${d}"`))
          .exhaustive(),
      );
    });
}

const HELP = `navi — search code, run flows, and keep a session ledger

Usage:
  navi "<query>"              Search the current repo, answer with cited evidence
  navi check "<claim>"        Challenge a completion claim; continue with -t <session>
  navi run <name|path> [args] Run a flow by name or action.yaml path
  navi catalog [--json]       List discovered skills + flows (source labels, collision/shadow flags)
  navi session list [--json] [--all]  List sessions; archived sessions are hidden unless --all is set
  navi session show <id> [--json] Timeline + current state of one session (zero model calls)
  navi session archive <session…>   Soft-hide one or more sessions from the default list (non-destructive)
  navi session unarchive <session…> Restore archived sessions to the default list
  navi story <session_id> [--json] The session's gate journey as a readable narrative (zero model calls)
  navi                        The front door: what navi does + every flow and when to reach for it
  navi install [-w <dir>]     Create interop + launcher symlinks and an ownership receipt
  navi uninstall [-w <dir>]   Remove those owned links and receipt; preserve everything else
  navi help [<flow>]          This text; with a flow name, that flow's own args and defaults
                              (same as navi run <flow> --help; also accepts a path)

Flags (any command):
  -w <dir>       Operate against <dir> instead of the current directory (absolute or cwd-relative)
                 e.g. navi -w ../my-project "where is retry configured?"
                 (does NOT apply to 'session' — the session ledger is shared across workspaces)
  --version, -V  Print navi version and exit (zero model calls)
  --ephemeral    Use a temporary ledger for this command; delete it on exit

Flags (run):
  --shape        Print the resolved plan (steps/tools/skills/models/schemas); no model call
  --json         Emit the navi.run.v2 envelope instead of human text
  --stdin        Bind the entire stdin JSON to the flow's input arg
  -t <id>        Continue an existing session (else a fresh session is minted)
  --fork         With -t: run on a fresh CLONE of that session (full history preserved); the source session stays untouched
  --progress <mode>  Progress on stderr: off | live | jsonl
  --override "<reason>"  Proceed against a demanding gate — recorded in the session ledger, exit 0

Flags (bare query):
  -t <id>                      Continue an existing session (else a fresh session is minted)
  --fork                       With -t: continue on a fresh CLONE; the source session stays untouched
  --progress <mode>            Progress on stderr: off | live | jsonl
  --max-steps <n>              Deep-lane (--deep) agent step budget (default: 50)
  --thinking <mode>            Override DeepSeek thinking: ${THINKING_MODES.join(" | ")}
                               (deepseek-v4 flash/pro default: enabled)
  --reasoning-effort <level>   DeepSeek reasoning effort: ${REASONING_EFFORTS.join(" | ")}
  (flow steps set these per-step in action.yaml via a settings: block)

  Lanes:
  (default)                    QUICK lane — one synthesis pass over deterministic
                               search context, followed by a grounding check. Prints
                               the answer, grade, and exact --deep command when needed.
  --deep                       DEEP lane — tool-backed agentic search at full budget:
                               a deeper repository read than the quick lane.

Flags (session list):
  --status <s>   Filter by session status: ${SessionStatus.options.join(" | ")}
  --gate <g>     Filter by latest gate: ${Gate.options.join(" | ")}
  --verdict <v>  Filter by latest verdict: ${VerdictSchema.shape.verdict.options.join(" | ")}
                 (filters map onto native listThreads metadata; AND-combined)
  --all          Include archived sessions (default list hides them; marker shows on archived rows)

Environment:
  NAVI_MODEL     Model override, e.g. ${DEFAULT_WORKFLOW_MODEL}
                 (default: ${DEFAULT_MODEL})

Exit codes (run):
  0 completed (inspect --json gate/verdict)
  1 runtime/model failure · 2 blocked · 3 escalate · 4 schema failure`;

// --- bare query -------------------------------------------------------------

// Validate + coerce the three bare-query tuning flags against the resolved model.
// A bad value is an honest usage error before any model call; deepseek-native
// options on a non-deepseek model are refused loudly (never silently dropped),
// mirroring the DSL's compile-time lint. On success returns the per-call maxSteps
// (when given) and the Mastra options fragment that deep-merges over the
// agent's managed defaults.
const isPositiveInteger = (n: number): boolean => Number.isInteger(n) && n > 0;

type BareOverrides = { maxSteps?: number | undefined; options: MastraModelOptions };

function resolveBareOverrides(flags: Flags, model: string): Result<BareOverrides, string> {
  const maxStepsR: Result<number | undefined, string> = match(flags.maxSteps)
    .with(undefined, () => ok<number | undefined, string>(undefined))
    .otherwise((raw) =>
      match(Number(raw))
        .with(P.when(isPositiveInteger), (n) => ok<number | undefined, string>(n))
        .otherwise(() => err<number | undefined, string>(`--max-steps must be a positive integer, got "${raw}"`)),
    );

  // Model-setting tuples define both validation and error-message vocabulary.
  const thinkingR: Result<ThinkingMode | undefined, string> = match(flags.thinking)
    .with(undefined, () => ok<ThinkingMode | undefined, string>(undefined))
    .with(P.union(...THINKING_MODES), (t) => ok<ThinkingMode | undefined, string>(t))
    .otherwise(() =>
      err<ThinkingMode | undefined, string>(`--thinking must be ${THINKING_MODES.join("|")}, got "${flags.thinking}"`),
    );

  const effortR: Result<ReasoningEffort | undefined, string> = match(flags.reasoningEffort)
    .with(undefined, () => ok<ReasoningEffort | undefined, string>(undefined))
    .with(P.union(...REASONING_EFFORTS), (e) => ok<ReasoningEffort | undefined, string>(e))
    .otherwise(() =>
      err<ReasoningEffort | undefined, string>(
        `--reasoning-effort must be ${REASONING_EFFORTS.join("|")}, got "${flags.reasoningEffort}"`,
      ),
    );

  return Result.combine([maxStepsR, thinkingR, effortR]).andThen(([maxSteps, thinking, reasoningEffort]) =>
    match((thinking !== undefined || reasoningEffort !== undefined) && !isDeepseek(model))
      .with(true, () =>
        err<BareOverrides, string>(`--thinking/--reasoning-effort are DeepSeek-only, but model is "${model}"`),
      )
      .with(false, () =>
        ok<BareOverrides, string>({
          maxSteps,
          options: toMastraOptions(model, resolveSettings(model, { thinking, reasoningEffort })),
        }),
      )
      .exhaustive(),
  );
}

// Bind the Navi agent to the selected workspace while retaining the shared
// session store.
function agentFor(basePath: string, workspaceDir: string | undefined) {
  return match(workspaceDir)
    .with(undefined, () => mastra.getAgentById("navi"))
    .otherwise(() =>
      new Mastra({ agents: { naviAgent }, workspace: createWorkspace(basePath), storage }).getAgentById("navi"),
    );
}

function reuseSession(sessionId: string): ResultAsync<string, string> {
  return resolveSessionToken(storage, sessionId);
}

// The thread the continuation runs on. Plain -t reuses the caller's id; a fresh
// call mints one. --fork needs
// a source: with no -t there is nothing to clone, so it's a loud usage error
// BEFORE any model call — never a silent no-op.
function resolveThread(flags: Flags): ResultAsync<string, string> {
  return match({ fork: flags.fork, thread: flags.thread })
    .with({ fork: false, thread: undefined }, () => okAsync<string, string>(randomUUID()))
    .with({ fork: false, thread: P.string }, ({ thread }) => reuseSession(thread))
    .with({ fork: true, thread: undefined }, () =>
      errAsync<string, string>("--fork needs a source session — pass -t <id> (nothing to fork otherwise)"),
    )
    .with({ fork: true, thread: P.string }, ({ thread }) =>
      reuseSession(thread).andThen((source) =>
        forkSessionThread(storage, source),
      ),
    )
    .exhaustive();
}

function appendTurn(inp: {
  sessionId: string;
  workflow: string;
  prior: SessionState | null;
  turn: SessionTurn;
  event?: unknown;
}): ResultAsync<void, string> {
  return appendSessionState(
    storage,
    sessionClient,
    inp.sessionId,
    assembleSessionState({
      sessionId: inp.sessionId,
      workflow: inp.workflow,
      prior: inp.prior,
      turn: inp.turn,
      event: inp.event,
      evidenceItems: [],
    }),
  );
}

// Convert a non-gate envelope into the exact durable turn it represents.
// Gate envelopes use runGatePath because they also carry directives, findings,
// evidence, surface maps, and override mechanics.
function turnForEnvelope(env: RunEnvelope): Result<SessionTurn, string> {
  const base = { run_id: env.run_id, workflow: env.workflow };
  return match(env)
    .with({ gate: P.not(null) }, () =>
      err<SessionTurn, string>("internal: gate envelope must use the gate persistence path"),
    )
    .with({ verdict: P.not(null) }, (e) =>
      match(VerdictSchema.safeParse(e.result))
        .with({ success: true }, ({ data }) =>
          ok<SessionTurn, string>({ ...base, kind: "verdict", decision: data }),
        )
        .with({ success: false }, ({ error }) =>
          err<SessionTurn, string>(`verdict result failed validation: ${zodIssues(error)}`),
        )
        .exhaustive(),
    )
    .with({ status: "failed" }, (e) =>
      ok<SessionTurn, string>({
        ...base,
        kind: "failure",
        // failureEnvelope owns this fixed human prefix. Session history stores the
        // underlying reason so story renders "failed" exactly once.
        reason: e.summary.replace(/^Run failed: /, ""),
      }),
    )
    .otherwise((e) =>
      ok<SessionTurn, string>({ ...base, kind: "plain", summary: e.summary }),
    );
}

function appendEnvelopeTurn(
  env: RunEnvelope,
  prior: SessionState | null,
  event: unknown,
): ResultAsync<void, string> {
  return turnForEnvelope(env).match(
    (turn) =>
      appendTurn({
        sessionId: env.session_id,
        workflow: env.workflow,
        prior,
        turn,
        event,
      }),
    (e) => errAsync<void, string>(e),
  );
}

async function bareQuery(query: string, flags: Flags): Promise<never> {
  const basePath = resolveBasePath(flags.workspace).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );

  // --progress validates BEFORE any model call (same shape as --thinking). An
  // out-of-set value is a loud usage error listing the legal modes; undefined is
  // fine and falls through to resolveProgressMode's TTY default.
  match(flags.progress)
    .with(undefined, () => undefined)
    .with(P.union(...PROGRESS_MODES), () => undefined)
    .otherwise(() =>
      fail(`Blocked: --progress must be ${PROGRESS_MODES.join("|")}, got "${flags.progress}"\n`, 1),
    );
  const progressMode = resolveProgressMode(flags.progress, process.stderr.isTTY === true);

  const model = process.env.NAVI_MODEL ?? DEFAULT_MODEL;
  const { maxSteps, options } = resolveBareOverrides(flags, model).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );

  // Resolve the thread BEFORE the model call: a --fork with no -t (nothing to
  // clone) is a loud, model-free error, and a real fork clones the parent first
  // so the continuation diverges onto the clone (parent untouched).
  const thread = (await resolveThread(flags)).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );
  match(flags.fork)
    .with(true, () => void process.stderr.write(`forked ${flags.thread} → ${thread}\n`))
    .with(false, () => undefined)
    .exhaustive();
  const prior = (await match(flags.thread)
    .with(undefined, async () => ok<SessionState | null, string>(null))
    .otherwise(async () =>
      readPriorSessionState(storage, thread),
    )).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );
  const runId = randomUUID();
  const bareEvent = { task: query };
  const recordBareTurn = (turn: SessionTurn): ResultAsync<void, string> =>
    appendTurn({
      sessionId: thread,
      workflow: "query",
      prior,
      turn,
      event: bareEvent,
    });

  const agent = agentFor(basePath, flags.workspace);
  // Workspace for skill force-pop: same root the agent tools read. Always build
  // via createWorkspace so -w and bare cwd share one path (module-level mastra
  // workspace is cwd; createWorkspace(basePath) is correct either way).
  const workspace = createWorkspace(basePath);

  // Force-pop the search doctrine, run the deterministic index preflight, and
  // attach compound tools. Fewer serial model steps reduce latency; failures are
  // loud before any model call.
  const skill = await (await loadPoppedSkill(workspace, "code-search")).match(
    async (v) => v,
    async (e) => {
      await recordBareTurn({
        kind: "failure",
        run_id: runId,
        workflow: null,
        reason: e,
      }).match(
        () => undefined,
        (writeError) => fail(`Blocked: session-state write failed: ${writeError}\n`, 1),
      );
      return fail(`Blocked: ${e}\n`, 1);
    },
  );
  // Instructions per lane: the agentic search loop always has the search skill
  // pre-loaded — built once here so the primary agentic run AND the escalation
  // deep-lane reuse it. The one-shot lane swaps in synthesis-only instructions (no
  // loop) at its own call site below.
  const searchInstructions = buildSearchInstructions(skill);
  const preflight = buildPreflightDigest(query, basePath);
  const tPrefetch = Date.now();
  // The quick lane is tool-free (no follow-up loop to fill gaps), so it front-loads
  // more context (12 files vs the deep lane's default 6) — the retrieval must carry
  // the answer by itself. The deep lane searches, so it needs less.
  const windows = prefetchTopHits(
    basePath,
    preflight.hits,
    match(flags.deep)
      .with(true, () => undefined)
      .with(false, () => 12)
      .exhaustive(),
  );
  const prefetchMs = Date.now() - tPrefetch;
  const prefetchText = renderPrefetchBlock(windows, prefetchMs);
  // Say which happened. "scanned the repo — 0 hits" reads as "your repo has
  // nothing"; when ripgrep is absent it actually means "nothing was scanned", and
  // the answer that follows is ungrounded for a reason the user can fix in one
  // command. Same discipline as every other honest-degradation line in navi.
  process.stderr.write(
    match(ripgrepAvailable())
      .with(true, () =>
        `navi: scanned the repo — ${preflight.hits.length} hits across ${windows.length} files (${preflight.durationMs + prefetchMs}ms)\n`,
      )
      .with(false, () =>
        `navi: ripgrep (rg) is not installed — answering WITHOUT the deterministic index, so this answer is ungrounded. Install ripgrep and re-run.\n`,
      )
      .exhaustive(),
  );
  process.stderr.write(
    match(flags.deep)
      .with(true, () => `navi: deep read — searching the repo as I go\n`)
      .with(false, () => `navi: quick pass — answering from what I found (I'll grade my own answer below)\n`)
      .exhaustive(),
  );
  const prompt = buildSearchPrompt(query, { preflight: preflight.text, prefetch: prefetchText });
  // The opt-in deep lane gets the full default step budget unless the caller
  // provides --max-steps; cutting a deliberate repository walk short defeats the
  // purpose of selecting this lane.
  const effectiveMaxSteps = maxSteps ?? DEFAULT_MAX_STEPS;
  // Toolsets execute server-side and return control to the agent loop.
  const toolsets = {
    speed: {
      parallel_view: makeParallelViewTool(basePath),
      multi_search: makeMultiSearchTool(basePath),
    },
  };

  // Stream one agent turn to stdout while collecting the full text. Tool chunks
  // paint progress on stderr; text deltas stay on stdout. Framework stream errors
  // become Result errors at this boundary.
  const collect = (
    streamP: ReturnType<typeof agent.stream>,
    mode: ProgressMode,
  ): ResultAsync<{ text: string; finishReason: string | undefined }, string> =>
    ResultAsync.fromPromise(
      (async () => {
        const stream = await streamP;
        let text = "";
        for await (const chunk of stream.fullStream) {
          const payload: Record<string, unknown> = match(chunk)
            .with(
              {
                payload: P.when(
                  (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
                ),
              },
              (c) => c.payload,
            )
            .otherwise((): Record<string, unknown> => ({}));
          match(chunk.type)
            .with("text-delta", () => {
              const t = String(payload.text ?? "");
              process.stdout.write(t);
              text += t;
            })
            .otherwise(() => {
              agentChunkProgress(mode, { type: chunk.type, payload });
            });
        }
        const finishReason = await stream.finishReason;
        // The framework's throw surface, re-thrown INSIDE fromPromise so it lands as an
        // Err at our seam. Truthiness is the original test, kept exactly via Boolean().
        match(Boolean(stream.error))
          .with(true, (): void => {
            throw stream.error;
          })
          .with(false, () => undefined)
          .exhaustive();
        return { text, finishReason };
      })(),
      errStr,
    );

  // The deep lane's stream options: full budget, no soft-cap. Per-call instructions
  // override the agent default so the search skill is already loaded (no step-0
  // `skill` tool) — AgentExecutionOptions.instructions.
  const deepOpts = {
    instructions: searchInstructions,
    memory: { thread, resource: "cli" as const },
    maxSteps: effectiveMaxSteps,
    // Exact allowlist: repo evidence plus navi's two bounded compound tools.
    // Agent-controlled shell is disabled globally, and it does not ride the
    // deep lane if Mastra adds another workspace tool in a future release.
    activeTools: [...DEEP_SEARCH_TOOL_NAMES],
    toolsets,
    ...options,
  };

  // Quick lane (default): a single tool-free synthesis turn. maxSteps 1 alone is NOT
  // enough — the shared workspace still injects its read/search/skill tools into the
  // request, so the model can emit a tool call it cannot resolve (finishReason=
  // tool-calls, no text). `activeTools: []` filters the resolved ToolSet to exactly
  // zero tools (the same primitive the DSL `tools:` allowlist compiles to — compile.ts),
  // so the model is genuinely tool-free and MUST answer from the pre-stuffed preflight+
  // prefetch context or abstain (oneshot-instructions). `--deep` runs the agentic lane.
  // match arms are thunks, so exactly ONE lane's agent.stream is ever invoked.
  const run = match(flags.deep)
    .with(true, () => collect(agent.stream(prompt, deepOpts), progressMode))
    .with(false, () =>
      collect(
        agent.stream(prompt, {
          instructions: buildOneShotInstructions(),
          memory: { thread, resource: "cli" },
          maxSteps: 1,
          activeTools: [],
          ...options,
        }),
        progressMode,
      ),
    )
    .exhaustive();

  // Whether a completed run is a genuine answer or a blocked outcome — shared by both lanes.
  const checkBlocked = (r: { text: string; finishReason: string | undefined }): string | undefined =>
    match({ finishReason: r.finishReason, hasAnswer: r.text.trim().length > 0 })
      .with({ finishReason: "stop", hasAnswer: true }, () => undefined)
      .with({ finishReason: "stop", hasAnswer: false }, () => "empty answer text")
      .with({ finishReason: P.string }, () => `finishReason=${r.finishReason}`)
      .otherwise(() => "stream ended without a finish reason");

  const answered = await run.match(
    (r) => ({ blocked: checkBlocked(r), text: r.text }),
    (message) => ({ blocked: `agent run failed: ${message}`, text: "" }),
  );
  // Undefined and an empty string both mean the run produced an answer.
  await match(answered.blocked)
    .with(P.union(undefined, ""), () => undefined)
    .otherwise(async (reason) => {
      await recordBareTurn({
        kind: "failure",
        run_id: runId,
        workflow: null,
        reason,
      }).match(
        () => undefined,
        (writeError) => fail(`\nBlocked: session-state write failed: ${writeError}\n`, 1),
      );
      process.stderr.write(`\nBlocked: ${reason}\n`);
      process.exit(1);
    });
  const answerText = answered.text;

  // The deep lane stands on its tool-backed repository read. The caller already
  // selected the deeper search, so it does not run the quick-lane grounding grade.
  await match(flags.deep)
    .with(true, async () => {
      await recordBareTurn({
        kind: "plain",
        run_id: runId,
        workflow: null,
        summary: `Answered: ${query}`,
      }).match(
        () => undefined,
        (e) => fail(`\nBlocked: session-state write failed: ${e}\n`, 1),
      );
      process.stdout.write("\n");
      process.exit(0);
    })
    .with(false, () => undefined)
    .exhaustive();

  // --- Quick lane: grounding grade (the confident-wrongness guard) ---------
  // A terse, thinking-off evidence-check over the SAME evidence + the answer. The
  // grader is the principled home for thinking-off — a mechanical support-check, not
  // open-ended synthesis. Mastra validates the small object; Navi renders it. On a
  // grader failure the answer already succeeded and printed, so hand off to --deep
  // rather than claiming the unavailable grade passed.
  const graderPrompt = `${prompt}\n\n=== ANSWER PRODUCED (grade this) ===\n${answerText}`;
  // Thinking-off is resolved fresh (NOT ...options) so the grader is deliberately
  // thinking-off regardless of the answer's --thinking; on a non-deepseek model
  // toMastraOptions simply drops the deepseek-only field.
  const graderOpts = toMastraOptions(model, resolveSettings(model, { thinking: "disabled" }));
  const groundingStage = await runGroundingStage(async () => {
    const result = await agent.generate(graderPrompt, {
      instructions: buildGraderInstructions(),
      memory: { thread: `${thread}-grade`, resource: "cli" },
      maxSteps: 1,
      // Tool-free like the answer: the grader judges from the provided evidence only.
      // Without this the shared workspace tools tempt it to "search" and it dies at
      // maxSteps:1 with narration and no verdict (observed live).
      activeTools: [],
      structuredOutput: structuredOutputOptions(GroundingGradeSchema),
      ...graderOpts,
    });
    return {
      finishReason: result.finishReason,
      object: result.object,
      text: result.text,
    };
  });

  // --- self-steering next command -------------------------------------------
  // Only a validated COMPLETE + no grade lets the quick answer stand. Every other
  // valid grade, and every unavailable/invalid grade, hands the caller the EXACT
  // command that re-runs THIS query on the deep lane. invocationPrefix() is
  // navi's own executable form (the portable bin name when installed, the tsx path in
  // a source checkout); -w keeps the SAME workspace and -t keeps the SAME session;
  // shellQuote keeps spaced/meta values pasteable into /bin/sh as one argument.
  const deepCmd = deepHandoffCommand(query, thread, flags.workspace);
  // Catalog-derived "same question, different lens" list. INFORMATIONAL only —
  // never a handed command. The ⚠ branch's `${deepCmd}` stays THE ONLY handed
  // command; the pass branch still contains NO --deep command.
  const movesBlock = [
    "",
    "  same question, different lens — copy one:",
    ...nextMoves(basePath, query).map((l) => `    ${l}`),
  ].join("\n");
  // A runnable `--deep` command appears only when the grounding result asks for it,
  // so an interop harness never escalates a passing quick answer.
  const groundingOutput = renderGroundingStage(groundingStage, deepCmd, movesBlock);
  process.stderr.write(groundingOutput.stderr);
  process.stdout.write(groundingOutput.stdout);
  await recordBareTurn({
    kind: "plain",
    run_id: runId,
    workflow: null,
    summary: `Answered: ${query}`,
  }).match(
    () => undefined,
    (e) => fail(`Blocked: session-state write failed: ${e}\n`, 1),
  );
  process.exit(0);
}

// --- run verb --------------------------------------------------------------

// The revision a run is anchored to: git HEAD of the workspace
// root, read by the CLI's OWN subprocess — model-free, and the one input the
// continuation-skip condition compares against a prior surface_map's hash. Total,
// never throws: spawnSync reports a spawn failure via `.error` / a non-zero
// `.status` (git absent, or basePath not a git repo) and both map to `null`,
// mirroring deriveCache's "infallible ⇒ return the value directly, not a Result".
function readRevision(basePath: string): string | null {
  const r = spawnSync("git", ["-C", basePath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return match(r.status)
    .with(0, () => r.stdout.trim())
    .otherwise(() => null);
}

type RunInvocation =
  | { kind: "run" }
  | { kind: "check"; event: string };

async function runVerb(
  runPos: string[],
  flags: Flags,
  invocation: RunInvocation = { kind: "run" },
): Promise<never> {
  // `runPos` arrives already flag-stripped from main()'s single parseArgs pass —
  // every recognized flag was consumed before the positional list was built.
  const token = match(runPos[0])
    .with(P.union(undefined, ""), () =>
      fail("navi run: missing workflow name — run `navi catalog` to list available flows\n", 1),
    )
    .otherwise((t) => t);
  // -w overrides the root the workflow is resolved AND run against (tiers + the
  // step agents' workspace). A bad dir is a loud usage error before load/compile.
  const basePath = resolveBasePath(flags.workspace).match(
    (v) => v,
    (e) => fail(`navi run: ${e}\n`, 1),
  );

  // --progress validates BEFORE any run (same shape as bareQuery). An out-of-set
  // value is a loud usage error; undefined falls through to resolveProgressMode's
  // TTY default (live on TTY, off when piped / --json-friendly silence).
  match(flags.progress)
    .with(undefined, () => undefined)
    .with(P.union(...PROGRESS_MODES), () => undefined)
    .otherwise(() =>
      fail(`navi run: --progress must be ${PROGRESS_MODES.join("|")}, got "${flags.progress}"\n`, 1),
    );
  const progressMode = resolveProgressMode(flags.progress, process.stderr.isTTY === true);

  // Load (resolve + parse + shape) once. A load failure — unknown workflow,
  // malformed action.yaml, broken wiring — is a compile-time failure: exit 1,
  // NOT the schema-failure code (4 is reserved for stdin input / envelope).
  // `loadShape` is async: a `.ts`-file `output:` reference is resolved by
  // dynamic import at plan time (still model-free). A broken reference lands as
  // a wiring lint error below, not a load failure.
  const shape = (await loadShape(token, basePath)).match(
    (v) => v,
    (e) => fail(`navi run: ${e}\n`, 1),
  );

  // Flow-scoped help. Answered from the SHAPE, not the catalog: ArgInfo drops each
  // arg's description and default (catalog.ts argsOf), and those are the only place
  // a caller learns what a `range` or a `base` actually accepts. The shape also
  // resolves a PATH token, which the name-keyed catalog cannot. Zero model calls.
  match(flags.help)
    .with(true, () => {
      console.log(flowHelp(shape, token, basePath));
      process.exit(0);
    })
    .with(false, () => undefined)
    .exhaustive();

  // --override is only meaningful on a live gated run that DEMANDS. Cheap
  // pre-check: --shape never reaches a gate, so the flag is a loud usage error
  // here (never a silent no-op skip-flag). Full gate-presence check is later
  // in runGatePath / the non-gate path.
  match({ override: flags.override, shape: flags.shape })
    .with({ override: P.string, shape: true }, () =>
      fail(`navi run: --override applies only to a live gated run\n`, 1),
    )
    .otherwise(() => undefined);

  // --shape is pure: print the resolved plan, no Agent, no model call.
  match(flags.shape)
    .with(true, () => {
      const summary = shapeSummary(shape);
      process.stdout.write(
        match(flags.json)
          .with(true, () => `${JSON.stringify(summary, null, 2)}\n`)
          .with(false, () => `${renderShape(shape)}\n`)
          .exhaustive(),
      );
      process.exit(
        match(lintErrors(shape).length)
          .with(0, () => 0)
          .otherwise(() => 1),
      );
    })
    .with(false, () => undefined)
    .exhaustive();

  // Bind input before anything that mutates state: a bad --stdin
  // payload / missing arg is a schema failure (exit 4) that must never reach a
  // model — and on --fork must fail BEFORE the clone, so a bad input never leaves an
  // orphan fork thread behind.
  const inputResult = match(invocation)
    .with({ kind: "run" }, () => readInputData(shape, runPos.slice(1), flags))
    .with({ kind: "check" }, ({ event }) =>
      bindStdin(shape, { event }).match(
        (inputData) => okAsync<Record<string, unknown>, string>(inputData),
        (message) => errAsync<Record<string, unknown>, string>(message),
      ),
    )
    .exhaustive();
  const inputData = (await inputResult).match(
    (v) => v,
    (e) => fail(`navi run: ${e}\n`, 4),
  );

  // With --fork, clone the -t session before reading prior state or running the
  // workflow. Every output and continuation targets the fork; the source remains
  // unchanged. Without -t there is nothing to clone, so --fork is a usage error.
  const sessionId = (await resolveThread(flags)).match(
    (v) => v,
    (e) => fail(`navi run: ${e}\n`, 1),
  );
  // Fork visibility, consistent with the bare path: name the source and the fork on
  // STDERR, so it shows in human runs AND stays off --json's stdout envelope. The
  // fork id is ALSO the envelope session_id, and the source is durably recorded in the
  // fork thread's metadata.clone.sourceThreadId (queryable via the lineage APIs) —
  // so no new envelope field is minted for it (navi.run.v2, zero external consumers;
  // decision-discipline).
  match(flags.fork)
    .with(true, () => void process.stderr.write(`navi run: forked ${flags.thread} → ${sessionId}\n`))
    .with(false, () => undefined)
    .exhaustive();

  // The self-steering continuation command's prefix is DERIVED from navi's own
  // invocation (invocationPrefix — the runtime + entry script as invoked), never the
  // hardcoded `navi` literal, so the emitted command is executable by construction in
  // the context Navi is actually running in.
  // Every interpolated token is shellQuote'd (invocation.ts): the prefix, the workflow
  // token (a path may carry spaces), and the session id. A safe token (a named workflow, a
  // UUID session id, a space-free install path) is emitted verbatim, so the allowlist
  // prefix still matches; a token with a space/metacharacter is quoted so the command
  // still pastes into /bin/sh as the intended argv.
  const continuationWorkspace = match(flags.workspace)
    .with(undefined, () => undefined)
    .otherwise(() => basePath);
  const nextCommand = continuationCommand(shape, token, sessionId, continuationWorkspace);
  const humanNextCommand = match(invocation)
    .with({ kind: "check" }, () =>
      checkContinuationCommand(sessionId, continuationWorkspace),
    )
    .with({ kind: "run" }, () => undefined)
    .exhaustive();

  // Reserved-input injection: compute `revision` (git HEAD, a
  // model-free subprocess) and `prior` (the newest SessionState on `-t` / the fork) and
  // inject both at the TOP LEVEL of inputData under the reserved keys. On --fork the
  // prior is read from the FORK's copied history (sessionId is the fork id), so the
  // continuation-skip condition compares the fork's OWN surface_map hash — proving
  // prior survived the clone. A step `condition` reads them as bare `prior`/`revision`
  // (compile.ts buildCtx spreads init to the eval-ctx top level); argsSchema is
  // .passthrough(), so the keys ride alongside declared args and never touch a
  // workflow that uses neither. A malformed prior is a LOUD exit 1 (never a silent
  // null): the session-of-record is corrupt, and substituting a stale/empty disposition
  // would mislead the judge.
  // Lazy arms: the DB read only happens on the -t path, exactly as before.
  const priorR: Result<SessionState | null, string> = await match(flags.thread)
    .with(undefined, async () => ok<SessionState | null, string>(null))
    .otherwise(async () =>
      readPriorSessionState(storage, sessionId),
    );
  const prior = priorR.match(
    (v) => v,
    (e) => fail(`navi run: ${e}\n`, 1),
  );
  inputData.revision = readRevision(basePath);
  inputData.prior = prior;
  // Discovery reuse is workflow-owned. A mixed session can carry a surface map
  // produced by another gate, so edge-walk may skip only when the immediately
  // preceding typed turn was also edge-walk. A later turn from another flow
  // deliberately makes discovery run again; that costs time but cannot suppress
  // the evidence pass on somebody else's artifact.
  inputData.prior_workflow = match(prior?.turn_history.at(-1)?.workflow)
    .with(P.string, (workflow) => workflow)
    .otherwise(() => null);
  const runId = randomUUID();

  // TWO views of the same filesystem, deliberately. compile() gets the skill tiers
  // so it can pop `skills.only` bodies into step-agent instructions; the run Mastra
  // gets a skills-FREE workspace so Mastra's SkillsProcessor never injects each
  // skill's absolute <location> into agents whose file tools are fenced to
  // basePath. Sharing one instance would let Mastra expose installed skill paths
  // outside an external workspace's filesystem boundary.
  const workspace = createWorkspace(basePath);
  const runWorkspace = createWorkspace(basePath, { skills: false });
  const compiled = await (await compile(
    shape,
    { thread: sessionId, resource: "cli" },
    workspace,
  )).match(
    async (v) => v,
    async (e) => {
      await appendTurn({
        sessionId,
        workflow: shape.name,
        prior,
        turn: {
          kind: "failure",
          run_id: runId,
          workflow: shape.name,
          reason: e,
        },
        event: eventOf(shape, inputData, flags, runPos.slice(1)),
      }).match(
        () => undefined,
        (writeError) => fail(`navi run: session-state write failed: ${writeError}\n`, 1),
      );
      return fail(`navi run: ${e}\n`, 1);
    },
  );

  const runMastra = new Mastra({
    workflows: { [shape.name]: compiled.workflow },
    agents: compiled.agents,
    workspace: runWorkspace,
    storage,
  });

  const started = Date.now();
  const result = await ResultAsync.fromPromise(
    (async () => {
      const wf = runMastra.getWorkflowById(shape.name);
      const run = await wf.createRun({ runId });
      const runOutput = run.stream({ inputData });
      for await (const ev of runOutput.fullStream) {
        const payload: Record<string, unknown> = match(ev)
          .with(
            {
              payload: P.when(
                (p): p is Record<string, unknown> => typeof p === "object" && p !== null,
              ),
            },
            (e) => e.payload,
          )
          .otherwise((): Record<string, unknown> => ({}));
        workflowEventProgress(progressMode, { type: ev.type, payload });
      }
      return await runOutput.result;
    })(),
    errStr,
  );

  const duration_ms = Date.now() - started;
  const base = {
    run_id: runId,
    session_id: sessionId,
    workflow: shape.name,
    event: "run",
    shape,
    nextCommand,
    humanNextCommand,
  };

  // Classify the final output against BOTH decision contracts at one boundary.
  // Zod object schemas strip unknown keys, so an object carrying every gate field
  // and every verdict field validates as both. Choosing either contract would
  // silently discard the other judgment. That ambiguity is a failed run, recorded
  // on the session; exact gates and exact verdicts keep their established paths.
  const finalHit = result
    .map((wr) =>
      match(wr)
        .with({ status: "success" }, (s) => {
          const output = finalOutput(shape, s.steps);
          return match([
            GateDecision.safeParse(output),
            VerdictSchema.safeParse(output),
          ])
            .with([{ success: true }, { success: true }], () => ({
              kind: "ambiguous" as const,
            }))
            .with([{ success: true }, { success: false }], ([{ data }]) => ({
              kind: "gate" as const,
              steps: s.steps,
              gateOutput: output,
              gate: data,
            }))
            .otherwise(() => ({ kind: "non_gate" as const }));
        })
        .otherwise(() => ({ kind: "non_gate" as const })),
    )
    .unwrapOr({ kind: "non_gate" as const });

  return match(finalHit)
    .with({ kind: "ambiguous" }, async () => {
      const reason =
        "final output is ambiguous: it validates as both GateDecision and VerdictSchema";
      await appendTurn({
        sessionId,
        workflow: shape.name,
        prior,
        turn: {
          kind: "failure",
          run_id: runId,
          workflow: shape.name,
          reason,
        },
        event: eventOf(shape, inputData, flags, runPos.slice(1)),
      }).match(
        () => undefined,
        (e) => fail(`navi run: session-state write failed: ${e}\n`, 1),
      );
      return fail(`navi run: ${reason}\n`, 1);
    })
    .with({ kind: "non_gate" }, async () => {
      // --override with no GateDecision on the final output is a loud usage
      // error: nothing was gated, so there is nothing to override. Never a
      // silent skip-flag on a plain non-gated workflow.
      await match(flags.override)
        .with(undefined, () => undefined)
        .otherwise(async () => {
          const reason = "--override applies only to a gated run — this workflow returned no gate";
          await appendTurn({
            sessionId,
            workflow: shape.name,
            prior,
            turn: {
              kind: "failure",
              run_id: runId,
              workflow: shape.name,
              reason,
            },
            event: eventOf(shape, inputData, flags, runPos.slice(1)),
          }).match(
            () => undefined,
            (e) => fail(`navi run: session-state write failed: ${e}\n`, 1),
          );
          return fail(`navi run: ${reason}\n`, 1);
        });

      const envelope: RunEnvelope = result.match(
        (wr) =>
          match(wr)
            .with({ status: "success" }, (s) =>
              successEnvelope({
                ...base,
                summary: summarize(shape, s.steps),
                result: finalOutput(shape, s.steps),
                trace: { duration_ms, ranSteps: ranStepsOf(s.steps) },
              }),
            )
            .otherwise((f) =>
              failureEnvelope({
                ...base,
                reason: reasonOf(f),
                // Mastra non-success WorkflowResult always carries steps (types.d.ts);
                // local interface only — do not force exhaustive on Mastra's open status union.
                trace: { duration_ms, ranSteps: ranStepsOf(failedWorkflowSteps(f)) },
              }),
            ),
        (message) => failureEnvelope({ ...base, reason: message, trace: { duration_ms, ranSteps: [] } }),
      );

      await appendEnvelopeTurn(
        envelope,
        prior,
        eventOf(shape, inputData, flags, runPos.slice(1)),
      ).match(
        () => undefined,
        (e) => fail(`navi run: session-state write failed: ${e}\n`, 1),
      );
      emit(envelope, flags, humanNextCommand);
      process.exit(exitFor(envelope));
    })
    .with({ kind: "gate" }, (hit) =>
      runGatePath({
        base,
        flags,
        token,
        shape,
        steps: hit.steps,
        gateOutput: hit.gateOutput,
        gate: hit.gate,
        duration_ms,
        prior,
        sessionId,
        inputData,
        // Honest parent-event signal: the joined positional argv BEFORE defaults
        // (bindArgs has already applied defaultsOf into inputData).
        argValues: runPos.slice(1),
        basePath,
      }),
    )
    .exhaustive();
}

// --- gate path --------------------------------------------------------------
// Reached only when the final
// step's output is a GateDecision (runVerb's shape-keyed detection). Does the liberal
// sibling extraction, persists the session-of-record (appendSessionState's first production
// caller), and emits the gate envelope. Never returns — always process.exit.

// Continuation command for a gated run's `next.command`. Mirrors
// the binder's own transport rule. It is shape-keyed rather than
// workflow-name-keyed so the advertised command is always runnable.
//
// Transport pick mirrors boundStdinKey / bindStdin (below): ANY json-typed arg at
// ANY position ⇒ the --stdin transport. bindStdin binds the first json-typed arg
// wherever it sits; keying only on `shape.args[0]` would advertise a positional
// continuation for a mixed shape (string then json) that bindArgs cannot fill
// (json refuses positional prose) and that bindStdin expects on --stdin — an
// unrunnable whisper. Edge-walk's sole arg is json-typed `input`, so its loop
// uses `--json --stdin -t <id>`.
// All-string shapes keep the positional `'<name>'` placeholder; argless → bare `-t`.
function continuationCommand(
  shape: Shape,
  token: string,
  sessionId: string,
  workspace: string | undefined = undefined,
): string {
  const prefix = invocationPrefix();
  const quotedToken = shellQuote(token);
  const quotedSession = shellQuote(sessionId);
  const suffix = [
    "-t",
    quotedSession,
    ...match(workspace)
      .with(undefined, (): string[] => [])
      .otherwise((path) => ["-w", shellQuote(path)]),
  ].join(" ");
  // Prefer the first json-typed arg (any position); else fall back to args[0]
  // (string placeholder or nullish bare). Same "first json wins" rule as boundStdinKey.
  return match(shape.args.find((a) => a.type === "json") ?? shape.args[0])
    .with({ type: "json" }, () =>
      // JSON-argument continuations read their payload from stdin.
      `${prefix} run ${quotedToken} --json --stdin ${suffix}`,
    )
    .with({ type: "string" }, (arg) =>
      // Positional PLACEHOLDER from the arg's own name (e.g. '<answer>'), shell-quoted
      // so a copy-paste survives as one argv element. NO --json: a prose conversation
      // hands the parent readable output, not an envelope wall.
      `${prefix} run ${quotedToken} ${shellQuote(`<${arg.name}>`)} ${suffix}`,
    )
    .with(P.nullish, () =>
      // No declared arg: same transport choice as string (no --json/--stdin), nothing
      // to placehold.
      `${prefix} run ${quotedToken} ${suffix}`,
    )
    .exhaustive();
}

function checkContinuationCommand(
  sessionId: string,
  workspace: string | undefined,
): string {
  const command = [
    invocationPrefix(),
    "check",
    shellQuote("<new evidence>"),
    "-t",
    shellQuote(sessionId),
    ...match(workspace)
      .with(undefined, (): string[] => [])
      .otherwise((path) => ["-w", shellQuote(path)]),
  ].join(" ");
  return `replace \`<new evidence>\` with what changed, then run:\n  ${command}`;
}

// Catalog-validate a model-supplied handoff and render its next.command, or null.
// The model picks a catalog NAME + request text — never shell. An ACTIVE catalog
// workflow that accepts a single required string arg (isSingleRequiredString —
// same predicate the bare-query whisper uses) ⇒
// `${invocationPrefix()} run ${shellQuote(flow)} ${shellQuote(request)}`
// (same helpers continuationCommand uses, so no unquoted model token reaches the
// shell). A name NOT in the active catalog, or one whose arg grammar cannot take
// a positional prose brief (json-arg edge-walk, optional git-range code-review),
// is NOT a hard failure and NOT a silent drop: one honest stderr line names why,
// and the COMPLETE arm keeps command null (as if the handoff were absent). Pure
// over the catalog snapshot; the only side effect is that stderr note.
function resolveHandoff(
  handoff: Handoff | undefined,
  basePath: string,
  workspace: string | undefined,
): { flow: string; command: string } | null {
  return match(handoff)
    .with(undefined, () => null)
    .otherwise((h) =>
      match(buildCatalog(basePath).workflows.find((w) => w.name === h.flow && w.active))
        .with(undefined, () => {
          process.stderr.write(
            `navi: handoff flow "${h.flow}" is not in the catalog — ignoring handoff\n`,
          );
          return null;
        })
        .otherwise((entry) =>
          match(isSingleRequiredString(entry))
            .with(false, () => {
              process.stderr.write(
                `navi: handoff flow "${h.flow}" does not accept a single required string arg — ignoring handoff\n`,
              );
              return null;
            })
            .with(true, () => ({
              flow: h.flow,
              command: [
                invocationPrefix(),
                "run",
                shellQuote(h.flow),
                shellQuote(h.request),
                ...match(workspace)
                  .with(undefined, (): string[] => [])
                  .otherwise((path) => ["-w", shellQuote(path)]),
              ].join(" "),
            }))
            .exhaustive(),
        ),
    );
}

async function runGatePath(inp: {
  base: {
    run_id: string;
    session_id: string;
    workflow: string;
    event: string;
    shape: Shape;
    nextCommand: string;
    humanNextCommand?: string | undefined;
  };
  flags: Flags;
  token: string;
  shape: Shape;
  steps: unknown;
  gateOutput: unknown;
  gate: GateDecision;
  duration_ms: number;
  prior: SessionState | null;
  sessionId: string;
  inputData: Record<string, unknown>;
  // Raw positional argv for this run (pre-defaults). eventOf records a parent
  // event only from this — never from inputData after defaultsOf.
  argValues: string[];
  // Workspace root for catalog validation of a COMPLETE handoff (same basePath
  // runVerb already resolved for load/compile — never re-derived here).
  basePath: string;
}): Promise<never> {
  // Liberal sibling extraction: the judge's composite may carry directives/findings/
  // surface_map/handoff alongside the GateDecision fields. Take them when present
  // AND Zod-valid; a present-but-invalid sibling is a LOUD runtime failure (exit 1),
  // never a silent drop — the judge's judgment content must not be quietly lost.
  const event = eventOf(inp.shape, inp.inputData, inp.flags, inp.argValues);
  const extracted = await extractWhisperFields(inp.gateOutput).match(
    async (v) => v,
    async (e) => {
      await appendTurn({
        sessionId: inp.sessionId,
        workflow: inp.shape.name,
        prior: inp.prior,
        turn: {
          kind: "failure",
          run_id: inp.base.run_id,
          workflow: inp.shape.name,
          reason: e,
        },
        event,
      }).match(
        () => undefined,
        (writeError) => fail(`navi run: session-state write failed: ${writeError}\n`, 1),
      );
      return fail(`navi run: ${e}\n`, 1);
    },
  );
  // This run's surface map: the judge's own sibling when present, else the freshest
  // step output that is itself a full SurfaceMap (e.g. edge-walk's expand step).
  const surfaceMapThisRun = extracted.surfaceMap ?? freshestSurfaceMap(inp.shape, inp.steps);
  const evidenceItems = evidenceItemsOf(inp.shape, inp.inputData, inp.flags);
  // Catalog-validate the handoff NOW (before emit) so an unknown flow's stderr note
  // lands before the envelope; the resolved value is threaded into nextForGate only
  // for the COMPLETE arm (see gateEnvelope).
  const handoff = resolveHandoff(
    extracted.handoff,
    inp.basePath,
    match(inp.flags.workspace)
      .with(undefined, () => undefined)
      .otherwise(() => inp.basePath),
  );

  await match({ override: inp.flags.override, gate: inp.gate.gate })
    .with(
      { override: P.string, gate: P.union("CLEAR", "COMPLETE") },
      async ({ gate }) => {
        const reason = `--override: nothing to override — gate ${gate} makes no demand`;
        await appendTurn({
          sessionId: inp.sessionId,
          workflow: inp.shape.name,
          prior: inp.prior,
          turn: {
            kind: "failure",
            run_id: inp.base.run_id,
            workflow: inp.shape.name,
            reason,
          },
          event,
        }).match(
          () => undefined,
          (e) => fail(`navi run: session-state write failed: ${e}\n`, 1),
        );
        return fail(`navi run: ${reason}\n`, 1);
      },
    )
    .otherwise(() => undefined);

  // Persist the session-of-record BEFORE emitting: a write failure is an honest exit 1
  // (the loop can't continue on `-t` if the session wasn't durably recorded), never a
  // silent success. appendSessionState also writes the metadata cache, so the session appears in
  // `navi session list`. The CLI owns only append-only MECHANICS (assembleSessionState);
  // judgment content is the judge's, carried in its output arrays.
  const assembledState = assembleSessionState({
    sessionId: inp.sessionId,
    workflow: inp.shape.name,
    prior: inp.prior,
    turn: {
      kind: "gate",
      run_id: inp.base.run_id,
      workflow: inp.shape.name,
      decision: inp.gate,
    },
    directives: extracted.directives,
    findings: extracted.findings,
    surfaceMap: surfaceMapThisRun,
    event,
    evidenceItems,
  });
  // Parent override-on-record: when `--override <reason>` is set, DEMANDING gates
  // (DIRECT/REPAIR/BLOCKED/ESCALATE) get the ledger record BEFORE append so the
  // persisted SessionState + derived cache carry it; CLEAR/COMPLETE make the flag a
  // loud usage error because there is nothing to override.
  const state = match(inp.flags.override)
    .with(undefined, () => assembledState)
    .otherwise((reason) =>
      match(inp.gate.gate)
        .with("DIRECT", "REPAIR", "BLOCKED", "ESCALATE", (gate) =>
          applyOverride(assembledState, reason, gate),
        )
        // The invalid CLEAR/COMPLETE combination was persisted as a failure and
        // exited above; this arm is unreachable at runtime but keeps the union
        // exhaustive for TypeScript.
        .with("CLEAR", "COMPLETE", () => assembledState)
        .exhaustive(),
    );
  // Void on success, so the ok arm has nothing to bind: the whole call IS the branch
  // (write, or fail loudly) — awaited before the envelope is emitted, order unchanged.
  await appendSessionState(storage, sessionClient, inp.sessionId, state).match(
    () => undefined,
    (e) => fail(`navi run: session-state write failed: ${e}\n`, 1),
  );

  // The literal continuation command has the thread id baked in, and
  // the transport/args mirror the flow's own shape (continuationCommand above) so a
  // parent following the whisper verbatim can actually re-invoke. The prefix is
  // derived from Navi's own invocation, so the parent can run it in the same
  // context without dropping `-t`.
  const whisperCommand = inp.base.nextCommand;
  // Envelope reports the judge's TRUE gate (honesty) — only the exit code and the
  // ledger record change under --override. handoff is CLI-resolved (catalog +
  // shellQuote); nextForGate applies it only on COMPLETE.
  const envelope = gateEnvelope({
    ...inp.base,
    summary: `${inp.gate.gate} — ${inp.gate.reason}`,
    result: inp.gateOutput,
    gate: inp.gate.gate,
    surface_map: surfaceMapThisRun ?? null,
    directives: extracted.directives ?? [],
    findings: extracted.findings ?? [],
    evidence: evidenceItems,
    confidence: inp.gate.confidence,
    blockingDirectiveIds: inp.gate.blocking_directive_ids,
    whisperCommand,
    handoff,
    trace: { duration_ms: inp.duration_ms, ranSteps: ranStepsOf(inp.steps) },
  });
  emit(envelope, inp.flags, inp.base.humanNextCommand);
  // An override records the decision and exits 0 instead of using the blocking
  // gate's exit code. One process.exit preserves the Promise<never> contract.
  const exitCode = match(inp.flags.override)
    .with(undefined, () => exitForGate(inp.gate.gate))
    .otherwise((reason) => {
      process.stderr.write(
        `navi: ⚠ override recorded — you are proceeding against ${inp.gate.gate} ("${reason}"). The session remembers.\n`,
      );
      return 0 as const;
    });
  process.exit(exitCode);
}

// The judge composite's sibling whisper fields (directives/findings/surface_map/
// handoff), extracted from the final output. A field ABSENT ⇒ undefined (fall
// back downstream). A field PRESENT but failing its contract ⇒ a loud Err
// (exit 1 in runGatePath), never a silent drop. Keyed on field presence, exactly
// like the GateDecision detection.

// ONE owner for all siblings, so the absent-vs-invalid split and the error
// wording can't drift between them. safeParse IS a discriminated union, so both
// arms are matched — `data`/`error` are each only in scope where they exist.
function whisperField<S extends z.ZodTypeAny>(
  rec: Record<string, unknown>,
  key: string,
  schema: S,
): Result<z.infer<S> | undefined, string> {
  return match(key in rec)
    .with(false, () => ok<z.infer<S> | undefined, string>(undefined))
    .with(true, () =>
      match(schema.safeParse(rec[key]))
        .with({ success: true }, ({ data }) => ok<z.infer<S> | undefined, string>(data))
        .with({ success: false }, ({ error }) =>
          err<z.infer<S> | undefined, string>(`gate output "${key}" failed validation: ${zodIssues(error)}`),
        )
        .exhaustive(),
    )
    .exhaustive();
}

function extractWhisperFields(
  output: unknown,
): Result<
  { directives?: Directive[]; findings?: Finding[]; surfaceMap?: SurfaceMap; handoff?: Handoff },
  string
> {
  return match(output)
    .with(P.when(isJsonObject), (rec) =>
      // Result.combine surfaces the FIRST failing field in this order — the same
      // field precedence the sequential guards had. handoff is last so a bad
      // directives/findings/surface_map still fails first (judgment before routing).
      Result.combine([
        whisperField(rec, "directives", z.array(Directive)),
        whisperField(rec, "findings", z.array(Finding)),
        whisperField(rec, "surface_map", SurfaceMap),
        whisperField(rec, "handoff", Handoff),
      ]).map(([directives, findings, surfaceMap, handoff]) => ({
        // A key is spread in only when the field was present AND valid, so an
        // absent sibling stays absent rather than becoming an explicit undefined.
        ...match(directives)
          .with(undefined, () => ({}))
          .otherwise((v) => ({ directives: v })),
        ...match(findings)
          .with(undefined, () => ({}))
          .otherwise((v) => ({ findings: v })),
        ...match(surfaceMap)
          .with(undefined, () => ({}))
          .otherwise((v) => ({ surfaceMap: v })),
        ...match(handoff)
          .with(undefined, () => ({}))
          .otherwise((v) => ({ handoff: v })),
      })),
    )
    .otherwise(() => ok({}));
}

// The freshest step output THIS run that is itself a full SurfaceMap — walking reverse
// shape order for the last success (edge-walk's expand step). Lenient: a non-matching
// output (the GateDecision, an agent's {text}) simply isn't a SurfaceMap, so it's
// skipped, not an error. undefined when no step produced one this run.
function freshestSurfaceMap(shape: Shape, steps: unknown): SurfaceMap | undefined {
  const rec = stepRunMapOf(steps);
  // Reverse shape order, successes only, first output that IS a SurfaceMap wins —
  // `.filter().map().find()` is that walk, with the skip as a predicate.
  return [...shape.steps]
    .reverse()
    .filter((s) => rec[s.name]?.status === "success")
    .map((s) => SurfaceMap.safeParse(unwrapCommandJson(rec[s.name]?.output ?? null)))
    .find((parsed) => parsed.success)?.data;
}

// This run's raw parent event is appended to parent_events. Two transports share
// the same ledger slot:
//
//   --stdin:  the object's `event` key when present.
//             String events use the positional transport's `{ task }` ledger
//             shape so story can narrate the parent's half of the exchange;
//             structured events stay byte-for-byte unchanged.
//   positional (non-stdin): the joined argv the parent ACTUALLY supplied. Do
//             NOT read inputData here — bindArgs has already applied defaultsOf,
//             so a gated flow whose first arg has a `default:` would write that
//             default into parent_events as if the parent said it. argValues is
//             the honest pre-default signal. Shaped as `{ task: <text> }` so
//             existing consumers keep working: taskFromEvent reads `event.task`
//             for SessionState.task / titleFromTask, and story renders a `parent:`
//             beat for the same shape (session-view.ts). Empty / unbound ⇒ undefined.
//
// Raw/untyped by contract (parent_events is append-only raw).
function eventOf(
  shape: Shape,
  inputData: Record<string, unknown>,
  flags: Flags,
  argValues: string[],
): unknown {
  return match(flags.stdin)
    .with(false, () =>
      match(shape.args[0])
        .with({ type: "string" }, () =>
          match(argValues.join(" ").trim())
            .with(P.string.minLength(1), (text) => ({ task: text }))
            .otherwise(() => undefined),
        )
        .otherwise(() => undefined),
    )
    .with(true, () =>
      match(inputData[boundStdinKey(shape)])
        // Parent events must be object-valued stdin payloads.
        .with(P.when(isJsonObject), (obj) =>
          match("event" in obj)
            .with(true, () =>
              match(obj.event)
                .with(P.string, (task) => ({ task }))
                .otherwise((event) => event),
            )
            .with(false, () => undefined)
            .exhaustive(),
        )
        .otherwise(() => undefined),
    )
    .exhaustive();
}

// This run's gate-validated stdin evidence items, for append to SessionState.evidence.
// The full EvidenceEvent was already validated by evidenceGate at input binding, so
// the items re-parse cleanly; a non-evidence stdin (or a non-stdin run) yields [].
function evidenceItemsOf(shape: Shape, inputData: Record<string, unknown>, flags: Flags): Evidence[] {
  return match(flags.stdin)
    .with(false, (): Evidence[] => [])
    .with(true, () =>
      match(evidenceCandidate(inputData[boundStdinKey(shape)]))
        .with(null, (): Evidence[] => [])
        .otherwise((candidate) =>
          match(z.array(Evidence).safeParse(candidate.evidence))
            .with({ success: true }, ({ data }) => data)
            .with({ success: false }, (): Evidence[] => [])
            .exhaustive(),
        ),
    )
    .exhaustive();
}

// --- catalog verb ----------------------------------------------------------
// A pure filesystem display pass over the configured tiers (src/catalog.ts):
// no model, no Workspace, never workspace.skills.get() (which throws on a
// same-name collision — the exact session the catalog must render and flag). Always
// exits 0: surfacing a collision IS the job, not failing on it. `--json` reuses
// the existing flag plumbing for a machine-parseable object.
async function catalogVerb(flags: Flags): Promise<never> {
  // -w lists the tiers of ANOTHER dir; a bad dir is a loud usage error (exit 1),
  // the one non-zero exit for catalog — surfacing a collision still exits 0.
  const basePath = resolveBasePath(flags.workspace).match(
    (v) => v,
    (e) => fail(`navi catalog: ${e}\n`, 1),
  );
  const cat = buildCatalog(basePath);
  process.stdout.write(
    match(flags.json)
      .with(true, () => `${JSON.stringify(cat, null, 2)}\n`)
      .with(false, () => `${renderCatalog(cat)}\n`)
      .exhaustive(),
  );
  process.exit(0);
}

// --- session verb ------------------------------------------------------------
// Two thin reads over native Mastra APIs in src/session-view.ts. Both operate on
// the shared `storage` (navi.db) —
// sessions are threads in the one db regardless of -w (which scopes SEARCH, not the
// session store), so -w does not apply here. No model call on either path.
async function sessionVerb(sessionPos: string[], flags: Flags): Promise<never> {
  return match(sessionPos[0])
    .with("list", () => sessionListVerb(flags))
    .with("show", () => sessionShowVerb(sessionPos[1], flags))
    .with("archive", () => sessionArchiveVerb(sessionPos.slice(1), true))
    .with("unarchive", () => sessionArchiveVerb(sessionPos.slice(1), false))
    .otherwise((sub) => {
      const named = match(sub)
        .with(P.union(undefined, ""), () => "(none)")
        .otherwise((s) => `"${s}"`);
      process.stderr.write(
        `navi session: unknown subcommand ${named} — expected list|show|archive|unarchive\n`,
      );
      process.exit(1);
    });
}

async function sessionListVerb(flags: Flags): Promise<never> {
  // --status/--gate validate against the enum vocabularies BEFORE the DB read: an
  // unknown value is a loud usage error listing the legal values (exit 1).
  const filters = parseListFilters(flags.status, flags.gate, flags.verdict).match(
    (v) => v,
    (e) => fail(`navi session list: ${e}\n`, 1),
  );
  // listSessions returns ALL matching sessions (incl. archived); visibility is a
  // display/json filter — --all includes archived rows.
  const allRows = (await listSessions(storage, filters)).match(
    (v) => v,
    (e) => fail(`navi session list: ${e}\n`, 1),
  );
  const visibility = { all: flags.all };
  await writeStdout(
    match(flags.json)
      .with(true, () => `${JSON.stringify(visibleSessions(allRows, visibility), null, 2)}\n`)
      .with(false, () => `${renderSessionList(allRows, visibility)}\n`)
      .exhaustive(),
  );
  process.exit(0);
}

// Soft-hide / restore one or more sessions via thread metadata.archived.
// Each token is a handle or full id (resolveSessionToken). Unknown tokens print the
// friendly resolve error and continue; exit 1 only when NOTHING succeeded.
// updateThread re-passes the existing title (never blank) — see setSessionArchived.
async function sessionArchiveVerb(tokens: string[], archived: boolean): Promise<never> {
  const verb = match(archived)
    .with(true, () => "archive" as const)
    .with(false, () => "unarchive" as const)
    .exhaustive();
  const past = match(archived)
    .with(true, () => "archived")
    .with(false, () => "unarchived")
    .exhaustive();
  const list = match(tokens)
    .with([], () =>
      fail(
        `navi session ${verb}: missing session — usage: navi session ${verb} <session…>  (handles from: navi session list)\n`,
        1,
      ),
    )
    .otherwise((ts) => ts);

  // Sequential: each resolve+update is independent; failures do not abort the rest.
  // Ok-count drives exit: 1 only when nothing landed.
  let succeeded = 0;
  for (const token of list) {
    const result = await resolveSessionToken(storage, token).andThen((sessionId) =>
      setSessionArchived(storage, sessionId, archived).map(({ handle, title }) => ({
        handle,
        // Display-cap for the confirmation line (same 60-char title style as
        // session list), quoted for readability.
        title: titleFromTask(title),
      })),
    );
    result.match(
      ({ handle, title }) => {
        succeeded += 1;
        process.stdout.write(`${past} ${handle} — "${title}"\n`);
      },
      (e) => {
        process.stderr.write(`navi session ${verb}: ${e}\n`);
      },
    );
  }
  process.exit(
    match(succeeded > 0)
      .with(true, () => 0)
      .with(false, () => 1)
      .exhaustive(),
  );
}

async function sessionShowVerb(id: string | undefined, flags: Flags): Promise<never> {
  const token = match(id)
    .with(P.union(undefined, ""), () =>
      fail("navi session show: missing session id — usage: navi session show <id|handle>\n", 1),
    )
    .otherwise((v) => v);
  // Handle OR full id. Unknown token → friendly "not a session" (never "no such thread").
  const sessionId = (await resolveSessionToken(storage, token)).match(
    (v) => v,
    (e) => fail(`navi session show: ${e}\n`, 1),
  );
  // A non-session thread or a malformed SessionState message are loud errs (exit 1) —
  // never a crash or a silent empty render (session-view.ts).
  const view = (await showSession(storage, sessionId)).match(
    (v) => v,
    (e) => fail(`navi session show: ${e}\n`, 1),
  );
  await writeStdout(
    match(flags.json)
      .with(true, () => `${JSON.stringify(view, null, 2)}\n`)
      .with(false, () => `${renderSessionShow(view)}\n`)
      .exhaustive(),
  );
  process.exit(0);
}

// --- story verb (deterministic per-session narrative) -------------------------
// Pure formatting over recorded SessionStates — zero model calls. A missing id
// points at `navi session list`. Same storage as session show (shared navi.db;
// -w does not apply).
// Accepts a word handle OR a full session id via resolveSessionToken.
async function storyVerb(id: string | undefined, flags: Flags): Promise<never> {
  const token = match(id)
    .with(P.union(undefined, ""), () =>
      fail(
        "navi story: missing session id — pick one from: navi session list\n",
        1,
      ),
    )
    .otherwise((v) => v);
  // Handle OR full id. Zero match / resolve fail → friendly "not a session" wording
  // (never leak "no such thread"). Ambiguous handle keeps resolveSessionToken's detail.
  const sessionId = (await resolveSessionToken(storage, token)).match(
    (v) => v,
    (e) =>
      fail(
        match(e)
          .with(P.string.startsWith("ambiguous handle"), (msg) => `navi story: ${msg}\n`)
          .otherwise(
            () => `navi story: "${token}" is not a session — pick one from: navi session list\n`,
          ),
        1,
      ),
  );
  const view = (await storySession(storage, sessionId)).match(
    (v) => v,
    (e) =>
      fail(
        match(e)
          .with(P.string.includes("no such thread"), () =>
            `navi story: "${token}" is not a session — pick one from: navi session list\n`,
          )
          .otherwise((msg) => `navi story: ${msg}\n`),
        1,
      ),
  );
  await writeStdout(
    match(flags.json)
      .with(true, () => `${JSON.stringify(view, null, 2)}\n`)
      .with(false, () => `${renderStory(view)}\n`)
      .exhaustive(),
  );
  process.exit(0);
}

// --- input binding ---------------------------------------------------------

function readInputData(
  shape: Shape,
  argValues: string[],
  flags: Flags,
): ResultAsync<Record<string, unknown>, string> {
  return match(flags.stdin)
    .with(true, () =>
      readStdin()
        .andThen((raw) => parseJson(raw))
        .andThen((input) => evidenceGate(input).andThen(() => bindStdin(shape, input))),
    )
    .with(false, () =>
      bindArgs(shape, argValues).match(
        (inputData) => okAsync<Record<string, unknown>, string>(inputData),
        (message) => errAsync<Record<string, unknown>, string>(message),
      ),
    )
    .exhaustive();
}

// The candidate evidence-return event in a --stdin payload is `input.event` when
// the object carries an object-valued `event` key, else the stdin object itself (a bare
// `{directive_id, evidence}`). Returned only when it CLAIMS to carry evidence — a
// `directive_id` or `evidence` key is present. Plain workflow args, or a
// plan/interpretation event with neither key, return null and are left untouched.
function evidenceCandidate(stdin: unknown): Record<string, unknown> | null {
  return match<unknown, Record<string, unknown> | null>(stdin)
    .with(P.when(isJsonObject), (obj) => {
      const candidate = match(obj.event)
        .with(P.when(isJsonObject), (event) => event)
        .otherwise(() => obj);
      return match("directive_id" in candidate || "evidence" in candidate)
        .with(true, (): Record<string, unknown> | null => candidate)
        .with(false, () => null)
        .exhaustive();
    })
    .otherwise(() => null);
}

// A --stdin payload that claims to be an
// evidence return MUST validate against EvidenceEvent BEFORE any compile/model
// work. Structural garbage → a schema err that runVerb maps to exit 4 (one-line
// message on stderr), with zero model calls and no thread writes. Whether the
// evidence actually proves the claim is judge discipline, never this schema. A
// payload that makes no evidence claim
// passes through untouched (non-event stdin is unaffected).
function evidenceGate(stdin: unknown): Result<void, string> {
  return match(evidenceCandidate(stdin))
    .with(null, () => ok<void, string>(undefined))
    .otherwise((candidate) =>
      match(EvidenceEvent.safeParse(candidate))
        .with({ success: true }, () => ok<void, string>(undefined))
        .with({ success: false }, ({ error }) =>
          err<void, string>(`evidence event schema failure: ${zodIssues(error)}`),
        )
        .exhaustive(),
    );
}

// Positional args become declared inputs: joined text fills the first
// declared arg; defaults fill the rest; a required arg left unfilled is an error.
function bindArgs(shape: Shape, argValues: string[]): Result<Record<string, unknown>, string> {
  const inputData = defaultsOf(shape);
  const joined = argValues.join(" ").trim();
  return (
    match({ first: shape.args[0], joined })
      .with({ first: P.not(P.nullish), joined: P.not("") }, ({ first }) =>
        // A `json` arg takes a whole JSON value, never positional prose: filling it
        // from argv text would smuggle a bare string where an object is meant. Refuse
        // loudly, naming --stdin as the transport, rather than silently parsing
        // positional prose as JSON.
        match(first.type)
          .with("json", () =>
            err<Record<string, unknown>, string>(
              `arg "${first.name}" is JSON-typed — provide it via --stdin (positional text cannot fill a JSON arg)`,
            ),
          )
          .with("string", () => {
            inputData[first.name] = joined;
            return ok<Record<string, unknown>, string>(inputData);
          })
          .exhaustive(),
      )
      .otherwise(() => ok<Record<string, unknown>, string>(inputData))
      // Validate required inputs only after positional binding succeeds.
      .andThen(() => requireArgs(shape, inputData))
  );
}

// Declared defaults, pre-seeded in declaration order (the shared first half of both
// binding paths). A default of `undefined` means "no default", so it is filtered out
// rather than written as a present-but-undefined key.
function defaultsOf(shape: Shape): Record<string, unknown> {
  const inputData: Record<string, unknown> = {};
  shape.args
    .filter((a) => a.default !== undefined)
    .forEach((a) => {
      inputData[a.name] = a.default;
    });
  return inputData;
}

// The required-arg check both binding paths run (ONE owner, so the wording and the
// accept/reject can't drift). A required arg still unfilled after defaults + binding
// is a loud schema failure (exit 4 at the CLI seam), never a Mastra-internal throw.
function requireArgs(shape: Shape, inputData: Record<string, unknown>): Result<Record<string, unknown>, string> {
  const missing = shape.args.filter((a) => a.required && inputData[a.name] === undefined);
  return match(missing.length)
    .with(0, () => ok<Record<string, unknown>, string>(inputData))
    .otherwise(() =>
      err<Record<string, unknown>, string>(`missing required arg(s): ${missing.map((a) => a.name).join(", ")}`),
    );
}

// --stdin binding: the whole stdin JSON object binds to the workflow's declared
// json-typed arg by name (the first `json` arg, but
// never hardcoded to that literal key), defaults fill the other declared args, and
// the SAME required-arg check the positional path runs then applies — so a --stdin
// run with a missing required non-stdin arg fails LOUDLY at the boundary (exit 4),
// not with a Mastra-internal validation throw mid-run. An argless workflow (the
// session-continuation fixtures) declares no json arg, so the object falls back to the
// literal `input` key. The CLI still injects
// revision/prior/prior_workflow through argsSchema's .passthrough().
function bindStdin(shape: Shape, input: unknown): Result<Record<string, unknown>, string> {
  const inputData = defaultsOf(shape);
  inputData[boundStdinKey(shape)] = input;
  return requireArgs(shape, inputData);
}

// The declared arg the --stdin object binds to: the first `json`-typed arg's name,
// else the literal `input` (the argless or no-json-arg fallback).
// ONE owner so the bind (bindStdin) and the read-back (eventOf/evidenceItemsOf)
// resolve the SAME key — never a moved-elsewhere hardcode.
function boundStdinKey(shape: Shape): string {
  return shape.args.find((a) => a.type === "json")?.name ?? "input";
}

function readStdin(): ResultAsync<string, string> {
  return ResultAsync.fromPromise(
    (async () => {
      let data = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) data += chunk;
      return data;
    })(),
    (e) => `cannot read stdin: ${errStr(e)}`,
  );
}

const parseJson = Result.fromThrowable(
  (raw: string) => JSON.parse(raw) as unknown,
  (e) => `invalid stdin JSON: ${errStr(e)}`,
);

// --- output ----------------------------------------------------------------

function emit(
  env: RunEnvelope,
  flags: Flags,
  humanNextCommand: string | undefined = undefined,
): void {
  const humanEnvelope = match({
    override: humanNextCommand,
    command: env.next.command,
  })
    .with(
      { override: P.string, command: P.string },
      ({ override }) => ({
        ...env,
        next: { ...env.next, command: override },
      }),
    )
    .otherwise(() => env);
  process.stdout.write(
    match(flags.json)
      .with(true, () => `${JSON.stringify(env, null, 2)}\n`)
      .with(false, () => `${renderHuman(humanEnvelope)}\n`)
      .exhaustive(),
  );
}

// The human/JSON summary is a one-line gloss of the last successful step's own
// output — read from the per-step results (reliable), not the workflow-level output
// (which the chain does not always surface). The step's output is UNWRAPPED first
// using the same command-JSON rule as `finalOutput`, so command-tail workflows
// surface their actual JSON object rather than their command wrapper.
function summarize(shape: Shape, steps: unknown): string {
  const rec = stepRunMapOf(steps);
  // Reverse shape order, successes only, first non-blank gloss wins — the same
  // `.filter().map().find()` walk as freshestSurfaceMap, over the in-memory step map.
  return (
    [...shape.steps]
      .reverse()
      .filter((s) => rec[s.name]?.status === "success")
      .map((s) => glossOf(unwrapCommandJson(rec[s.name]?.output ?? null)))
      .find((gloss) => gloss !== undefined && gloss !== "") ?? `${shape.name}: completed ${shape.steps.length} step(s).`
  );
}

// A one-line gloss of a step's (already-unwrapped) output. An agent step carries a
// deliberate `summary`/`text` field; a verdict-shaped result (founder, and any
// workflow emitting the same shape — keyed on the FIELD, matching envelope.ts's
// verdict-aware `next`) is glossed from its verdict + take. Anything else has no
// honest one-liner here, so the caller falls back to the generic completion line
// (the object still travels intact on `result`).
function glossOf(output: unknown): string | undefined {
  // Arrays are objects at this boundary and simply fall through to the generic gloss.
  return match(output)
    .with(P.when(isTruthyObject), (rec) => glossOfObject(rec, output))
    .otherwise(() => undefined);
}

const isTruthyObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";

function glossOfObject(rec: Record<string, unknown>, output: unknown): string | undefined {
  const declared = ["summary", "text"]
    .map((key) => rec[key])
    .filter((val): val is string => typeof val === "string" && val.trim().length > 0)
    .map((val) => val.trim())
    .at(0);
  // Verdict gloss only when the object is a full valid Verdict — a partial or
  // out-of-enum `verdict` field falls through (generic completion line), matching
  // envelope nextFor's not-a-verdict path. `/\S/` is the take-is-non-blank test.
  return (
    declared ??
    match(VerdictSchema.safeParse(output))
      .with(
        { success: true, data: { take: P.string.regex(/\S/) } },
        ({ data }) => `${data.verdict} — ${data.take.trim()}`,
      )
      .otherwise(() => undefined)
  );
}

// The `result` field carries the final step's structured
// output object, carried as-is (never paraphrased — that is `summary`'s job).
// Reverse shape order finds the last step that succeeded, which IS the final step
// on the success path; a skipped conditional tail (edge-walk's recon/expand) falls
// through to the real final step. A step with no declared output already carries
// {text} — that IS its structured output, so it is returned unchanged. null only
// when nothing ran (the failure path builds its own null-result envelope).
function finalOutput(shape: Shape, steps: unknown): unknown {
  const rec = stepRunMapOf(steps);
  // `.find` stops at the first success, so only that step's output is ever unwrapped.
  return match([...shape.steps].reverse().find((s) => rec[s.name]?.status === "success"))
    .with(undefined, (): unknown => null)
    .otherwise((s) => unwrapCommandJson(rec[s.name]?.output ?? null));
}

// A JSON OBJECT (never null, never an array) — the one parse shape worth unwrapping
// to, and the one steps shape worth reading per-step results off. A predicate, so it
// composes as a `P.when(...)` pattern instead of a guard `if`.
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// When the final step is a command step whose stdout is a JSON OBJECT, surface the parsed object
// as `result` — the {stdout,stderr,exitCode} wrapper is command-step plumbing, not
// the workflow's actual output, and envelope.result is defined as "the validated
// object a workflow's last step produced" (envelope.ts). Keyed on the OUTPUT SHAPE,
// never the workflow name, so the CLI stays independent of built-in flow names.
// On success, exitCode is 0 and the raw stdout is recoverable with JSON.stringify;
// only non-fatal stderr is omitted.
// A non-object parse (array/scalar) or a parse failure leaves the wrapper
// untouched — honest, never a guess. Shape detection uses COMMAND_OUTPUT (the same
// zod schema the compiler assigns to command steps) so accept/reject stays identical.
// Verdict VALIDATION deliberately does NOT live here: this function only unwraps,
// so the parsed object always travels intact on `result` (including a malformed or
// extended verdict, and any non-founder JSON that happens to carry a `verdict` key).
// The two consumers that ACT on a verdict — envelope nextFor and glossOf — each
// safeParse it themselves and fall back to their not-a-verdict path, so gating here
// too would strip extra keys and re-wrap objects no one asked us to judge.
function unwrapCommandJson(output: unknown): unknown {
  return match(COMMAND_OUTPUT.safeParse(output))
    .with({ success: true }, ({ data }) =>
      parseJson(data.stdout)
        .map((v) =>
          match(v)
            .with(P.when(isJsonObject), (obj): unknown => obj)
            .otherwise(() => output),
        )
        .unwrapOr(output),
    )
    .otherwise(() => output);
}

// Minimal local interface for the only field of a non-success Mastra WorkflowResult we read.
interface FailedWorkflowSteps {
  steps?: unknown;
}

function failedWorkflowSteps(f: FailedWorkflowSteps): unknown {
  return f.steps;
}

// Shared narrowing at the Mastra WorkflowResult.steps boundary — one type alias +
// one guard, reused by every per-step reader (freshestSurfaceMap / summarize /
// finalOutput / ranStepsOf) so the four verbatim casts never drift.
type StepRunMap = Record<string, { status?: string; output?: unknown }>;

function stepRunMapOf(steps: unknown): StepRunMap {
  return match(steps)
    .with(P.when(isJsonObject), (o) => o as StepRunMap)
    .otherwise(() => ({}));
}

function ranStepsOf(steps: unknown): string[] {
  return Object.entries(stepRunMapOf(steps))
    .filter(([, r]) => r?.status === "success")
    .map(([id]) => id);
}

function reasonOf(f: unknown): string {
  return (
    match((f as { error?: unknown }).error)
      .with(P.instanceOf(Error), (e) => e.message)
      .with(P.string, (e) => e)
      // Mastra may return a plain {message, name} object rather than an Error.
      // Preserve that message in the envelope.
      .with({ message: P.string }, (e) => e.message)
      .otherwise(() => `workflow ${(f as { status?: string }).status ?? "did not succeed"}`)
  );
}

function renderShape(shape: Shape): string {
  const described = match(shape.description)
    .with(P.union(undefined, ""), () => "")
    .otherwise((d) => ` — ${d}`);
  const lines = [`workflow: ${shape.name}${described}`];
  lines.push(`default model: ${shape.defaultModel}`);
  match(shape.args.length)
    .with(0, () => undefined)
    .otherwise(() => {
      const rendered = shape.args
        .map((a) => {
          const star = match(a.required)
            .with(true, () => "*")
            .with(false, () => "")
            .exhaustive();
          const dflt = match(a.default)
            .with(undefined, () => "")
            .otherwise((v) => `=${JSON.stringify(v)}`);
          return `${a.name}${star}${dflt}`;
        })
        .join(", ");
      lines.push(`args: ${rendered}`);
    });
  lines.push("", "steps:");
  for (const s of shape.steps) {
    const bits = [
      `type=${s.type}`,
      // Only agent steps resolve/call a model; a command step's resolved `model` is
      // inert (compile.ts never touches it), so showing it here misleads a --shape
      // output into suggesting the step makes a model call. Omit it for command steps.
      ...match(s.type)
        .with("agent", () => [`model=${s.model}`, `maxSteps=${s.maxSteps}`])
        .with("command", () => [] as string[])
        .exhaustive(),
      listBit("tools", s.tools),
      listBit("skills", s.skills),
      listBit("depends", s.depends),
      match(s.condition)
        .with(P.nullish, () => "")
        .otherwise((c) => `condition="${c.source}"`),
      `output={${s.outputFields.join(",")}}`,
      `prompt=${s.promptSize}c`,
    ].filter(Boolean);
    lines.push(`  - ${s.name}: ${bits.join(" ")}`);
  }
  match(shape.lint.length)
    .with(0, () => undefined)
    .otherwise(() => {
      lines.push("", "lint:");
      shape.lint.forEach((f) => {
        const at = match(f.step)
          .with(P.union(undefined, ""), () => "")
          .otherwise((s) => `[${s}] `);
        lines.push(`  ${f.level}: ${at}${f.message}`);
      });
    });
  return lines.join("\n");
}

// `name=[a,b]` for a non-empty list, "" for an empty one — the three identical
// step-bit ternaries, folded into one owner.
function listBit(name: string, values: string[]): string {
  return match(values.length)
    .with(0, () => "")
    .otherwise(() => `${name}=[${values.join(",")}]`);
}

// --- front door ------------------------------------------------------------
// Bare `navi` (no verb, no --help) is a friendly on-ramp for a cold agent —
// assembled from catalog data via flowMenu, never hardcoded flow names. No model.

// One flow's own help: what it is, how to invoke it, and what each arg means.
// Built from the resolved shape so a PATH token works and arg descriptions survive.
function flowHelp(shape: Shape, token: string, basePath: string): string {
  const tty = process.stdout.isTTY === true;
  // argToken, not a local rebuild: a json-typed arg is bound with --stdin, never
  // positionally, and printing `<input>` here handed the reader a command the CLI
  // rejects eight lines below on the very same screen.
  const invocation = [`navi run ${token}`, ...shape.args.map(argToken)].join(" ");
  const argW = Math.max(0, ...shape.args.map((a) => a.name.length));
  const argLines = shape.args.map((a) => {
    const req = match(a.required)
      .with(true, () => "required")
      .otherwise(() => "optional");
    const dflt = match(a.default)
      .with(P.nullish, () => "")
      .otherwise((d) => `  (default: ${String(d)})`);
    const stdin = match(a.type)
      .with("json", () => "  — bind with --stdin")
      .otherwise(() => "");
    return [
      `  ${a.name.padEnd(argW)}  ${req}${dflt}${stdin}`,
      ...match(a.description)
        .with(P.nullish, (): string[] => [])
        .otherwise((d) => d.trim().split("\n").map((l) => `  ${" ".repeat(argW)}  ${l.trim()}`)),
    ].join("\n");
  });
  // Tier + collision are the one thing the shape does not carry, so they come from
  // the catalog — and only a NAME can have them (a path token has no entry).
  const tierLine = match(buildCatalog(basePath).workflows.find((w) => w.name === token))
    .with(P.nullish, (): string[] => [])
    .otherwise((e) =>
      match(e.flag)
        .with(P.nullish, () => [`  tier: ${e.tier}`])
        .otherwise((f) => [`  tier: ${e.tier}  [${f}]`]),
    );
  return [
    `${accent(shape.name, tty)} — ${shape.description ?? ""}`,
    "",
    rule("run it"),
    `  ${accent(invocation, tty)}`,
    ...match(argLines.length)
      .with(0, (): string[] => [])
      .otherwise(() => ["", rule("arguments"), ...argLines]),
    "",
    rule(""),
    ...tierLine,
    `  default model: ${shape.defaultModel}`,
    `  full plan (no model call): navi run ${token} --shape`,
  ].join("\n");
}

function installVerb(flags: Flags): never {
  const to = resolveTarget(flags.workspace).match(
    (v) => v,
    (e) => fail(`navi install: ${e}\n`, 1),
  );
  const plan = planInstall(INSTALL_ROOT, to).match(
    (v) => v,
    (e) => fail(`navi install: ${e}\n`, 1),
  );
  applyInstall(plan).match(
    () => console.log(renderInstall(plan, to)),
    (e) => fail(`navi install: ${e}\n`, 1),
  );
  process.exit(0);
}

function uninstallVerb(flags: Flags): never {
  const to = resolveTarget(flags.workspace).match(
    (v) => v,
    (e) => fail(`navi uninstall: ${e}\n`, 1),
  );
  uninstall(INSTALL_ROOT, to).match(
    (msg) => console.log(msg),
    (e) => fail(`navi uninstall: ${e}\n`, 1),
  );
  process.exit(0);
}

function frontDoor(basePath: string = process.cwd()): string {
  const tty = process.stdout.isTTY === true;
  const q = 'navi "<question>"';
  const check = 'navi check "<claim>"';
  const run = "navi run <name>";
  const sessions = "navi session list";
  const story = "navi story <id>";
  const cmdW = Math.max(q.length, check.length, run.length, sessions.length, story.length);
  // Accent the `navi run …` invocation on each flow-menu line; pad spaces and
  // the when-clause stay plain so columns still line up under ANSI.
  const accentFlowLine = (line: string): string =>
    match(tty)
      .with(false, () => line)
      .with(true, () =>
        match(line.match(/^(  )(navi run \S+(?: \S+)*)(.*)$/))
          .with(P.nullish, () => line)
          .otherwise((m) => `${m[1]}${accent(m[2]!, true)}${m[3]}`),
      )
      .exhaustive();
  return [
    "navi — search the code, run a flow, or check your work. Each command suggests the next.",
    "",
    `  ${accent(q, tty)}${" ".repeat(cmdW - q.length)}  search this repo; cited answer + a graded next step`,
    `  ${accent(check, tty)}${" ".repeat(cmdW - check.length)}  challenge a completion claim with evidence`,
    `  ${accent(run, tty)}${" ".repeat(cmdW - run.length)}  run a flow (listed below)`,
    `  ${accent(sessions, tty)}${" ".repeat(cmdW - sessions.length)}  your sessions — what you have been doing here`,
    `  ${accent(story, tty)}${" ".repeat(cmdW - story.length)}  how a session got where it is`,
    "",
    rule("flows · when to reach for each"),
    ...flowMenu(basePath).map(accentFlowLine),
    "",
    rule(""),
    "  full when-to-use + arg details: navi catalog",
    "Run one — each command ends with your next moves.",
  ].join("\n");
}

function checkVerb(positional: string[], flags: Flags): Promise<never> {
  const event = positional.join(" ").trim();
  return match({
    event,
    stdin: flags.stdin,
    shape: flags.shape,
  })
    .with({ stdin: true, event: P.string.minLength(1) }, () =>
      fail("navi check: choose positional text or --stdin, not both\n", 4),
    )
    .with({ stdin: true, event: "" }, () =>
      runVerb(["edge-walk"], flags),
    )
    .with({ event: "", shape: true }, () =>
      runVerb(["edge-walk"], flags),
    )
    .with({ event: "" }, () =>
      fail('navi check: missing claim — run `navi check "what is done, and what proves it"`\n', 1),
    )
    .otherwise(({ event: text }) =>
      runVerb(
        ["edge-walk"],
        { ...flags, stdin: true },
        { kind: "check", event: text },
      ),
    );
}

// --- entry -----------------------------------------------------------------
// Everything above is a declaration; the dispatch runs last so every `const`
// helper (parseJson, …) is initialized before a verb can reach it.

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2)).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );
  // --version / -V before front-door/help: print package version, exit 0, zero
  // model calls. A typo like --verison never reaches here (parseArgs errors it).
  match(flags.version)
    .with(true, () => {
      process.stdout.write(`navi ${VERSION}\n`);
      process.exit(0);
    })
    .with(false, () => undefined)
    .exhaustive();
  // Bare `navi` → front door (exit 0). Explicit --help/-h → front door + flag
  // reference HELP beneath it (exit 0). Neither is a usage failure.
  // `navi help …` and `navi --help …` share one zero-model path. Consume the help
  // token before dispatch so it can never become a repository query.
  const verbs = match(positional[0])
    .with("help", () => positional.slice(1))
    .otherwise(() => positional);
  // Set on `flags`, not just locally: runVerb answers the flow-scoped form and
  // reads flags.help there, so `navi help <flow>` must be indistinguishable from
  // `navi run <flow> --help` by the time it arrives — otherwise it falls through
  // to a real run and dies on the missing required arg it was asking about.
  flags.help = flags.help || positional[0] === "help";
  const wantsHelp = flags.help;
  // -w is resolved HERE, not only inside the verbs: the front door lists the flows
  // discovered in a workspace, so `navi --help -w <dir>` must both honour the flag
  // and fail loudly on a bad one, exactly as every verb does.
  const helpBase = resolveBasePath(flags.workspace).match(
    (v) => v,
    (e) => fail(`Blocked: ${e}\n`, 1),
  );
  // A flow-scoped help request is answered by runVerb, which already loads the
  // shape: the global front door cannot show a flow's args, and buildCatalog is
  // name-keyed so it could not answer for a PATH at all. `navi help <flow>` is
  // accepted only for a name the catalog actually carries — anything else keeps
  // the front door rather than inventing a "no such flow" error, since catalog /
  // session / story are verbs, not flows.
  // A path token routes straight through: `navi run <path> --help` already worked,
  // and HELP advertises `navi help <flow>` as accepting one, so accepting only
  // catalog NAMES made the documented behaviour silently false — a path printed the
  // generic front door and exited 0.
  const looksLikePath = (t: string | undefined): boolean =>
    typeof t === "string" && (t.includes("/") || t.endsWith(".yaml") || t.endsWith(".yml"));
  const helpFlow = match({ help: wantsHelp, verb: verbs[0], next: verbs[1] })
    .with({ help: true, verb: "run", next: P.string }, ({ next }) => next)
    .with({ help: true, verb: P.when(looksLikePath) }, ({ verb }) => verb)
    .with({ help: true, verb: P.string }, ({ verb }) =>
      match(buildCatalog(helpBase).workflows.some((w) => w.name === verb && w.active))
        .with(true, () => verb)
        .with(false, () => undefined)
        .exhaustive(),
    )
    .otherwise(() => undefined);
  match({ help: wantsHelp, flow: helpFlow, bare: verbs.length === 0 })
    .with({ flow: P.string }, () => undefined)
    .with({ help: true }, () => {
      console.log(`${frontDoor(helpBase)}\n\n${HELP}`);
      process.exit(0);
    })
    .with({ bare: true }, () => {
      console.log(frontDoor(helpBase));
      process.exit(0);
    })
    .otherwise(() => undefined);
  // install/uninstall are the only verbs that WRITE. They are deliberately
  // model-free and synchronous: nothing about linking a skill needs a model, and a
  // write path that can hang on a network call is a write path that gets
  // interrupted halfway.
  match(verbs[0])
    .with("install", () => installVerb(flags))
    .with("uninstall", () => uninstallVerb(flags))
    .otherwise(() => undefined);
  await match({ verb: verbs[0], flow: helpFlow })
    .with({ flow: P.string }, ({ flow }) => runVerb([flow], flags))
    .with({ verb: "check" }, () => checkVerb(verbs.slice(1), flags))
    .with({ verb: "run" }, () => runVerb(verbs.slice(1), flags))
    .with({ verb: "catalog" }, () => catalogVerb(flags))
    .with({ verb: "session" }, () => sessionVerb(verbs.slice(1), flags))
    .with({ verb: "story" }, () => storyVerb(verbs[1], flags))
    .otherwise(() => bareQuery(verbs.join(" "), flags));
}

await main();
