import { validateCallRecord } from "./validate.ts";
import { repairCallRecord } from "./repair.ts";
import { storeCallRecord } from "./storage.ts";
import type { RawCallRecord, CallRecord } from "./records.ts";

export interface ImportResult {
  stored: CallRecord[];
  dropped: RawCallRecord[];
}

// Bulk backfill entry point (nightly reconciliation job). Unlike the live ingest
// chain (handler.ts), this path salvages a dirty record via repairCallRecord
// before giving up: validate, and only on failure attempt repair + re-validate.
export function importBatch(raw: RawCallRecord[]): ImportResult {
  const stored: CallRecord[] = [];
  const dropped: RawCallRecord[] = [];

  for (const record of raw) {
    let result = validateCallRecord(record);
    if (!result.ok) {
      result = validateCallRecord(repairCallRecord(record));
    }
    if (result.ok) {
      storeCallRecord(result.record);
      stored.push(result.record);
    } else {
      dropped.push(record);
    }
  }

  return { stored, dropped };
}
