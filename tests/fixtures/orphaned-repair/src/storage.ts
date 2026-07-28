import type { CallRecord } from "./records.ts";

// The output sink for validated call records. A trivial in-memory store stands
// in for whatever durable target (a warehouse table, a queue) the real service
// would write to; the shape of the ingest boundary is what matters here.

const sink: CallRecord[] = [];

export function storeCallRecord(record: CallRecord): void {
  sink.push(record);
}

export function storedRecords(): readonly CallRecord[] {
  return sink;
}

export function resetStorage(): void {
  sink.length = 0;
}
