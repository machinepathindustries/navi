// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { match, P } from "ts-pattern";
import { Result, ResultAsync, okAsync, errAsync } from "neverthrow";
import type { Client, Transaction } from "@libsql/client";
import { TABLE_MESSAGES, TABLE_THREADS } from "@mastra/core/storage";
import type { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import {
  SESSION_SCHEMA_VERSION,
  SessionState,
  zodIssues,
  type SessionTurn,
  type Directive,
  type Finding,
  type SurfaceMap,
  type Evidence,
} from "./contracts/whisper.ts";
import type { Verdict } from "./contracts/verdict.ts";
import { sessionStatusForGate, type Gate } from "./contracts/envelope.ts";
import { errStr } from "./err.ts";

// appendSessionState stamps `content.metadata.kind` so classification is exact,
// never inferred from the shape of ordinary assistant JSON.
export const SESSION_STATE_KIND = "session_state";

// The canonical session record lives in thread messages: each judged turn appends
// the full SessionState JSON as one message. Thread metadata is only a thin,
// rebuildable cache for `navi session list`. Storage is injected so importing
// this module never boots the runtime or opens the database.

// Shared storage scope for session writes and session-view list filters.
export const RESOURCE_ID = "cli";

// Page size, never a search bound. A session can accumulate arbitrarily many
// ordinary agent/tool messages after its last state snapshot, so readPrior keeps
// paging newest→oldest until it finds a discriminated state or exhausts the
// thread. Numeric recall fetches the newest page and returns that page in
// chronological order; walking each page backward preserves the integrity rule
// that the newest discriminated snapshot wins (or fails loudly when malformed).
const RECALL_PAGE_SIZE = 100;

// appendSessionState uses @libsql/client's public interactive transaction API
// directly because Mastra's memory store exposes no transaction that can contain
// BOTH saveMessages and updateThread. The companion Client is constructed from
// the same URL as the injected LibSQLStore and passed explicitly; no private
// LibSQLStore or MemoryLibSQL field is reached. This small queue serializes writes
// on one retained client (avoiding a local connection waiting on its own write
// lock); BEGIN IMMEDIATE / the remote libSQL server remains the cross-client and
// cross-process serialization boundary.
const clientWriteTails = new WeakMap<Client, Promise<void>>();

function withClientWriteLock<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  const prior = clientWriteTails.get(client) ?? Promise.resolve();
  const current = prior.then(operation);
  clientWriteTails.set(
    client,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

// Scalar cache fields are `listThreads`-filterable through flat equality.
// `open_directive_ids` is an array, so it is data-only; queries use the companion
// count scalar instead. Types derive from SessionState so the cache stays aligned
// with the persisted contract.
export interface SessionCache {
  schema_version: SessionState["schema_version"];
  status: SessionState["status"];
  turn_kind: SessionTurn["kind"] | null;
  workflow: string | null;
  gate: Gate | null;
  verdict: Verdict["verdict"] | null;
  open_directive_ids: string[];
  open_directive_count: number;
  revision_hash: string | null;
}

// Gate and verdict are both written on every update, including null. A verdict
// turn after a gate (or vice versa) therefore cannot leave a stale disposition
// in the list cache.
export function deriveCache(state: SessionState): SessionCache {
  const openIds = state.directives.filter((d) => d.status === "open").map((d) => d.id);
  const latest = state.turn_history.at(-1);
  return {
    schema_version: state.schema_version,
    status: state.status,
    turn_kind: latest?.kind ?? null,
    workflow: latest?.workflow ?? null,
    gate: match(latest)
      .with({ kind: "gate" }, ({ decision }) => decision.gate)
      .otherwise(() => null),
    verdict: match(latest)
      .with({ kind: "verdict" }, ({ decision }) => decision.verdict)
      .otherwise(() => null),
    open_directive_ids: openIds,
    open_directive_count: openIds.length,
    revision_hash: state.surface_map?.revision_hash ?? null,
  };
}

// Resolve the raw memory-domain store from the injected LibSQLStore. The raw
// store does not create its tables automatically, so initialize it explicitly
// before access.
export function memoryStore(storage: LibSQLStore) {
  return ResultAsync.fromPromise(
    (async () => {
      await storage.init();
      return await storage.getStore("memory");
    })(),
    errStr,
  ).andThen((mem) =>
    // Normalize a missing store onto the same Result seam as initialization errors.
    match(mem)
      .with(P.nullish, () => errAsync<NonNullable<typeof mem>, string>("memory store unavailable"))
      .otherwise((m) => okAsync<NonNullable<typeof mem>, string>(m)),
  );
}

// A Memory bound to the injected storage. The ordering/reverse guarantee for
// `recall` ordering lives on Memory, not the raw store's listMessages, so read
// paths go through a throwaway Memory rather than the raw
// store. Exported as the owner of the `new Memory(); setStorage` idiom shared
// with session-view.ts.
export function memoryFor(storage: LibSQLStore): Memory {
  const memory = new Memory();
  memory.setStorage(storage);
  return memory;
}

export function statusForTurn(turn: SessionTurn): SessionState["status"] {
  return match(turn)
    .with({ kind: "gate" }, ({ decision }) => sessionStatusForGate(decision.gate))
    .with({ kind: "verdict", decision: { verdict: "REFINE" } }, () => "awaiting_parent" as const)
    .with({ kind: "verdict", decision: { verdict: P.union("GO", "REJECT") } }, () => "complete" as const)
    .with({ kind: "plain" }, () => "active" as const)
    .with({ kind: "failure" }, () => "failed" as const)
    .exhaustive();
}

export function statusForCommittedTurn(
  prior: SessionState,
  turn: SessionTurn,
  directives: Directive[],
): SessionState["status"] {
  return match(turn)
    .with({ kind: "gate" }, () => statusForTurn(turn))
    .with({ kind: "failure" }, () => "failed" as const)
    .otherwise(() =>
      match(directives.some((directive) => directive.status === "open"))
        .with(true, () =>
          match([...prior.turn_history].reverse().find((candidate) => candidate.kind === "gate"))
            .with({ kind: "gate" }, (gateTurn) => statusForTurn(gateTurn))
            .otherwise(() => "awaiting_parent" as const),
        )
        .with(false, () => statusForTurn(turn))
        .exhaustive(),
    );
}

// Append one exact run outcome. Gate artifacts may change only on a gate turn;
// verdict, plain, and failure turns carry the last gate's artifacts unchanged.
export function assembleSessionState(inp: {
  sessionId: string;
  workflow: string;
  prior: SessionState | null;
  turn: SessionTurn;
  // Optional inputs may arrive as explicit undefined from extractWhisperFields
  // (EOPT: `?: T` alone rejects `undefined` assignment).
  directives?: Directive[] | undefined;
  findings?: Finding[] | undefined;
  surfaceMap?: SurfaceMap | undefined;
  event?: unknown;
  evidenceItems: Evidence[];
}): SessionState {
  const prior = inp.prior;
  const gateTurn = inp.turn.kind === "gate";
  const directives = match(gateTurn)
    .with(true, () => inp.directives ?? prior?.directives ?? [])
    .with(false, () => prior?.directives ?? [])
    .exhaustive();
  return {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: inp.sessionId,
    task: prior?.task ?? taskFromEvent(inp.event, inp.workflow),
    parent_events: [
      ...(prior?.parent_events ?? []),
      ...match<unknown, unknown[]>(inp.event)
        .with(undefined, () => [])
        .otherwise((e) => [e]),
    ],
    surface_map: match(gateTurn)
      .with(true, () => inp.surfaceMap ?? prior?.surface_map ?? null)
      .with(false, () => prior?.surface_map ?? null)
      .exhaustive(),
    directives,
    findings: match(gateTurn)
      .with(true, () => inp.findings ?? prior?.findings ?? [])
      .with(false, () => prior?.findings ?? [])
      .exhaustive(),
    evidence: match(gateTurn)
      .with(true, () => [...(prior?.evidence ?? []), ...inp.evidenceItems])
      .with(false, () => prior?.evidence ?? [])
      .exhaustive(),
    turn_history: [...(prior?.turn_history ?? []), inp.turn],
    status: match(prior)
      .with(P.nullish, () => statusForTurn(inp.turn))
      .otherwise((state) => statusForCommittedTurn(state, inp.turn, directives)),
  };
}

// The ledger's override record uses parent_events and the existing "rejected"
// directive status, so no schema change is needed.
// Pure: returns a new SessionState with (a) parent_events + a navi.override event
// (open directive ids, reason, gate, ISO-8601 at) and (b) every open directive
// flipped to status "rejected" so open_directive_count → 0. turn_history and
// every other field are untouched — the override never rewrites the judge's
// verdict; it only records that the parent proceeded anyway.
export function applyOverride(state: SessionState, reason: string, gate: Gate): SessionState {
  const openIds = state.directives.filter((d) => d.status === "open").map((d) => d.id);
  return {
    ...state,
    status: "complete",
    parent_events: [
      ...state.parent_events,
      {
        type: "navi.override",
        reason,
        gate,
        overridden_directive_ids: openIds,
        at: new Date().toISOString(),
      },
    ],
    directives: state.directives.map((d) =>
      match(d.status)
        .with("open", () => ({ ...d, status: "rejected" as const }))
        .otherwise(() => d),
    ),
  };
}

// A sensible session `task` when there is no prior to inherit one from: the event's own
// `task` string when the parent supplied one, else the workflow name (never empty —
// SessionState.task is a required string).
// An array is not an event object, whatever properties it happens to carry.
function taskFromEvent(event: unknown, workflow: string): string {
  const fromEvent = match<unknown, string>(event)
    .with(P.array(), () => "")
    .with({ task: P.string }, ({ task }) => task.trim())
    .otherwise(() => "");
  return match(fromEvent)
    .with("", () => workflow)
    .otherwise((t) => t);
}

// Human-facing thread title from a session `task`: collapse whitespace, trim, and
// cap at 200 chars with an ellipsis as a sanity bound only.
export function titleFromTask(task: string): string {
  const collapsed = task.replace(/\s+/g, " ").trim();
  return match(collapsed.length > 200)
    .with(true, () => collapsed.slice(0, 199) + "…")
    .with(false, () => collapsed)
    .exhaustive();
}

const parseJson = Result.fromThrowable(
  (t: string) => JSON.parse(t) as unknown,
  () => "bad-json" as const,
);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function candidateTail<T>(current: T[], candidate: T[]): T[] {
  let common = 0;
  while (
    common < current.length &&
    common < candidate.length &&
    isDeepStrictEqual(current[common], candidate[common])
  ) {
    common++;
  }
  return candidate.slice(common);
}

function mergeCandidateState(
  current: SessionState | null,
  candidate: SessionState,
): { state: SessionState; changed: boolean } {
  return match(current)
    .with(null, () => ({ state: candidate, changed: true }))
    .otherwise((prior) => {
      const seenRunIds = new Set(
        prior.turn_history.flatMap((turn) =>
          match(turn.run_id)
            .with(null, (): string[] => [])
            .otherwise((id) => [id]),
        ),
      );
      const appendedTurns = candidateTail(prior.turn_history, candidate.turn_history).reduce<SessionTurn[]>(
        (turns, turn) =>
          match(turn.run_id)
            .with(null, () => [...turns, turn])
            .otherwise((runId) =>
              match(seenRunIds.has(runId))
                .with(true, () => turns)
                .with(false, () => {
                  seenRunIds.add(runId);
                  return [...turns, turn];
                })
                .exhaustive(),
            ),
        [],
      );
      return match(appendedTurns.at(-1))
        .with(undefined, () => ({ state: prior, changed: false }))
        .otherwise((latest) => {
          const gateArtifacts = match(latest.kind)
            .with("gate", () => ({
              surface_map: candidate.surface_map,
              directives: candidate.directives,
              findings: candidate.findings,
            }))
            .otherwise(() => ({
              surface_map: prior.surface_map,
              directives: prior.directives,
              findings: prior.findings,
            }));
          const mergedDirectives = gateArtifacts.directives;
          return {
            changed: true,
            state: {
              ...prior,
              ...gateArtifacts,
              schema_version: candidate.schema_version,
              session_id: candidate.session_id,
              parent_events: [
                ...prior.parent_events,
                ...candidateTail(prior.parent_events, candidate.parent_events),
              ],
              evidence: [
                ...prior.evidence,
                ...candidateTail(prior.evidence, candidate.evidence),
              ],
              turn_history: [...prior.turn_history, ...appendedTurns],
              status: match(latest)
                // Candidate assembly (and applyOverride) owns a gate turn's
                // terminal status. Recomputing from the gate enum here would
                // turn an overridden DIRECT back into awaiting_parent.
                .with({ kind: "gate" }, () => candidate.status)
                .otherwise(() => statusForCommittedTurn(prior, latest, mergedDirectives)),
            },
          };
        });
    });
}

type TransactionalState = {
  state: SessionState;
  createdAtMs: number;
};

function rowAsRecallMessage(content: unknown, role: unknown): RecallMessage {
  const parsed = match(content)
    .with(P.string, (text) => parseJson(text).unwrapOr(null))
    .otherwise((value) => value);
  return { content: parsed, role: String(role) } as RecallMessage;
}

function classifyTransactionalRow(row: Record<string, unknown>): Classified {
  const message = rowAsRecallMessage(row.content, row.role);
  return classifySessionStateMessage(message);
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value));
  return match(Number.isFinite(parsed))
    .with(true, () => parsed)
    .with(false, () => 0)
    .exhaustive();
}

async function latestStateInTransaction(
  tx: Transaction,
  sessionId: string,
): Promise<TransactionalState | null> {
  let page = 0;
  let found: TransactionalState | null = null;
  let exhausted = false;
  while (found === null && !exhausted) {
    const result = await tx.execute({
      sql: `SELECT json(content) AS content, role, "createdAt"
            FROM "${TABLE_MESSAGES}"
            WHERE thread_id = ?
            ORDER BY "createdAt" DESC, id DESC
            LIMIT ? OFFSET ?`,
      args: [sessionId, RECALL_PAGE_SIZE, page * RECALL_PAGE_SIZE],
    });
    let index = 0;
    while (found === null && index < result.rows.length) {
      const row = result.rows[index]!;
      found = match(classifyTransactionalRow(row))
        .with({ tag: "skip" }, () => null)
        .with({ tag: "valid" }, ({ state }) => ({
          state,
          createdAtMs: timestampMs(row.createdAt),
        }))
        .with({ tag: "malformed" }, ({ error }): never => {
          throw new Error(error);
        })
        .exhaustive();
      index++;
    }
    exhausted = result.rows.length < RECALL_PAGE_SIZE;
    page++;
  }
  return found;
}

function metadataObject(value: unknown): Record<string, unknown> {
  const parsed = match(value)
    .with(P.string, (text) => parseJson(text).unwrapOr(null))
    .otherwise((raw) => raw);
  return match(parsed)
    .with(P.when(isPlainObject), (metadata) => metadata)
    .otherwise(() => ({}));
}

async function appendInTransaction(
  client: Client,
  sessionId: string,
  candidate: SessionState,
): Promise<void> {
  const tx = await client.transaction("write");
  try {
    const latest = await latestStateInTransaction(tx, sessionId);
    const merged = mergeCandidateState(latest?.state ?? null, candidate);
    await match(merged.changed)
      .with(false, async () => undefined)
      .with(true, async () => {
        const threadResult = await tx.execute({
          sql: `SELECT title, json(metadata) AS metadata
                FROM "${TABLE_THREADS}"
                WHERE id = ?`,
          args: [sessionId],
        });
        const existing = threadResult.rows.at(0);
        const createdAt = new Date(
          Math.max(Date.now(), (latest?.createdAtMs ?? 0) + 1),
        ).toISOString();
        await match(existing)
          .with(undefined, () =>
            tx.execute({
              sql: `INSERT INTO "${TABLE_THREADS}"
                    (id, "resourceId", title, metadata, "createdAt", "updatedAt")
                    VALUES (?, ?, ?, jsonb(?), ?, ?)`,
              args: [sessionId, RESOURCE_ID, "", "{}", createdAt, createdAt],
            }),
          )
          .otherwise(async () => undefined);
        const title = match(String(existing?.title ?? ""))
          .with("", () => titleFromTask(merged.state.task))
          .otherwise((value) => value);
        const metadata = {
          ...metadataObject(existing?.metadata),
          ...deriveCache(merged.state),
        };
        const content = JSON.stringify({
          format: 2,
          parts: [{ type: "text", text: JSON.stringify(merged.state) }],
          metadata: { kind: SESSION_STATE_KIND },
        });
        await tx.execute({
          sql: `INSERT INTO "${TABLE_MESSAGES}"
                (id, thread_id, content, role, type, "createdAt", "resourceId")
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            sessionId,
            content,
            "assistant",
            "text",
            createdAt,
            RESOURCE_ID,
          ],
        });
        await tx.execute({
          sql: `UPDATE "${TABLE_THREADS}"
                SET title = ?, metadata = jsonb(?), "updatedAt" = ?
                WHERE id = ?`,
          args: [title, JSON.stringify(metadata), createdAt, sessionId],
        });
      })
      .exhaustive();
    await tx.commit();
  } catch (error) {
    await match(tx.closed)
      .with(true, async () => undefined)
      .with(false, () => tx.rollback())
      .exhaustive();
    throw error;
  } finally {
    tx.close();
  }
}

const MAX_BUSY_RETRIES = 3;

function withBusyRetry<T>(
  operation: () => Promise<T>,
  attempt: number = 0,
): Promise<T> {
  return operation().catch((error) =>
    match({
      busy: /SQLITE_BUSY|database is locked/i.test(errStr(error)),
      retry: attempt < MAX_BUSY_RETRIES,
    })
      .with({ busy: true, retry: true }, () =>
        new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1))).then(
          () => withBusyRetry(operation, attempt + 1),
        ),
      )
      .otherwise(() => Promise.reject(error)),
  );
}

// Append a full SessionState as a thread message AND, in the same operation, derive +
// write the metadata cache. The metadata write re-passes the thread's current
// title: updateThread shallow-merges `metadata` but overwrites `title`,
// so omitting it would silently blank the title. The thread normally already
// exists (the workflow's agent memory created it before the judge turn); if it
// does not yet (a first write on a bare id), a minimal thread is created so the
// message insert + metadata write have a row to land on — the existing title,
// when present, is always preserved.
export function appendSessionState(
  storage: LibSQLStore,
  client: Client,
  sessionId: string,
  state: SessionState,
): ResultAsync<void, string> {
  return match(sessionId === state.session_id)
    .with(false, () =>
      errAsync<void, string>(
        `session/thread identity mismatch: append target "${sessionId}" != state "${state.session_id}"`,
      ),
    )
    .with(true, () =>
      ResultAsync.fromPromise(
        storage.init().then(() =>
          withClientWriteLock(client, () =>
            withBusyRetry(() => appendInTransaction(client, sessionId, state)),
          ),
        ),
        errStr,
      ),
    )
    .exhaustive();
}

// The newest text part's text, or undefined (no text part ⇒ not a SessionState
// message). Guarded runtime narrowing over the MastraMessagePart union.
export type RecallMessage = Awaited<ReturnType<InstanceType<typeof Memory>["recall"]>>["messages"][number];

function textOf(msg: RecallMessage): string | undefined {
  return (msg.content?.parts ?? [])
    .flatMap((p) =>
      match<typeof p, string[]>(p)
        .with({ type: "text", text: P.string }, ({ text }) => [text])
        .otherwise(() => []),
    )
    .at(0);
}

function asObject(text: string): Record<string, unknown> | null {
  return parseJson(text)
    .map((v) =>
      match<unknown, Record<string, unknown> | null>(v)
        .with(P.when(isPlainObject), (o) => o)
        .otherwise(() => null),
    )
    .unwrapOr(null);
}

// The exact session-state marker from content.metadata, or undefined.
function messageKind(msg: RecallMessage): string | undefined {
  const meta = (msg.content as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  return match(meta?.kind)
    .with(P.string, (kind): string | undefined => kind)
    .otherwise(() => undefined);
}

export type Classified =
  | { tag: "skip" }
  | { tag: "valid"; state: SessionState }
  | { tag: "malformed"; error: string };

// Skip: not an assistant message carrying navi's exact session-state marker
// — tolerated so interleaved agent/tool turns never break the read.
// Valid: a marked object that passes SessionState.
// Malformed: a marked object that FAILS SessionState — a corrupt session-of-record.
// Exported as the ONE owner of the message→SessionState walk: readPriorSessionState (newest
// discriminated message) and session-view.showSession (whole-history) both consume it, so
// the discriminator and malformed-message wording cannot drift. Each consumer
// keeps its OWN match on the tags (show appends the offending message id to malformed).
export function classifySessionStateMessage(msg: RecallMessage): Classified {
  const obj = match(textOf(msg))
    .with(undefined, () => null)
    .otherwise((text) => asObject(text));
  const isSessionState =
    msg.role === "assistant" && messageKind(msg) === SESSION_STATE_KIND;
  return match({ isSessionState, obj })
    .with({ isSessionState: false }, (): Classified => ({ tag: "skip" }))
    .with({ obj: null }, (): Classified => ({
      tag: "malformed",
      error: "malformed SessionState: message body is not a JSON object",
    }))
    // safeParse IS the discriminated union — matching both arms means `data` and
    // `error` are each only in scope on the arm that carries one.
    .otherwise(({ obj: body }) =>
      match(SessionState.safeParse(body))
        .with({ success: true }, ({ data }): Classified => ({ tag: "valid", state: data }))
        .with({ success: false }, ({ error }): Classified => ({
          tag: "malformed",
          error: `malformed SessionState: ${zodIssues(error)}`,
        }))
        .exhaustive(),
    );
}

// Read back the NEWEST SessionState on a thread, tolerating interleaved non-SessionState
// messages by walking newest→oldest to the first message that IS a session state.
// Returns:
//  - ok(SessionState) for the newest valid session state,
//  - ok(null)      when the thread has no session-state message yet,
//  - err(...)      when the newest DISCRIMINATED message is malformed.
// A malformed newest state is a loud err, NOT a silent fall-back to an older valid
// one: silently substituting a stale disposition would hand the caller outdated
// directives and gate state, which is worse than an explicit read failure.
// Ordering: recall with a numeric perPage fetches the newest page and returns that
// page in chronological order, so the last element is newest. Iterate each page
// backward, then fetch an older page only when every message was noise.
function readPriorSessionStateRaw(
  storage: LibSQLStore,
  sessionId: string,
): ResultAsync<SessionState | null, string> {
  return ResultAsync.fromPromise(
    (async (): Promise<SessionState | null> => {
      await storage.init();
      const memory = memoryFor(storage);
      let found: SessionState | null = null;
      let page = 0;
      let hasMore = true;
      // Both loops stay LAZY. We stop after the first discriminated message, so
      // an older malformed snapshot cannot poison a newer valid one. We also stop
      // fetching pages as soon as that message is found.
      while (found === null && hasMore) {
        const recalled = await memory.recall({
          threadId: sessionId,
          page,
          perPage: RECALL_PAGE_SIZE,
        });
        let i = recalled.messages.length - 1;
        while (found === null && i >= 0) {
          found = match(classifySessionStateMessage(recalled.messages[i]!))
            .with({ tag: "skip" }, () => null)
            .with({ tag: "valid" }, ({ state }) => state)
            .with({ tag: "malformed" }, ({ error }): never => {
              throw new Error(error);
            })
            .exhaustive();
          i--;
        }
        hasMore = recalled.hasMore;
        page++;
      }
      return found;
    })(),
    errStr,
  );
}

export function readPriorSessionState(
  storage: LibSQLStore,
  sessionId: string,
): ResultAsync<SessionState | null, string> {
  return readPriorSessionStateRaw(storage, sessionId);
}

// On `--fork` the source messages are cloned but the session cache is not.
// Re-derive it from the cloned messages. updateThread shallow-merges the cache
// alongside the clone provenance and re-passes the current title.
//
// SKIP-tolerant variant. Returns:
//  - ok(cache) when the fork carries a SessionState (the cache written, handy for the caller/tests),
//  - ok(null)  when it has none (a fork of a plain-chat thread; the cache stays empty),
//  - err(...)  only on a genuine failure (a malformed session-of-record, a missing
//              thread, or a write failure).
// This is the shape the CLI's --fork path wants: no SessionState is a typed
// `ok(null)` it can skip directly, without a second prior read or matching this
// module's error wording.
export function rederiveCacheAfterForkIfPresent(
  storage: LibSQLStore,
  threadId: string,
): ResultAsync<SessionCache | null, string> {
  return readPriorSessionState(storage, threadId).andThen((state) =>
    match(state)
      .with(null, () => okAsync<SessionCache | null, string>(null))
      .otherwise((s) =>
        memoryStore(storage).andThen((mem) =>
          ResultAsync.fromPromise(
            (async (): Promise<SessionCache | null> => {
              const thread = await mem.getThreadById({ threadId });
              // Same title rule as appendSessionState: preserve a non-empty title,
              // else derive from the cloned session's task (fork parity).
              const title = match(thread)
                .with(P.nullish, (): never => {
                  throw new Error(`thread ${threadId} not found`);
                })
                .otherwise((t) =>
                  match(t.title ?? "")
                    .with("", () => titleFromTask(s.task))
                    .otherwise((existing) => existing),
                );
              const cache = deriveCache(s);
              await mem.updateThread({ id: threadId, title, metadata: { ...cache } });
              return cache;
            })(),
            errStr,
          ),
        ),
      ),
  );
}

// STRICT variant: a clone with no session-state message is a loud err — there is
// nothing to re-derive (a bare re-derive only makes sense on a session that HAS state),
// and a silent empty cache would misreport the session as stateless in `navi session list`.
// Thin wrapper over the skip-tolerant variant so both share one read + write path.
export function rederiveCacheAfterFork(
  storage: LibSQLStore,
  threadId: string,
): ResultAsync<SessionCache, string> {
  return rederiveCacheAfterForkIfPresent(storage, threadId).andThen((cache) =>
    match(cache)
      .with(null, () => errAsync<SessionCache, string>(`no SessionState message on thread ${threadId} to re-derive cache from`))
      .otherwise((c) => okAsync<SessionCache, string>(c)),
  );
}

// One owner for the product's clone boundary. Native cloneThread copies the
// messages and provenance but not the rebuildable session cache, so returning a
// fork id before re-derivation would expose a temporarily false session row.
// A plain-chat source legitimately has no SessionState and keeps only clone
// provenance. If re-derivation fails, compensate by deleting the clone before
// returning the original error: a failed fork never leaves an unreported thread.
export function forkSessionThread(
  storage: LibSQLStore,
  sourceSessionId: string,
  newSessionId: string = randomUUID(),
): ResultAsync<string, string> {
  return memoryStore(storage)
    .andThen((memory) =>
      ResultAsync.fromPromise(
        memory
          .cloneThread({
            sourceThreadId: sourceSessionId,
            newThreadId: newSessionId,
          })
          .then(() => ({ memory, forkId: newSessionId })),
        errStr,
      ),
    )
    .andThen(({ memory, forkId }) =>
      rederiveCacheAfterForkIfPresent(storage, forkId)
        .map(() => forkId)
        .orElse((cause) =>
          ResultAsync.fromPromise(
            memory.deleteThread({ threadId: forkId }),
            (cleanupError) =>
              `${cause}; failed to remove incomplete fork "${forkId}": ${errStr(cleanupError)}`,
          ).andThen(() => errAsync<string, string>(cause)),
        ),
    );
}
