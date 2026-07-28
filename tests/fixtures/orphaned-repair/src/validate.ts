import type { RawCallRecord, CallRecord } from "./records.ts";

// Strict validation for a raw call record. A record either passes cleanly and
// becomes a storable `CallRecord`, or it is rejected with a human-readable
// reason. Validation does NOT mutate or salvage input — cleaning dirty records
// is `repairCallRecord`'s job (see repair.ts).

export type ValidationResult =
  | { ok: true; record: CallRecord }
  | { ok: false; reason: string };

// A minimal E.164 check: a leading "+", a non-zero country digit, then 6–14 more.
const E164 = /^\+[1-9]\d{6,14}$/;

export function validateCallRecord(raw: RawCallRecord): ValidationResult {
  if (!raw.id) return { ok: false, reason: "missing id" };
  if (!E164.test(raw.from)) return { ok: false, reason: `from not E.164: ${raw.from}` };
  if (!E164.test(raw.to)) return { ok: false, reason: `to not E.164: ${raw.to}` };
  if (raw.direction !== "inbound" && raw.direction !== "outbound")
    return { ok: false, reason: `unknown direction: ${raw.direction ?? "(absent)"}` };
  if (typeof raw.durationMs !== "number" || raw.durationMs < 0)
    return { ok: false, reason: "missing or negative durationMs" };
  return {
    ok: true,
    record: {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      direction: raw.direction,
      durationMs: raw.durationMs,
    },
  };
}
