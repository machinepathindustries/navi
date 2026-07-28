# Fixture: `orphaned-repair`

A small, plausible TypeScript service (a call-detail-record ingest pipeline) with
**one seeded seam**: `repairCallRecord()` is implemented and unit-tested, but
`handler.ts` never calls it—the runtime wiring is missing. This is the
proof fixture for `edge-walk`: Navi must find the
missing call, reject schema-valid **weak** evidence, and clear only on **strong**
evidence.

The bug is the **absence of a call** (missing wiring), never code quality —
`repairCallRecord` itself is correct and thoroughly tested. That is what makes
the decoy tempting: the parent plan (see `payloads/event.json`) claims the task
is done and cites only `repair.ts` + `repair.test.ts`, both of which are real,
green, and prove the function *works* — but say nothing about whether it is
*wired*.

## The mini-codebase (`src/`)

`edge-walk` runs with the workspace root pointed at **`src/`** (e.g.
`navi run edge-walk -w tests/fixtures/orphaned-repair/src …`), so recon sees only
the service, not this README or the payloads. All citation `uri`s are therefore
**relative to `src/`** (bare filenames: `repair.ts`, `handler.ts`).

| file | role |
|---|---|
| `index.ts` | Entry point: `ingest(batch)` → runs the handler chain. |
| `handler.ts` | The ingest chain: validate → store. **The seam lives here** — dropped records are never routed through repair. |
| `validate.ts` | Strict `validateCallRecord`; does not salvage, only accepts/rejects. |
| `records.ts` | `RawCallRecord` / `CallRecord` domain types. |
| `repair.ts` | Implements + exports `repairCallRecord` (the orphan — imported ONLY by its test). |
| `storage.ts` | The output sink (`storeCallRecord`). |
| `repair.test.ts` | Decoy unit test: exercises `repairCallRecord` directly (incl. that a repaired record then passes validation). Never touches `handleBatch`/`ingest`. |

**The seam, one sentence:** `handler.ts` drops every record that fails
validation (`handler.ts:27`) instead of first routing it through
`repairCallRecord` (`repair.ts:11`) and re-validating — repair is imported only
by `repair.test.ts`, so it is dead runtime weight.

## Payloads (`payloads/`)

Each file is a whole **stdin object** for `navi run edge-walk --stdin` — the
entire object binds to the workflow's `input`, and the event is read as
`input.event`, matching the CLI's stdin binding.

| file | what it is |
|---|---|
| `event.json` | The parent event that starts the session: task + a plan claiming completion, citing only `repair.ts` + `repair.test.ts`. Carries no `directive_id`/`evidence`, so the CLI's weak-evidence gate treats it as pass-through (not gated). |
| `evidence-weak.json` | A continuation evidence return: one `source_location` pointing at the **function definition** in `repair.ts`. **Passes** the structural Zod gate (`EvidenceEvent`); its weakness is semantic — proving the function *exists* is not proving it is *called*. The judge must reject it. |
| `evidence-strong.json` | A continuation evidence return: a **call-site** `source_location` in `handler.ts` + a `call_path` entry + a `test_result` with `fresh_for_revision`. The bundle that proves the wiring is real and freshly tested. The judge should clear on it. |

### Placeholder substitutions (runner-facing)

The payloads are static; two values are computed at run time and must be
substituted before the payload is piped to `navi`:

- **`DIRECTIVE_ID_PLACEHOLDER`** (in both evidence payloads) — the judge mints the
  directive id at run time. After the `event.json` run returns a directive, take
  its `id` and substitute it into the evidence payload's `directive_id`.
- **`REVISION_PLACEHOLDER`** (in `evidence-strong.json`, `fresh_for_revision`) —
  the git HEAD the integration test was run against. Substitute the current
  revision, e.g.:
  ```sh
  sed "s/REVISION_PLACEHOLDER/$(git -C tests/fixtures/orphaned-repair/src rev-parse HEAD)/" \
    payloads/evidence-strong.json | ./node_modules/.bin/tsx src/cli.ts run edge-walk --json --stdin -t <session_id>
  ```

Both placeholders are plain strings, so the payloads **already pass the
structural `EvidenceEvent` gate unsubstituted** — substitution only makes the
values semantically live, it is never needed to clear the schema check.

### Note on the strong-evidence CLEAR path (the fixture is un-wired)

The shipped `src/` tree is the **un-wired baseline** — `handler.ts` genuinely
does not call `repairCallRecord`. `evidence-strong.json` describes the state
*after* the one-line wiring is added: the call site it cites (`handler.ts:27`,
inside the `else`/dropped branch) and the `test_result` it names
(`handler.integration.test.ts`) do not exist in the baseline. The reviewer
re-reads cited locations, so a legitimate CLEAR requires the runner to apply
that wiring, add the integration test, and recompute HEAD for
`REVISION_PLACEHOLDER`. Presented against the unwired baseline, even the
"strong" bundle is correctly unverifiable and remains a valid negative control.

## Suite / typecheck integration

- **Vitest** discovers `tests/**/*.test.ts`, which would sweep the decoy
  `repair.test.ts`. `vitest.config.ts` excludes `tests/fixtures/**` (fixtures are
  test *data*, never suites), so the decoy is not run and the suite count is
  unchanged.
- **Typecheck** (`tsc --noEmit`) has `include: ["src/**/*"]`, so it never sweeps
  `tests/fixtures/**`; the fixture is not part of the repo build. It is still
  written to typecheck cleanly on its own.
