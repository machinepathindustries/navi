import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import type {
  GateDecision,
  SessionState,
  SessionTurn,
} from "../src/contracts/whisper.ts";
import {
  appendSessionState,
  rederiveCacheAfterFork,
  SESSION_STATE_KIND,
} from "../src/session-state.ts";
import {
  listSessions,
  showSession,
  storySession,
  parseListFilters,
  renderSessionList,
  renderSessionShow,
  renderStory,
  handleOf,
  resolveSessionToken,
  setSessionArchived,
  visibleSessions,
  type StoryView,
} from "../src/session-view.ts";

// Session observability reads are keyless and make zero model calls:
//  (A) the query+render seam called directly against a temp-file libsql db
//      (session-state.test.ts pattern) — isolated, never touches the shared navi.db;
//  (B) the CLI verbs as real subprocesses against a per-suite temp NAVI_DB
//      (same file the CLI opens via process.env.NAVI_DB) — proves dispatch,
//      exit map, and --json wiring without ever touching the real navi.db.
// (B) seeds only freshly minted test ids on that temp path so sessions persist
// across the suite's multiple CLI calls.

const RESOURCE_ID = "cli";

// --- shared fixture --------------------------------------------------------

// A full, valid SessionState (session-state.test.ts shape): 3 directives (d1/d3 open,
// d2 satisfied), 1 finding (severity high), 1 evidence, and one gate turn.
function makeState(sessionId: string, opts: { status?: SessionState["status"]; gate?: string; rev?: string } = {}): SessionState {
  const gate = (opts.gate ?? "DIRECT") as GateDecision["gate"];
  return {
    schema_version: "navi.session.v2",
    session_id: sessionId,
    task: "wire repairCallRecord() into handler.ts",
    parent_events: [{ kind: "plan", text: "claims completion citing repair.ts" }],
    surface_map: {
      surfaces: ["src/handler.ts", "src/repair.ts"],
      seams: ["handler.ts never calls repairCallRecord()"],
      unknowns: [],
      revision_hash: opts.rev ?? "revfixture",
    },
    directives: [
      dir("d1", "open", "blocking", "produce a call path to repairCallRecord()"),
      dir("d2", "satisfied", "non_blocking", "confirm the unit test is not runtime proof"),
      dir("d3", "open", "blocking", "run an integration test fresh for the revision"),
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
      },
    ],
    evidence: [{ kind: "source_location", uri: "src/repair.ts", line_start: 10, line_end: 20, claim_supported: false }],
    turn_history: [gateTurn(gate, "latest disposition", ["d1", "d3"], "run-1")],
    status: opts.status ?? "active",
  };
}

function dir(id: string, status: SessionState["directives"][number]["status"], severity: "blocking" | "non_blocking", action: string): SessionState["directives"][number] {
  return {
    id,
    type: "trace-runtime-path",
    priority: 1,
    severity,
    status,
    reason: "reason",
    action,
    targets: ["src/handler.ts"],
    required_evidence: ["call_path"],
    completion_criteria: ["a live call site is cited"],
    stop_conditions: [],
    issued_at: "2026-07-18T00:00:00.000Z",
  };
}

// Minimal gate decision for story fixtures (single entry, explicit reason).
function gateDec(
  gate: GateDecision["gate"],
  reason: string,
  blocking: string[] = [],
): GateDecision {
  return {
    gate,
    reason,
    blocking_directive_ids: blocking,
    non_blocking_risks: [],
    human_escalation: null,
    confidence: 0.8,
  };
}

function gateTurn(
  gate: GateDecision["gate"],
  reason: string,
  blocking: string[] = [],
  runId: string = randomUUID(),
): SessionTurn {
  return {
    kind: "gate",
    run_id: runId,
    workflow: "edge-walk",
    decision: gateDec(gate, reason, blocking),
  };
}

// Story journey builder: start from makeState shape, then override the fields
// the narrative cares about (turn_history, directives, evidence, parent_events).
function storyState(
  sessionId: string,
  patch: Partial<Pick<SessionState, "status" | "turn_history" | "directives" | "evidence" | "parent_events" | "task">>,
): SessionState {
  const base = makeState(sessionId);
  return {
    ...base,
    ...patch,
    turn_history: patch.turn_history ?? [gateTurn("DIRECT", "first disposition", ["d1"])],
    directives: patch.directives ?? [dir("d1", "open", "blocking", "wire the call path")],
    evidence: patch.evidence ?? [],
    parent_events: patch.parent_events ?? [],
  };
}

// =========================================================================
// (A) Direct calls against a temp-file libsql db
// =========================================================================

describe("session-view — listSessions / showSession (temp db, model-free)", () => {
  let DIR: string;
  let storage: LibSQLStore;
  let client: Client;
  let mem: Awaited<ReturnType<LibSQLStore["getStore"]>> & object;

  beforeAll(async () => {
    DIR = mkdtempSync(join(tmpdir(), "navi-session-view-"));
    const url = `file:${join(DIR, "session.db")}`;
    storage = new LibSQLStore({ id: "test", url });
    client = createClient({ url, timeout: 5_000 });
    await storage.init();
    const store = await storage.getStore("memory");
    if (!store) throw new Error("memory store unavailable");
    mem = store as typeof mem;
  });

  afterAll(async () => {
    client.close();
    await storage.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("lists a seeded session with correct columns", async () => {
    const id = `session-cols-${randomUUID()}`;
    const state = makeState(id, { rev: `rev-${id}` });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const rows = (await listSessions(storage, {}))._unsafeUnwrap();
    const row = rows.find((r) => r.session_id === id);
    expect(row).toBeTruthy();
    expect(row).toMatchObject({
      session_id: id,
      status: "active",
      turn_kind: "gate",
      workflow: "edge-walk",
      gate: "DIRECT",
      verdict: null,
      open_directive_count: 2, // d1 + d3
      revision_hash: `rev-${id}`,
      fork_of: null,
      archived: false,
    });
    expect(typeof row!.updatedAt).toBe("string");
    expect(new Date(row!.updatedAt).toISOString()).toBe(row!.updatedAt); // valid ISO
  });

  it("archive flags a session; list hides it by default; --all shows; unarchive restores", async () => {
    const keep = `session-arch-keep-${randomUUID()}`;
    const junk = `session-arch-junk-${randomUUID()}`;
    expect((await appendSessionState(storage, client, keep, makeState(keep))).isOk()).toBe(true);
    expect((await appendSessionState(storage, client, junk, makeState(junk))).isOk()).toBe(true);

    // Archive the junk session (title re-passed, metadata shallow-merged).
    const arch = (await setSessionArchived(storage, junk, true))._unsafeUnwrap();
    expect(arch.handle).toBe(handleOf(junk));
    expect(arch.title.length).toBeGreaterThan(0);

    const allRows = (await listSessions(storage, {}))._unsafeUnwrap();
    expect(allRows.find((r) => r.session_id === junk)?.archived).toBe(true);
    expect(allRows.find((r) => r.session_id === keep)?.archived).toBe(false);

    // Default visibility hides archived; --all includes them.
    const shown = visibleSessions(allRows, { all: false });
    expect(shown.map((r) => r.session_id)).toContain(keep);
    expect(shown.map((r) => r.session_id)).not.toContain(junk);
    const withAll = visibleSessions(allRows, { all: true });
    expect(withAll.map((r) => r.session_id)).toContain(junk);

    // Human render: meta names the hidden count; --all paints the marker.
    const human = renderSessionList(allRows);
    expect(human).toMatch(/archived \(navi session list --all\)/);
    expect(human).not.toMatch(new RegExp(handleOf(junk)));
    const humanAll = renderSessionList(allRows, { all: true });
    expect(humanAll).toMatch(new RegExp(handleOf(junk)));
    expect(humanAll).toMatch(/· archived/);

    // Unarchive restores default visibility.
    expect((await setSessionArchived(storage, junk, false)).isOk()).toBe(true);
    const restored = (await listSessions(storage, {}))._unsafeUnwrap();
    expect(restored.find((r) => r.session_id === junk)?.archived).toBe(false);
    expect(visibleSessions(restored, { all: false }).map((r) => r.session_id)).toContain(junk);
  });

  it("--status filter returns only matching sessions (native metadata filter)", async () => {
    const active = `session-st-active-${randomUUID()}`;
    const complete = `session-st-complete-${randomUUID()}`;
    expect((await appendSessionState(storage, client, active, makeState(active, { status: "active" }))).isOk()).toBe(true);
    expect((await appendSessionState(storage, client, complete, makeState(complete, { status: "complete" }))).isOk()).toBe(true);

    const rows = (await listSessions(storage, { status: "complete" }))._unsafeUnwrap();
    const ids = rows.map((r) => r.session_id);
    expect(ids).toContain(complete);
    expect(ids).not.toContain(active);
    expect(rows.every((r) => r.status === "complete")).toBe(true);
  });

  it("--gate filter returns only matching sessions", async () => {
    const direct = `session-g-direct-${randomUUID()}`;
    const clear = `session-g-clear-${randomUUID()}`;
    expect((await appendSessionState(storage, client, direct, makeState(direct, { gate: "DIRECT" }))).isOk()).toBe(true);
    expect((await appendSessionState(storage, client, clear, makeState(clear, { gate: "CLEAR" }))).isOk()).toBe(true);

    const rows = (await listSessions(storage, { gate: "CLEAR" }))._unsafeUnwrap();
    const ids = rows.map((r) => r.session_id);
    expect(ids).toContain(clear);
    expect(ids).not.toContain(direct);
  });

  it("--verdict filters verdict turns and a verdict clears the prior gate cache", async () => {
    const id = `session-v-refine-${randomUUID()}`;
    const prior = makeState(id, { gate: "DIRECT" });
    const state: SessionState = {
      ...prior,
      status: "awaiting_parent",
      turn_history: [
        ...prior.turn_history,
        {
          kind: "verdict",
          run_id: "verdict-run",
          workflow: "founder",
          decision: {
            verdict: "REFINE",
            take: "tighten the plan",
            grounding_points: [],
            decision_rules: [],
            what_not_to_do: [],
          },
        },
      ],
    };
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const verdictRows = (await listSessions(storage, { verdict: "REFINE" }))._unsafeUnwrap();
    expect(verdictRows.find((row) => row.session_id === id)).toMatchObject({
      turn_kind: "verdict",
      workflow: "founder",
      gate: null,
      verdict: "REFINE",
    });
    const gateRows = (await listSessions(storage, { gate: "DIRECT" }))._unsafeUnwrap();
    expect(gateRows.map((row) => row.session_id)).not.toContain(id);
  });

  it("AND of status + gate (both native filter keys must match)", async () => {
    const both = `session-and-both-${randomUUID()}`;
    const onlyStatus = `session-and-status-${randomUUID()}`;
    expect((await appendSessionState(storage, client, both, makeState(both, { status: "active", gate: "REPAIR" }))).isOk()).toBe(true);
    expect((await appendSessionState(storage, client, onlyStatus, makeState(onlyStatus, { status: "active", gate: "CLEAR" }))).isOk()).toBe(true);

    const rows = (await listSessions(storage, { status: "active", gate: "REPAIR" }))._unsafeUnwrap();
    const ids = rows.map((r) => r.session_id);
    expect(ids).toContain(both);
    expect(ids).not.toContain(onlyStatus); // matches status but NOT gate → excluded by AND
  });

  it("excludes non-session threads (no schema_version discriminator in metadata)", async () => {
    const plain = `plain-${randomUUID()}`;
    const now = new Date();
    await mem.saveThread({ thread: { id: plain, resourceId: RESOURCE_ID, title: "plain chat", metadata: {}, createdAt: now, updatedAt: now } });
    await mem.saveMessages({
      messages: [{ id: randomUUID(), threadId: plain, resourceId: RESOURCE_ID, role: "assistant" as const, type: "text", createdAt: now, content: { format: 2 as const, parts: [{ type: "text" as const, text: "hello, not a session" }] } }],
    });

    const rows = (await listSessions(storage, {}))._unsafeUnwrap();
    expect(rows.map((r) => r.session_id)).not.toContain(plain);
  });

  it("fork-of column: a clone carries fork_of = source id", async () => {
    const src = `session-forksrc-${randomUUID()}`;
    expect((await appendSessionState(storage, client, src, makeState(src))).isOk()).toBe(true);
    const fork = randomUUID();
    await mem.cloneThread({ sourceThreadId: src, newThreadId: fork });
    expect((await rederiveCacheAfterFork(storage, fork)).isOk()).toBe(true); // fork gets the cache

    const rows = (await listSessions(storage, {}))._unsafeUnwrap();
    expect(rows.find((r) => r.session_id === src)?.fork_of).toBeNull();
    expect(rows.find((r) => r.session_id === fork)?.fork_of).toBe(src);
  });

  it("showSession renders a chronological timeline for a multi-SessionState thread + current state", async () => {
    const id = `session-show-${randomUUID()}`;
    const first = makeState(id, { status: "awaiting_parent", gate: "DIRECT" });
    const second: SessionState = {
      ...first,
      status: "awaiting_parent",
      turn_history: [
        ...first.turn_history,
        gateTurn("REPAIR", "repair the seam", ["d1"], "run-2"),
      ],
    };
    expect((await appendSessionState(storage, client, id, first)).isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 5)); // strictly increasing createdAt
    expect((await appendSessionState(storage, client, id, second)).isOk()).toBe(true);

    const view = (await showSession(storage, id))._unsafeUnwrap();
    // Two turns, oldest → newest.
    expect(
      view.timeline.map((t) => [
        t.status,
        t.turn.kind === "gate" ? t.turn.decision.gate : t.turn.kind,
      ]),
    ).toEqual([
      ["awaiting_parent", "DIRECT"],
      ["awaiting_parent", "REPAIR"],
    ]);
    expect(new Date(view.timeline[0]!.at).getTime()).toBeLessThan(new Date(view.timeline[1]!.at).getTime());
    // Current = the newest SessionState.
    expect(view.current.status).toBe("awaiting_parent");
    expect(view.current.latest_turn).toEqual(second.turn_history.at(-1));
    expect(view.current.workflow).toBe("edge-walk");
    expect(view.current.gate).toBe("REPAIR");
    expect(view.current.verdict).toBeNull();
    expect(view.current.open_directives.map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(view.current.open_directives[0]).toMatchObject({ id: "d1", severity: "blocking" });
    expect(view.current.findings_count).toBe(1);
    expect(view.current.finding_severities).toEqual(["high"]);
    expect(view.current.evidence_count).toBe(1);
    expect(view.current.revision_hash).toBe("revfixture");
    expect(view.lineage).toEqual([]); // not a clone
  });

  it("showSession uses the committed snapshot status when open directives keep a plain turn waiting", async () => {
    const id = `session-show-open-${randomUUID()}`;
    const first = makeState(id, { status: "awaiting_parent", gate: "DIRECT" });
    const plainTurn: SessionTurn = {
      kind: "plain",
      run_id: "plain-run",
      workflow: "code-search",
      summary: "the search completed but the earlier demand is still open",
    };
    const second: SessionState = {
      ...first,
      status: "awaiting_parent",
      turn_history: [...first.turn_history, plainTurn],
    };
    expect((await appendSessionState(storage, client, id, first)).isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await appendSessionState(storage, client, id, second)).isOk()).toBe(true);

    const view = (await showSession(storage, id))._unsafeUnwrap();
    expect(view.timeline.at(-1)).toEqual(
      expect.objectContaining({ status: "awaiting_parent", turn: plainTurn }),
    );
    expect(view.current.status).toBe("awaiting_parent");
  });

  it("showSession renders an overridden demanding gate with its committed complete status", async () => {
    const id = `session-show-override-${randomUUID()}`;
    const turn = gateTurn("DIRECT", "the parent accepted the residual risk", [], "override-run");
    const overridden: SessionState = {
      ...makeState(id),
      status: "complete",
      directives: [dir("d1", "rejected", "blocking", "close the seam")],
      turn_history: [turn],
      parent_events: [
        {
          type: "navi.override",
          reason: "accepted for this release",
          gate: "DIRECT",
          overridden_directive_ids: ["d1"],
          at: "2026-07-26T12:00:00.000Z",
        },
      ],
    };
    expect((await appendSessionState(storage, client, id, overridden)).isOk()).toBe(true);

    const view = (await showSession(storage, id))._unsafeUnwrap();
    expect(view.timeline).toEqual([
      expect.objectContaining({ status: "complete", turn }),
    ]);
    expect(view.current.status).toBe("complete");
  });

  it("showSession exposes a verdict turn without inventing a gate", async () => {
    const id = `session-verdict-show-${randomUUID()}`;
    const verdictTurn: SessionTurn = {
      kind: "verdict",
      run_id: "verdict-run",
      workflow: "founder",
      decision: {
        verdict: "REFINE",
        take: "narrow the migration",
        grounding_points: ["the diff spans two contracts"],
        decision_rules: ["separate storage from presentation"],
        what_not_to_do: [],
      },
    };
    const state: SessionState = {
      ...makeState(id),
      status: "awaiting_parent",
      directives: [],
      turn_history: [verdictTurn],
    };
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const view = (await showSession(storage, id))._unsafeUnwrap();
    expect(view.timeline).toEqual([
      expect.objectContaining({ status: "awaiting_parent", turn: verdictTurn }),
    ]);
    expect(view.current).toMatchObject({
      latest_turn: verdictTurn,
      workflow: "founder",
      gate: null,
      verdict: "REFINE",
    });
    expect(renderSessionShow(view)).toMatch(
      /verdict REFINE — narrow the migration/,
    );
  });

  it("showSession surfaces fork lineage (oldest → newest) on a clone", async () => {
    const src = `session-lin-src-${randomUUID()}`;
    expect((await appendSessionState(storage, client, src, makeState(src))).isOk()).toBe(true);
    const fork = randomUUID();
    await mem.cloneThread({ sourceThreadId: src, newThreadId: fork });
    expect((await rederiveCacheAfterFork(storage, fork)).isOk()).toBe(true);

    const view = (await showSession(storage, fork))._unsafeUnwrap();
    expect(view.lineage).toEqual([src, fork]); // ancestor chain incl. self, oldest first
  });

  it("showSession errs loudly on a thread that exists but has no SessionState", async () => {
    const id = `nonsession-${randomUUID()}`;
    const now = new Date();
    await mem.saveThread({ thread: { id, resourceId: RESOURCE_ID, title: "chat", metadata: {}, createdAt: now, updatedAt: now } });
    await mem.saveMessages({
      messages: [{ id: randomUUID(), threadId: id, resourceId: RESOURCE_ID, role: "assistant" as const, type: "text", createdAt: now, content: { format: 2 as const, parts: [{ type: "text" as const, text: "just chatting" }] } }],
    });
    const r = await showSession(storage, id);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toMatch(/not a session thread/);
  });

  it("showSession errs loudly on a missing thread", async () => {
    const r = await showSession(storage, `missing-${randomUUID()}`);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toMatch(/no such thread/);
  });

  it("showSession errs loudly (naming the message) on a malformed SessionState anywhere in history", async () => {
    const id = `session-malformed-${randomUUID()}`;
    // A valid older state, then a corrupt newer one (discriminator present, fails schema).
    expect((await appendSessionState(storage, client, id, makeState(id))).isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const badId = randomUUID();
    await mem.saveMessages({
      messages: [{ id: badId, threadId: id, resourceId: RESOURCE_ID, role: "assistant" as const, type: "text", createdAt: new Date(), content: { format: 2 as const, parts: [{ type: "text" as const, text: JSON.stringify({ session_id: id, schema_version: "navi.session.v2", status: "not-a-status" }) }], metadata: { kind: SESSION_STATE_KIND } } }],
    });
    const r = await showSession(storage, id);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toMatch(/malformed SessionState/);
    expect(r._unsafeUnwrapErr()).toContain(badId); // names the offending message
  });
});

// =========================================================================
// pure helpers (no db)
// =========================================================================

describe("session-view — parseListFilters + renderers (pure)", () => {
  it("rejects an unknown --status, listing the legal values", () => {
    const r = parseListFilters("nope", undefined);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toMatch(/--status must be one of: new, active, .* complete, failed \(got "nope"\)/);
  });

  it("rejects an unknown --gate, listing the legal values", () => {
    const r = parseListFilters(undefined, "nope");
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toMatch(/--gate must be one of: CLEAR, DIRECT, .* COMPLETE \(got "nope"\)/);
  });

  it("rejects an unknown --verdict, listing the legal values", () => {
    const r = parseListFilters(undefined, undefined, "maybe");
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr()).toBe(
      '--verdict must be one of: GO, REFINE, REJECT (got "maybe")',
    );
  });

  it("accepts valid values and undefined", () => {
    expect(parseListFilters("active", "DIRECT", "REFINE")._unsafeUnwrap()).toEqual({
      status: "active",
      gate: "DIRECT",
      verdict: "REFINE",
    });
    expect(parseListFilters(undefined, undefined, undefined)._unsafeUnwrap()).toEqual({});
  });

  it("renders an empty listing as rule + none-yet line (no moves block)", () => {
    const text = renderSessionList([]);
    expect(text).toMatch(/^── your sessions ──/);
    expect(text).toMatch(/none yet — a session starts with your first navi run/);
    expect(text).toMatch(/navi "where is configuration loaded\?"/);
    expect(text).not.toMatch(/── moves ──/);
  });

  it("renders a session-show view (timeline + current + lineage)", () => {
    const turn = gateTurn("DIRECT", "trace it", ["d1"], "run-show");
    const text = renderSessionShow({
      session_id: "c1",
      title: "wire repair",
      timeline: [{ at: "2026-07-19T01:00:00.000Z", status: "awaiting_parent", turn }],
      current: {
        status: "awaiting_parent",
        latest_turn: turn,
        workflow: "edge-walk",
        gate: "DIRECT",
        verdict: null,
        open_directives: [{ id: "d1", action: "trace it", severity: "blocking" }],
        findings_count: 1,
        finding_severities: ["high"],
        evidence_count: 1,
        revision_hash: "abc1234",
      },
      lineage: ["c0", "c1"],
    });
    expect(text).toMatch(new RegExp(`session ${handleOf("c1")} \\(c1\\) — wire repair`));
    expect(text).toMatch(/lineage:/);
    expect(text).toMatch(/└── .* \(c1\)/);
    expect(text).toMatch(/now: waiting on you · gate DIRECT — trace it · rev abc1234/);
    expect(text).toMatch(/open demands \(1\):/);
    expect(text).toMatch(/d1 \[blocking\] trace it/);
    expect(text).toMatch(/findings: 1 \(high\)/);
    expect(text).toMatch(/evidence: 1/);
  });

  it("renderStory: rule heading + timestamped beats + where-it-stands rule (plain off-TTY)", () => {
    const view: StoryView = {
      session_id: "c-story",
      title: "wire repair",
      task: "wire repairCallRecord()",
      beats: [
        {
          at: "2026-07-19T01:00:00.000Z",
          lines: ["DIRECT — first disposition", "asked: d1 — wire the call path"],
        },
        {
          at: "2026-07-19T02:30:00.000Z",
          lines: ["CLEAR — all directives met", "satisfied: d1", "evidence +1"],
        },
      ],
      outcome: "approved on the evidence (2 rounds)",
    };
    const text = renderStory(view);
    expect(text).toMatch(new RegExp(`^── the story of ${handleOf("c-story")} ──`));
    expect(text).toMatch(/\(session c-story\)/);
    expect(text).toMatch(/wire repair/);
    expect(text).toMatch(/2026-07-19 01:00 {2}DIRECT — first disposition/);
    expect(text).toMatch(/asked: d1 — wire the call path/);
    expect(text).toMatch(/2026-07-19 02:30 {2}CLEAR — all directives met/);
    expect(text).toMatch(/satisfied: d1/);
    expect(text).toMatch(/── where it stands ──/);
    expect(text).toMatch(/approved on the evidence \(2 rounds\)/);
    expect(text).toMatch(/legend: gates: DIRECT do this first/);
    // Off-TTY (tests): no ANSI on the approved outcome.
    expect(text).not.toMatch(/\x1b\[/);
  });

  it("renderStory: OVERRIDE line present; title falls back to task when empty", () => {
    const view: StoryView = {
      session_id: "c-ov",
      title: "",
      task: "ship despite open gate",
      beats: [
        {
          at: "2026-07-20T10:15:00.000Z",
          lines: [
            '⚠ OVERRIDE — proceeded against DIRECT: "parent accepts residual risk"',
            "rejected: d1",
          ],
        },
      ],
      outcome: "shipped without approval — 1 demand overridden",
    };
    const text = renderStory(view);
    expect(text).toMatch(new RegExp(`^── the story of ${handleOf("c-ov")} ──`));
    expect(text).toMatch(/ship despite open gate/);
    expect(text).toMatch(/⚠ OVERRIDE — proceeded against DIRECT/);
    expect(text).toMatch(/── where it stands ──/);
    expect(text).toMatch(/shipped without approval — 1 demand overridden/);

  });

  it("handleOf is deterministic and distinct across a batch of ids", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `session-handle-${i}-${randomUUID()}`);
    const handles = ids.map(handleOf);
    // same id → same handle
    expect(handleOf(ids[0]!)).toBe(handles[0]);
    expect(handleOf(ids[0]!)).toBe(handleOf(ids[0]!));
    // adj-noun shape
    expect(handles[0]).toMatch(/^[a-z]+-[a-z]+$/);
    // high distinctness across the batch (allow rare collision, but expect most unique)
    expect(new Set(handles).size).toBeGreaterThanOrEqual(18);
  });

  it("renderSessionList: two-line rows, combined status·gate, open suffix, moves block", () => {
    const id = "a6ff8119-cfda-4016-a2e5-632d989638ae";
    const handle = handleOf(id);
    // Fixed `now` so relTime is deterministic (5h ago).
    const now = Date.parse("2026-07-24T17:00:00.000Z");
    const text = renderSessionList(
      [
        {
          session_id: id,
          title: "a long title that stays full",
          status: "awaiting_parent",
          turn_kind: "gate",
          workflow: "edge-walk",
          gate: "DIRECT",
          verdict: null,
          open_directive_count: 2,
          revision_hash: "abcdef12",
          updatedAt: "2026-07-24T12:00:00.000Z",
          fork_of: null,
          archived: false,
        },
      ],
      { all: false },
      now,
    );
    expect(text).toMatch(/^── your sessions ──/);
    expect(text).toMatch(/1 shown · newest first/);
    expect(text).toMatch(new RegExp(handle));
    expect(text).not.toMatch(id); // full uuid not in the human table
    expect(text).not.toMatch(/abcdef12/); // rev dropped from human list
    expect(text).toMatch(/waiting on you · DIRECT/);
    expect(text).toMatch(/5h ago · 2 open/);
    expect(text).toMatch(/a long title that stays full/);
    expect(text).toMatch(/── moves ──/);
    expect(text).toMatch(/legend:     gates: DIRECT do this first/);
    expect(text).toMatch(/what's a session\?/);
    expect(text).toMatch(new RegExp(`read one:   navi story ${handle}`));
    expect(text).toMatch(new RegExp(`tidy up:    navi session archive ${handle}`));
  });

  it("renderSessionList hides archived by default; --all shows them with · archived + meta counts", () => {
    const activeId = "active-session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const archivedId = "archived-session-bbbb-cccc-dddd-eeee-ffffffffffff";
    const now = Date.parse("2026-07-24T17:00:00.000Z");
    const rows = [
      {
        session_id: activeId,
        title: "live work",
        status: "active" as const,
        turn_kind: "gate" as const,
        workflow: "edge-walk",
        gate: "DIRECT" as const,
        verdict: null,
        open_directive_count: 1,
        revision_hash: "deadbeef",
        updatedAt: "2026-07-24T12:00:00.000Z",
        fork_of: null,
        archived: false,
      },
      {
        session_id: archivedId,
        title: "archived work",
        status: "complete" as const,
        turn_kind: "gate" as const,
        workflow: "edge-walk",
        gate: "COMPLETE" as const,
        verdict: null,
        open_directive_count: 0,
        revision_hash: "cafebabe",
        updatedAt: "2026-07-20T12:00:00.000Z",
        fork_of: null,
        archived: true,
      },
    ];
    const hidden = renderSessionList(rows, { all: false }, now);
    expect(hidden).toMatch(/^── your sessions ──/);
    expect(hidden).toMatch(/1 shown · 1 archived \(navi session list --all\) · newest first/);
    expect(hidden).toMatch(/live work/);
    expect(hidden).not.toMatch(/archived work/);
    expect(hidden).toMatch(new RegExp(`navi story ${handleOf(activeId)}`));

    const all = renderSessionList(rows, { all: true }, now);
    expect(all).toMatch(/2 shown · newest first/);
    expect(all).toMatch(/live work/);
    expect(all).toMatch(/archived work/);
    // Marker is a dim suffix on the archived row's line 1.
    expect(all).toMatch(/· archived/);
  });
});

// =========================================================================
// storySession — multi-state journeys (temp db, model-free)
// =========================================================================

describe("session-view — storySession (temp db, model-free)", () => {
  let DIR: string;
  let storage: LibSQLStore;
  let client: Client;

  beforeAll(async () => {
    DIR = mkdtempSync(join(tmpdir(), "navi-session-story-"));
    const url = `file:${join(DIR, "story.db")}`;
    storage = new LibSQLStore({ id: "test-story", url });
    client = createClient({ url, timeout: 5_000 });
    await storage.init();
  });

  afterAll(async () => {
    client.close();
    await storage.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("beats show gate + asked/satisfied lines in chronological order; CLEAR → approved", async () => {
    const id = `story-clear-${randomUUID()}`;
    const s1 = storyState(id, {
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "needs a live call path", ["d1"], "run-1")],
      directives: [dir("d1", "open", "blocking", "wire the call path")],
      evidence: [],
    });
    const s2 = storyState(id, {
      status: "clear",
      turn_history: [
        gateTurn("DIRECT", "needs a live call path", ["d1"], "run-1"),
        gateTurn("CLEAR", "call path proven on the revision", [], "run-2"),
      ],
      directives: [dir("d1", "satisfied", "blocking", "wire the call path")],
      evidence: [{ kind: "source_location", uri: "src/handler.ts", line_start: 10, line_end: 20, claim_supported: true }],
    });
    expect((await appendSessionState(storage, client, id, s1)).isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await appendSessionState(storage, client, id, s2)).isOk()).toBe(true);

    const view = (await storySession(storage, id))._unsafeUnwrap();
    expect(view.session_id).toBe(id);
    expect(view.task).toBe(s1.task);
    expect(view.beats).toHaveLength(2);

    // Beat 0: first state vs empty — new gate + asked open directive.
    const b0 = view.beats[0]!.lines.join("\n");
    expect(b0).toMatch(/DIRECT — needs a live call path/);
    expect(b0).toMatch(/asked: d1 — wire the call path/);

    // Beat 1: CLEAR gate, d1 open→satisfied, evidence +1.
    const b1 = view.beats[1]!.lines.join("\n");
    expect(b1).toMatch(/CLEAR — call path proven on the revision/);
    expect(b1).toMatch(/satisfied: d1/);
    expect(b1).toMatch(/evidence \+1/);
    // Order: gate before satisfied before evidence (diff composition order).
    expect(b1.indexOf("CLEAR")).toBeLessThan(b1.indexOf("satisfied: d1"));
    expect(b1.indexOf("satisfied: d1")).toBeLessThan(b1.indexOf("evidence +1"));

    expect(view.outcome).toBe("approved on the evidence (2 rounds)");

    // Human render carries the same journey.
    const text = renderStory(view);
    expect(text).toMatch(/── the story of /);
    expect(text).toMatch(/DIRECT — needs a live call path/);
    expect(text).toMatch(/satisfied: d1/);
    expect(text).toMatch(/── where it stands ──/);
    expect(text).toMatch(/approved on the evidence \(2 rounds\)/);
  });

  it("counts rounds in the approving gate lane, not every run on the session", async () => {
    const id = `story-rounds-${randomUUID()}`;
    const state = storyState(id, {
      status: "clear",
      turn_history: [
        {
          kind: "plain",
          run_id: "run-plain-1",
          workflow: "code-search",
          summary: "located the relevant files",
        },
        {
          kind: "failure",
          run_id: "run-failed-1",
          workflow: "web-search",
          reason: "provider unavailable",
        },
        {
          ...gateTurn("DIRECT", "a different check remains open", [], "run-other-gate"),
          workflow: "pre-pr-review",
        },
        {
          ...gateTurn("CLEAR", "this check is proven", [], "run-clear"),
          workflow: "edge-walk",
        },
      ],
      directives: [],
    });
    expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);

    const view = (await storySession(storage, id))._unsafeUnwrap();
    expect(view.outcome).toBe("approved on the evidence (1 round)");
  });

  it("story shortens a long COMPLETE/gate reason at a clause boundary (never mid-word)", async () => {
    // COMPLETE briefs can be long; excerpt them via
    // style.shortClause — same cut as catalog when-to-use labels.
    const id = `story-long-${randomUUID()}`;
    const longReason =
      "The handler never reaches repairCallRecord because the validation short-circuit returns before the repair path is considered, which means dirty records stay dirty end-to-end and the integration test that only exercises the happy path cannot prove the seam is closed.";
    expect(longReason.length).toBeGreaterThan(120);
    const s1 = storyState(id, {
      status: "complete",
      turn_history: [gateTurn("COMPLETE", longReason, [], "run-1")],
      directives: [dir("d1", "satisfied", "blocking", "wire the call path")],
    });
    expect((await appendSessionState(storage, client, id, s1)).isOk()).toBe(true);
    const view = (await storySession(storage, id))._unsafeUnwrap();
    const reasonLine = view.beats[0]!.lines.find((l) => l.startsWith("COMPLETE — "));
    expect(reasonLine).toBeTruthy();
    const excerpt = reasonLine!.slice("COMPLETE — ".length);
    // Shortened: not the full paragraph, never mid-word.
    expect(excerpt.length).toBeLessThan(longReason.length);
    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(longReason.startsWith(excerpt.replace(/…$/, ""))).toBe(true);
    // If ellipsis was used, the char before it is not a partial mid-word cut
    // into a longer source word (word-boundary or clause-boundary only).
    expect(excerpt).toMatch(/([,;:]|—|\w…?)$/);
    const text = renderStory(view);
    expect(text).toContain(excerpt);
    expect(text).not.toContain(longReason);
  });

  it("story parent: line is a short excerpt — never the full verbatim answer, never mid-word", async () => {
    // Long parent answers stay visible as shortened story beats.
    const id = `story-parent-${randomUUID()}`;
    const longAnswer =
      "We need a handoff seam because the parent has already decided the direction, and the remaining work is only to name the concrete change in one sentence so the next gate can clear without re-litigating scope, which is why this answer deliberately runs long enough to prove the excerpt path fires and never slices a word in half.";
    expect(longAnswer.length).toBeGreaterThan(120);
    const s1 = storyState(id, {
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "needs the real ask", ["d1"], "run-1")],
      directives: [dir("d1", "open", "blocking", "state the change in one sentence")],
      parent_events: [{ task: longAnswer }],
    });
    expect((await appendSessionState(storage, client, id, s1)).isOk()).toBe(true);
    const view = (await storySession(storage, id))._unsafeUnwrap();
    const parentLine = view.beats[0]!.lines.find((l) => l.startsWith("parent: "));
    expect(parentLine).toBeTruthy();
    // Still a parent: line (narrative preserved) — just not the full wall.
    expect(parentLine).toMatch(/^parent: /);
    const excerpt = parentLine!.slice("parent: ".length);
    expect(excerpt.length).toBeLessThan(longAnswer.length);
    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(longAnswer.startsWith(excerpt.replace(/…$/, ""))).toBe(true);
    // Never mid-word: body before optional ellipsis is a prefix of the source.
    const body = excerpt.endsWith("…") ? excerpt.slice(0, -1) : excerpt;
    expect(longAnswer.startsWith(body)).toBe(true);
    // Last char of body is end-of-word or clause punct — not a torn word.
    expect(body).toMatch(/\S$/);
    expect(longAnswer.charAt(body.length)).toMatch(/^(\s|$|[,.;:—])/);

    const text = renderStory(view);
    expect(text).toContain("parent: ");
    expect(text).toContain(excerpt);
    expect(text).not.toContain(longAnswer);
  });

  it("override event → ⚠ OVERRIDE beat + shipped without approval outcome", async () => {
    const id = `story-ov-${randomUUID()}`;
    const s1 = storyState(id, {
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "blocking seam open", ["d1"], "run-1")],
      directives: [dir("d1", "open", "blocking", "close the seam")],
    });
    const s2 = storyState(id, {
      status: "awaiting_parent",
      turn_history: [
        gateTurn("DIRECT", "blocking seam open", ["d1"], "run-1"),
        gateTurn("DIRECT", "parent accepted the residual risk", [], "run-2"),
      ],
      directives: [dir("d1", "rejected", "blocking", "close the seam")],
      parent_events: [
        {
          type: "navi.override",
          reason: "parent accepts residual risk for this release",
          gate: "DIRECT",
          overridden_directive_ids: ["d1"],
          at: "2026-07-20T12:00:00.000Z",
        },
      ],
    });
    expect((await appendSessionState(storage, client, id, s1)).isOk()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await appendSessionState(storage, client, id, s2)).isOk()).toBe(true);

    const view = (await storySession(storage, id))._unsafeUnwrap();
    expect(view.beats).toHaveLength(2);
    const b1 = view.beats[1]!.lines.join("\n");
    expect(b1).toMatch(/⚠ OVERRIDE — proceeded against DIRECT: "parent accepts residual risk for this release"/);
    expect(b1).toMatch(/rejected: d1/);
    expect(view.outcome).toBe("shipped without approval — 1 demand overridden");

    const text = renderStory(view);
    expect(text).toMatch(/⚠ OVERRIDE — proceeded against DIRECT/);
    expect(text).toMatch(/── where it stands ──/);
    expect(text).toMatch(/shipped without approval — 1 demand overridden/);

    const s3 = storyState(id, {
      status: "clear",
      turn_history: [
        ...s2.turn_history,
        gateTurn("CLEAR", "the residual risk was later closed", [], "run-3"),
      ],
      directives: s2.directives,
      parent_events: s2.parent_events,
    });
    expect((await appendSessionState(storage, client, id, s3)).isOk()).toBe(true);
    const resolved = (await storySession(storage, id))._unsafeUnwrap();
    expect(
      resolved.beats
        .flatMap((beat) => beat.lines)
        .filter((line) => line.includes("⚠ OVERRIDE")),
    ).toHaveLength(1);
    expect(resolved.outcome).toBe("approved on the evidence (3 rounds)");
  });

  it("open directives remaining → still open outcome", async () => {
    const id = `story-open-${randomUUID()}`;
    const s1 = storyState(id, {
      status: "awaiting_parent",
      turn_history: [gateTurn("DIRECT", "more work", ["d1", "d3"], "run-1")],
      directives: [
        dir("d1", "open", "blocking", "first ask"),
        dir("d3", "open", "blocking", "second ask"),
      ],
    });
    expect((await appendSessionState(storage, client, id, s1)).isOk()).toBe(true);
    const view = (await storySession(storage, id))._unsafeUnwrap();
    expect(view.outcome).toBe("still open — waiting on: d1, d3");
    expect(view.beats[0]!.lines.some((l) => l.startsWith("asked: d1"))).toBe(true);
    expect(view.beats[0]!.lines.some((l) => l.startsWith("asked: d3"))).toBe(true);
  });

  it.each([
    [
      "verdict",
      {
        kind: "verdict",
        run_id: "verdict-run",
        workflow: "founder",
        decision: {
          verdict: "REJECT",
          take: "the premise is wrong",
          grounding_points: [],
          decision_rules: [],
          what_not_to_do: [],
        },
      } satisfies SessionTurn,
      "verdict REJECT — the premise is wrong",
      "verdict REJECT — stop",
      "complete",
    ],
    [
      "plain",
      {
        kind: "plain",
        run_id: "plain-run",
        workflow: "code-search",
        summary: "the owner is src/config.ts",
      } satisfies SessionTurn,
      "code-search complete — the owner is src/config.ts",
      "code-search complete",
      "active",
    ],
    [
      "failure",
      {
        kind: "failure",
        run_id: "failure-run",
        workflow: "code-search",
        reason: "provider timed out",
      } satisfies SessionTurn,
      "code-search failed — provider timed out",
      "code-search failed — provider timed out",
      "failed",
    ],
  ] as const)(
    "story renders a %s turn in its own vocabulary",
    async (_name, turn, line, outcome, status) => {
      const id = `story-turn-${randomUUID()}`;
      const state = storyState(id, {
        status,
        turn_history: [turn],
        directives: [],
      });
      expect((await appendSessionState(storage, client, id, state)).isOk()).toBe(true);
      const view = (await storySession(storage, id))._unsafeUnwrap();
      expect(view.beats[0]!.lines).toContain(line);
      expect(view.outcome).toBe(outcome);
    },
  );

  it("resolveSessionToken: exact id, handle hit, zero, happy path", async () => {
    const occupied = new Set(
      (await listSessions(storage, {}))._unsafeUnwrap().map(({ session_id }) =>
        handleOf(session_id),
      ),
    );
    let id = `story-tok-${randomUUID()}`;
    while (occupied.has(handleOf(id))) id = `story-tok-${randomUUID()}`;
    expect((await appendSessionState(storage, client, id, storyState(id, {}))).isOk()).toBe(true);
    const byId = (await resolveSessionToken(storage, id))._unsafeUnwrap();
    expect(byId).toBe(id);
    const h = handleOf(id);
    const byHandle = (await resolveSessionToken(storage, h))._unsafeUnwrap();
    expect(byHandle).toBe(id);
    const miss = await resolveSessionToken(storage, "no-such-handle-zzzz");
    expect(miss.isErr()).toBe(true);
    expect(miss._unsafeUnwrapErr()).toMatch(/no session named "no-such-handle-zzzz"/);
    expect(miss._unsafeUnwrapErr()).toMatch(/navi session list/);
  });
});

// =========================================================================
// (B) CLI verbs as subprocesses against a per-suite temp NAVI_DB
// =========================================================================

describe("session-view — CLI verbs (subprocess, per-suite temp NAVI_DB)", () => {
  const ROOT = process.cwd();
  const TSX = join(ROOT, "node_modules/.bin/tsx");
  const CLI = join(ROOT, "src/cli.ts");
  // One temp sqlite for the whole describe: seed + every CLI spawn share it, so
  // sessions persist across calls, and the real cwd navi.db is never opened.
  const suiteDir = mkdtempSync(join(tmpdir(), "navi-session-view-"));
  const NAVI_DB = `file:${join(suiteDir, "navi.db")}`;
  let storage: LibSQLStore;
  let client: Client;
  let mem: Awaited<ReturnType<LibSQLStore["getStore"]>> & object;
  const sources = new Set<string>();
  const created = new Set<string>();

  function navi(args: string[]) {
    const r = spawnSync(TSX, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NAVI_DB },
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  beforeAll(async () => {
    storage = new LibSQLStore({ id: "navi", url: NAVI_DB });
    client = createClient({ url: NAVI_DB, timeout: 5_000 });
    await storage.init();
    const store = await storage.getStore("memory");
    if (!store) throw new Error("memory store unavailable");
    mem = store as typeof mem;
  });

  afterAll(async () => {
    // Delete clones of the test sources by provenance.
    // then every named id, then the throwaway dir itself.
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

  it("session list --json includes a seeded session with the right fields; --status filters it", async () => {
    const id = `session-list-${randomUUID()}`;
    sources.add(id);
    created.add(id);
    expect((await appendSessionState(storage, client, id, makeState(id, { status: "blocked", gate: "BLOCKED" }))).isOk()).toBe(true);

    const all = navi(["session", "list", "--json"]);
    expect(all.code).toBe(0);
    const rows = JSON.parse(all.stdout) as { session_id: string; status: string; gate: string }[];
    const row = rows.find((r) => r.session_id === id);
    expect(row).toMatchObject({ status: "blocked", gate: "BLOCKED" });

    // --status maps onto the native filter: a matching value includes it, a
    // non-matching value excludes it.
    const hit = navi(["session", "list", "--status", "blocked", "--json"]);
    expect(hit.code).toBe(0);
    expect((JSON.parse(hit.stdout) as { session_id: string }[]).map((r) => r.session_id)).toContain(id);
    const miss = navi(["session", "list", "--status", "clear", "--json"]);
    expect((JSON.parse(miss.stdout) as { session_id: string }[]).map((r) => r.session_id)).not.toContain(id);
  });

  it("session list --json flushes output larger than a pipe buffer", async () => {
    const now = new Date();
    const ids = Array.from({ length: 240 }, () => `session-large-${randomUUID()}`);
    for (const id of ids) {
      created.add(id);
      await mem.saveThread({
        thread: {
          id,
          resourceId: RESOURCE_ID,
          title: `large-output-${id}-${"x".repeat(160)}`,
          metadata: {
            schema_version: "navi.session.v2",
            status: "active",
            turn_kind: "plain",
            workflow: "code-search",
            gate: null,
            verdict: null,
            open_directive_ids: [],
            open_directive_count: 0,
            revision_hash: null,
          },
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    const result = navi(["session", "list", "--json"]);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(64 * 1024);
    const rows = JSON.parse(result.stdout) as { session_id: string }[];
    expect(ids.every((id) => rows.some((row) => row.session_id === id))).toBe(true);
  });

  it("session show <id> --json renders timeline + current for a real session thread", async () => {
    const id = `session-show-${randomUUID()}`;
    sources.add(id);
    created.add(id);
    expect((await appendSessionState(storage, client, id, makeState(id))).isOk()).toBe(true);

    const r = navi(["session", "show", id, "--json"]);
    expect(r.code).toBe(0);
    const view = JSON.parse(r.stdout) as { timeline: unknown[]; current: { open_directives: unknown[] }; lineage: string[] };
    expect(view.timeline.length).toBe(1);
    expect(view.current.open_directives.length).toBe(2);
    expect(view.lineage).toEqual([]);
  });

  it("session show on a fork shows lineage (source → fork)", async () => {
    const src = `session-fork-source-${randomUUID()}`;
    sources.add(src);
    created.add(src);
    expect((await appendSessionState(storage, client, src, makeState(src))).isOk()).toBe(true);
    // Fork through the real CLI run-path fork? Simpler + model-free: clone directly,
    // then render — the CLI show verb reads the same lineage the run-path fork writes.
    const fork = `session-fork-${randomUUID()}`;
    created.add(fork);
    await mem.cloneThread({ sourceThreadId: src, newThreadId: fork });
    expect((await rederiveCacheAfterFork(storage, fork)).isOk()).toBe(true);

    const r = navi(["session", "show", fork, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { lineage: string[] }).lineage).toEqual([src, fork]);
    // human render surfaces the lineage line too (handle + full id).
    const human = navi(["session", "show", fork]);
    expect(human.stdout).toMatch(/lineage:/);
    expect(human.stdout).toContain(src);
    expect(human.stdout).toContain(fork);
  });

  it("session show on a non-session thread errs loudly → exit 1", async () => {
    const id = `non-session-${randomUUID()}`;
    created.add(id);
    const now = new Date();
    await mem.saveThread({ thread: { id, resourceId: RESOURCE_ID, title: "chat", metadata: {}, createdAt: now, updatedAt: now } });
    await mem.saveMessages({
      messages: [{ id: randomUUID(), threadId: id, resourceId: RESOURCE_ID, role: "assistant" as const, type: "text", createdAt: now, content: { format: 2 as const, parts: [{ type: "text" as const, text: "chatting" }] } }],
    });
    const r = navi(["session", "show", id]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not a session thread/);
    expect(r.stdout).toBe("");
  });

  it("an unknown --status value errs loudly, listing legal values → exit 1 (keyless, no seed)", () => {
    const r = navi(["session", "list", "--status", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--status must be one of: new, active/);
    expect(r.stdout).toBe("");
  });

  it("an unknown --verdict value errs loudly without translating it into a gate", () => {
    const r = navi(["session", "list", "--verdict", "CLEAR"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--verdict must be one of: GO, REFINE, REJECT/);
    expect(r.stdout).toBe("");
  });

  it("navi story with no id errs loudly → exit 1 and points at session list", () => {
    const r = navi(["story"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/navi story: missing session id — pick one from: navi session list/);
    expect(r.stderr).toMatch(/pick one from: navi session list/);
    expect(r.stdout).toBe("");
  });

  it("navi story <id> --json emits StoryView for a seeded session", async () => {
    const id = `session-story-${randomUUID()}`;
    sources.add(id);
    created.add(id);
    expect(
      (
        await appendSessionState(
          storage,
          client,
          id,
          storyState(id, {
            status: "clear",
            turn_history: [gateTurn("CLEAR", "done", [], "run-1")],
            directives: [dir("d1", "satisfied", "blocking", "done")],
            evidence: [{ kind: "source_location", uri: "src/a.ts", claim_supported: true }],
          }),
        )
      ).isOk(),
    ).toBe(true);

    const r = navi(["story", id, "--json"]);
    expect(r.code).toBe(0);
    const view = JSON.parse(r.stdout) as StoryView;
    expect(view.session_id).toBe(id);
    expect(view.beats.length).toBeGreaterThanOrEqual(1);
    expect(view.outcome).toBe("approved on the evidence (1 round)");
  });

  it("navi story <handle> resolves the word handle; nonsense token is friendly", async () => {
    // This suite already seeds 240 sessions for the large-output test. Handles
    // have 3,072 possible adjective/noun pairs, so choosing this id blindly made
    // the subprocess test fail whenever it collided with one of those sessions.
    // Pick a genuinely unoccupied handle before asserting one-to-one resolution.
    const occupied = new Set(
      (await listSessions(storage, {}))._unsafeUnwrap().map(({ session_id }) =>
        handleOf(session_id),
      ),
    );
    let id = `session-story-human-${randomUUID()}`;
    while (occupied.has(handleOf(id))) id = `session-story-human-${randomUUID()}`;
    sources.add(id);
    created.add(id);
    expect(
      (
        await appendSessionState(
          storage,
          client,
          id,
          storyState(id, {
            status: "clear",
            turn_history: [gateTurn("CLEAR", "done", [], "run-1")],
            directives: [dir("d1", "satisfied", "blocking", "done")],
          }),
        )
      ).isOk(),
    ).toBe(true);

    const h = handleOf(id);
    const r = navi(["story", h, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as StoryView).session_id).toBe(id);

    const bad = navi(["story", "nonsense-token-xyz"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/navi story: "nonsense-token-xyz" is not a session — pick one from: navi session list/);
    expect(bad.stderr).not.toMatch(/no such thread/);
  });
});
