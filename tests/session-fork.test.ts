import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import type { SessionState } from "../src/contracts/whisper.ts";
import {
  appendSessionState,
  readPriorSessionState,
  deriveCache,
  SESSION_STATE_KIND,
} from "../src/session-state.ts";

// Keyless integration coverage for `--fork`: real @mastra/libsql against a
// per-suite NAVI_DB, model-free command fixtures, and zero model calls. It proves
// fork mechanics end to end as real CLI subprocesses — clone-first, run-on-the-
// fork, source unmodified, the cache re-derived on the fork, and
// the graceful-skip versus loud-error split. Seed and every CLI spawn share
// one throwaway sqlite so sessions persist across the suite without touching the
// real navi.db.

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");
const REVISION_ECHO = "tests/fixtures/session-continuation/revision-echo/action.yaml";
const RESOURCE_ID = "cli";
const suiteDir = mkdtempSync(join(tmpdir(), "navi-session-fork-"));
const NAVI_DB = `file:${join(suiteDir, "navi.db")}`;

function navi(args: string[], input?: string) {
  const r = spawnSync(TSX, [CLI, ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NAVI_DB },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let storage: LibSQLStore;
let client: Client;
let mem: Awaited<ReturnType<LibSQLStore["getStore"]>> & object;
// Every source thread I seed (afterAll still removes any successful forks).
const sources = new Set<string>();
// Every thread id I know by name (sources + forks captured off the "forked …" line).
const created = new Set<string>();

beforeAll(async () => {
  storage = new LibSQLStore({ id: "navi", url: NAVI_DB });
  client = createClient({ url: NAVI_DB, timeout: 5_000 });
  await storage.init(); // the raw store does not create tables automatically
  const store = await storage.getStore("memory");
  if (!store) throw new Error("memory store unavailable");
  mem = store as typeof mem;
});

afterAll(async () => {
  // Delete every successful fork, then the sources + any named threads.
  const all = await mem.listThreads({ filter: { resourceId: RESOURCE_ID }, perPage: false });
  for (const t of all.threads) {
    const src = (t.metadata as { clone?: { sourceThreadId?: unknown } } | undefined)?.clone?.sourceThreadId;
    if (typeof src === "string" && sources.has(src)) await mem.deleteThread({ threadId: t.id }).catch(() => {});
  }
  for (const id of created) await mem.deleteThread({ threadId: id }).catch(() => {});
  client.close();
  await storage.close();
  rmSync(suiteDir, { recursive: true, force: true });
});

// A compact, fully valid SessionState. It is JSON-safe, so a
// seed → clone → read-back is deep-equal.
function makeState(sessionId: string, revisionHash: string): SessionState {
  return {
    schema_version: "navi.session.v2",
    session_id: sessionId,
    task: "wire repairCallRecord() into handler.ts",
    parent_events: [{ kind: "plan", text: "claims completion citing repair.ts" }],
    surface_map: {
      surfaces: ["src/handler.ts", "src/repair.ts"],
      seams: ["handler.ts never calls repairCallRecord()"],
      unknowns: [],
      revision_hash: revisionHash,
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
        stop_conditions: [],
        issued_at: "2026-07-18T00:00:00.000Z",
      },
    ],
    findings: [],
    evidence: [],
    turn_history: [
      {
        kind: "gate",
        run_id: "seed-run",
        workflow: "edge-walk",
        decision: {
          gate: "DIRECT",
          reason: "first disposition",
          blocking_directive_ids: ["d1"],
          non_blocking_risks: [],
          human_escalation: null,
          confidence: 0.7,
        },
      },
    ],
    status: "active",
  };
}

async function createThread(id: string, title: string) {
  const now = new Date();
  await mem.saveThread({ thread: { id, resourceId: RESOURCE_ID, title, metadata: {}, createdAt: now, updatedAt: now } });
}

async function seedRaw(
  threadId: string,
  text: string,
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
        createdAt: new Date(),
        content: {
          format: 2 as const,
          parts: [{ type: "text" as const, text }],
          ...(metadata === undefined ? {} : { metadata }),
        },
      },
    ],
  });
}

const forkIdOf = (stderr: string): string | undefined => stderr.match(/forked \S+ → (\S+)/)?.[1];

// --- 1. run --fork clones, runs on the fork, preserves the source -------------
describe("run --fork — clone-first, run-on-the-fork, source preserved (model-free)", () => {
  it("forks the -t session, runs on the fork, and leaves the source unchanged", async () => {
    const T = `fork-source-${randomUUID()}`;
    sources.add(T);
    created.add(T);
    const state = makeState(T, "revfork1");
    expect((await appendSessionState(storage, client, T, state)).isOk()).toBe(true);
    // read-back verify the seed before trusting any downstream result.
    expect((await readPriorSessionState(storage, T))._unsafeUnwrap()).toEqual(state);

    // Snapshot the SOURCE after its cache write, to prove the fork never touches it.
    const srcMetaBefore = (await mem.getThreadById({ threadId: T }))?.metadata;
    const srcMsgIdsBefore = (await mem.listMessages({ threadId: T })).messages.map((m) => m.id);

    const r = navi(["run", REVISION_ECHO, "-t", T, "--fork", "--json"]);
    expect(r.code).toBe(0);

    // Fork visibility: stderr names source → fork; envelope session_id IS the fork.
    const m = r.stderr.match(/forked (\S+) → (\S+)/);
    expect(m, r.stderr).not.toBeNull();
    expect(m![1]).toBe(T); // source
    const forkId = m![2];
    created.add(forkId);
    expect(forkId).not.toBe(T);

    const env = JSON.parse(r.stdout) as { session_id: string; next: { command: string } };
    expect(env.session_id).toBe(forkId); // the run executed on the FORK, not the source
    expect(env.next.command).toContain(`-t ${forkId}`); // the whisper loop continues on the fork

    // The fork carries the cloned history plus this run's plain turn, the re-derived
    // session cache, and clone provenance.
    const forkState = (await readPriorSessionState(storage, forkId))._unsafeUnwrap();
    expect(forkState).not.toBeNull();
    expect(forkState).toEqual({
      ...state,
      session_id: forkId,
      status: "awaiting_parent",
      turn_history: [
        ...state.turn_history,
        {
          kind: "plain",
          run_id: expect.any(String),
          workflow: "revision-echo",
          summary: "revision-echo: completed 1 step(s).",
        },
      ],
    });
    const forkMeta = (await mem.getThreadById({ threadId: forkId }))?.metadata;
    expect(forkMeta).toMatchObject(deriveCache(forkState!) as Record<string, unknown>);
    expect((forkMeta as { clone?: { sourceThreadId?: string } })?.clone).toMatchObject({ sourceThreadId: T });

    // SOURCE unchanged: metadata + message ids + readable state all identical.
    expect((await mem.getThreadById({ threadId: T }))?.metadata).toEqual(srcMetaBefore);
    expect((await mem.listMessages({ threadId: T })).messages.map((x) => x.id)).toEqual(srcMsgIdsBefore);
    expect((await readPriorSessionState(storage, T))._unsafeUnwrap()).toEqual(state);
  });
});

// --- 2. run --fork without -t is a loud usage error (bare-path consistency) ----
describe("run --fork guard — no -t is a loud usage error", () => {
  it("run --fork without -t → exit 1, no clone, no envelope", () => {
    const r = navi(["run", REVISION_ECHO, "--fork", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--fork needs a source session/);
    expect(r.stdout).toBe(""); // no envelope emitted — errored before compile/run
  });
});

// --- 3. graceful skip: forking a thread with no prior SessionState is not a failure -
describe("run --fork re-derive rule — graceful skip on a no-SessionState source", () => {
  it("forks a plain chat thread, run succeeds, and the run creates the fork's first session turn", async () => {
    const T = `fork-plain-${randomUUID()}`;
    sources.add(T);
    created.add(T);
    await createThread(T, "plain-chat");
    await seedRaw(T, "hello from the parent harness"); // a non-SessionState message

    const r = navi(["run", REVISION_ECHO, "-t", T, "--fork", "--json"]);
    expect(r.code).toBe(0); // graceful skip — NOT a run-aborting failure
    const forkId = forkIdOf(r.stderr);
    expect(forkId, r.stderr).toBeDefined();
    created.add(forkId!);

    const forkMeta = (await mem.getThreadById({ threadId: forkId! }))?.metadata;
    const forkState = (await readPriorSessionState(storage, forkId!))._unsafeUnwrap();
    expect(forkState).not.toBeNull();
    expect(forkState).toMatchObject({
      session_id: forkId,
      status: "active",
      turn_history: [
        {
          kind: "plain",
          workflow: "revision-echo",
          summary: "revision-echo: completed 1 step(s).",
        },
      ],
    });
    expect(forkMeta).toMatchObject(deriveCache(forkState!) as Record<string, unknown>);
    expect((forkMeta as { clone?: { sourceThreadId?: string } })?.clone).toMatchObject({ sourceThreadId: T });
    expect((await readPriorSessionState(storage, T))._unsafeUnwrap()).toBeNull();
  });
});

// --- 4. loud side of the rule: a malformed source session aborts the fork ---------
describe("run --fork re-derive rule — a malformed source session is a LOUD exit 1", () => {
  it("removes the incomplete clone before returning the error", async () => {
    const T = `fork-corrupt-${randomUUID()}`;
    sources.add(T);
    created.add(T);
    await createThread(T, "corrupt");
    await seedRaw(
      T,
      JSON.stringify({ session_id: T, schema_version: "navi.session.v2", status: "not-a-status" }),
      { kind: SESSION_STATE_KIND },
    );

    const r = navi(["run", REVISION_ECHO, "-t", T, "--fork", "--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/malformed SessionState/);
    expect(r.stdout).toBe(""); // aborted at the fork step, before compile/run
    const rows = await mem.listThreads({
      filter: { resourceId: RESOURCE_ID },
      perPage: false,
    });
    expect(
      rows.threads.filter(
        (thread) =>
          (thread.metadata as { clone?: { sourceThreadId?: unknown } } | undefined)
            ?.clone?.sourceThreadId === T,
      ),
    ).toEqual([]);
  });
});
