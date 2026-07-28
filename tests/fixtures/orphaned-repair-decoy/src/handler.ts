import { validateCallRecord } from "./validate.ts";
import { storeCallRecord } from "./storage.ts";
import type { RawCallRecord, CallRecord } from "./records.ts";

export interface HandlerResult {
  stored: CallRecord[];
  dropped: RawCallRecord[];
}

// The ingest chain for a batch of raw call records. Each record is validated;
// the ones that pass are stored, and the ones that fail are collected in
// `dropped` for the batch report.
//
// A dropped record is one the switch feed sent dirty — an un-normalized number,
// an absent duration or direction. Those are exactly the records repair.ts was
// written to salvage before they are given up on.
export function handleBatch(raw: RawCallRecord[]): HandlerResult {
  const stored: CallRecord[] = [];
  const dropped: RawCallRecord[] = [];

  for (const record of raw) {
    const result = validateCallRecord(record);
    if (result.ok) {
      storeCallRecord(result.record);
      stored.push(result.record);
    } else {
      dropped.push(record);
    }
  }

  return { stored, dropped };
}
