// Domain types for the call-detail-record (CDR) ingest service.
//
// A `RawCallRecord` is what arrives from the upstream switch feed: often dirty
// — un-normalized phone numbers, a missing duration, an absent direction. A
// `CallRecord` is the clean, storable shape every downstream consumer relies on.

export interface RawCallRecord {
  id: string;
  from: string;
  to: string;
  startedAt: string; // ISO-8601 timestamp
  endedAt: string; // ISO-8601 timestamp
  direction?: string;
  durationMs?: number;
}

export interface CallRecord {
  id: string;
  from: string; // E.164, e.g. "+15550101234"
  to: string; // E.164
  startedAt: string;
  endedAt: string;
  direction: "inbound" | "outbound";
  durationMs: number;
}
