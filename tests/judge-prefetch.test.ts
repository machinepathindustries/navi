import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  deriveCitedLocations,
  dedupeLocations,
  parseLocationsFromText,
  peekCitedLocations,
  renderJudgePrefetchBlock,
  judgePrefetchEnabled,
  JUDGE_PREFETCH_HEADER,
  type CiteLocation,
} from "../src/search/judge-prefetch.ts";

const FIXTURE = join(process.cwd(), "tests/fixtures/orphaned-repair-decoy/src");

describe("judge-prefetch derive + peek", () => {
  it("parses file:line and file:start-end from free text", () => {
    const locs = parseLocationsFromText(
      "orphaned: repairCallRecord (repair.ts:11) never called; handler.ts:21-32 drops",
      "test",
    );
    expect(locs.some((l) => l.uri === "repair.ts" && l.lineStart === 11)).toBe(true);
    expect(locs.some((l) => l.uri === "handler.ts" && l.lineStart === 21 && l.lineEnd === 32)).toBe(
      true,
    );
  });

  it("derives from event evidence + directive targets + required_evidence (founder rail)", () => {
    const locs = deriveCitedLocations({
      event: {
        directive_id: "d-1",
        evidence: [
          {
            kind: "source_location",
            uri: "handler.ts",
            line_start: 27,
            line_end: 27,
            claim_supported: true,
          },
          {
            kind: "test_result",
            command: "npm test -- handler.integration.test.ts",
            exit_code: 0,
            claim_supported: true,
          },
        ],
      },
      prior: {
        directives: [
          {
            id: "d-1",
            targets: ["handler.ts", "handler.integration.test.ts", "repair.ts"],
            required_evidence: [
              "handler.ts showing a call to repairCallRecord in the else branch",
              "handler.integration.test.ts with a dirty-record test",
            ],
            completion_criteria: ["re-read handler.ts:27"],
            reason: "orphan at repair.ts:11",
            action: "wire it",
            stop_conditions: [],
          },
        ],
        evidence: [],
        findings: [],
        surface_map: {
          surfaces: ["handler.ts:21-32 — ingest drop path"],
          seams: [],
          unknowns: [],
          revision_hash: "abc",
        },
      },
      recon: {
        production_triggers: [{ path: "index.ts", line: 7, note: "entry" }],
      },
      expand: {
        surfaces: ["repair.ts:11 — orphan definition"],
      },
    });

    const uris = new Set(locs.map((l) => l.uri));
    expect(uris.has("handler.ts")).toBe(true);
    expect(uris.has("handler.integration.test.ts")).toBe(true);
    expect(uris.has("repair.ts")).toBe(true);
    expect(uris.has("index.ts")).toBe(true);
  });

  it("dedupes by (uri, line-range) and merges near-overlapping ranges", () => {
    const input: CiteLocation[] = [
      { uri: "handler.ts", lineStart: 20, lineEnd: 25, source: "a" },
      { uri: "handler.ts", lineStart: 24, lineEnd: 30, source: "b" },
      { uri: "handler.ts", lineStart: 20, lineEnd: 25, source: "c" },
      { uri: "repair.ts", source: "d" },
    ];
    const out = dedupeLocations(input);
    const handler = out.filter((l) => l.uri === "handler.ts");
    expect(handler).toHaveLength(1);
    expect(handler[0]!.lineStart).toBe(20);
    expect(handler[0]!.lineEnd).toBe(30);
    expect(out.some((l) => l.uri === "repair.ts" && l.lineStart == null)).toBe(true);
  });

  it("peeks real current fixture bytes for cited locations", () => {
    const locs = deriveCitedLocations({
      event: {
        evidence: [
          {
            kind: "source_location",
            uri: "handler.ts",
            line_start: 20,
            line_end: 28,
            claim_supported: true,
          },
        ],
      },
      prior: {
        directives: [
          {
            id: "d-1",
            targets: ["handler.integration.test.ts"],
            required_evidence: ["dirty-record case"],
            completion_criteria: ["x"],
            reason: "x",
            action: "x",
            stop_conditions: [],
          },
        ],
      },
    });
    const windows = peekCitedLocations(FIXTURE, locs);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    const handler = windows.find((w) => w.path === "handler.ts" || w.path.endsWith("handler.ts"));
    expect(handler).toBeTruthy();
    expect(handler!.text).toMatch(/handleBatch|validateCallRecord|drop/i);
    const integ = windows.find((w) => w.path.includes("handler.integration.test"));
    expect(integ).toBeTruthy();
    // Decoy fixture: clean-record tests only — the content the judge must NOT over-read as proof.
    expect(integ!.text).toMatch(/clean|inbound|stores/i);
  });

  it("path-guard fences the peek: denied/escape cites never read (Gotcha rail)", () => {
    // Basenames with no in-workspace twin, so the basename fallback can't
    // accidentally serve an unrelated same-named file — this isolates the guard.
    const locs: CiteLocation[] = [
      { uri: "node_modules/evil/backdoor.ts", lineStart: 1, lineEnd: 5, source: "attack" },
      { uri: "external/vendor/secretlib.ts", lineStart: 1, lineEnd: 5, source: "attack" },
      { uri: "../../../etc/hostsfile.ts", source: "attack" },
    ];
    const windows = peekCitedLocations(FIXTURE, locs);
    expect(windows).toHaveLength(0);
    // Even if some in-workspace basename twin existed, no window may point into
    // a denied tier — the guard must fence node_modules/external/escapes.
    expect(windows.every((w) => !/node_modules|external/.test(w.path))).toBe(true);
  });

  it("renders the founder-safe header (never pre-judged/verified/evidence)", () => {
    const block = renderJudgePrefetchBlock(
      [
        {
          path: "handler.ts",
          lineStart: 1,
          lineEnd: 3,
          totalLines: 40,
          text: "1|// stub\n2|export function x() {}\n3|",
        },
      ],
      12,
    );
    expect(block).toContain(JUDGE_PREFETCH_HEADER);
    // Header states it is real current file content pre-fetched from the cited
    // locations, to verify further, a head start and not a verdict (honesty rail).
    expect(JUDGE_PREFETCH_HEADER).toMatch(/real current file content/i);
    expect(JUDGE_PREFETCH_HEADER).toMatch(/verify further/i);
    // Must not *label* content as pre-judged / verified / evidence-as-proof.
    expect(block.toLowerCase()).not.toMatch(
      /\b(pre-judged|verified evidence|this is evidence that|already verified)\b/,
    );
    expect(block).toContain("head start");
    expect(block).toContain("not a verdict");
  });

  it("DEFAULT-ON: enabled for edge-walk judge unless NAVI_JUDGE_PREFETCH disables it", () => {
    const prev = process.env.NAVI_JUDGE_PREFETCH;
    try {
      // Unset means default-on.
      delete process.env.NAVI_JUDGE_PREFETCH;
      expect(judgePrefetchEnabled("edge-walk", "judge")).toBe(true);
      // Emergency-disable values.
      for (const off of ["0", "off", "false", "OFF", "False"]) {
        process.env.NAVI_JUDGE_PREFETCH = off;
        expect(judgePrefetchEnabled("edge-walk", "judge")).toBe(false);
      }
      // Any other value keeps it on.
      for (const on of ["1", "true", "yes", ""]) {
        process.env.NAVI_JUDGE_PREFETCH = on;
        expect(judgePrefetchEnabled("edge-walk", "judge")).toBe(true);
      }
      // Scope rail: only the edge-walk judge step, even when enabled.
      delete process.env.NAVI_JUDGE_PREFETCH;
      expect(judgePrefetchEnabled("edge-walk", "recon")).toBe(false);
      expect(judgePrefetchEnabled("edge-walk", "expand")).toBe(false);
      expect(judgePrefetchEnabled("founder", "judge")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NAVI_JUDGE_PREFETCH;
      else process.env.NAVI_JUDGE_PREFETCH = prev;
    }
  });
});
