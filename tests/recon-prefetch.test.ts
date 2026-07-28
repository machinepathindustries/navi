import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  assembleReconPrefetch,
  buildSubjectQuery,
  collectSeedCites,
  reconPrefetchEnabled,
  renderReconPrefetchBlock,
  RECON_PREFETCH_HEADER,
} from "../src/search/recon-prefetch.ts";
import type { PrefetchedWindow } from "../src/search/prefetch.ts";
import type { PreflightHit } from "../src/search/preflight.ts";

const FIXTURE = join(process.cwd(), "tests/fixtures/orphaned-repair/src");

const SAMPLE_EVENT = {
  kind: "plan",
  task: "Add call-record repair so salvageable records are cleaned and stored instead of dropped.",
  plan: {
    claim: "complete",
    summary:
      "Implemented repairCallRecord() in repair.ts. Unit tests in repair.test.ts. Call-record repair is done.",
    citations: [
      { uri: "repair.ts", line_start: 11, line_end: 19 },
      { uri: "repair.test.ts", line_start: 1, line_end: 58 },
    ],
  },
};

describe("recon-prefetch toggle", () => {
  const prev = process.env.NAVI_RECON_PREFETCH;
  afterEach(() => {
    if (prev === undefined) delete process.env.NAVI_RECON_PREFETCH;
    else process.env.NAVI_RECON_PREFETCH = prev;
  });

  it("DEFAULT-ON: unset ⇒ enabled for edge-walk recon + expand, never judge", () => {
    delete process.env.NAVI_RECON_PREFETCH;
    expect(reconPrefetchEnabled("edge-walk", "recon")).toBe(true);
    expect(reconPrefetchEnabled("edge-walk", "expand")).toBe(true);
    // The judge evaluates the completed evidence and does not receive this
    // deterministic recon head start.
    expect(reconPrefetchEnabled("edge-walk", "judge")).toBe(false);
    // Only the edge-walk workflow.
    expect(reconPrefetchEnabled("other-wf", "recon")).toBe(false);
    expect(reconPrefetchEnabled("founder", "recon")).toBe(false);
  });

  it("NAVI_RECON_PREFETCH is an emergency-disable, not an opt-in", () => {
    for (const off of ["0", "off", "false", "OFF", "False"]) {
      process.env.NAVI_RECON_PREFETCH = off;
      expect(reconPrefetchEnabled("edge-walk", "recon")).toBe(false);
      expect(reconPrefetchEnabled("edge-walk", "expand")).toBe(false);
    }
    // Any other value (including empty / "1" / "true") keeps it on.
    for (const on of ["1", "true", "yes", ""]) {
      process.env.NAVI_RECON_PREFETCH = on;
      expect(reconPrefetchEnabled("edge-walk", "recon")).toBe(true);
    }
  });
});

describe("recon-prefetch subject + seeds", () => {
  it("buildSubjectQuery includes task prose and citation basenames", () => {
    const q = buildSubjectQuery({ event: SAMPLE_EVENT, prior: null, step: "recon" });
    expect(q).toMatch(/repairCallRecord|call-record repair/i);
    expect(q).toContain("repair.ts");
  });

  it("collectSeedCites pulls plan citations + prior directive targets", () => {
    const seeds = collectSeedCites({
      event: SAMPLE_EVENT,
      prior: {
        directives: [
          {
            id: "d-1",
            targets: ["handler.ts", "repair.ts"],
            required_evidence: ["handler.ts showing a call to repairCallRecord"],
          },
        ],
      },
    });
    const uris = new Set(seeds.map((s) => s.uri));
    expect(uris.has("repair.ts")).toBe(true);
    expect(uris.has("repair.test.ts")).toBe(true);
    expect(uris.has("handler.ts")).toBe(true);
    expect(seeds.some((s) => s.uri === "repair.ts" && s.lineStart === 11)).toBe(true);
  });

  it("expand step folds recon surface paths into seeds", () => {
    const seeds = collectSeedCites({
      event: SAMPLE_EVENT,
      prior: null,
      recon: {
        production_triggers: [{ path: "index.ts", line: 7, note: "entry" }],
        direct_callers: [{ path: "handler.ts", line: 27, note: "drop" }],
      },
    });
    const uris = new Set(seeds.map((s) => s.uri));
    expect(uris.has("index.ts")).toBe(true);
    expect(uris.has("handler.ts")).toBe(true);
  });
});

describe("recon-prefetch honesty render", () => {
  it("labels candidates-to-verify and hit-list-is-not-evidence", () => {
    const windows: PrefetchedWindow[] = [
      {
        path: "repair.ts",
        lineStart: 1,
        lineEnd: 20,
        totalLines: 40,
        text: "1|export function repairCallRecord",
      },
    ];
    const hits: PreflightHit[] = [
      { term: "repairCallRecord", path: "repair.ts", line: 11, text: "export function repairCallRecord" },
    ];
    const block = renderReconPrefetchBlock(windows, hits, ["repairCallRecord"], 3, "recon");
    expect(block).toContain(RECON_PREFETCH_HEADER);
    expect(block).toMatch(/CANDIDATES|candidates to VERIFY|VERIFY/i);
    expect(block).toMatch(/hit-list is NOT evidence|NOT evidence/i);
    expect(block).toMatch(/not proof|NOT proof/i);
    expect(block).not.toMatch(/pre-judged|verified verdict|this is evidence of wiring/i);
    expect(block).toContain("repair.ts");
  });

  it("empty windows still carry honesty + INDEX digest", () => {
    const block = renderReconPrefetchBlock([], [], [], 1, "expand");
    expect(block).toContain(RECON_PREFETCH_HEADER);
    expect(block).toMatch(/0 windows/);
    expect(block).toMatch(/NOT evidence/i);
  });
});

describe("recon-prefetch assemble on fixture", () => {
  it("peeks repair.ts from plan citations under the fixture workspace", () => {
    const ctx = {
      input: { event: SAMPLE_EVENT },
      prior: null,
      steps: {},
    };
    const r = assembleReconPrefetch(FIXTURE, ctx, "recon");
    expect(r.durationMs).toBeLessThan(5000);
    expect(r.windows.length).toBeGreaterThan(0);
    expect(r.windows.some((w) => w.path.includes("repair"))).toBe(true);
    expect(r.block).toContain(RECON_PREFETCH_HEADER);
    expect(r.block).toMatch(/NOT evidence/i);
    // Real file bytes (numbered lines from peek)
    const repairWin = r.windows.find((w) => w.path.includes("repair") && !w.path.includes("test"));
    expect(repairWin?.text.length ?? 0).toBeGreaterThan(20);
  });

  it("expand assemble includes recon-derived paths when present", () => {
    const ctx = {
      input: { event: SAMPLE_EVENT },
      prior: null,
      steps: {
        recon: {
          production_triggers: [{ path: "index.ts", line: 7, note: "ingest entry" }],
          subject_callers: [{ path: "handler.ts", line: 17, note: "handleBatch" }],
        },
      },
    };
    const r = assembleReconPrefetch(FIXTURE, ctx, "expand");
    expect(r.step).toBe("expand");
    expect(r.windows.length).toBeGreaterThan(0);
    const paths = r.windows.map((w) => w.path).join(" ");
    // Should cover at least plan claim (repair) or recon surfaces (handler/index)
    expect(/repair|handler|index/.test(paths)).toBe(true);
  });

  it("path-guard fences seed peeks: denied/escape targets never read", () => {
    const ctx = {
      input: {
        event: {
          kind: "plan",
          task: "malicious",
          plan: {
            claim: "complete",
            summary: "see node_modules/evil/backdoor.ts:1 and external/vendor/secret.ts:1",
            citations: [
              { uri: "node_modules/evil/backdoor.ts", line_start: 1, line_end: 5 },
              { uri: "external/vendor/secret.ts", line_start: 1, line_end: 5 },
              { uri: "../../../etc/hostsfile.ts", line_start: 1, line_end: 5 },
            ],
          },
        },
      },
      prior: {
        directives: [{ id: "d-1", targets: ["node_modules/evil/backdoor.ts", "external/x.ts"] }],
      },
      steps: {},
    };
    const r = assembleReconPrefetch(FIXTURE, ctx, "recon");
    // No window may point into a denied tier or escape the workspace.
    expect(r.windows.every((w) => !/node_modules|external/.test(w.path))).toBe(true);
    const seeds = collectSeedCites({ event: ctx.input.event, prior: ctx.prior });
    expect(seeds.every((s) => !/node_modules|external/.test(s.uri))).toBe(true);
  });
});
