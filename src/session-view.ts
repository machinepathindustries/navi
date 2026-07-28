// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { match, P } from "ts-pattern";
import { Result, ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
import type { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import {
  SessionState,
  SessionStatus,
  Gate,
  type Directive,
  type SessionTurn,
} from "./contracts/whisper.ts";
import { VerdictSchema, type Verdict } from "./contracts/verdict.ts";
import {
  RESOURCE_ID,
  memoryFor,
  classifySessionStateMessage,
  statusForTurn,
  type RecallMessage,
} from "./session-state.ts";
import { errStr } from "./err.ts";
import { rule, bold, dim, accent, paintCode, statusCode, relTime, shortClause } from "./style.ts";

// Story beat excerpts: long enough for a readable half-sentence, short enough
// that a 5-round session stays scannable. Cap is the caller's; the cut logic is
// style.shortClause (shared with catalog when-to-use labels).
const STORY_EXCERPT_MAX = 120;

// The observability reads use native Mastra APIs. `listSessions` is one
// listThreads call with a metadata filter; `showSession` recalls and walks Navi's
// structured messages without a model call. Storage is injected, so importing
// this module never boots the runtime or opens the database.

// A thread is a session when its metadata carries a string `schema_version`.
// Mastra's metadata filter has scalar equality but no key-existence operator, and
// schema versions may evolve, so this discriminator is applied client-side to the
// rows from the single listThreads call.
// RESOURCE_ID, memoryFor, classifySessionStateMessage + RecallMessage are the ONE
// owner's copies, imported from src/session-state.ts (the message→SessionState walk
// and the store-acquisition idioms live there — no re-implementation here);
// errStr comes from its own leaf owner, src/err.ts.
const SCHEMA_VERSION_KEY = "schema_version";

// --- word handles (deterministic, no storage) ------------------------------
// Human-friendly adj-noun label derived from a session id. Pure + total: same id
// always yields the same handle; no schema or storage change. Used in the session
// list column and as an alternate token for `session show` / `story`.

const ADJECTIVES = [
  "brave",
  "calm",
  "clever",
  "bright",
  "swift",
  "gentle",
  "keen",
  "merry",
  "noble",
  "quiet",
  "rapid",
  "steady",
  "witty",
  "bold",
  "crisp",
  "eager",
  "fair",
  "glad",
  "happy",
  "jolly",
  "kind",
  "lively",
  "mild",
  "neat",
  "plucky",
  "proud",
  "quick",
  "rusty",
  "sunny",
  "tidy",
  "vivid",
  "warm",
  "zesty",
  "amber",
  "azure",
  "coral",
  "cosmic",
  "frosty",
  "golden",
  "lunar",
  "misty",
  "silver",
  "spry",
  "sturdy",
  "nimble",
  "honest",
  "lucid",
  "peppy",
] as const;

const NOUNS = [
  "otter",
  "heron",
  "cedar",
  "maple",
  "river",
  "willow",
  "falcon",
  "badger",
  "coral",
  "meadow",
  "pine",
  "sparrow",
  "trout",
  "aspen",
  "birch",
  "cinder",
  "dolphin",
  "ember",
  "fern",
  "glade",
  "harbor",
  "ibis",
  "jasper",
  "kite",
  "lark",
  "moss",
  "nest",
  "orchid",
  "pebble",
  "quail",
  "raven",
  "sage",
  "thistle",
  "umbra",
  "violet",
  "wren",
  "yarrow",
  "zephyr",
  "acorn",
  "brook",
  "cliff",
  "dune",
  "eagle",
  "finch",
  "grove",
  "hazel",
  "iris",
  "juniper",
  "kelp",
  "lotus",
  "mink",
  "nymph",
  "osprey",
  "poppy",
  "quartz",
  "reef",
  "stone",
  "tide",
  "ursa",
  "vine",
  "wave",
  "lynx",
  "fox",
  "hare",
] as const;

// FNV-1a 32-bit over the id string — stable across process restarts, no crypto.
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic `adj-noun` handle for a session id (e.g. "brave-otter"). Pure, total. */
export function handleOf(sessionId: string): string {
  const h = fnv1a32(sessionId);
  const adj = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[(h >>> 16) % NOUNS.length]!;
  return `${adj}-${noun}`;
}

// Resolve a user-typed token to a session id: exact session id (or existing thread id)
// wins; otherwise treat as a word handle over listSessions. Zero / many matches are
// loud user-facing errs (never "no such thread").
export function resolveSessionToken(
  storage: LibSQLStore,
  token: string,
): ResultAsync<string, string> {
  return listSessions(storage, {}).andThen((rows) =>
    match(rows.find((r) => r.session_id === token))
      .with({ session_id: P.string }, (r) => okAsync(r.session_id))
      .otherwise(() => {
        const hits = rows.filter((r) => handleOf(r.session_id) === token);
        return match(hits)
          .with([P._], ([only]) => okAsync(only.session_id))
          .with([], () =>
            // Exact thread that exists (incl. non-session) still resolves so show/story
            // can report "not a session thread" rather than "no such handle".
            ResultAsync.fromPromise(
              (async () => {
                await storage.init();
                const memory = memoryFor(storage);
                return memory.getThreadById({ threadId: token });
              })(),
              errStr,
            ).andThen((thread) =>
              match(thread)
                .with(P.nullish, () =>
                  errAsync<string, string>(
                    `no session named "${token}" — pick one from: navi session list`,
                  ),
                )
                .otherwise(() => okAsync(token)),
            ),
          )
          .otherwise((many) =>
            errAsync<string, string>(
              `ambiguous handle "${token}" matches: ${many.map((r) => r.session_id).join(", ")}`,
            ),
          );
      }),
  );
}

// --- session list -------------------------------------------------------------

// One row per session thread. `--json` emits these objects verbatim (catalog.ts
// style — no truncation); the human table shortens the two hash-shaped columns.
export interface SessionRow {
  session_id: string; // = thread id (what `session show <id>` takes)
  title: string;
  status: SessionStatus | null; // cache scalar; null when absent/blanked/corrupt
  turn_kind: SessionTurn["kind"] | null;
  workflow: string | null;
  gate: Gate | null;
  verdict: Verdict["verdict"] | null;
  open_directive_count: number | null;
  revision_hash: string | null;
  updatedAt: string; // ISO 8601
  fork_of: string | null; // source thread id when the thread is a clone, else null
  // Soft-hide flag (thread metadata.archived === true). Non-destructive; list
  // hides these by default, `--all` includes them. No schema change.
  archived: boolean;
}

export interface ListFilters {
  status?: SessionStatus;
  gate?: Gate;
  verdict?: Verdict["verdict"];
}

// Human list/json visibility: default hides archived rows; `--all` includes them.
export interface ListVisibility {
  all: boolean;
}

// Rows the human/`--json` list should show under the current visibility flag.
export function visibleSessions(rows: SessionRow[], visibility: ListVisibility): SessionRow[] {
  return match(visibility.all)
    .with(true, () => rows)
    .with(false, () => rows.filter((r) => !r.archived))
    .exhaustive();
}

type ThreadRow = Awaited<ReturnType<Memory["listThreads"]>>["threads"][number];

// Safe Date conversion for Mastra timestamps (may arrive as Date | string | number
// depending on store serialization). Guards throw-capable toISOString/getTime at
// the seam; NaN/missing → Result err for callers to fallback.
const isInvalidDate = (d: Date): boolean => Number.isNaN(d.getTime());

function asDate(value: string | number | Date | null | undefined): Result<Date, string> {
  return match<typeof value, Result<Date, string>>(value)
    .with(P.nullish, "", () => err("missing timestamp"))
    .with(P.instanceOf(Date), (d) => ok(d))
    .otherwise((v) => ok(new Date(v)))
    .andThen((d) =>
      match(d)
        .with(P.when(isInvalidDate), () => err<Date, string>("invalid timestamp"))
        .otherwise(() => ok<Date, string>(d)),
    );
}

function toIsoString(value: string | number | Date | null | undefined): string {
  return asDate(value)
    .map((d) => d.toISOString())
    .unwrapOr("");
}

function toEpochMs(value: string | number | Date | null | undefined): number {
  return asDate(value)
    .map((d) => d.getTime())
    .unwrapOr(0);
}

// Validate raw filters against their contract vocabularies. An unknown value is a loud
// usage error that lists the legal values — never a silent no-match. Pure, so it
// is unit-testable without a DB. Argv INPUT stays string; OUTPUT is the closed enums —
// the schema's own safeParse IS the membership test, used as a `P.when` pattern so the
// ok() arm narrows without a cast and the vocabulary stays owned by contracts/whisper.ts.
const isSessionStatus = (v: unknown): v is SessionStatus => SessionStatus.safeParse(v).success;
const isGate = (v: unknown): v is Gate => Gate.safeParse(v).success;
const isVerdict = (v: unknown): v is Verdict["verdict"] =>
  VerdictSchema.shape.verdict.safeParse(v).success;

export function parseListFilters(
  status: string | undefined,
  gate: string | undefined,
  verdict: string | undefined = undefined,
): Result<ListFilters, string> {
  const statusR: Result<SessionStatus | undefined, string> = match(status)
    .with(undefined, () => ok<SessionStatus | undefined, string>(undefined))
    .with(P.when(isSessionStatus), (s) => ok<SessionStatus | undefined, string>(s))
    .otherwise(() =>
      err<SessionStatus | undefined, string>(
        `--status must be one of: ${SessionStatus.options.join(", ")} (got "${status}")`,
      ),
    );
  const gateR: Result<Gate | undefined, string> = match(gate)
    .with(undefined, () => ok<Gate | undefined, string>(undefined))
    .with(P.when(isGate), (g) => ok<Gate | undefined, string>(g))
    .otherwise(() =>
      err<Gate | undefined, string>(`--gate must be one of: ${Gate.options.join(", ")} (got "${gate}")`),
    );
  const verdictR: Result<Verdict["verdict"] | undefined, string> = match(verdict)
    .with(undefined, () => ok<Verdict["verdict"] | undefined, string>(undefined))
    .with(P.when(isVerdict), (v) => ok<Verdict["verdict"] | undefined, string>(v))
    .otherwise(() =>
      err<Verdict["verdict"] | undefined, string>(
        `--verdict must be one of: ${VerdictSchema.shape.verdict.options.join(", ")} (got "${verdict}")`,
      ),
    );
  // The two optional fields are assembled by SPREAD, not by conditional assignment:
  // an absent filter contributes `{}`, so the key is never present-but-undefined
  // (exactOptionalPropertyTypes) and `{}` stays `{}`.
  return Result.combine([statusR, gateR, verdictR]).map(([s, g, v]) => ({
    ...match<SessionStatus | undefined, ListFilters>(s)
      .with(undefined, () => ({}))
      .otherwise((status) => ({ status })),
    ...match<Gate | undefined, ListFilters>(g)
      .with(undefined, () => ({}))
      .otherwise((gate) => ({ gate })),
    ...match<Verdict["verdict"] | undefined, ListFilters>(v)
      .with(undefined, () => ({}))
      .otherwise((verdict) => ({ verdict })),
  }));
}

function isSessionThread(t: ThreadRow): boolean {
  return typeof (t.metadata as Record<string, unknown> | undefined)?.[SCHEMA_VERSION_KEY] === "string";
}

function toRow(memory: Memory, t: ThreadRow): SessionRow {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  return {
    session_id: t.id,
    title: t.title ?? "",
    // Re-close the thread-metadata read: a corrupt/hand-edited enum string
    // renders null rather than an illegal value on the SessionRow.
    status: SessionStatus.safeParse(md.status).data ?? null,
    turn_kind: match(md.turn_kind)
      .with(P.union("gate", "verdict", "plain", "failure"), (kind) => kind)
      .otherwise(() => null),
    workflow: match(md.workflow)
      .with(P.string, (workflow) => workflow)
      .otherwise(() => null),
    gate: Gate.safeParse(md.gate).data ?? null,
    verdict: VerdictSchema.shape.verdict.safeParse(md.verdict).data ?? null,
    open_directive_count: match(md.open_directive_count)
      .with(P.number, (n) => n)
      .otherwise(() => null),
    revision_hash: match(md.revision_hash)
      .with(P.string, (s) => s)
      .otherwise(() => null),
    updatedAt: toIsoString(t.updatedAt),
    // Fork provenance is read from the row already in hand. Non-clone rows carry
    // null, and the lazy arm avoids reading clone metadata for them.
    // The arm is lazy, so getCloneMetadata is still only called on a clone row.
    fork_of: match(memory.isClone(t))
      .with(true, () => memory.getCloneMetadata(t)?.sourceThreadId ?? null)
      .with(false, () => null)
      .exhaustive(),
    // Strict equality: only an explicit `true` archives; absent/false/other stay active.
    archived: md.archived === true,
  };
}

// Non-destructive soft-hide / restore via thread metadata. updateThread
// shallow-merges metadata (so the session cache stays) but OVERWRITES title —
// always re-pass the existing title or it blanks (session-state.ts comments).
// Returns the handle + title for the one-line CLI confirmation.
export function setSessionArchived(
  storage: LibSQLStore,
  sessionId: string,
  archived: boolean,
): ResultAsync<{ handle: string; title: string }, string> {
  return ResultAsync.fromPromise(
    (async () => {
      await storage.init();
      const memory = memoryFor(storage);
      const thread = match(await memory.getThreadById({ threadId: sessionId }))
        .with(P.nullish, (): never => {
          throw new Error(`no such thread "${sessionId}"`);
        })
        .otherwise((t) => t);
      // Re-pass existing title — never omit or blank.
      const title = thread.title ?? "";
      await memory.updateThread({
        id: sessionId,
        title,
        metadata: { archived },
      });
      return { handle: handleOf(sessionId), title };
    })(),
    errStr,
  );
}

// ONE listThreads call: resourceId + the native metadata equality filter built
// from --status/--gate/--verdict, ordered updatedAt DESC using the native column.
// Non-session threads are then dropped by the
// schema_version discriminator. perPage:false fetches all rows (no truncation).
export function listSessions(storage: LibSQLStore, filters: ListFilters): ResultAsync<SessionRow[], string> {
  return ResultAsync.fromPromise(
    (async () => {
      await storage.init();
      const memory = memoryFor(storage);
      const metadata: Record<string, unknown> = {
        ...match<SessionStatus | undefined, Record<string, unknown>>(filters.status)
          .with(undefined, () => ({}))
          .otherwise((status) => ({ status })),
        ...match<Gate | undefined, Record<string, unknown>>(filters.gate)
          .with(undefined, () => ({}))
          .otherwise((gate) => ({ gate })),
        ...match<Verdict["verdict"] | undefined, Record<string, unknown>>(filters.verdict)
          .with(undefined, () => ({}))
          .otherwise((verdict) => ({ verdict })),
      };
      // No filters → NO `metadata` key at all (a `{}` filter would be a
      // native equality against an empty object, not "unfiltered").
      const filter = match(Object.keys(metadata).length)
        .with(0, () => ({ resourceId: RESOURCE_ID }))
        .otherwise(() => ({ resourceId: RESOURCE_ID, metadata }));
      const { threads } = await memory.listThreads({
        filter,
        orderBy: { field: "updatedAt", direction: "DESC" },
        perPage: false,
      });
      return threads.filter(isSessionThread).map((t) => toRow(memory, t));
    })(),
    errStr,
  );
}

// --- shared SessionState walk (show + story) ----------------------------------

// One timed SessionState message from the chronological walk. Both `showSession` and
// `storySession` consume the same list — one owner, no duplicate recall/classify.
export interface TimedSessionState {
  at: string; // message createdAt (ISO)
  state: SessionState;
}

type SessionThread = NonNullable<Awaited<ReturnType<Memory["getThreadById"]>>>;

const timeOf = (msg: RecallMessage): number => toEpochMs(msg.createdAt);

// Recall the thread and walk every SessionState message chronologically without
// a model call. Unlike session-state's readPriorSessionState (newest only), this
// inspects the WHOLE history — a malformed SessionState ANYWHERE is a loud err
// naming that message, not a silent skip.
//  - missing thread → loud err
//  - thread exists but has no SessionState message → loud "not a session thread"
//  - any malformed SessionState message → loud err naming the message
function sessionStatesOf(
  storage: LibSQLStore,
  sessionId: string,
): ResultAsync<{ thread: SessionThread; states: TimedSessionState[] }, string> {
  return ResultAsync.fromPromise(
    (async (): Promise<{ thread: SessionThread; states: TimedSessionState[] }> => {
      await storage.init();
      const memory = memoryFor(storage);
      const thread = match(await memory.getThreadById({ threadId: sessionId }))
        .with(P.nullish, (): never => {
          throw new Error(`no such thread "${sessionId}"`);
        })
        .otherwise((t) => t);

      const { messages } = await memory.recall({ threadId: sessionId, perPage: false });
      const sorted = [...messages].sort((a, b) => timeOf(a) - timeOf(b));

      // flatMap replaces the push-guard: `skip` contributes nothing, `valid` one
      // entry. Eager BY DESIGN (the whole history is inspected); the throw fires
      // on the first malformed message — no IO per element, messages already in hand.
      const states: TimedSessionState[] = sorted.flatMap(
        (msg): TimedSessionState[] =>
          match(classifySessionStateMessage(msg))
            .with({ tag: "skip" }, () => [])
            .with({ tag: "valid" }, ({ state }) => [{ at: toIsoString(msg.createdAt), state }])
            .with({ tag: "malformed" }, ({ error }): never => {
              throw new Error(`${error} (message ${msg.id})`);
            })
            .exhaustive(),
      );

      // Loud "not a session thread" when the walk found nothing.
      match(states.at(-1))
        .with(undefined, (): never => {
          throw new Error(`thread "${sessionId}" exists but has no SessionState message — not a session thread`);
        })
        .otherwise(() => undefined);

      return { thread, states };
    })(),
    errStr,
  );
}

// --- session show -------------------------------------------------------------

export interface TimelineEntry {
  at: string; // message createdAt (ISO)
  status: SessionStatus;
  turn: SessionTurn;
}

export interface OpenDirective {
  id: string;
  action: string;
  severity: Directive["severity"];
}

export interface CurrentState {
  status: SessionStatus;
  latest_turn: SessionTurn | null;
  workflow: string | null;
  gate: Gate | null;
  verdict: Verdict["verdict"] | null;
  open_directives: OpenDirective[];
  findings_count: number;
  finding_severities: string[];
  evidence_count: number;
  revision_hash: string | null;
}

export interface SessionView {
  session_id: string;
  title: string;
  timeline: TimelineEntry[];
  current: CurrentState;
  lineage: string[]; // clone ancestor chain oldest→newest (incl. self), [] when not a clone
}

// Reconstruct timeline + current from the shared walk. Lineage still needs a
// Memory handle for isClone/getCloneHistory — opened here, not in the walk.
export function showSession(storage: LibSQLStore, sessionId: string): ResultAsync<SessionView, string> {
  return sessionStatesOf(storage, sessionId).andThen(({ thread, states }) =>
    ResultAsync.fromPromise(
      (async (): Promise<SessionView> => {
        const latest = match(states.at(-1))
          .with(undefined, (): never => {
            // sessionStatesOf already rejects the empty walk; this arm is unreachable
            // but keeps the match exhaustive without a non-null assertion.
            throw new Error(`thread "${sessionId}" exists but has no SessionState message — not a session thread`);
          })
          .otherwise(({ state }) => state);

        const timeline: TimelineEntry[] = states.flatMap(({ at, state }, i) => {
          const priorLength = match(states[i - 1])
            .with(undefined, () => 0)
            .otherwise(({ state: prior }) => prior.turn_history.length);
          const appended = state.turn_history.slice(priorLength);
          return appended.map((turn, turnIndex) => ({
            at,
            // The snapshot owns the committed disposition of its final turn.
            // That can intentionally differ from the turn's intrinsic mapping:
            // an override commits a demanding gate as complete, and a plain or
            // verdict turn can stay waiting while earlier directives remain open.
            // Earlier turns are replayed from cumulative snapshots, where no
            // intermediate committed status exists in the current snapshot.
            status: match(turnIndex === appended.length - 1)
              .with(true, () => state.status)
              .with(false, () => statusForTurn(turn))
              .exhaustive(),
            turn,
          }));
        });
        const latestTurn = latest.turn_history.at(-1) ?? null;

        const current: CurrentState = {
          status: latest.status,
          latest_turn: latestTurn,
          workflow: latestTurn?.workflow ?? null,
          gate: match(latestTurn)
            .with({ kind: "gate" }, ({ decision }) => decision.gate)
            .otherwise(() => null),
          verdict: match(latestTurn)
            .with({ kind: "verdict" }, ({ decision }) => decision.verdict)
            .otherwise(() => null),
          open_directives: latest.directives
            .filter((d) => d.status === "open")
            .map((d) => ({ id: d.id, action: d.action, severity: d.severity })),
          findings_count: latest.findings.length,
          finding_severities: latest.findings.map((f) => f.severity),
          evidence_count: latest.evidence.length,
          revision_hash: latest.surface_map?.revision_hash ?? null,
        };

        // Lineage is read only for clones; the lazy arm avoids an unnecessary
        // database call for ordinary sessions.
        const memory = memoryFor(storage);
        const lineage = await match(memory.isClone(thread))
          .with(true, async () => (await memory.getCloneHistory(sessionId)).map((t) => t.id))
          .with(false, async (): Promise<string[]> => [])
          .exhaustive();

        return { session_id: sessionId, title: thread.title ?? "", timeline, current, lineage };
      })(),
      errStr,
    ),
  );
}

// --- session story (deterministic per-session narrative) -------------------------

// One beat = one state transition (state[i-1] → state[i]; first diffs empty).
// `lines` are the human-readable deltas for that transition (gate, asked,
// satisfied, rejected, evidence, override) — never a model call.
export interface StoryBeat {
  at: string;
  lines: string[];
}

export interface StoryView {
  session_id: string;
  title: string;
  task: string;
  beats: StoryBeat[];
  outcome: string;
}

// Empty baseline the first state diffs against — no turns, directives, evidence,
// or parent events yet recorded.
const EMPTY_BASELINE: Pick<SessionState, "turn_history" | "directives" | "evidence" | "parent_events"> = {
  turn_history: [],
  directives: [],
  evidence: [],
  parent_events: [],
};

// Clause-boundary excerpt for story prose (parent answers, gate reasons, long
// asked actions). shortClause is the ONE owner (also catalog when-to-use); this
// only supplies the story cap.
function storyExcerpt(s: string): string {
  return shortClause(s, STORY_EXCERPT_MAX);
}

// Proper pluralization for human renders (never "1 demand(s)").
function countNoun(n: number, singular: string, pluralWord: string): string {
  return match(n)
    .with(1, () => `1 ${singular}`)
    .otherwise(() => `${n} ${pluralWord}`);
}

// Human status phrases for the session list / show / story surfaces. Unknown values
// pass through raw (never crash).
function humanStatus(status: string): string {
  return match(status)
    .with("awaiting_parent", () => "waiting on you")
    .with("escalated", () => "needs a human")
    .with("blocked", () => "blocked")
    .with("active", () => "active")
    .otherwise((s) => s);
}

const DISPOSITIONS_LEGEND =
  "gates: DIRECT do this first · REPAIR fix this · CLEAR/COMPLETE approved · BLOCKED stuck · ESCALATE human · verdicts: GO proceed · REFINE revise · REJECT stop";

// Shape-match a parent_events entry written by applyOverride (session-state.ts):
// { type: "navi.override", reason, gate, … }. Raw parent_events are untyped, so
// this is the only contract the story reader relies on.
type OverrideEvent = { type: "navi.override"; reason: string; gate: string; overridden_directive_ids?: string[] };

function asOverrideEvent(e: unknown): OverrideEvent | null {
  return match(e)
    .with(
      { type: "navi.override", reason: P.string, gate: P.string },
      (o) => o as OverrideEvent,
    )
    .otherwise(() => null);
}

// Diff prev → curr into narrative lines (order: turns, parent answers, asked,
// satisfied, rejected, evidence, overrides). Append-only collections use
// length-slice; directive status flips use id lookup on the prior list.
//
// `parent:` lines come from parent_events entries shaped `{ task: string }` —
// the same shape taskFromEvent already consumes for SessionState.task (cli.ts
// eventOf on the positional transport; --stdin events that carry a task).
// This keeps the parent's answer next to Navi's question. Overrides stay on their own
// ⚠ OVERRIDE arm and are never double-rendered as parent.
function beatLines(
  prev: Pick<SessionState, "turn_history" | "directives" | "evidence" | "parent_events">,
  curr: SessionState,
): string[] {
  const prevById = new Map(prev.directives.map((d) => [d.id, d]));

  // Turn prose and parent answers are free prose — excerpt, never full wall.
  // Narrative stays round-by-round (what navi asked / what parent answered); only
  // the length of each beat line is capped (clause boundary, never mid-word).
  const turnLines = curr.turn_history
    .slice(prev.turn_history.length)
    .map((turn) =>
      match(turn)
        .with(
          { kind: "gate" },
          ({ decision }) => `${decision.gate} — ${storyExcerpt(decision.reason)}`,
        )
        .with(
          { kind: "verdict" },
          ({ decision }) => `verdict ${decision.verdict} — ${decision.take}`,
        )
        .with(
          { kind: "plain" },
          ({ workflow, summary }) => `${workflow ?? "run"} complete — ${summary}`,
        )
        .with(
          { kind: "failure" },
          ({ workflow, reason }) => `${workflow ?? "run"} failed — ${reason}`,
        )
        .exhaustive(),
    );

  const parentLines = curr.parent_events
    .slice(prev.parent_events.length)
    .flatMap((e) =>
      match(e)
        .with({ type: "navi.override" }, () => [] as string[])
        .with({ task: P.string.minLength(1) }, ({ task }) => [`parent: ${storyExcerpt(task)}`])
        .otherwise(() => [] as string[]),
    );

  const askedLines = curr.directives.flatMap((d) =>
    match({ open: d.status === "open", prior: prevById.get(d.id) })
      .with({ open: true, prior: undefined }, () => [
        `asked: ${d.id} — ${storyExcerpt(d.action || d.reason)}`,
      ])
      .with({ open: true, prior: { status: P.not("open") } }, () => [
        `asked: ${d.id} — ${storyExcerpt(d.action || d.reason)}`,
      ])
      .otherwise(() => []),
  );

  const flipLines = curr.directives.flatMap((d) =>
    match({ prior: prevById.get(d.id)?.status, now: d.status })
      .with({ prior: "open", now: "satisfied" }, () => [`satisfied: ${d.id}`])
      .with({ prior: "open", now: "rejected" }, () => [`rejected: ${d.id}`])
      .otherwise(() => []),
  );

  const evidenceDelta = curr.evidence.length - prev.evidence.length;
  const evidenceLines = match(evidenceDelta > 0)
    .with(true, () => [`evidence +${evidenceDelta}`])
    .with(false, () => [])
    .exhaustive();

  const overrideLines = curr.parent_events
    .slice(prev.parent_events.length)
    .flatMap((e) =>
      match(asOverrideEvent(e))
        .with(null, () => [])
        .otherwise(
          (o) => [`⚠ OVERRIDE — proceeded against ${o.gate}: "${storyExcerpt(o.reason)}"`],
        ),
    );

  return [
    ...turnLines,
    ...parentLines,
    ...askedLines,
    ...flipLines,
    ...evidenceLines,
    ...overrideLines,
  ];
}

// Unresolved directives take priority. An override is the outcome only on the
// snapshot that records it; later CLEAR/GO/plain turns keep the override in the
// timeline without letting it permanently replace the latest outcome.
function storyOutcome(states: TimedSessionState[]): string {
  const final = match(states.at(-1))
    .with(undefined, (): never => {
      throw new Error("storyOutcome: empty states");
    })
    .otherwise(({ state }) => state);
  const previousParentEvents = match(states.at(-2))
    .with(undefined, (): unknown[] => [])
    .otherwise(({ state }) => state.parent_events);
  const overrides = final.parent_events
    .slice(previousParentEvents.length)
    .flatMap((event) =>
      match(asOverrideEvent(event))
        .with(null, () => [])
        .otherwise((override) => [override]),
    );
  const openIds = final.directives.filter((d) => d.status === "open").map((d) => d.id);
  const latestTurn = final.turn_history.at(-1) ?? null;
  const nDemands = overrides.reduce(
    (acc, o) =>
      acc +
      match(o.overridden_directive_ids)
        .with(P.array(P.string), (ids) => ids.length)
        .otherwise(() => 1),
    0,
  );

  return match({
    hasOverride: overrides.length > 0,
    open: openIds,
    turn: latestTurn,
  })
    .with(
      { open: P.when((ids: string[]) => ids.length > 0) },
      ({ open }) => `still open — waiting on: ${open.join(", ")}`,
    )
    .with(
      { hasOverride: true },
      () => `shipped without approval — ${countNoun(nDemands, "demand", "demands")} overridden`,
    )
    .with({ turn: { kind: "gate", decision: { gate: "ESCALATE" } } }, () => "paused — needs a human call")
    .with({ turn: { kind: "gate", decision: { gate: "BLOCKED" } } }, () => "blocked")
    .with(
      {
        turn: {
          kind: "gate",
          workflow: P.select("workflow"),
          decision: { gate: P.union("CLEAR", "COMPLETE") },
        },
      },
      ({ workflow }) => {
        const rounds = final.turn_history.filter(
          (turn) => turn.kind === "gate" && turn.workflow === workflow,
        ).length;
        return `approved on the evidence (${countNoun(rounds, "round", "rounds")})`;
      },
    )
    .with(
      { turn: { kind: "gate", decision: { gate: P.union("DIRECT", "REPAIR") } } },
      () => "waiting on you",
    )
    .with(
      { turn: { kind: "verdict", decision: { verdict: "GO" } } },
      () => "verdict GO — proceed as scoped",
    )
    .with(
      { turn: { kind: "verdict", decision: { verdict: "REFINE" } } },
      () => "verdict REFINE — revise before continuing",
    )
    .with(
      { turn: { kind: "verdict", decision: { verdict: "REJECT" } } },
      () => "verdict REJECT — stop",
    )
    .with(
      { turn: { kind: "plain", workflow: P.select("workflow") } },
      ({ workflow }) => `${workflow ?? "run"} complete`,
    )
    .with(
      {
        turn: {
          kind: "failure",
          workflow: P.select("workflow"),
          reason: P.select("reason"),
        },
      },
      ({ workflow, reason }) => `${workflow ?? "run"} failed — ${reason}`,
    )
    .otherwise(() => "in progress");
}

// Build the deterministic per-session narrative from the shared walk. Zero model
// calls — pure formatting over recorded SessionStates.
export function storySession(storage: LibSQLStore, sessionId: string): ResultAsync<StoryView, string> {
  return sessionStatesOf(storage, sessionId).map(({ thread, states }) => {
    const beats: StoryBeat[] = states.map(({ at, state }, i) => {
      const prev = match(i)
        .with(0, () => EMPTY_BASELINE)
        .otherwise(() => states[i - 1]!.state);
      return { at, lines: beatLines(prev, state) };
    });
    const first = match(states.at(0))
      .with(undefined, (): never => {
        throw new Error(`thread "${sessionId}" exists but has no SessionState message — not a session thread`);
      })
      .otherwise(({ state }) => state);
    return {
      session_id: sessionId,
      title: thread.title ?? "",
      task: first.task,
      beats,
      outcome: storyOutcome(states),
    };
  });
}

// --- human rendering -------------------------------------------------------

// TTY gate for stdout human renders. Piped output and tests see plain text;
// interactive terminals get bold/dim/accent/status color from style.ts.
const isTty = (): boolean => process.stdout.isTTY === true;

// Short form of a hash-shaped value for session show (git shas); the full value
// always rides on --json. Session list no longer shows rev (handles only).
const short = (h: string | null): string =>
  match(h)
    .with(null, "", () => "—")
    .otherwise((s) => s.slice(0, 8));

// Counts meta under the "your sessions" rule. Archived-hidden names how many and
// the flag that reveals them.
function sessionListMeta(shown: number, archivedHidden: number): string {
  return match(archivedHidden > 0)
    .with(
      true,
      () =>
        `  ${shown} shown · ${archivedHidden} archived (navi session list --all) · newest first`,
    )
    .with(false, () => `  ${shown} shown · newest first`)
    .exhaustive();
}

// Moves block after the session rows — first shown handle fills the examples.
// Commands accent on TTY; legend + "what's a session?" dim.
function sessionListMoves(firstHandle: string, tty: boolean): string[] {
  const readCmd = `navi story ${firstHandle}`;
  const tidyCmd = `navi session archive ${firstHandle} [<handle> …]`;
  const whatCmd = `navi story ${firstHandle}`;
  return [
    rule("moves"),
    `  read one:   ${accent(readCmd, tty)}`,
    `  tidy up:    ${accent(tidyCmd, tty)}`,
    dim(
      `  legend:     ${DISPOSITIONS_LEGEND}`,
      tty,
    ),
    dim(
      `  what's a session?  one conversation; each run records a summary, verdict, gate, or failure: ${whatCmd}`,
      tty,
    ),
  ];
}

function rowDisposition(row: SessionRow): string {
  return match(row.turn_kind)
    .with("gate", () => row.gate ?? "—")
    .with("verdict", () => row.verdict ?? "—")
    .with("plain", () => "plain")
    .with("failure", () => "failure")
    .with(null, () => "—")
    .exhaustive();
}

// Two-line session list: handle + status·latest disposition + relTime on line 1; full title
// (no truncation) indented under the status column on line 2. No rev column.
// Empty list is a rule + none-yet line (exit 0 in the CLI). `now` is injectable
// so relTime stays deterministic in tests.
export function renderSessionList(
  allRows: SessionRow[],
  visibility: ListVisibility = { all: false },
  now: number = Date.now(),
): string {
  const tty = isTty();
  const shown = visibleSessions(allRows, visibility);
  const archivedHidden = match(visibility.all)
    .with(true, () => 0)
    .with(false, () => allRows.filter((r) => r.archived).length)
    .exhaustive();
  // The empty session is the whole render, not a guard: the width fold below is
  // undefined on zero rows (Math.max of nothing), so it must never be reached.
  return match(shown.length)
    .with(0, () =>
      [
        rule("your sessions"),
        '  none yet — a session starts with your first navi run (try: navi "where is configuration loaded?")',
      ].join("\n"),
    )
    .otherwise(() => {
      const cells = shown.map((r) => {
        const status = humanStatus(r.status ?? "—");
        const disposition = rowDisposition(r);
        const statusDisposition = `${status} · ${disposition}`;
        const colorKey = match(r.turn_kind)
          .with("gate", () => r.gate ?? r.status ?? "—")
          .otherwise(() => r.status ?? "—");
        return {
          handle: handleOf(r.session_id),
          statusDisposition,
          colorKey,
          archived: r.archived,
          time: relTime(r.updatedAt, now),
          openSuffix: match(r.open_directive_count)
            .with(
              P.when((n): n is number => typeof n === "number" && n > 0),
              (n) => ` · ${n} open`,
            )
            .otherwise(() => ""),
          fork: match(r.fork_of)
            .with(null, "", () => "")
            .otherwise((f) => ` (fork of ${handleOf(f)})`),
          title: r.title || "—",
        };
      });
      const hw = Math.max(...cells.map((c) => c.handle.length));
      // Title indent = leading spaces + handle pad + gap before status column.
      const titleIndent = " ".repeat(2 + hw + 2);
      const firstHandle = cells[0]!.handle;
      return [
        rule("your sessions"),
        dim(sessionListMeta(shown.length, archivedHidden), tty),
        "",
        ...cells.flatMap((c, i) => {
          const handleCell = bold(c.handle.padEnd(hw), tty);
          const statusCell = paintCode(statusCode(c.colorKey), c.statusDisposition, tty);
          const archivedSuffix = match(c.archived)
            .with(true, () => dim(" · archived", tty))
            .with(false, () => "")
            .exhaustive();
          const line1 = `  ${handleCell}  ${statusCell}    ${c.time}${c.openSuffix}${archivedSuffix}`;
          const line2 = `${titleIndent}${c.title}${c.fork}`;
          // Blank line between sessions (not after the last).
          const gap = match(i < cells.length - 1)
            .with(true, () => [""])
            .with(false, () => [])
            .exhaustive();
          return [line1, line2, ...gap];
        }),
        "",
        ...sessionListMoves(firstHandle, tty),
      ].join("\n");
    });
}

function describeTurn(turn: SessionTurn | null): string {
  return match(turn)
    .with(null, () => "no recorded turn")
    .with(
      { kind: "gate" },
      ({ decision }) => `gate ${decision.gate} — ${decision.reason}`,
    )
    .with(
      { kind: "verdict" },
      ({ decision }) => `verdict ${decision.verdict} — ${decision.take}`,
    )
    .with(
      { kind: "plain" },
      ({ workflow, summary }) => `${workflow ?? "run"} — ${summary}`,
    )
    .with(
      { kind: "failure" },
      ({ workflow, reason }) => `${workflow ?? "run"} failed — ${reason}`,
    )
    .exhaustive();
}

// Optional lines contribute zero or one element. Lineage, when present, is a
// box-drawing tree from oldest to newest.
// Heading prints the word handle + full id so the user can copy either.
export function renderSessionShow(view: SessionView): string {
  const tty = isTty();
  const c = view.current;
  const handle = handleOf(view.session_id);
  return [
    `session ${handle} (${view.session_id})${match(view.title)
      .with("", () => "")
      .otherwise((t) => ` — ${t}`)}`,
    ...match<number, string[]>(view.lineage.length)
      .with(0, () => [])
      .otherwise(() => [
        "lineage:",
        ...view.lineage.map((id, i) =>
          match(i)
            .with(view.lineage.length - 1, () => `    └── ${handleOf(id)} (${id})`)
            .otherwise(() => `    ├── ${handleOf(id)} (${id})`),
        ),
      ]),
    "",
    "timeline:",
    ...view.timeline.map(
      (t) =>
        `  ${t.at}  ${paintCode(statusCode(t.status), humanStatus(t.status), tty)} · ${describeTurn(t.turn)}`,
    ),
    "",
    `now: ${paintCode(statusCode(c.status), humanStatus(c.status), tty)} · ${describeTurn(c.latest_turn)} · rev ${short(c.revision_hash)}`,
    `  open demands (${c.open_directives.length}):`,
    ...match<number, string[]>(c.open_directives.length)
      .with(0, () => ["    none"])
      .otherwise(() => []),
    ...c.open_directives.map((d) => `    ${d.id} [${d.severity}] ${d.action}`),
    `  findings: ${c.findings_count}${match<number, string>(c.finding_severities.length)
      .with(0, () => "")
      .otherwise(() => ` (${c.finding_severities.join(", ")})`)}`,
    `  evidence: ${c.evidence_count}`,
  ].join("\n");
}

// YYYY-MM-DD HH:MM from an ISO timestamp.
const storyAt = (at: string): string => at.slice(0, 16).replace("T", " ");

// OVERRIDE lines paint red on TTY; everything else plain.
function paintStoryLine(line: string, tty: boolean): string {
  return match(line)
    .with(P.string.startsWith("⚠ OVERRIDE"), (l) => paintCode("31", l, tty))
    .otherwise((l) => l);
}

// Outcome string → status color code (bold + this when TTY).
function outcomeColor(outcome: string): string {
  return match(outcome)
    .with(P.string.startsWith("approved on the evidence"), () => "32")
    .with(P.string.startsWith("verdict GO"), () => "32")
    .with(P.string.startsWith("verdict REFINE"), () => "33")
    .with(P.string.startsWith("verdict REJECT"), () => "31")
    .with(P.string.endsWith(" complete"), () => "32")
    .with(P.string.includes(" failed"), () => "31")
    .with(P.string.startsWith("shipped without approval"), () => "31")
    .with(P.string.startsWith("still open"), () => "33")
    .with(P.string.startsWith("paused"), () => "31")
    .with(P.string.startsWith("blocked"), () => "31")
    .otherwise(() => "33");
}

// `── the story of <handle> ──…` + dim `(session <id>)` + title, then each beat's
// timestamped lines (full text, hanging indent; terminal wraps), then
// `── where it stands ──…` + bold status-colored outcome. Legend footer last.
export function renderStory(view: StoryView): string {
  const tty = isTty();
  // Prefer title when present and not truncated; fall back to SessionState.task
  // (the full request). Thread titles are often cut with … at write time —
  // story is the reading surface, so never show a truncated heading when the
  // full task text is available.
  const label = match(view.title)
    .with("", () => view.task)
    .with(
      P.when((t) => t.endsWith("…") || t.endsWith("...")),
      (t) =>
        match(view.task)
          .with("", () => t)
          .otherwise((task) => task),
    )
    .otherwise((t) => t);
  const handle = handleOf(view.session_id);
  // Bold + status color in one SGR (nested paint would reset bold).
  const outcomeText = match(tty)
    .with(true, () => paintCode(`1;${outcomeColor(view.outcome)}`, view.outcome, true))
    .with(false, () => view.outcome)
    .exhaustive();
  const beatBlocks = view.beats.flatMap((b) =>
    match(b.lines)
      .with([], () => [] as string[])
      .otherwise((lines) => {
        const head = `  ${storyAt(b.at)}  `;
        const cont = " ".repeat(head.length);
        const [first, ...rest] = lines;
        return [
          "",
          `${head}${paintStoryLine(first!, tty)}`,
          ...rest.map((l) => `${cont}${paintStoryLine(l, tty)}`),
        ];
      }),
  );
  return [
    rule(`the story of ${handle}`),
    dim(`  (session ${view.session_id})`, tty),
    `  ${label}`,
    ...beatBlocks,
    "",
    rule("where it stands"),
    `  ${outcomeText}`,
    dim(`  legend: ${DISPOSITIONS_LEGEND}`, tty),
  ].join("\n");
}
