// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// ONE owner for navi's human-facing look. Every colorizer is pure: takes the
// text and a `tty` flag the CALLER passes (stdout.isTTY for stdout renders,
// stderr.isTTY for stderr). Plain text always carries full structure; ANSI is
// garnish only. Visual signature = the labeled rule (`── next ──…`).

import { match, P } from "ts-pattern";

/** Total character width of a `rule()` line (unicode box-drawing dashes). */
const RULE_WIDTH = 62;

/**
 * Labeled rule: `── <label> ──` padded with `─` to RULE_WIDTH.
 * Empty label → a plain full-width dash line (no color).
 */
export function rule(label: string): string {
  return match(label)
    .with("", () => "─".repeat(RULE_WIDTH))
    .otherwise((l) => {
      const core = `── ${l} ──`;
      return core + "─".repeat(Math.max(0, RULE_WIDTH - core.length));
    });
}

/** Generic ANSI SGR wrapper. Off-TTY returns text unchanged. */
export function paintCode(code: string, t: string, tty: boolean): string {
  return match(tty)
    .with(true, () => `\x1b[${code}m${t}\x1b[0m`)
    .with(false, () => t)
    .exhaustive();
}

export function bold(t: string, tty: boolean): string {
  return paintCode("1", t, tty);
}

export function dim(t: string, tty: boolean): string {
  return paintCode("2", t, tty);
}

/** Cyan (36) — command tokens and other accent. */
export function accent(t: string, tty: boolean): string {
  return paintCode("36", t, tty);
}

/**
 * Status/gate string → ANSI color code. Green = healthy/terminal-good,
 * yellow = in-progress/needs-work, red = escalated/blocked, dim = unknown.
 * ONE owner — session-view (and any other human render) imports this.
 */
export function statusCode(status: string): string {
  return match(status)
    .with(P.union("CLEAR", "COMPLETE", "DIRECT", "active", "clear", "complete"), () => "32")
    .with(P.union("awaiting_parent", "REPAIR", "new"), () => "33")
    .with(P.union("ESCALATE", "BLOCKED", "escalated", "blocked", "failed"), () => "31")
    .otherwise(() => "2");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Deterministic relative time from an ISO timestamp.
 * <60s "just now", <60m "Nm ago", <24h "Nh ago", <7d "Nd ago", else "Jul 20".
 * `now` defaults to Date.now() but is injectable for tests.
 */
export function relTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  return match(Number.isNaN(then))
    .with(true, () => iso)
    .with(false, () => {
      const sec = Math.floor((now - then) / 1000);
      return match(sec)
        .when(
          (s) => s < 60,
          () => "just now",
        )
        .when(
          (s) => s < 3600,
          (s) => `${Math.floor(s / 60)}m ago`,
        )
        .when(
          (s) => s < 86400,
          (s) => `${Math.floor(s / 3600)}h ago`,
        )
        .when(
          (s) => s < 604800,
          (s) => `${Math.floor(s / 86400)}d ago`,
        )
        .otherwise(() => {
          const d = new Date(iso);
          return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
        });
    })
    .exhaustive();
}

// --- human excerpt (clause-boundary cut) -----------------------------------
// ONE owner for "shorten long prose for a human surface without mid-word cuts".
// Catalog's when-to-use labels and the session story's parent/reason lines both
// need the same discipline: a finished-looking clause when possible, else a
// word-boundary ellipsis. Cap is the caller's (menu labels want ~64; story
// beats want more breathing room). Do not fork a second truncator.

/** Clause boundaries for a finished-looking cut (no trailing ellipsis). */
const CLAUSE_BOUNDARIES = [" — ", ":", ",", ";"] as const;

// Last clause-boundary index at or before `cap`, or -1 when none.
function lastClauseAt(s: string, cap: number): number {
  const window = s.slice(0, cap);
  return CLAUSE_BOUNDARIES.reduce((best, b) => Math.max(best, window.lastIndexOf(b)), -1);
}

/**
 * Human excerpt of free prose. Collapse whitespace; prefer the first sentence
 * (up to and including the first `.`); then cap to `cap`. Prefer a clause
 * boundary (`:` `,` `;` ` — `) at/before the cap and DROP the ellipsis (a
 * complete clause reads finished). Only when no clause boundary exists fall
 * back to a word-boundary cut + `…` — never mid-word.
 */
export function shortClause(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return match(oneLine)
    .with("", () => "")
    .otherwise((s) =>
      match(
        match(s.match(/^[^.]*\./))
          .with(P.nullish, () => s)
          .otherwise((m) => (m[0] ?? s).trim()),
      )
        .when(
          (c) => c.length > cap,
          (c) =>
            match(lastClauseAt(c, cap))
              .when(
                (i) => i > 0,
                // Complete clause — no ellipsis. Cut at the boundary start and
                // trimEnd so trailing punct/spaces from the boundary drop cleanly.
                (i) => c.slice(0, i).trimEnd(),
              )
              .otherwise(() =>
                // Last whitespace at or before the cap — never slice mid-word.
                match(c.slice(0, cap).lastIndexOf(" "))
                  .when(
                    (i) => i > 0,
                    (i) => `${c.slice(0, i).trimEnd()}…`,
                  )
                  .otherwise(() => `${c.slice(0, cap).trimEnd()}…`),
              ),
        )
        .otherwise((c) => c),
    );
}
