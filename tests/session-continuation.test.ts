import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execSync } from "node:child_process";
import { afterAll, describe, it, expect } from "vitest";
import { LibSQLStore } from "@mastra/libsql";
import { buildShape, loadShape, lintErrors, compile } from "../src/compiler/index.ts";
import { parseSpecText } from "../src/compiler/parse.ts";
import { SESSION_STATE_KIND } from "../src/session-state.ts";

// Continuation wiring across three keyless surfaces: (1) the
// continuation-skip fixture compiles to a native .branch() whose predicate is the
// exact skip condition, proven against the compiler's own artifacts with no
// model; (2) the reserved-arg lint refuses a workflow declaring any injected key;
// (3) the weak-evidence --stdin gate (exit 4 pre-model) plus reserved-key injection,
// proven as real CLI subprocesses on model-free command fixtures.
// Subprocess + seed share a per-suite temp NAVI_DB so the real navi.db is never
// touched (corrupt-prior seed and any run-path session writes stay on the throwaway).

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");
const CONT = "tests/fixtures/session-continuation/action.yaml";
const EVIDENCE_ECHO = "tests/fixtures/session-continuation/evidence-echo/action.yaml";
const REVISION_ECHO = "tests/fixtures/session-continuation/revision-echo/action.yaml";
const PRIOR_ECHO = "tests/fixtures/session-continuation/prior-echo/action.yaml";
const SKIP_CONDITION =
  "prior == null || prior.surface_map == null || prior_workflow != 'edge-walk' || prior.surface_map.revision_hash != revision";
const suiteDir = mkdtempSync(join(tmpdir(), "navi-session-cont-"));
const NAVI_DB = `file:${join(suiteDir, "navi.db")}`;

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

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

async function shapeFrom(yaml: string) {
  return buildShape(parseSpecText(yaml)._unsafeUnwrap());
}

// --- 1. continuation-skip branch wiring (compiler artifacts, no model) -------
describe("session-continuation — compiled branch wiring (no model)", () => {
  it("recon carries the exact skip condition and compiles cleanly to a branch", async () => {
    const shape = (await loadShape(CONT, ROOT))._unsafeUnwrap();
    expect(lintErrors(shape)).toHaveLength(0);
    expect(shape.steps.map((s) => s.name)).toEqual(["recon", "report"]);
    const recon = shape.steps.find((s) => s.name === "recon")!;
    // the recon step is the conditional (branch) step; report is unconditional.
    expect(recon.condition?.source).toBe(SKIP_CONDITION);
    expect(shape.steps.find((s) => s.name === "report")!.condition).toBeUndefined();

    const c = await compile(shape, { thread: "c1", resource: "cli" });
    expect(c.isOk()).toBe(true);
    const { workflow, agents } = c._unsafeUnwrap();
    // both steps are in the committed graph (a leading .branch() then a .then()).
    expect(workflow.serializedStepGraph.length).toBe(2);
    expect(Object.keys(agents).sort()).toEqual(["session-continuation.recon", "session-continuation.report"]);
  });

  it("the compiled predicate reuses only an edge-walk-owned map at the same revision", async () => {
    const shape = (await loadShape(CONT, ROOT))._unsafeUnwrap();
    const pred = shape.steps.find((s) => s.name === "recon")!.condition!.predicate;
    // ctx mirrors compile.ts buildCtx: the injected reserved keys sit at the top level.
    // fresh session: prior null ⇒ condition true ⇒ recon RUNS.
    expect(pred({ prior: null, prior_workflow: null, revision: "abc123" })).toBe(true);
    // A typed plain/founder session has no map, so the dotted read must not fail.
    expect(pred({ prior: { surface_map: null }, prior_workflow: "founder", revision: "abc123" })).toBe(true);
    // Another flow's same-revision map never suppresses edge-walk discovery.
    expect(
      pred({
        prior: { surface_map: { revision_hash: "abc123" } },
        prior_workflow: "pre-pr-review",
        revision: "abc123",
      }),
    ).toBe(true);
    // Only edge-walk's own same-revision map is reusable.
    expect(
      pred({
        prior: { surface_map: { revision_hash: "abc123" } },
        prior_workflow: "edge-walk",
        revision: "abc123",
      }),
    ).toBe(false);
    // stale revision ⇒ condition true ⇒ recon RUNS again.
    expect(
      pred({
        prior: { surface_map: { revision_hash: "old000" } },
        prior_workflow: "edge-walk",
        revision: "abc123",
      }),
    ).toBe(true);
  });
});

// --- 2. reserved-arg lint (compiler, no model) -------------------------------
describe("session-continuation — reserved-arg lint (revision/prior/prior_workflow)", () => {
  for (const reserved of ["revision", "prior", "prior_workflow"]) {
    it(`a workflow declaring arg "${reserved}" is a loud compile error`, async () => {
      const shape = await shapeFrom(`
name: collide
args:
  ${reserved}:
    required: true
steps:
  - name: s
    type: agent
    prompt: hi
`);
      expect(lintErrors(shape).some((e) => new RegExp(`arg "${reserved}" is a reserved input key`).test(e.message))).toBe(
        true,
      );
      expect((await compile(shape, { thread: "c", resource: "cli" })).isErr()).toBe(true);
    });
  }

  it("a normal arg name is unaffected", async () => {
    const shape = await shapeFrom(`
name: fine
args:
  topic:
    required: true
steps:
  - name: s
    type: agent
    prompt: hi
`);
    expect(lintErrors(shape)).toHaveLength(0);
  });
});

// --- 3. weak-evidence --stdin gate (real subprocess, model-free) -------------
describe("session-continuation — weak-evidence --stdin gate (exit 4 pre-model)", () => {
  it("garbage evidence event (empty evidence[]) → exit 4 fast, one-line schema error, no model", () => {
    const r = navi(["run", EVIDENCE_ECHO, "--stdin"], JSON.stringify({ event: { directive_id: "d1", evidence: [] } }));
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/evidence event schema failure/);
    expect(r.stdout).toBe(""); // no envelope emitted
  });

  it("a bare {directive_id, evidence} (no event wrapper) is gated too", () => {
    const r = navi(["run", EVIDENCE_ECHO, "--stdin"], JSON.stringify({ directive_id: "d1", evidence: [] }));
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/evidence event schema failure/);
  });

  it("an event claiming evidence but with an out-of-enum kind → exit 4", () => {
    const r = navi(
      ["run", EVIDENCE_ECHO, "--stdin"],
      JSON.stringify({ event: { directive_id: "d1", evidence: [{ kind: "hunch", claim_supported: true }] } }),
    );
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/evidence event schema failure/);
  });

  it("a valid minimal EvidenceEvent passes the gate and reaches input.event untouched", () => {
    const r = navi(
      ["run", EVIDENCE_ECHO, "--stdin", "--json"],
      JSON.stringify({
        event: { directive_id: "d-42", evidence: [{ kind: "source_location", uri: "src/x.ts", claim_supported: true }] },
      }),
    );
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { result: { stdout: string } };
    // the command echoed input.event.directive_id — proof the event rode through untouched.
    expect(env.result.stdout).toBe("d-42");
  });

  it("plain non-event stdin is completely unaffected (no directive_id/evidence keys)", () => {
    const r = navi(["run", EVIDENCE_ECHO, "--stdin", "--json"], JSON.stringify({ note: "hello" }));
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { result: { stdout: string } };
    expect(env.result.stdout).toBe(""); // no event ⇒ interpolation empty, but the run proceeds
  });

  it("malformed JSON keeps its EXISTING behavior (exit 4, invalid stdin JSON — not the evidence gate)", () => {
    const r = navi(["run", EVIDENCE_ECHO, "--stdin"], "not json {");
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/invalid stdin JSON/);
    expect(r.stderr).not.toMatch(/evidence event schema failure/);
  });
});

// --- 4. reserved-key injection reaches the workflow input (subprocess) --------
describe("session-continuation — reserved-key injection (no model)", () => {
  it("the CLI injects `revision` (git HEAD) into the workflow input", () => {
    const head = execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
    const r = navi(["run", REVISION_ECHO, "--json"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as { result: { stdout: string } };
    expect(env.result.stdout).toBe(head);
  });

  it("the CLI injects prior state and the immediately prior workflow on -t", async () => {
    const storage = new LibSQLStore({ id: "navi", url: NAVI_DB });
    await storage.init();
    const mem = await storage.getStore("memory");
    if (!mem) throw new Error("memory store unavailable");
    const threadId = `prior-echo-${randomUUID()}`;
    const task = `prior-task-${randomUUID()}`;
    const now = new Date();
    await mem.saveThread({
      thread: {
        id: threadId,
        resourceId: "cli",
        title: task,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    });
    await mem.saveMessages({
      messages: [
        {
          id: randomUUID(),
          threadId,
          resourceId: "cli",
          role: "assistant" as const,
          type: "text",
          createdAt: now,
          content: {
            format: 2 as const,
            parts: [{
              type: "text" as const,
              text: JSON.stringify({
                schema_version: "navi.session.v2",
                session_id: threadId,
                task,
                parent_events: [],
                surface_map: null,
                directives: [],
                findings: [],
                evidence: [],
                turn_history: [
                  {
                    kind: "plain",
                    run_id: "prior-run",
                    workflow: "founder",
                    summary: "an earlier run",
                  },
                ],
                status: "active",
              }),
            }],
            metadata: { kind: SESSION_STATE_KIND },
          },
        },
      ],
    });

    try {
      const r = navi(["run", PRIOR_ECHO, "-t", threadId, "--json"]);
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as { session_id: string; result: { stdout: string } };
      expect(env.session_id).toBe(threadId);
      expect(env.result.stdout).toBe(`${task}|founder`);
    } finally {
      await mem.deleteThread({ threadId });
      await storage.close();
    }
  });
});

// --- 5. malformed prior on -t is a LOUD exit 1 (subprocess) ------------------
describe("session-continuation — malformed prior is a loud exit 1, never a silent null", () => {
  it("a corrupt session-of-record on the -t thread aborts pre-model with exit 1", async () => {
    // Seed a corrupt SessionState (discriminator present, fails validation) onto a
    // random thread in the SAME temp NAVI_DB the CLI reads, then run -t that thread.
    const storage = new LibSQLStore({ id: "navi", url: NAVI_DB });
    await storage.init();
    const mem = await storage.getStore("memory");
    if (!mem) throw new Error("memory store unavailable");
    const threadId = `continuation-corrupt-${randomUUID()}`;
    const now = new Date();
    await mem.saveThread({
      thread: { id: threadId, resourceId: "cli", title: "", metadata: {}, createdAt: now, updatedAt: now },
    });
    await mem.saveMessages({
      messages: [
        {
          id: randomUUID(),
          threadId,
          resourceId: "cli",
          role: "assistant" as const,
          type: "text",
          createdAt: now,
          content: {
            format: 2 as const,
            parts: [{ type: "text" as const, text: JSON.stringify({ session_id: threadId, schema_version: "navi.session.v2", status: "not-a-status" }) }],
            metadata: { kind: SESSION_STATE_KIND },
          },
        },
      ],
    });

    try {
      const r = navi(["run", EVIDENCE_ECHO, "-t", threadId, "--json"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/malformed SessionState/);
      expect(r.stdout).toBe(""); // no envelope — aborted before compile/model
    } finally {
      await mem.deleteThread({ threadId });
    }
  });
});
