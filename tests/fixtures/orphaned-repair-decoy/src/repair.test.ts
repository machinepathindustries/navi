import { describe, it, expect } from "vitest";
import { repairCallRecord } from "./repair.ts";
import { validateCallRecord } from "./validate.ts";

// Unit tests for repairCallRecord. These exercise the function directly and
// prove it does its job — including that a repaired record then passes strict
// validation. They do NOT exercise the ingest pipeline (handler.ts): nothing
// here calls handleBatch or ingest, so a green run says only that repair WORKS,
// never that it is WIRED into the runtime path.

describe("repairCallRecord", () => {
  it("normalizes dirty phone numbers to E.164", () => {
    const repaired = repairCallRecord({
      id: "c1",
      from: "1 (555) 010-1234",
      to: "+1 555 010 5678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(repaired.from).toBe("+15550101234");
    expect(repaired.to).toBe("+15550105678");
  });

  it("backfills durationMs from the timestamps when absent", () => {
    const repaired = repairCallRecord({
      id: "c2",
      from: "+15550101234",
      to: "+15550105678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
    });
    expect(repaired.durationMs).toBe(30_000);
  });

  it("defaults a missing direction to inbound", () => {
    const repaired = repairCallRecord({
      id: "c3",
      from: "+15550101234",
      to: "+15550105678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:30.000Z",
    });
    expect(repaired.direction).toBe("inbound");
  });

  it("produces a record that then passes strict validation", () => {
    const dirty = {
      id: "c4",
      from: "1-555-010-1234",
      to: "1-555-010-5678",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:45.000Z",
    };
    const repaired = repairCallRecord(dirty);
    const result = validateCallRecord(repaired);
    expect(result.ok).toBe(true);
  });
});
