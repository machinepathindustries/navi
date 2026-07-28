import { describe, it, expect } from "vitest";
import { importBatch } from "./batch-import.ts";
import { resetStorage, storedRecords } from "./storage.ts";

// Real integration test for the backfill entry point. Unlike repair.test.ts,
// which calls repairCallRecord directly, this drives the production trigger
// (importBatch) end to end and proves the repair-then-revalidate path genuinely
// salvages a truly dirty record — it is stored, not dropped. This test is NOT a
// decoy: importBatch really is wired to repair. The seam in this variant is the
// OTHER entry point (handler.ts / ingest), which this test does not touch.
describe("importBatch", () => {
  it("salvages a dirty record via repair and stores it", () => {
    resetStorage();
    const result = importBatch([{
      id: "c4",
      from: "1-555-010-1234", // not E.164 — needs repair
      to: "1-555-010-5678", // not E.164 — needs repair
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:45.000Z",
      // direction and durationMs absent — repair backfills them
    }]);
    expect(result.stored).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(result.stored[0].from).toBe("+15550101234");
    expect(storedRecords()).toHaveLength(1);
  });

  it("stores an already-clean record without needing repair", () => {
    resetStorage();
    const result = importBatch([{
      id: "c1",
      from: "+15550101234",
      to: "+15550105678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      direction: "inbound",
      durationMs: 60_000,
    }]);
    expect(result.stored).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops a record that is unsalvageable even after repair", () => {
    resetStorage();
    const result = importBatch([{
      id: "", // missing id — repair cannot fix this, validation still fails
      from: "1-555-010-1234",
      to: "1-555-010-5678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:45.000Z",
    }]);
    expect(result.stored).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });
});
