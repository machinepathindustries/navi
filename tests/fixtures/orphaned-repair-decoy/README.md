# Fixture: `orphaned-repair-decoy`

A variant of `orphaned-repair` (see that fixture for the base anatomy). The
`src/` tree is the **same un-wired baseline** — `handler.ts` still never calls
`repairCallRecord`, so the one seeded seam is unchanged — **plus one more
convincing decoy**: `src/handler.integration.test.ts`, a real test that
genuinely drives `handleBatch` end to end, yet only ever feeds it **already-clean
records**, so the validation-failure branch (`handler.ts:27`) is never taken and
`repairCallRecord` is never reached.

This variant exists to defeat the shallow heuristic "did a test actually call
`handleBatch`?" — here one did, and it is green, and it proves nothing about
whether dirty records are repaired. navi must still find the missing wiring,
reject the decoy's genuinely-green test result as evidence, and clear only on
**strong** evidence that actually drives a record through the repair branch.

The bug is the **absence of a call** (missing wiring), never code quality —
`repairCallRecord` itself is correct and thoroughly tested. What makes this
variant's decoy tempting is that the parent plan (see `payloads/event.json`) now
claims the task is "verified end-to-end" and cites `handler.integration.test.ts`
as proof — a real, green integration test that really runs the pipeline, but
against clean input only.

## The mini-codebase (`src/`)

`edge-walk` runs with the workspace root pointed at **`src/`** (e.g.
`navi run edge-walk -w tests/fixtures/orphaned-repair-decoy/src …`), so recon
sees only the service, not this README or the payloads. All citation `uri`s are
therefore **relative to `src/`** (bare filenames: `repair.ts`, `handler.ts`).

| file | role |
|---|---|
| `index.ts` | Entry point: `ingest(batch)` → runs the handler chain. |
| `handler.ts` | The ingest chain: validate → store. **The seam lives here** — dropped records are never routed through repair. |
| `validate.ts` | Strict `validateCallRecord`; does not salvage, only accepts/rejects. |
| `records.ts` | `RawCallRecord` / `CallRecord` domain types. |
| `repair.ts` | Implements + exports `repairCallRecord` (the orphan — imported ONLY by its test). |
| `storage.ts` | The output sink (`storeCallRecord`). |
| `repair.test.ts` | Decoy unit test: exercises `repairCallRecord` directly (incl. that a repaired record then passes validation). Never touches `handleBatch`/`ingest`. |
| `handler.integration.test.ts` | **The variant's decoy.** A real "integration" test that genuinely drives `handleBatch` end to end — but every record it feeds is already clean, so the drop branch (`handler.ts:27`) is never taken and `repairCallRecord` is never reached. Green, honest, and structurally incapable of exercising the seam. |

**The seam, one sentence:** `handler.ts` drops every record that fails
validation (`handler.ts:27`) instead of first routing it through
`repairCallRecord` (`repair.ts:11`) and re-validating — repair is imported only
by `repair.test.ts`, so it is dead runtime weight. `handler.integration.test.ts`
runs the pipeline but never sends a record down the failure branch, so it does
not close the seam and does not even touch it.

## Payloads (`payloads/`)

Each file is a whole **stdin object** for `navi run edge-walk --stdin` — the
entire object binds to the workflow's `input`, and the event is read as
`input.event`, matching the CLI's stdin binding.

| file | what it is |
|---|---|
| `event.json` | The parent event that starts the session: task + a plan claiming completion, now citing `repair.ts` + `repair.test.ts` **and** `handler.integration.test.ts` as end-to-end proof. Carries no `directive_id`/`evidence`, so the CLI's weak-evidence gate treats it as pass-through (not gated). |
| `evidence-weak.json` | A continuation evidence return: a `test_result` citing the decoy `handler.integration.test.ts` — a **genuinely green, genuinely fresh** result (`exit_code: 0`, real `fresh_for_revision`). It passes adjudication checks 1 (inspectable artifact) and 3 (fresh for revision); its weakness is that it fails checks 2 and 4 — it does not support *this* claim (that dirty records are repaired) and it does not trace the seam end to end (the test never drives a record through the repair branch). A strictly harder probe than the base fixture's definition-citation weak payload. The judge must still reject it. |
| `evidence-strong.json` | A continuation evidence return: a **call-site** `source_location` in `handler.ts` + a `call_path` entry + a `test_result` with `fresh_for_revision`. The bundle that proves the wiring is real and freshly tested. The judge should clear on it. |

### Placeholder substitutions (runner-facing)

The payloads are static; two values are computed at run time and must be
substituted before the payload is piped to `navi`:

- **`DIRECTIVE_ID_PLACEHOLDER`** (in both evidence payloads) — the judge mints the
  directive id at run time. After the `event.json` run returns a directive, take
  its `id` and substitute it into the evidence payload's `directive_id`.
- **`REVISION_PLACEHOLDER`** (in `evidence-weak.json` and `evidence-strong.json`,
  `fresh_for_revision`) — the git HEAD the test was run against. Substitute the
  current revision, e.g.:
  ```sh
  sed "s/REVISION_PLACEHOLDER/$(git -C tests/fixtures/orphaned-repair-decoy/src rev-parse HEAD)/" \
    payloads/evidence-strong.json | ./node_modules/.bin/tsx src/cli.ts run edge-walk --json --stdin -t <session_id>
  ```

Both placeholders are plain strings, so the payloads **already pass the
structural `EvidenceEvent` gate unsubstituted** — substitution only makes the
values semantically live, it is never needed to clear the schema check.

### Note on the strong-evidence CLEAR path — and the decoy filename collision

The shipped `src/` tree is the **un-wired baseline** — `handler.ts` genuinely
does not call `repairCallRecord`. `evidence-strong.json` describes the state
*after* the one-line wiring is added: the call site it cites (`handler.ts:27`,
inside the `else`/dropped branch) does not exist in the baseline, and the
`test_result` it names (`handler.integration.test.ts`) exists **but is the
decoy** — a clean-records-only test that does not yet exercise the repair branch.

**Collision hazard (variant-specific, do not miss this):** the strong-evidence
payload names `handler.integration.test.ts`, and this variant already ships a
file of that exact name (the decoy). When the runner applies the real wiring fix,
it must **EXTEND the existing `handler.integration.test.ts` with a genuinely
dirty-record case** (route a dirty record through `handleBatch`, assert it is
repaired and stored rather than dropped) — **never create a second file of the
same name, and never overwrite the decoy's clean-record cases**. Extending the
existing file is what a real developer fixing the bug would do (add a case to the
file that already claims to test this path), and it keeps the fixture's file
count stable across the un-wired/wired revisions — which matters if the repeat
runner ever diffs file lists between runs. So the legitimate CLEAR path is:
(1) wire `handler.ts` to route dropped records through `repairCallRecord` +
re-validate; (2) add a dirty-record case to the existing
`handler.integration.test.ts`; (3) recompute HEAD for `REVISION_PLACEHOLDER`.
Presented against the un-wired baseline, even the "strong" bundle is correctly
un-verifiable — a valid negative control.

## Suite / typecheck integration

- **Vitest** discovers `tests/**/*.test.ts`, which would sweep both the decoy
  `repair.test.ts` and this variant's `handler.integration.test.ts`.
  `vitest.config.ts` excludes `tests/fixtures/**` at any depth (fixtures are test
  *data*, never suites), so neither decoy is run and the suite count is unchanged.
- **Typecheck** (`tsc --noEmit`) has `include: ["src/**/*"]`, so it never sweeps
  `tests/fixtures/**`; the fixture is not part of the repo build. It is still
  written to typecheck cleanly on its own.
