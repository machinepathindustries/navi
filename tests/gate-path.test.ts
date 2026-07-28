import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";
import { readPriorSessionState, memoryFor, SESSION_STATE_KIND } from "../src/session-state.ts";

// Keyless integration coverage for the shape-keyed gate
// path proven end to end as REAL CLI subprocesses against a per-suite temp
// NAVI_DB (process.env.NAVI_DB) the CLI also opens, on a model-free command
// fixture whose final step echoes a GateDecision. Proves: GateDecision detection,
// the exit map (0/2/3 via exitForGate), the gate-aware next block, the
// envelope fields, SessionState persistence (including its exact marker and `navi session list`
// visibility), the -t continuation (turn_history/parent_events grow), the
// liberal-extraction loud-fail, and distinct verdict persistence.
// Seed + every CLI spawn share one throwaway sqlite so sessions persist across the
// suite without ever touching the real navi.db.

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");
// The self-steering next.command prefix is DERIVED from navi's own invocation
// from src/invocation.ts: these subprocesses are `${TSX} ${CLI}`,
// so the emitted continuation command carries exactly that executable prefix — no
// longer an invocation tied to a different runtime.
const PREFIX = `${TSX} ${CLI}`;
const GATE = "tests/fixtures/gate-command/action.yaml";
const BAD = "tests/fixtures/gate-command/bad-directive/action.yaml";
const HYBRID = "tests/fixtures/hybrid-decision/action.yaml";
const JSON_CMD = "tests/fixtures/json-command/action.yaml";
const RESOURCE_ID = "cli";
const FIXTURE_REV = "fixturerev"; // every gate-command SessionState carries this
const suiteDir = mkdtempSync(join(tmpdir(), "navi-gate-path-"));
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

type Envelope = {
  session_id: string;
  gate: string | null;
  verdict: string | null;
  status: string;
  confidence: number | null;
  surface_map: { revision_hash?: string } | null;
  directives: unknown[];
  findings: unknown[];
  evidence: unknown[];
  next: { instruction: string; return: string[]; command: string | null };
};

let storage: LibSQLStore;
let client: Client;
let mem: Awaited<ReturnType<LibSQLStore["getStore"]>> & object;
const created = new Set<string>();

beforeAll(async () => {
  storage = new LibSQLStore({ id: "navi", url: NAVI_DB });
  client = createClient({ url: NAVI_DB, timeout: 5_000 });
  await storage.init(); // the raw store does not create tables automatically
  const store = await storage.getStore("memory");
  if (!store) throw new Error("memory store unavailable");
  mem = store as typeof mem;
});

async function createContinuationTarget(id: string): Promise<void> {
  const now = new Date();
  await mem.saveThread({
    thread: {
      id,
      resourceId: RESOURCE_ID,
      title: "",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
  });
}

afterAll(async () => {
  const { threads } = await mem.listThreads({ filter: { resourceId: RESOURCE_ID }, perPage: false });
  for (const t of threads) {
    if ((t.metadata as { revision_hash?: unknown } | undefined)?.revision_hash === FIXTURE_REV)
      await mem.deleteThread({ threadId: t.id }).catch(() => {});
  }
  for (const id of created) await mem.deleteThread({ threadId: id }).catch(() => {});
  client.close();
  await storage.close();
  rmSync(suiteDir, { recursive: true, force: true });
});

// Run the gate fixture with a chosen gate (positional arg) and capture the envelope +
// its minted session for cleanup. Asserts the run parsed to an envelope on stdout.
function gateRun(gate: string, extra: string[] = []): { code: number | null; env: Envelope; stderr: string } {
  const r = navi(["run", GATE, gate, "--json", ...extra]);
  const env = JSON.parse(r.stdout) as Envelope;
  created.add(env.session_id);
  return { code: r.code, env, stderr: r.stderr };
}

// --- 1. exit map 0/2/3, gate + status derived from the GateDecision -----------
describe("gate-command — exit map + derived gate/status (keyless, real CLI)", () => {
  it("DIRECT → exit 0, gate DIRECT, status awaiting_parent", () => {
    const { code, env } = gateRun("DIRECT");
    expect(code).toBe(0);
    expect(env.gate).toBe("DIRECT");
    expect(env.status).toBe("awaiting_parent");
  });

  it("BLOCKED → exit 2, gate BLOCKED, status blocked", () => {
    const { code, env } = gateRun("BLOCKED");
    expect(code).toBe(2);
    expect(env.gate).toBe("BLOCKED");
    expect(env.status).toBe("blocked");
  });

  it("ESCALATE → exit 3, gate ESCALATE, status escalated", () => {
    const { code, env } = gateRun("ESCALATE");
    expect(code).toBe(3);
    expect(env.gate).toBe("ESCALATE");
    expect(env.status).toBe("escalated");
  });

  it("CLEAR and COMPLETE → exit 0", () => {
    expect(gateRun("CLEAR").code).toBe(0);
    const comp = gateRun("COMPLETE");
    expect(comp.code).toBe(0);
    expect(comp.env.status).toBe("complete");
  });
});

// --- 2. whisper envelope fields + gate-aware next block -----------------------
describe("gate-command — whisper envelope fields + gate-aware next", () => {
  it("populates surface_map/directives/findings/confidence/evidence from the gate output", () => {
    const { env } = gateRun("DIRECT");
    expect(env.confidence).toBe(0.62);
    expect(env.directives).toHaveLength(1);
    expect(env.findings).toHaveLength(1);
    expect(env.surface_map).toMatchObject({ revision_hash: FIXTURE_REV });
    expect(env.evidence).toEqual([]); // no stdin evidence returned on this run
  });

  it("DIRECT next = the blocking directive's action + required_evidence + the shape-mirrored continuation", () => {
    const { env } = gateRun("DIRECT");
    expect(env.next.instruction).toMatch(/produce a call path from an entry point to repairCallRecord\(\)/);
    expect(env.next.return).toEqual(["call_path"]);
    // gate-command's first arg is string-typed `gate` → positional '<gate>' placeholder,
    // no --json (prose/positional grammar, not the edge-walk --stdin transport).
    expect(env.next.command).toBe(`${PREFIX} run ${GATE} '<gate>' -t ${env.session_id}`);
  });

  it("CLEAR proceeds-and-checkpoints; BLOCKED surfaces to the human — both keep the continuation command", () => {
    const clear = gateRun("CLEAR");
    expect(clear.env.next.instruction).toMatch(/CLEAR — proceed/);
    expect(clear.env.next.command).toBe(`${PREFIX} run ${GATE} '<gate>' -t ${clear.env.session_id}`);
    const blocked = gateRun("BLOCKED");
    expect(blocked.env.next.instruction).toMatch(/BLOCKED — surface to the human/);
    expect(blocked.env.next.command).toContain(`'<gate>' -t ${blocked.env.session_id}`);
  });

  it("COMPLETE has a null next.command", () => {
    expect(gateRun("COMPLETE").env.next.command).toBeNull();
  });

  it("human (non --json) gate render: question block + next command, not raw JSON", () => {
    // Human path is shape-keyed (gate + confidence) — no GateDecision JSON dump.
    // Continuation still appears under `── next ──`; full object is `--json` only.
    const r = navi(["run", GATE, "DIRECT"]);
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toContain("── what it's asking ──");
    expect(out).toContain("── next ──");
    expect(out).toMatch(new RegExp(`${PREFIX} run ${GATE} '<gate>' -t `));
    expect(out).toContain("full detail: --json");
    expect(out).not.toContain("result:");
    expect(out).not.toContain("completion_criteria");
    // capture the minted session for cleanup (human render prints the session in the command).
    const cid = out.match(/-t (\S+)/)?.[1];
    if (cid) created.add(cid);
  });
});

// --- 2b. continuationCommand mirrors shape.args (json vs string transport) ----
// Shape-keyed: the first declared arg's type picks the continuation grammar. A
// json-typed first arg uses `--json --stdin -t <id>`; a string-typed first arg
// yields a positional `'<name>'`
// placeholder with no --json (conversational gated flows).
describe("gate-command — continuationCommand is shape-keyed (json vs string first arg)", () => {
  it("string-typed first arg → positional '<name>' placeholder, no --json/--stdin", () => {
    const { env } = gateRun("DIRECT");
    expect(env.next.command).toBe(`${PREFIX} run ${GATE} '<gate>' -t ${env.session_id}`);
    expect(env.next.command).not.toContain("--json");
    expect(env.next.command).not.toContain("--stdin");
  });

  it("json-typed first arg → exact `--json --stdin -t <id>`", () => {
    // Model-free temp fixture: json-typed first arg + GateDecision final output so the
    // whisper path fires. Same tmpWorkflow construction style as cli.test.ts's
    // --stdin binding suite.
    const dir = mkdtempSync(join(tmpdir(), "navi-gate-json-arg-"));
    const path = join(dir, "action.yaml");
    writeFileSync(
      path,
      `name: gate-json-arg
description: Model-free fixture — json-typed first arg emitting a GateDecision.
args:
  input:
    type: json
    required: true
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"DIRECT","reason":"json-arg continuation proof","blocking_directive_ids":[],"non_blocking_risks":[],"human_escalation":null,"confidence":0.5}'
`,
    );
    try {
      const r = navi(["run", path, "--stdin", "--json"], JSON.stringify({ task: "prove json arm" }));
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      // The edge-walk continuation grammar is exact.
      expect(env.next.command).toBe(`${PREFIX} run ${path} --json --stdin -t ${env.session_id}`);
      expect(env.next.command).toContain("--json --stdin -t ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves an explicit -w workspace so the continuation runs from the same cwd", () => {
    const { env } = gateRun("DIRECT", ["-w", ROOT]);
    expect(env.next.command).toBe(
      `${PREFIX} run ${GATE} '<gate>' -t ${env.session_id} -w ${ROOT}`,
    );
  });
});

// --- 3. SessionState persistence + kind-marker + session list visibility -----------
describe("gate-command — SessionState persistence, marker, and session list", () => {
  it("appends one gate turn with the marker and shows the session in `navi session list`", async () => {
    const { env } = gateRun("DIRECT");

    const state = (await readPriorSessionState(storage, env.session_id))._unsafeUnwrap();
    expect(state, "a SessionState was appended on the run path").not.toBeNull();
    expect(
      state!.turn_history.map((turn) =>
        turn.kind === "gate" ? turn.decision.gate : turn.kind,
      ),
    ).toEqual(["DIRECT"]);
    expect(state!.status).toBe("awaiting_parent");

    // The exact kind marker rides on the run-created message.
    const { messages } = await memoryFor(storage).recall({ threadId: env.session_id, perPage: 100 });
    const marked = messages.some(
      (m) => (m.content as { metadata?: { kind?: unknown } } | undefined)?.metadata?.kind === SESSION_STATE_KIND,
    );
    expect(marked, "run-created message carries the kind-marker").toBe(true);

    // The metadata cache makes the run-created session appear in `navi session list`.
    const list = navi(["session", "list", "--json"]);
    expect(list.code).toBe(0);
    const rows = JSON.parse(list.stdout) as { session_id: string; status: string | null; gate: string | null }[];
    const row = rows.find((x) => x.session_id === env.session_id);
    expect(row, "run-created session is listed").toBeDefined();
    expect(row!.status).toBe("awaiting_parent");
    expect(row!.gate).toBe("DIRECT");
  });
});

// --- 4. -t continuation: prior read + extended -------------------------------
describe("gate-command — continuation on -t (prior read, history extended)", () => {
  it("turn_history and parent_events grow once per -t continuation (--stdin event)", async () => {
    const r1 = navi(["run", GATE, "--stdin", "--json"], JSON.stringify({ gate: "DIRECT", event: { task: "wire it" } }));
    expect(r1.code).toBe(0);
    const e1 = JSON.parse(r1.stdout) as Envelope;
    created.add(e1.session_id);

    const r2 = navi(
      ["run", GATE, "--stdin", "--json", "-t", e1.session_id],
      JSON.stringify({ gate: "CLEAR", event: { kind: "evidence-return" } }),
    );
    expect(r2.code).toBe(0);
    const e2 = JSON.parse(r2.stdout) as Envelope;
    expect(e2.session_id).toBe(e1.session_id); // continued on the SAME session
    expect(e2.gate).toBe("CLEAR");

    const state = (await readPriorSessionState(storage, e1.session_id))._unsafeUnwrap();
    expect(
      state!.turn_history.map((turn) =>
        turn.kind === "gate" ? turn.decision.gate : turn.kind,
      ),
    ).toEqual(["DIRECT", "CLEAR"]);
    expect(state!.parent_events).toHaveLength(2); // grew
    expect(state!.task).toBe("wire it"); // carried from the prior turn
    expect(state!.status).toBe("clear");
  });
});

// --- 5. liberal extraction is loud, never a silent drop ----------------------
describe("gate-command — a malformed judgment sibling is a loud exit 1", () => {
  it("a GateDecision-bearing output with an invalid directives[] records a failure turn", async () => {
    const sessionId = `bad-sibling-${Date.now()}`;
    created.add(sessionId);
    await createContinuationTarget(sessionId);
    const r = navi(["run", BAD, "--json", "-t", sessionId]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/gate output "directives" failed validation/);
    expect(r.stdout).toBe(""); // no envelope emitted — never a silent gate-path success
    const state = (await readPriorSessionState(storage, sessionId))._unsafeUnwrap();
    expect(state?.turn_history.at(-1)).toMatchObject({
      kind: "failure",
      reason: expect.stringMatching(/directives.*failed validation/),
    });
  });
});

describe("decision output — gate/verdict ambiguity is a loud exit 1", () => {
  it("records a failure turn instead of silently choosing GateDecision", async () => {
    const sessionId = `hybrid-${Date.now()}`;
    created.add(sessionId);
    await createContinuationTarget(sessionId);
    const r = navi(["run", HYBRID, "--json", "-t", sessionId]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /final output is ambiguous: it validates as both GateDecision and VerdictSchema/,
    );
    const state = (await readPriorSessionState(storage, sessionId))._unsafeUnwrap();
    expect(state?.turn_history).toHaveLength(1);
    expect(state?.turn_history[0]).toMatchObject({
      kind: "failure",
      reason: expect.stringMatching(/validates as both GateDecision and VerdictSchema/),
    });
  });
});

describe("gate-command — invalid override attempts remain visible", () => {
  it("records a failure turn when CLEAR has nothing to override", async () => {
    const sessionId = `bad-override-${Date.now()}`;
    created.add(sessionId);
    await createContinuationTarget(sessionId);
    const r = navi([
      "run",
      GATE,
      "CLEAR",
      "--override",
      "force it",
      "-t",
      sessionId,
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/nothing to override — gate CLEAR/);
    const state = (await readPriorSessionState(storage, sessionId))._unsafeUnwrap();
    expect(state?.turn_history).toHaveLength(1);
    expect(state?.turn_history[0]).toMatchObject({
      kind: "failure",
      reason: expect.stringMatching(/nothing to override/),
    });
  });
});

// --- 6. verdict workflows remain distinct from gates --------------------------
describe("gate-command — a verdict is recorded without inventing a gate", () => {
  it("json-command emits GO as a verdict and writes one resolvable session turn", async () => {
    const r = navi(["run", JSON_CMD, "GO", "--json"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope & { result: { verdict?: string } };
    expect(env.gate).toBeNull();
    expect(env.verdict).toBe("GO");
    expect(env.status).toBe("complete");
    expect(env.directives).toEqual([]);
    expect(env.findings).toEqual([]);
    expect(env.surface_map).toBeNull();
    expect(env.confidence).toBeNull();
    expect(env.result.verdict).toBe("GO"); // the command-JSON unwrap still applies
    const state = (await readPriorSessionState(storage, env.session_id))._unsafeUnwrap();
    expect(state?.turn_history).toHaveLength(1);
    expect(state?.turn_history[0]).toMatchObject({
      kind: "verdict",
      decision: { verdict: "GO" },
    });
  });
});

// --- 7. COMPLETE handoff sibling (catalog-validated successor command) --------
// A gated workflow's final output may carry `handoff: { flow, request }` alongside
// the GateDecision. Only the COMPLETE arm fills next.command from it; every other
// Model supplies a catalog name + text — never shell.
describe("gate-command — COMPLETE handoff sibling", () => {
  // Model-free temp fixture: emits a chosen gate + optional handoff sibling. The
  // handoff JSON is interpolated into the command step (shell-safe fixtures only).
  function handoffFixture(gate: string, handoffJson: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "navi-handoff-"));
    const path = join(dir, "action.yaml");
    const handoffField = handoffJson === null ? "" : `,"handoff":${handoffJson}`;
    writeFileSync(
      path,
      `name: gate-handoff
description: Model-free fixture — GateDecision + optional handoff sibling.
args:
  note:
    required: false
    default: ""
    description: optional positional prose (for parent-event capture)
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"${gate}","reason":"handoff fixture","blocking_directive_ids":["d1"],"non_blocking_risks":[],"human_escalation":null,"confidence":0.7,"directives":[{"id":"d1","type":"forcing_question","priority":1,"severity":"blocking","status":"open","reason":"need the real ask","action":"In ONE sentence, what changes?","targets":[],"required_evidence":["one sentence"],"completion_criteria":["stated"],"stop_conditions":[],"issued_at":"2026-07-25T00:00:00Z"}]${handoffField}}'
`,
    );
    return path;
  }

  it("COMPLETE with no handoff → command null and the completion instruction", () => {
    const path = handoffFixture("COMPLETE", null);
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.gate).toBe("COMPLETE");
      expect(env.next.command).toBeNull();
      expect(env.next.instruction).toBe("Gate COMPLETE — the session is resolved.");
    } finally {
      rmSync(path, { force: true });
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("COMPLETE + valid handoff → rendered command (shell-quoted) + honest instruction", () => {
    // `founder` is a shipped active catalog workflow; request carries a space so
    // shellQuote must single-quote it.
    const path = handoffFixture(
      "COMPLETE",
      '{"flow":"founder","request":"should we build handoff?"}',
    );
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.gate).toBe("COMPLETE");
      expect(env.next.instruction).toBe("Gate COMPLETE — continue with `founder`.");
      expect(env.next.command).toBe(
        `${PREFIX} run founder ${shellQuoteFixture("should we build handoff?")}`,
      );
      // Model never contributes an unquoted token with spaces.
      expect(env.next.command).toContain("'should we build handoff?'");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("COMPLETE handoff preserves an explicit -w workspace", () => {
    const path = handoffFixture(
      "COMPLETE",
      '{"flow":"founder","request":"should we build handoff?"}',
    );
    try {
      const r = navi(["run", path, "--json", "-w", ROOT]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.next.command).toBe(
        `${PREFIX} run founder ${shellQuoteFixture("should we build handoff?")} -w ${ROOT}`,
      );
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("COMPLETE + unknown flow → stderr note, command stays null, run still succeeds", () => {
    const path = handoffFixture(
      "COMPLETE",
      '{"flow":"no-such-flow-xyz","request":"anything"}',
    );
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.next.command).toBeNull();
      expect(env.next.instruction).toBe("Gate COMPLETE — the session is resolved.");
      expect(r.stderr).toMatch(/handoff flow "no-such-flow-xyz" is not in the catalog/);
      // Never fabricate a command from a hallucinated name (result may still
      // carry the raw handoff sibling — that is the judge's output, not next).
      expect(env.next.command).toBeNull();
      expect(JSON.stringify(env.next)).not.toMatch(/no-such-flow-xyz/);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("COMPLETE + malformed handoff → loud exit 1, no envelope", () => {
    // Present but missing required `request` — same absent-vs-invalid discipline
    // as directives/findings/surface_map.
    const path = handoffFixture("COMPLETE", '{"flow":"founder"}');
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/gate output "handoff" failed validation/);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("handoff on a NON-COMPLETE gate does not hijack the continuation command", () => {
    const path = handoffFixture(
      "DIRECT",
      '{"flow":"founder","request":"should not appear as next.command"}',
    );
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      // Continuation is the shape-mirrored -t command, NOT the handoff.
      expect(env.next.command).toBe(`${PREFIX} run ${path} '<note>' -t ${env.session_id}`);
      expect(env.next.command).not.toContain("founder");
      expect(env.next.instruction).toMatch(/In ONE sentence, what changes/);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  // A handoff renders a positional command only when the successor can accept
  // the request text. edge-walk takes JSON, so prose cannot bind to it.
  it("COMPLETE + handoff to json-arg flow → stderr note, command null", () => {
    const path = handoffFixture(
      "COMPLETE",
      '{"flow":"edge-walk","request":"a prose brief that cannot bind to a json arg"}',
    );
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.next.command).toBeNull();
      expect(env.next.instruction).toBe("Gate COMPLETE — the session is resolved.");
      expect(r.stderr).toMatch(
        /handoff flow "edge-walk" does not accept a single required string arg/,
      );
      expect(JSON.stringify(env.next)).not.toMatch(/edge-walk/);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("COMPLETE + handoff to optional-arg flow (code-review) → stderr note, command null", () => {
    // code-review's range is optional with a default — not a single required
    // string. A prose brief would bind silently into a git ref and fail confusingly.
    const path = handoffFixture(
      "COMPLETE",
      '{"flow":"code-review","request":"please review this design brief"}',
    );
    try {
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      expect(env.next.command).toBeNull();
      expect(r.stderr).toMatch(
        /handoff flow "code-review" does not accept a single required string arg/,
      );
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});

// shellQuote mirror for test expectations (safe tokens verbatim; spaces → single-quoted).
// Mirrors src/invocation.ts — tests assert the rendered form without importing the
// production helper into every assertion (the live CLI path is what we exercise).
function shellQuoteFixture(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`;
}

// --- 8. item-3: mixed arg shape (string then json) uses --stdin transport -----
// continuationCommand must mirror boundStdinKey: ANY json-typed arg at any
// position ⇒ --json --stdin, not a positional placeholder on args[0].
describe("gate-command — mixed arg shape (string + json) advertises --stdin", () => {
  it("string-first + later json arg → --json --stdin -t (not '<name>' positional)", () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-gate-mixed-arg-"));
    const path = join(dir, "action.yaml");
    writeFileSync(
      path,
      `name: gate-mixed-arg
description: Model-free fixture — string arg then json arg; GateDecision final output.
args:
  label:
    type: string
    required: false
    default: ""
  payload:
    type: json
    required: true
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"DIRECT","reason":"mixed-arg continuation proof","blocking_directive_ids":[],"non_blocking_risks":[],"human_escalation":null,"confidence":0.5}'
`,
    );
    try {
      const r = navi(
        ["run", path, "--stdin", "--json"],
        JSON.stringify({ task: "prove mixed arm" }),
      );
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);
      // Same transport as pure-json first-arg (edge-walk form); NOT a positional
      // '<label>' that would leave the required json arg unbound.
      expect(env.next.command).toBe(`${PREFIX} run ${path} --json --stdin -t ${env.session_id}`);
      expect(env.next.command).not.toContain("<label>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- 9. item-2: positional parent answer reaches parent_events ---------------
// On a non-stdin run the bound positional text IS the parent's event. Shaped as
// { task } so taskFromEvent / story's parent: line both work. Two-turn probe
// proves the ledger holds both halves (and story narrates them).
// Dedicated fixture: the positional arg is free-form prose (does NOT select the
// gate — gate-command interpolates input.gate into the GateDecision, so feeding
// answer text there would fail schema validation).
describe("gate-command — positional parent answer is recorded on the ledger", () => {
  function dialogueFixture(gate: "DIRECT" | "CLEAR"): string {
    const dir = mkdtempSync(join(tmpdir(), "navi-dialogue-"));
    const path = join(dir, "action.yaml");
    writeFileSync(
      path,
      `name: gate-dialogue
description: Model-free dialogue fixture — fixed gate; positional answer is free prose.
args:
  answer:
    required: true
    description: parent's free-form text this turn
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"${gate}","reason":"dialogue fixture ${gate}","blocking_directive_ids":["q1"],"non_blocking_risks":[],"human_escalation":null,"confidence":0.8,"directives":[{"id":"q1","type":"forcing_question","priority":1,"severity":"blocking","status":"open","reason":"the real ask is not yet stated","action":"In ONE sentence, what actually changes when this ships?","targets":[],"required_evidence":["one sentence"],"completion_criteria":["stated"],"stop_conditions":[],"issued_at":"2026-07-25T00:00:00Z"}]}'
`,
    );
    return path;
  }

  it("positional prose lands in parent_events as { task }; story shows parent + asked", async () => {
    const path1 = dialogueFixture("DIRECT");
    const path2 = dialogueFixture("CLEAR");
    try {
      // Turn 1: parent states the ask; navi DIRECT/asks.
      const r1 = navi(["run", path1, "we need a handoff seam", "--json"]);
      expect(r1.code).toBe(0);
      const e1 = JSON.parse(r1.stdout) as Envelope;
      created.add(e1.session_id);

      const s1 = (await readPriorSessionState(storage, e1.session_id))._unsafeUnwrap();
      expect(s1).not.toBeNull();
      expect(s1!.parent_events).toEqual([{ task: "we need a handoff seam" }]);
      expect(s1!.task).toBe("we need a handoff seam"); // taskFromEvent reads event.task

      // Turn 2: parent answers on -t. path2 emits CLEAR so the session can resolve;
      // ledger continuity is via -t, not the path token.
      const r2 = navi([
        "run",
        path2,
        "the one-sentence answer",
        "--json",
        "-t",
        e1.session_id,
      ]);
      expect(r2.code).toBe(0);
      const e2 = JSON.parse(r2.stdout) as Envelope;
      expect(e2.session_id).toBe(e1.session_id);

      const s2 = (await readPriorSessionState(storage, e1.session_id))._unsafeUnwrap();
      expect(s2!.parent_events).toEqual([
        { task: "we need a handoff seam" },
        { task: "the one-sentence answer" },
      ]);
      // Task is carried from prior (first turn), not overwritten by the answer.
      expect(s2!.task).toBe("we need a handoff seam");

      // story narrates both halves: navi's asked: line and the parent's reply.
      const story = navi(["story", e1.session_id]);
      expect(story.code).toBe(0);
      expect(story.stdout).toMatch(/asked: q1/);
      expect(story.stdout).toMatch(/parent: we need a handoff seam/);
      expect(story.stdout).toMatch(/parent: the one-sentence answer/);
    } finally {
      rmSync(join(path1, ".."), { recursive: true, force: true });
      rmSync(join(path2, ".."), { recursive: true, force: true });
    }
  });

  // A defaulted first argument is not a parent answer when the caller supplies
  // no positional input.
  it("defaulted first arg with no positional → parent_events stays empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-default-event-"));
    const path = join(dir, "action.yaml");
    writeFileSync(
      path,
      `name: gate-default-event
description: Model-free fixture — defaulted string arg; parent may supply nothing.
args:
  answer:
    required: false
    default: "I am a default the parent never said"
    description: optional; default must not become a parent event
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"DIRECT","reason":"default-event fixture","blocking_directive_ids":[],"non_blocking_risks":[],"human_escalation":null,"confidence":0.5}'
`,
    );
    try {
      // No positional after the path — bindArgs fills answer from default.
      const r = navi(["run", path, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Envelope;
      created.add(env.session_id);

      const state = (await readPriorSessionState(storage, env.session_id))._unsafeUnwrap();
      expect(state).not.toBeNull();
      // Parent said nothing — ledger must not quote the default back.
      expect(state!.parent_events).toEqual([]);
      expect(JSON.stringify(state!.parent_events)).not.toMatch(/parent never said/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
