---
name: seam-taxonomy
description: >-
  The vocabulary of seams for expanding a task past its literal wording: twelve
  defect-shaped seam kinds — orphaned implementation, partial wiring, bypassed
  entry point, contract drift, writer/reader mismatch, stale cache, concurrency,
  failure-handling, authorization bypass, unit-only proof, misplaced
  responsibility, operational — each with a concrete detection cue. Load when a
  step must take a change past "looks fine" and decide which real seams it opens;
  supplies the kinds to check and how to spot them, not the map's output shape.
version: 0.1.0
tags:
  - seams
  - taxonomy
  - review
---

# Seam Taxonomy

Seam kinds are the vocabulary for expanding a task past its literal wording. A
real change rarely stops at the lines it edits; it opens seams — boundaries
where the edit's assumptions can quietly fail to hold. Run the task against
these kinds so it gets expanded past its face value instead of stopping at
"looks fine." How the resulting map is written down is not this skill's
concern; this skill supplies the kinds and the cues that flag them.

## The seam kinds

Each is a one-line definition and a concrete cue that should make you suspect
it.

- **Orphaned implementation** — new or changed logic exists but no confirmed
  caller reaches it from a real trigger. *Cue:* searching for the symbol
  outside its own file returns nothing, or only test-file hits.
- **Partial wiring** — the change is applied in some of the places it needs to
  be, not all of them. *Cue:* the same symbol, field, or check exists in more
  than one similar location (two serializers, two handlers) and only one was
  touched.
- **Bypassed entry point** — a second path reaches the same externally visible
  effect without going through the changed code. *Cue:* more than one call
  path produces the same outcome; only one has been traced.
- **Contract / representation drift** — data or an interface changes shape at a
  boundary (domain object ↔ DTO, wire format, DB row ↔ app object, public API,
  config schema) and the other side was not updated to match. *Cue:* a shared
  field or type name appears on both sides of a boundary with different shapes,
  or a public signature changed with no matching caller update.
- **Writer/reader mismatch** — new data is written in a new shape; existing
  persisted data, or a reader still on old assumptions, is not accounted for.
  *Cue:* a serializer or writer changed but no change or test touches the
  matching loader or reader.
- **Stale state / cache seam** — cached, memoized, or retained state is not
  invalidated when its source changes. *Cue:* a cache, memo, or singleton
  holds data derived from the changed source, and no invalidation call site
  sits near the change.
- **Concurrency / retry seam** — behavior assumes a single uninterrupted
  execution; no defined behavior for retry, duplicate delivery, cancellation,
  or a race. *Cue:* a side-effecting operation (write, send, charge) has no
  idempotency key or duplicate check nearby.
- **Failure-handling seam** — an error is caught, logged, or translated in a
  way that loses information, or a failure path performs no cleanup or
  compensation. *Cue:* a catch block with no rethrow, no telemetry, and no
  compensating action.
- **Authorization bypass** — an alternate path to the same mutation skips a
  permission check that guards the primary path. *Cue:* two call paths
  converge on one side effect; only one is preceded by an authz check.
- **Unit-only proof** — the only test exercises a helper in isolation, not the
  integrated runtime path. *Cue:* the test imports the function directly rather
  than driving it through its production trigger (command, route, handler,
  job).
- **Misplaced responsibility** — a fix lands in one convenient caller rather
  than the component that should own the concern (validation, retries,
  persistence), leaving sibling callers exposed. *Cue:* the same responsibility
  is duplicated at one call site instead of centralized.
- **Operational / deployment seam** — behavior depends on deployment order,
  feature-flag state, rollback, or config precedence that was not traced.
  *Cue:* a flag, env var, or config key is referenced without confirming which
  value actually wins at runtime.

## Prioritize — do not checklist

Do not run every kind against every task. A checklist produces generic,
unranked findings and hands the work back to the parent. Pick the seam(s) with
the strongest concrete cue and the highest blast radius for *this* task, and go
only as deep as the task's risk warrants — persistence, concurrency, security,
public contracts, and migrations justify more digging than a small local
change does. Record unrelated observations separately rather than letting them
hijack the map.

## Flag unknowns — do not fabricate

When there isn't enough evidence within budget to confirm or rule out a
suspected seam, say so explicitly. Do not guess it into existence, and do not
drop it silently — a suspicion named as unknown is honest; an invented seam or
a quietly abandoned one is not.
