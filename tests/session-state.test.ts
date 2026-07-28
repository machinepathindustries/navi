import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { match } from "ts-pattern";
import { SessionState, type GateDecision, type SessionTurn } from "../src/contracts/whisper.ts";
import {
  appendSessionState,
  readPriorSessionState,
  deriveCache,
  rederiveCacheAfterFork,
  assembleSessionState,
  applyOverride,
  classifySessionStateMessage,
  memoryFor,
  forkSessionThread,
  statusForTurn,
  statusForCommittedTurn,
  SESSION_STATE_KIND,
} from "../src/session-state.ts";

// Integration coverage using a real @mastra/libsql store and Memory against a
// temporary file database, with zero model calls. It proves the session-state seam end to
// end — message round-trip, the rebuildable metadata cache + its listThreads
// filterability, and the fork re-derive — against the actual framework, not mocks.

const RESOURCE_ID = "cli";
let DIR: string;
let storage: LibSQLStore;
let client: Client;
// Raw memory-domain handle for seeding/asserting directly (same handle the module
// reaches via storage.getStore("memory")).
let mem: Awaited<ReturnType<LibSQLStore["getStore"]>> & object;

beforeAll(async () => {
  DIR = mkdtempSync(join(tmpdir(), "navi-session-state-"));
  const url = `file:${join(DIR, "session.db")}`;
  storage = new LibSQLStore({ id: "test", url });
  client = createClient({ url, timeout: 5_000 });
  await storage.init(); // the raw store does not create tables automatically
  const store = await storage.getStore("memory");
  if (!store) throw new Error("memory store unavailable");
  mem = store as typeof mem;
});

afterAll(async () => {
  client.close();
  await storage.close();
  rmSync(DIR, { recursive: true, force: true });
});

// --- fixtures --------------------------------------------------------------

function gateDecision(
  gate: GateDecision["gate"],
  reason: string = "r",
): GateDecision {
  return {
    gate,
    reason,
    blocking_directive_ids: [],
    non_blocking_risks: [],
    human_escalation: null,
    confidence: 0.5,
  };
}

function gateTurn(
  gate: GateDecision["gate"],
  reason: string,
  runId: string,
): SessionTurn {
  return {
    kind: "gate",
    run_id: runId,
    workflow: "edge-walk",
    decision: gateDecision(gate, reason),
  };
}

// A full, valid SessionState with every array populated (directives with mixed
// statuses, a two-entry turn_history whose newest is a DIRECT gate, a surface_map with a
// revision_hash). JSON-safe throughout (no Date fields on the contract), so a
// save→read round-trip is deep-equal.
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  const base: SessionState = {
    schema_version: "navi.session.v2",
    session_id: "session-fixture",
    task: "wire repairCallRecord() into handler.ts",
    parent_events: [{ kind: "plan", text: "claims completion citing repair.ts" }],
    surface_map: {
      surfaces: ["src/handler.ts", "src/repair.ts"],
      seams: ["handler.ts never calls repairCallRecord()"],
      unknowns: ["is there a second entry point?"],
      revision_hash: "revfixture",
    },
    directives: [
      {
        id: "d1",
        type: "trace-runtime-path",
        priority: 1,
        severity: "blocking",
        status: "open",
        reason: "the function is defined but never invoked at runtime",
        action: "produce a call path from an entry point to repairCallRecord()",
        targets: ["src/handler.ts"],
        required_evidence: ["call_path"],
        completion_criteria: ["a live call site is cited"],
        stop_conditions: ["no entry point calls it"],
        issued_at: "2026-07-18T00:00:00.000Z",
      },
      {
        id: "d2",
        type: "unit-test-review",
        priority: 2,
        severity: "non_blocking",
        status: "satisfied",
        reason: "the unit test exists (decoy)",
        action: "confirm the unit test alone is not runtime proof",
        targets: ["src/repair.test.ts"],
        required_evidence: ["test_result"],
        completion_criteria: ["reviewer notes it is not a wiring proof"],
        stop_conditions: [],
        issued_at: "2026-07-18T00:00:00.000Z",
      },
      {
        id: "d3",
        type: "integration-test",
        priority: 3,
        severity: "blocking",
        status: "open",
        reason: "no integration test exercises the runtime path",
        action: "run an integration test fresh for the current revision",
        targets: ["tests/"],
        required_evidence: ["test_result"],
        completion_criteria: ["a passing integration result fresh_for_revision"],
        stop_conditions: [],
        issued_at: "2026-07-18T00:00:00.000Z",
      },
    ],
    findings: [
      {
        id: "f1",
        file: "src/handler.ts",
        line: 42,
        severity: "high",
        category: "integration-completeness",
        summary: "repairCallRecord() is never reached from handler.ts",
        evidence: [{ kind: "source_location", uri: "src/repair.ts", line_start: 10, line_end: 20, claim_supported: false }],
        confidence: 0.8,
        suggested_resolution: "call repairCallRecord() from handler.ts",
      },
    ],
    evidence: [{ kind: "source_location", uri: "src/repair.ts", line_start: 10, line_end: 20, claim_supported: false }],
    turn_history: [
      gateTurn("DIRECT", "first disposition", "run-1"),
      {
        ...gateTurn("DIRECT", "still awaiting the runtime trace", "run-2"),
        decision: {
          ...gateDecision("DIRECT", "still awaiting the runtime trace"),
          blocking_directive_ids: ["d1", "d3"],
          confidence: 0.75,
        },
      },
    ],
    status: "active",
  };
  return { ...base, ...overrides };
}

async function createThread(id: string, title: string) {
  const now = new Date();
  await mem.saveThread({ thread: { id, resourceId: RESOURCE_ID, title, metadata: {}, createdAt: now, updatedAt: now } });
}

// Seed a NON-SessionState message (plain agent/parent text, or arbitrary JSON) with an
// explicit createdAt so the newest→oldest walk order is deterministic.
async function seedRaw(
  threadId: string,
  text: string,
  createdAt: Date,
  metadata?: Record<string, unknown>,
) {
  await mem.saveMessages({
    messages: [
      {
        id: randomUUID(),
        threadId,
        resourceId: RESOURCE_ID,
        role: "assistant" as const,
        type: "text",
        createdAt,
        content: {
          format: 2 as const,
          parts: [{ type: "text" as const, text }],
          ...(metadata === undefined ? {} : { metadata }),
        },
      },
    ],
  });
}

// --- tests -----------------------------------------------------------------

describe("session-state — append ↔ readPrior round-trip", () => {
  it("initializes a new ledger before its first SessionState append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-session-first-write-"));
    const url = `file:${join(dir, "session.db")}`;
    const freshStorage = new LibSQLStore({ id: "fresh", url });
    const freshClient = createClient({ url, timeout: 5_000 });
    onTestFinished(async () => {
      freshClient.close();
      await freshStorage.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const id = randomUUID();
    const state = makeState({ session_id: id });
    const appended = await appendSessionState(
      freshStorage,
      freshClient,
      id,
      state,
    );
    expect(appended.isOk(), appended.match(() => "", (error) => error)).toBe(
      true,
    );
    expect(
      (await readPriorSessionState(freshStorage, id))._unsafeUnwrap(),
    ).toEqual(state);
  });

  it("a full SessionState round-trips deep-equal", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id });

    const appended = await appendSessionState(storage, client, id, state);
    expect(appended.isOk()).toBe(true);

    const read = await readPriorSessionState(storage, id);
    expect(read.isOk()).toBe(true);
    expect(read._unsafeUnwrap()).toEqual(state);
  });

  it("refuses a state whose session id differs from the target thread", async () => {
    const target = randomUUID();
    const stateId = randomUUID();
    const result = await appendSessionState(
      storage,
      client,
      target,
      makeState({ session_id: stateId }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatch(/session\/thread identity mismatch/);
    expect(await mem.getThreadById({ threadId: target })).toBeNull();
  });

  it("readPrior returns null on a fresh thread with no SessionState message", async () => {
    const id = randomUUID();
    await createThread(id, "empty");
    const read = await readPriorSessionState(storage, id);
    expect(read.isOk()).toBe(true);
    expect(read._unsafeUnwrap()).toBeNull();

    // A never-created thread id also reads as null (no throw on a missing thread).
    const unseen = await readPriorSessionState(storage, randomUUID());
    expect(unseen.isOk()).toBe(true);
    expect(unseen._unsafeUnwrap()).toBeNull();
  });

  it("tolerates non-SessionState messages interleaved around the SessionState", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id, task: "interleaved" });
    const now = Date.now();

    // A plain parent message BEFORE the SessionState (never reached by the walk).
    await seedRaw(id, "hello from the parent harness", new Date(now - 10_000));
    // The real SessionState (createdAt ~now, assigned by appendSessionState).
    const appended = await appendSessionState(storage, client, id, state);
    expect(appended.isOk()).toBe(true);
    // Two non-SessionState messages AFTER it: arbitrary JSON (no discriminator) and prose.
    await seedRaw(id, JSON.stringify({ foo: "bar" }), new Date(now + 5_000));
    await seedRaw(id, "agent: reading the cited locations...", new Date(now + 10_000));

    // The walk skips the two newer noise messages and returns the SessionState.
    const read = await readPriorSessionState(storage, id);
    expect(read.isOk()).toBe(true);
    expect(read._unsafeUnwrap()).toEqual(state);
  });

  it("finds the newest SessionState beyond the first 100 ordinary messages", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id, task: "older-than-one-recall-page" });
    const now = Date.now();

    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);
    await mem.saveMessages({
      messages: Array.from({ length: 101 }, (_, index) => ({
        id: randomUUID(),
        threadId: id,
        resourceId: RESOURCE_ID,
        role: "assistant" as const,
        type: "text",
        createdAt: new Date(now + 1_000 + index),
        content: {
          format: 2 as const,
          parts: [{ type: "text" as const, text: `ordinary message ${index}` }],
        },
      })),
    });

    const read = await readPriorSessionState(storage, id);
    expect(read.isOk()).toBe(true);
    expect(read._unsafeUnwrap()).toEqual(state);
  });

  it("returns the newest sequential state without duplicating its prior turns", async () => {
    const id = randomUUID();
    const first = makeState({ session_id: id, task: "turn-1", status: "active" });
    const latestTurn: SessionTurn = {
      kind: "plain",
      run_id: "run-3",
      workflow: "code-search",
      summary: "third turn",
    };
    const second = {
      ...first,
      turn_history: [...first.turn_history, latestTurn],
      status: "awaiting_parent" as const,
    };

    expect((await appendSessionState(storage, client, id, first)).isOk()).toBe(true);
    expect((await appendSessionState(storage, client, id, second)).isOk()).toBe(true);

    const read = await readPriorSessionState(storage, id);
    expect(read._unsafeUnwrap()).toEqual(second);
  });
});

describe("session-state — atomic append under contention", () => {
  it("preserves both stale-prior candidates, append-only tails, cache metadata, and chronological snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-session-race-"));
    const url = `file:${join(dir, "race.db")}`;
    const storageA = new LibSQLStore({ id: "race-a", url, connectionTimeoutMs: 50 });
    const storageB = new LibSQLStore({ id: "race-b", url, connectionTimeoutMs: 50 });
    const clientA = createClient({ url, timeout: 50 });
    const clientB = createClient({ url, timeout: 50 });
    onTestFinished(async () => {
      clientA.close();
      clientB.close();
      await Promise.allSettled([storageA.close(), storageB.close()]);
      rmSync(dir, { recursive: true, force: true });
    });
    await storageA.init();
    await storageB.init();
    const memoryA = await storageA.getStore("memory");
    expect(memoryA).not.toBeNull();

    const id = randomUUID();
    const now = new Date();
    await memoryA!.saveThread({
      thread: {
        id,
        resourceId: RESOURCE_ID,
        title: "caller title",
        metadata: {
          clone: { sourceThreadId: "source-session" },
          archived: true,
          caller_key: "keep",
        },
        createdAt: now,
        updatedAt: now,
      },
    });
    const base = makeState({
      session_id: id,
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "base", "run-base")],
    });
    expect((await appendSessionState(storageA, clientA, id, base)).isOk()).toBe(true);

    // Both candidates are deliberately assembled from the SAME committed prior.
    const priorA = (await readPriorSessionState(storageA, id))._unsafeUnwrap()!;
    const priorB = (await readPriorSessionState(storageB, id))._unsafeUnwrap()!;
    expect(priorA).toEqual(priorB);
    const gateCandidate = applyOverride(
      assembleSessionState({
        sessionId: id,
        workflow: "edge-walk",
        prior: priorA,
        turn: gateTurn("DIRECT", "candidate A", "run-a"),
        event: { type: "parent.a" },
        evidenceItems: [
          {
            kind: "test_result",
            command: "npm test",
            exit_code: 0,
            claim_supported: true,
          },
        ],
      }),
      "accept residual risk",
      "DIRECT",
    );
    const plainTurn: SessionTurn = {
      kind: "plain",
      run_id: "run-b",
      workflow: "code-search",
      summary: "candidate B",
    };
    const plainCandidate = assembleSessionState({
      sessionId: id,
      workflow: "code-search",
      prior: priorB,
      turn: plainTurn,
      event: { type: "parent.b" },
      evidenceItems: [],
    });

    const results = await Promise.all([
      appendSessionState(storageA, clientA, id, gateCandidate),
      appendSessionState(storageB, clientB, id, plainCandidate),
    ]);
    expect(
      results.map((result) => result.match(() => "ok", (error) => error)),
    ).toEqual(["ok", "ok"]);

    const current = (await readPriorSessionState(storageA, id))._unsafeUnwrap()!;
    const runIds = current.turn_history.map((turn) => turn.run_id);
    expect(runIds).toHaveLength(3);
    expect(runIds[0]).toBe("run-base");
    expect(runIds.slice(1).sort()).toEqual(["run-a", "run-b"]);
    expect(new Set(runIds).size).toBe(3);

    const eventLabels = current.parent_events.map((event) =>
      "type" in (event as Record<string, unknown>)
        ? (event as { type: unknown }).type
        : (event as { kind?: unknown }).kind,
    );
    expect(eventLabels).toHaveLength(4);
    expect(eventLabels.filter((label) => label === "plan")).toHaveLength(1);
    expect(eventLabels.filter((label) => label === "parent.a")).toHaveLength(1);
    expect(eventLabels.filter((label) => label === "parent.b")).toHaveLength(1);
    expect(eventLabels.filter((label) => label === "navi.override")).toHaveLength(1);

    expect(current.evidence).toHaveLength(2);
    expect(current.evidence.filter((item) => item.kind === "source_location")).toHaveLength(1);
    expect(current.evidence.filter((item) => item.kind === "test_result")).toEqual([
      expect.objectContaining({ command: "npm test" }),
    ]);
    expect(current.directives.filter((directive) => directive.status === "open")).toHaveLength(0);
    expect(current.status).toBe(statusForTurn(current.turn_history.at(-1)!));

    const thread = await memoryA!.getThreadById({ threadId: id });
    expect(thread?.title).toBe("caller title");
    expect(thread?.metadata).toMatchObject({
      clone: { sourceThreadId: "source-session" },
      archived: true,
      caller_key: "keep",
      ...deriveCache(current),
    });

    const snapshots = await clientA.execute({
      sql: `SELECT "createdAt"
            FROM mastra_messages
            WHERE thread_id = ?
            ORDER BY "createdAt" ASC, id ASC`,
      args: [id],
    });
    const times = snapshots.rows.map((row) => Date.parse(String(row.createdAt)));
    expect(times).toHaveLength(3);
    expect(times[0]!).toBeLessThan(times[1]!);
    expect(times[1]!).toBeLessThan(times[2]!);

    // A retry carrying a non-null run_id is a no-op, not a fourth snapshot.
    expect((await appendSessionState(storageB, clientB, id, gateCandidate)).isOk()).toBe(true);
    const afterRetry = await clientA.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [id],
    });
    expect(Number(afterRetry.rows[0]!.count)).toBe(3);
    const afterRetryState = (await readPriorSessionState(storageA, id))._unsafeUnwrap()!;
    expect(afterRetryState).toEqual(current);
    const afterRetryThread = await memoryA!.getThreadById({ threadId: id });
    expect(afterRetryThread?.metadata).toMatchObject({
      clone: { sourceThreadId: "source-session" },
      archived: true,
      caller_key: "keep",
      ...deriveCache(current),
    });

  });

  it("serializes two stale candidates through the one retained client used in production", async () => {
    const id = randomUUID();
    const base = makeState({
      session_id: id,
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "base", "same-client-base")],
    });
    expect((await appendSessionState(storage, client, id, base)).isOk()).toBe(true);
    const stale = (await readPriorSessionState(storage, id))._unsafeUnwrap()!;
    const candidate = (runId: string) =>
      assembleSessionState({
        sessionId: id,
        workflow: "code-search",
        prior: stale,
        turn: {
          kind: "plain",
          run_id: runId,
          workflow: "code-search",
          summary: runId,
        },
        event: { type: runId },
        evidenceItems: [],
      });

    const results = await Promise.all([
      appendSessionState(storage, client, id, candidate("same-client-a")),
      appendSessionState(storage, client, id, candidate("same-client-b")),
    ]);
    expect(results.every((result) => result.isOk())).toBe(true);

    const final = (await readPriorSessionState(storage, id))._unsafeUnwrap()!;
    expect(final.turn_history.map((turn) => turn.run_id)).toEqual([
      "same-client-base",
      "same-client-a",
      "same-client-b",
    ]);
  });

  it("rolls the state message back when the metadata cache update aborts", async () => {
    const id = randomUUID();
    await createThread(id, "rollback-title");
    const trigger = `abort_cache_${id.replaceAll("-", "_")}`;
    await client.execute(
      `CREATE TRIGGER "${trigger}"
       BEFORE UPDATE OF metadata ON mastra_threads
       WHEN OLD.id = '${id}'
       BEGIN
         SELECT RAISE(ABORT, 'forced metadata failure');
       END`,
    );
    const before = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [id],
    });

    const result = await appendSessionState(
      storage,
      client,
      id,
      makeState({ session_id: id }),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatch(/forced metadata failure/);

    const after = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [id],
    });
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    const thread = await mem.getThreadById({ threadId: id });
    expect(thread?.title).toBe("rollback-title");
    expect(thread?.metadata).toEqual({});
    await client.execute(`DROP TRIGGER "${trigger}"`);
  });

  it("pages past 101 newer messages and ignores markerless user JSON on a retry", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);
    const now = Date.now();
    await mem.saveMessages({
      messages: [
        ...Array.from({ length: 100 }, (_, index) => ({
          id: randomUUID(),
          threadId: id,
          resourceId: RESOURCE_ID,
          role: "assistant" as const,
          type: "text",
          createdAt: new Date(now + 1_000 + index),
          content: {
            format: 2 as const,
            parts: [{ type: "text" as const, text: `ordinary ${index}` }],
          },
        })),
        {
          id: randomUUID(),
          threadId: id,
          resourceId: RESOURCE_ID,
          role: "user" as const,
          type: "text",
          createdAt: new Date(now + 2_000),
          content: {
            format: 2 as const,
            parts: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...state, task: "forged user state" }),
              },
            ],
          },
        },
      ],
    });
    const before = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [id],
    });

    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const after = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [id],
    });
    expect(Number(before.rows[0]!.count)).toBe(102);
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});

describe("session-state — deriveCache + live listThreads filterability", () => {
  it("deriveCache reads the cache fields honestly", () => {
    const cache = deriveCache(makeState());
    expect(cache).toEqual({
      schema_version: "navi.session.v2",
      status: "active",
      turn_kind: "gate",
      workflow: "edge-walk",
      gate: "DIRECT",
      verdict: null,
      open_directive_ids: ["d1", "d3"], // only status:"open", in order
      open_directive_count: 2,
      revision_hash: "revfixture",
    });
  });

  it("null-safe: empty turn_history and null surface_map yield null disposition/revision_hash", () => {
    const cache = deriveCache(makeState({ turn_history: [], surface_map: null, directives: [] }));
    expect(cache.turn_kind).toBeNull();
    expect(cache.workflow).toBeNull();
    expect(cache.gate).toBeNull();
    expect(cache.verdict).toBeNull();
    expect(cache.revision_hash).toBeNull();
    expect(cache.open_directive_ids).toEqual([]);
    expect(cache.open_directive_count).toBe(0);
  });

  it("latest verdict actively clears a prior gate from the cache", () => {
    const verdictTurn: SessionTurn = {
      kind: "verdict",
      run_id: "run-3",
      workflow: "founder",
      decision: {
        verdict: "REFINE",
        take: "tighten the scope",
        grounding_points: [],
        decision_rules: [],
        what_not_to_do: [],
      },
    };
    const cache = deriveCache(
      makeState({ turn_history: [...makeState().turn_history, verdictTurn] }),
    );
    expect(cache).toMatchObject({
      turn_kind: "verdict",
      workflow: "founder",
      gate: null,
      verdict: "REFINE",
    });
  });

  it("append writes a correct, live-filterable cache and the title survives", async () => {
    const id = randomUUID();
    const rev = `rev-${id}`; // unique scalar so the filter isolates this thread
    const state = makeState({ session_id: id, surface_map: { surfaces: [], seams: [], unknowns: [], revision_hash: rev } });
    await createThread(id, "session-title-preserve");

    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    // Cache is exactly deriveCache(state) on the thread's metadata.
    const thread = await mem.getThreadById({ threadId: id });
    expect(thread?.metadata).toMatchObject(deriveCache(state) as Record<string, unknown>);
    // The metadata write preserves the pre-existing title.
    expect(thread?.title).toBe("session-title-preserve");

    // Scalar cache fields are live-filterable via listThreads (AND across keys).
    const found = await mem.listThreads({ filter: { metadata: { status: "active", open_directive_count: 2, revision_hash: rev } } });
    expect(found.threads.map((t) => t.id)).toContain(id);

    // A wrong scalar value does NOT match.
    const miss = await mem.listThreads({ filter: { metadata: { status: "complete", revision_hash: rev } } });
    expect(miss.threads.map((t) => t.id)).not.toContain(id);
  });
});

describe("session-state — fork re-derive", () => {
  it("rederiveCacheAfterFork rebuilds the clone's cache; source stays unmutated", async () => {
    const srcId = randomUUID();
    const state = makeState({ session_id: srcId, task: "fork-source" });
    await createThread(srcId, "src-title");
    expect((await appendSessionState(storage, client, srcId, state)).isOk()).toBe(true);

    // Baseline the source AFTER its cache write, to prove the fork never touches it.
    const srcBefore = await mem.getThreadById({ threadId: srcId });
    const srcMsgsBefore = (await mem.listMessages({ threadId: srcId })).messages.length;

    // Exercise the production clone boundary before any subsequent run writes
    // another cache value.
    const newThreadId = randomUUID();
    const re = await forkSessionThread(storage, srcId, newThreadId);
    expect(re.isOk()).toBe(true);
    expect(re._unsafeUnwrap()).toBe(newThreadId);

    // Clone metadata carries both the cache and clone provenance.
    const cloneThreadRow = await mem.getThreadById({ threadId: newThreadId });
    expect(cloneThreadRow?.metadata).toMatchObject(deriveCache(state) as Record<string, unknown>);
    expect(cloneThreadRow?.metadata?.clone).toMatchObject({ sourceThreadId: srcId });

    // Clone carries the full message history + the readable session state.
    const cloneMsgs = (await mem.listMessages({ threadId: newThreadId })).messages.length;
    expect(cloneMsgs).toBe(srcMsgsBefore);
    expect((await readPriorSessionState(storage, newThreadId))._unsafeUnwrap()).toEqual(state);

    // Source thread: metadata + messages + readable state all unchanged.
    const srcAfter = await mem.getThreadById({ threadId: srcId });
    expect(srcAfter?.metadata).toEqual(srcBefore?.metadata);
    expect((await mem.listMessages({ threadId: srcId })).messages.length).toBe(srcMsgsBefore);
    expect((await readPriorSessionState(storage, srcId))._unsafeUnwrap()).toEqual(state);
  });

  it("re-deriving a thread with no SessionState message is a loud err", async () => {
    const id = randomUUID();
    await createThread(id, "stateless");
    const re = await rederiveCacheAfterFork(storage, id);
    expect(re.isErr()).toBe(true);
    expect(re._unsafeUnwrapErr()).toMatch(/no SessionState message/);
  });
});

describe("session-state — malformed SessionState integrity", () => {
  it("a discriminated-but-invalid SessionState message reads as an err", async () => {
    const id = randomUUID();
    await createThread(id, "corrupt");
    // Exact marker claims this as machine state, but required fields are absent.
    await seedRaw(
      id,
      JSON.stringify({ session_id: id, schema_version: "navi.session.v2" }),
      new Date(),
      { kind: SESSION_STATE_KIND },
    );

    const read = await readPriorSessionState(storage, id);
    expect(read.isErr()).toBe(true);
    expect(read._unsafeUnwrapErr()).toMatch(/malformed SessionState/);
  });

  it("a malformed NEWEST state errs rather than silently falling back to an older valid one", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id, task: "older-valid" });
    const now = Date.now();

    // Older: a valid SessionState.
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);
    // Newer: a marked, corrupt session-of-record.
    await seedRaw(
      id,
      JSON.stringify({ session_id: id, schema_version: "navi.session.v2", status: "not-a-status" }),
      new Date(now + 10_000),
      { kind: SESSION_STATE_KIND },
    );

    const read = await readPriorSessionState(storage, id);
    expect(read.isErr()).toBe(true);
    expect(read._unsafeUnwrapErr()).toMatch(/malformed SessionState/);
  });
});

// assembleSessionState — append-only turn mechanics. Gate turns may update the
// gate-specific artifacts; all other turns carry them unchanged.
describe("session-state — assembleSessionState (mechanical merge)", () => {
  it("fresh: appends one exact gate turn, derives status, and takes task from the event", () => {
    const turn = gateTurn("DIRECT", "r", "run-1");
    const s = assembleSessionState({
      sessionId: "c",
      workflow: "edge-walk",
      prior: null,
      turn,
      event: { task: "wire repairCallRecord into handler.ts" },
      evidenceItems: [],
    });
    expect(SessionState.safeParse(s).success).toBe(true);
    expect(s.turn_history).toEqual([turn]);
    expect(s.parent_events).toEqual([{ task: "wire repairCallRecord into handler.ts" }]);
    expect(s.status).toBe("awaiting_parent");
    expect(s.task).toBe("wire repairCallRecord into handler.ts");
  });

  it("no event and no prior: task falls back to the workflow name; parent_events stays empty", () => {
    const s = assembleSessionState({
      sessionId: "c",
      workflow: "edge-walk",
      prior: null,
      turn: gateTurn("CLEAR", "r", "run-1"),
      evidenceItems: [],
    });
    expect(s.task).toBe("edge-walk");
    expect(s.parent_events).toEqual([]);
    expect(s.status).toBe("clear");
  });

  it("continuation: turns, parent events, and gate evidence grow; task is carried", () => {
    const prior = assembleSessionState({
      sessionId: "c",
      workflow: "edge-walk",
      prior: null,
      turn: gateTurn("DIRECT", "r", "run-1"),
      event: { task: "wire it" },
      evidenceItems: [],
    });
    const ev = { kind: "call_path", claim_supported: true } as const;
    const next = assembleSessionState({
      sessionId: "c",
      workflow: "edge-walk",
      prior,
      turn: gateTurn("CLEAR", "done", "run-2"),
      event: { kind: "evidence-return" },
      evidenceItems: [ev],
    });
    expect(SessionState.safeParse(next).success).toBe(true);
    expect(
      next.turn_history.map((turn) =>
        turn.kind === "gate" ? turn.decision.gate : turn.kind,
      ),
    ).toEqual(["DIRECT", "CLEAR"]);
    expect(next.parent_events).toHaveLength(2);
    expect(next.evidence).toEqual([ev]);
    expect(next.task).toBe("wire it");
    expect(next.status).toBe("clear");
  });

  it("judge directives are authoritative when present (even []); carried from prior when the field is absent", () => {
    const dirs = makeState().directives.slice(0, 1);
    const prior = assembleSessionState({
      sessionId: "c",
      workflow: "w",
      prior: null,
      turn: gateTurn("DIRECT", "r", "run-1"),
      directives: dirs,
      evidenceItems: [],
    });
    expect(prior.directives).toEqual(dirs);
    // absent on the next turn → prior's directives carried forward
    const carried = assembleSessionState({
      sessionId: "c",
      workflow: "w",
      prior,
      turn: gateTurn("DIRECT", "r", "run-2"),
      evidenceItems: [],
    });
    expect(carried.directives).toEqual(dirs);
    // present-but-empty → authoritative (the judge cleared them)
    const cleared = assembleSessionState({
      sessionId: "c",
      workflow: "w",
      prior,
      turn: gateTurn("CLEAR", "r", "run-3"),
      directives: [],
      evidenceItems: [],
    });
    expect(cleared.directives).toEqual([]);
  });

  it.each([
    [
      "GO verdict",
      {
        kind: "verdict",
        run_id: "v1",
        workflow: "founder",
        decision: {
          verdict: "GO",
          take: "ship",
          grounding_points: [],
          decision_rules: [],
          what_not_to_do: [],
        },
      } satisfies SessionTurn,
      "complete",
    ],
    [
      "REFINE verdict",
      {
        kind: "verdict",
        run_id: "v2",
        workflow: "founder",
        decision: {
          verdict: "REFINE",
          take: "tighten",
          grounding_points: [],
          decision_rules: [],
          what_not_to_do: [],
        },
      } satisfies SessionTurn,
      "awaiting_parent",
    ],
    [
      "REJECT verdict",
      {
        kind: "verdict",
        run_id: "v3",
        workflow: "founder",
        decision: {
          verdict: "REJECT",
          take: "stop",
          grounding_points: [],
          decision_rules: [],
          what_not_to_do: [],
        },
      } satisfies SessionTurn,
      "complete",
    ],
    [
      "plain",
      { kind: "plain", run_id: "p1", workflow: "code-search", summary: "found it" } satisfies SessionTurn,
      "active",
    ],
    [
      "failure",
      { kind: "failure", run_id: "f1", workflow: "code-search", reason: "provider failed" } satisfies SessionTurn,
      "failed",
    ],
  ] as const)("derives the %s turn status without translating its disposition", (_name, turn, status) => {
    const state = assembleSessionState({
      sessionId: "c",
      workflow: turn.workflow ?? "run",
      prior: null,
      turn,
      evidenceItems: [],
    });
    expect(state.status).toBe(status);
    expect(state.turn_history).toEqual([turn]);
  });

  it("non-gate turns carry gate artifacts unchanged", () => {
    const prior = makeState();
    const plain: SessionTurn = {
      kind: "plain",
      run_id: "plain-1",
      workflow: "code-search",
      summary: "answer",
    };
    const next = assembleSessionState({
      sessionId: prior.session_id,
      workflow: "code-search",
      prior,
      turn: plain,
      directives: [],
      findings: [],
      surfaceMap: { surfaces: [], seams: [], unknowns: [], revision_hash: "wrong" },
      evidenceItems: [{ kind: "test_result", claim_supported: true }],
    });
    expect(next.turn_history).toEqual([...prior.turn_history, plain]);
    expect(next.directives).toEqual(prior.directives);
    expect(next.findings).toEqual(prior.findings);
    expect(next.surface_map).toEqual(prior.surface_map);
    expect(next.evidence).toEqual(prior.evidence);
    expect(next.status).toBe("awaiting_parent");
  });

  it("a non-gate commit cannot clear a prior status while directives stay open", () => {
    const prior = makeState({ status: "awaiting_parent" });
    const verdict: SessionTurn = {
      kind: "verdict",
      run_id: "verdict-open",
      workflow: "founder",
      decision: {
        verdict: "GO",
        take: "proceed",
        grounding_points: [],
        decision_rules: [],
        what_not_to_do: [],
      },
    };
    expect(statusForCommittedTurn(prior, verdict, prior.directives)).toBe(
      "awaiting_parent",
    );
    expect(
      statusForCommittedTurn(
        { ...prior, status: "failed" },
        verdict,
        prior.directives,
      ),
    ).toBe("awaiting_parent");
    expect(
      statusForCommittedTurn(
        prior,
        { kind: "failure", run_id: "failed", workflow: "founder", reason: "down" },
        prior.directives,
      ),
    ).toBe("failed");
  });
});

// applyOverride — the ledger's override record (parent_events + rejected
// directives; zero schema change). Pure, so unit-tested without a DB.
describe("session-state — applyOverride (ledger override record)", () => {
  it("open directives flip to rejected; non-open stay untouched; input not mutated", () => {
    const state = makeState();
    const next = applyOverride(state, "parent says proceed", "DIRECT");
    expect(next.directives.map((d) => ({ id: d.id, status: d.status }))).toEqual([
      { id: "d1", status: "rejected" },
      { id: "d2", status: "satisfied" },
      { id: "d3", status: "rejected" },
    ]);
    // Pure: the input SessionState is never mutated.
    expect(state.directives.map((d) => d.status)).toEqual(["open", "satisfied", "open"]);
  });

  it("appends a navi.override event to parent_events with reason/gate/ids", () => {
    const state = makeState();
    const priorLen = state.parent_events.length;
    const next = applyOverride(state, "ship it", "BLOCKED");
    expect(next.parent_events).toHaveLength(priorLen + 1);
    // Prior events preserved in order; override is append-only at the end.
    expect(next.parent_events.slice(0, priorLen)).toEqual(state.parent_events);
    const ev = next.parent_events.at(-1) as {
      type: string;
      reason: string;
      gate: string;
      overridden_directive_ids: string[];
      at: string;
    };
    expect(ev.type).toBe("navi.override");
    expect(ev.reason).toBe("ship it");
    expect(ev.gate).toBe("BLOCKED");
    expect(ev.overridden_directive_ids).toEqual(["d1", "d3"]);
    // ISO-8601 timestamp — Date.parse accepts it and toISOString round-trips shape.
    expect(Number.isNaN(Date.parse(ev.at))).toBe(false);
    expect(SessionState.safeParse(next).success).toBe(true);
  });

  it("turn_history is unchanged (override never rewrites a disposition)", () => {
    const state = makeState();
    const next = applyOverride(state, "r", "ESCALATE");
    expect(next.turn_history).toEqual(state.turn_history);
    expect(next.status).toBe("complete");
    expect(next.findings).toEqual(state.findings);
    expect(next.evidence).toEqual(state.evidence);
    expect(next.surface_map).toEqual(state.surface_map);
  });

  it("deriveCache of the result has open_directive_count 0", () => {
    const next = applyOverride(makeState(), "r", "REPAIR");
    const cache = deriveCache(next);
    expect(cache.open_directive_count).toBe(0);
    expect(cache.open_directive_ids).toEqual([]);
  });
});

// Thread title: appendSessionState derives a human title from state.task when the
// thread has none yet, and preserves an existing non-empty title (listThreads /
// `navi session list` must not show "—" or blank a caller-set title).
describe("session-state — thread title from task", () => {
  it("a short task becomes the thread title on a fresh session", async () => {
    const id = randomUUID();
    const task = "wire repairCallRecord into handler";
    const state = makeState({ session_id: id, task });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const thread = await mem.getThreadById({ threadId: id });
    expect(thread?.title).toBe(task);
  });

  it("a long task is capped at 200 chars with a trailing …", async () => {
    const id = randomUUID();
    // Sanity-bound only: one collapsed line; over 200 → slice + ellipsis.
    const task = "wire repairCallRecord into handler and also update the integration tests covering the runtime path ".repeat(3).trim();
    expect(task.length).toBeGreaterThan(200);
    const state = makeState({ session_id: id, task });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const thread = await mem.getThreadById({ threadId: id });
    expect(thread?.title).toBe(task.slice(0, 199) + "…");
    expect(thread?.title?.length).toBe(200);
    expect(thread?.title?.endsWith("…")).toBe(true);
  });

  it("an existing non-empty title is preserved (not overwritten by task)", async () => {
    const id = randomUUID();
    await createThread(id, "caller-set-title");
    const state = makeState({ session_id: id, task: "a different task string" });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const thread = await mem.getThreadById({ threadId: id });
    expect(thread?.title).toBe("caller-set-title");
  });
});

describe("session-state — exact kind marker", () => {
  it("appendSessionState stamps content.metadata.kind = session_state, and classify accepts it", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const { messages } = await memoryFor(storage).recall({ threadId: id, perPage: 100 });
    const marked = messages.find((m) => (m.content as { metadata?: { kind?: unknown } } | undefined)?.metadata?.kind === SESSION_STATE_KIND);
    expect(marked, "appendSessionState message carries the kind-marker").toBeDefined();
    expect(classifySessionStateMessage(marked!)).toMatchObject({ tag: "valid" });
  });

  it("markerless assistant JSON cannot claim the machine ledger, even when shape-valid", async () => {
    const id = randomUUID();
    const state = makeState({ session_id: id, task: "markerless" });
    await createThread(id, "markerless");
    await seedRaw(id, JSON.stringify(state), new Date()); // seedRaw writes NO content.metadata

    const { messages } = await memoryFor(storage).recall({ threadId: id, perPage: 100 });
    const msg = messages.at(-1)!;
    expect((msg.content as { metadata?: { kind?: unknown } } | undefined)?.metadata?.kind).toBeUndefined();
    expect(classifySessionStateMessage(msg)).toMatchObject({ tag: "skip" });
    expect((await readPriorSessionState(storage, id))._unsafeUnwrap()).toBeNull();
  });
});
