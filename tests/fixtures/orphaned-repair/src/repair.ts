import type { RawCallRecord } from "./records.ts";

// Salvage a dirty call record so it can pass validation instead of being
// dropped: normalize both phone numbers to E.164, backfill `durationMs` from
// the timestamps when it is absent, and default a missing `direction` to
// "inbound". Pure — returns a new record and never mutates the input.
//
// Intended use: the ingest pipeline should route any record that FAILS
// validation through here, then re-validate the repaired record before giving
// up on it (see handler.ts).
export function repairCallRecord(raw: RawCallRecord): RawCallRecord {
  return {
    ...raw,
    from: normalizeNumber(raw.from),
    to: normalizeNumber(raw.to),
    direction: raw.direction ?? "inbound",
    durationMs: raw.durationMs ?? computeDurationMs(raw.startedAt, raw.endedAt),
  };
}

// Strip everything but digits and re-apply the leading "+", turning switch
// noise like "1 (555) 010-1234" or "1-555-010-1234" into "+15550101234".
function normalizeNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return `+${digits}`;
}

// Duration in milliseconds between two ISO timestamps; 0 if either is unparseable.
function computeDurationMs(startedAt: string, endedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}
