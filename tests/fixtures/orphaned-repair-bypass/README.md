# Fixture: `orphaned-repair-bypass`

A variant of `orphaned-repair` (see that fixture for the base anatomy). The
seven baseline files are unchanged, **plus a second, genuinely-wired production
entry point**: `src/batch-import.ts` (a nightly backfill / reconciliation job)
whose `importBatch` **does** correctly repair-then-revalidate before dropping,
with a real integration test in `src/batch-import.test.ts`.

**This fixture is NOT "un-wired".** `repairCallRecord` is genuinely called from
the runtime in `batch-import.ts`. The seam is a **bypass**: the *primary,
default, live* ingest path — `index.ts` → `handler.ts` (`ingest` →
`handleBatch`) — still drops every record that fails validation
(`handler.ts:27`) without ever routing it through `repairCallRecord`. Two entry
points now produce the same externally visible effect (a record stored, or a
record dropped); only one of them repairs. The bug is the **absence of a repair
call on the primary path**, not code quality and not an absence of any repair
call anywhere — `batch-import.ts` and `repairCallRecord` are both correct.

This variant exists to catch the classic false-negative shape a bypassed entry
point produces on a shallow reviewer: treating the correctly-wired backfill path
as proof that the whole pipeline is fixed, and never noticing the primary path is
still bypassed.

## The mini-codebase (`src/`)

`edge-walk` runs with the workspace root pointed at **`src/`** (e.g.
`navi run edge-walk -w tests/fixtures/orphaned-repair-bypass/src …`), so recon
sees only the service, not this README or the payloads. All citation `uri`s are
therefore **relative to `src/`** (bare filenames: `repair.ts`, `handler.ts`).

| file | role |
|---|---|
| `index.ts` | Primary entry point: `ingest(batch)` → runs the handler chain. **On the seam** — this path never repairs. |
| `handler.ts` | The live ingest chain: validate → store. **The seam lives here** — dropped records are never routed through repair (`handler.ts:27`). |
| `validate.ts` | Strict `validateCallRecord`; does not salvage, only accepts/rejects. |
| `records.ts` | `RawCallRecord` / `CallRecord` domain types. |
| `repair.ts` | Implements + exports `repairCallRecord`. Imported by its own test **and** by `batch-import.ts` (the backfill path). |
| `storage.ts` | The output sink (`storeCallRecord`). |
| `repair.test.ts` | Unit test: exercises `repairCallRecord` directly. Never touches `handleBatch`/`ingest`/`importBatch`. |
| `batch-import.ts` | **Second production entry point** (nightly backfill). `importBatch` validates, then on failure repairs + re-validates before dropping — the *correctly-wired* path. Not the seam. |
| `batch-import.test.ts` | **Real** integration test (not a decoy): drives `importBatch` with a genuinely dirty record and proves it is repaired and stored. Green because `batch-import.ts` really is wired. |

**The seam, one sentence:** the primary ingest path (`index.ts` → `handler.ts`)
drops every record that fails validation (`handler.ts:27`) instead of routing it
through `repairCallRecord` (`repair.ts:11`) and re-validating — even though the
backfill path (`batch-import.ts`) already does exactly that. The seam is the
primary path's bypass, not the absence of a repair call anywhere in the tree.

## Payloads (`payloads/`)

Each file is a whole **stdin object** for `navi run edge-walk --stdin` — the
entire object binds to the workflow's `input`, and the event is read as
`input.event`, matching the CLI's stdin binding.

| file | what it is |
|---|---|
| `event.json` | The parent event that starts the session: a **partially-true** completion claim. Every citation (`repair.ts`, `repair.test.ts`, `batch-import.ts`, `batch-import.test.ts`) is real, green, and truthful — the claim is false only by **omission**: it is silent about `handler.ts`/`index.ts`, the still-live primary path that never repairs. Nothing cited is fabricated. Carries no `directive_id`/`evidence`, so the CLI's weak-evidence gate treats it as pass-through (not gated). |
| `evidence-weak.json` | A continuation evidence return citing `batch-import.ts`'s real repair call site **and** a real, fresh, passing `batch-import.test.ts` result — **objectively strong evidence, but for the wrong directive**. If the judge correctly scoped the open directive to `handler.ts`/`index.ts`, this evidence about a *different file* must not satisfy it (adjudication check 2: does it support *the specific claim it is offered for*). This double-tests judge discipline: not just evidence quality, but evidence *targeting*. Note: `directive_id` matching is judge-prompt discipline only, not code-validated (see below). |
| `evidence-strong.json` | A continuation evidence return: a **call-site** `source_location` in `handler.ts` + a `call_path` entry + a `test_result` with `fresh_for_revision`. Describes the state *after* the primary path is also wired. The judge should clear on it. |

### Placeholder substitutions (runner-facing)

The payloads are static; two values are computed at run time and must be
substituted before the payload is piped to `navi`:

- **`DIRECTIVE_ID_PLACEHOLDER`** (in both evidence payloads) — the judge mints the
  directive id at run time. After the `event.json` run returns a directive, take
  its `id` and substitute it into the evidence payload's `directive_id`.
  **Important for this variant:** `EvidenceEvent.directive_id` is *not*
  code-validated against the session's open directives (the CLI extracts only the
  `evidence` array; matching evidence to the right directive is judge-prompt
  discipline only). So even with the correct `directive_id` substituted, the
  mistargeted `evidence-weak.json` is a genuine test of whether the judge applies
  the adjudication checks against the *directive's target* (`handler.ts`) rather
  than accepting any green evidence at face value.
- **`REVISION_PLACEHOLDER`** (in `evidence-weak.json` and `evidence-strong.json`,
  `fresh_for_revision`) — the git HEAD the test was run against. Substitute the
  current revision, e.g.:
  ```sh
  sed "s/REVISION_PLACEHOLDER/$(git -C tests/fixtures/orphaned-repair-bypass/src rev-parse HEAD)/" \
    payloads/evidence-strong.json | ./node_modules/.bin/tsx src/cli.ts run edge-walk --json --stdin -t <session_id>
  ```

Both placeholders are plain strings, so the payloads **already pass the
structural `EvidenceEvent` gate unsubstituted** — substitution only makes the
values semantically live, it is never needed to clear the schema check.

### Note on the strong-evidence CLEAR path (the primary path is un-wired)

The shipped `src/` tree has the **primary ingest path un-wired**: `handler.ts`
genuinely does not call `repairCallRecord`. (The backfill path, `batch-import.ts`,
*is* fully wired from the start — do not read "un-wired" as applying to the whole
tree.) `evidence-strong.json` describes the state *after* the primary path is
also wired: the call site it cites (`handler.ts:27`, inside the `else`/dropped
branch) and the `test_result` it names (`handler.integration.test.ts`) do not
exist in the baseline. The judge **re-reads cited locations**, so for the
strong-evidence run to legitimately CLEAR, the runner must first wire
`handler.ts` (or `index.ts`) to route dropped records through `repairCallRecord`
+ re-validate — mirroring `batch-import.ts`'s approach — add a fresh integration
test (`handler.integration.test.ts`), and recompute HEAD for
`REVISION_PLACEHOLDER`. Presented against the baseline (primary path still
bypassed), even the "strong" bundle is correctly un-verifiable — a valid negative
control.

## Suite / typecheck integration

- **Vitest** discovers `tests/**/*.test.ts`, which would sweep this fixture's
  `repair.test.ts` and `batch-import.test.ts`. `vitest.config.ts` excludes
  `tests/fixtures/**` at any depth (fixtures are test *data*, never suites), so
  neither is run and the suite count is unchanged.
- **Typecheck** (`tsc --noEmit`) has `include: ["src/**/*"]`, so it never sweeps
  `tests/fixtures/**`; the fixture is not part of the repo build. It is still
  written to typecheck cleanly on its own.
