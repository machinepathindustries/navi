import { handleBatch, type HandlerResult } from "./handler.ts";
import type { RawCallRecord } from "./records.ts";

// Entry point for the call-record ingest service. A batch of raw records
// arrives from the upstream switch feed; `ingest` runs the handler chain over
// them and returns the batch result (what was stored, what was dropped).
export function ingest(batch: RawCallRecord[]): HandlerResult {
  return handleBatch(batch);
}

export type { RawCallRecord, CallRecord } from "./records.ts";
export type { HandlerResult } from "./handler.ts";
