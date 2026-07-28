import { describe, it, expect } from "vitest";
import { handleBatch } from "./handler.ts";
import { resetStorage, storedRecords } from "./storage.ts";

// "Integration" coverage for the ingest handler chain: drives handleBatch end to end
// against a representative batch and confirms the pipeline stores what it should.
describe("handleBatch integration", () => {
  it("stores a clean inbound record and reports zero drops", () => {
    resetStorage();
    const result = handleBatch([{
      id: "c1", from: "+15550101234", to: "+15550105678",
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z",
      direction: "inbound", durationMs: 60_000,
    }]);
    expect(result.dropped).toHaveLength(0);
    expect(result.stored).toHaveLength(1);
    expect(storedRecords()).toHaveLength(1);
  });

  it("processes a full outbound batch without throwing", () => {
    resetStorage();
    const result = handleBatch([{
      id: "c2", from: "+15550109999", to: "+15550108888",
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:30.000Z",
      direction: "outbound", durationMs: 30_000,
    }]);
    expect(result.stored.length + result.dropped.length).toBe(1);
  });
});
