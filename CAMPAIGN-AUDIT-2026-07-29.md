# Campaign closed-seams audit

**Status:** AUDIT ONLY — NOT APPROVED TO LAND

**Range:** `23a95cc6cb385c37bcd61fdcebf10f340c4461fa..4860e4ef`

**Campaign commits:** 17

**Diff:** 34 files, 272 insertions, 1,958 deletions

**Audit date:** 2026-07-29

**Audit worktree:** isolated scratch worktree at `4860e4ef`

**Baseline:** 31 files, 614 tests passing

No campaign commit was changed, committed, or pushed during this audit. The root
worktree's uncommitted Founder doctrine/rubric changes were deliberately left
untouched. Every destructive experiment below ran in the isolated worktree and
was restored to `4860e4ef` after the result was recorded.

## Verdict vocabulary

These records are formatted as the initial closed-seams ledger:

- **CLOSED** — a destructive mutation of the named behavioral contract causes a
  surviving test to fail for that contract.
- **EXPOSED** — the mutation survives the current test suite, or the protected
  behavior was removed and has no surviving executable owner.
- **EXPOSED — retired protocol** — the old transport/protocol is intentionally no
  longer product behavior. It is still recorded as exposed because no surviving
  test fails when that old contract is absent.
- **EXPOSED — evaluation pending** — the production feature and its guards were
  removed. A preregistered evaluation, rather than a revert, is the next evidence
  required.
- **UNPROVEN** — the audit did not complete a mutation that isolates the named
  contract. UNPROVEN is never evidence that a seam is closed.

Existing source text, type declarations, import relationships, old landing
verdicts, and statements that a test “should” catch a break are not proof.

## Method and audit integrity

For each deleted protection, the audit changed the smallest current owner that
would violate the named contract, then ran either the directly implicated test
or the full 614-test suite. A contract is marked CLOSED only when the failure
observably follows from that mutation.

The first `4960e49` run used a cross-worktree `node_modules` symlink and produced
10 `gate-path` failures caused by absolute package-prefix contamination. Those
failures were discarded. The scratch worktree then received its own `npm ci`;
all reported experiments use that isolated dependency tree.

## Commit classification

The classification is by the commit's primary effect. “Mixed” names secondary
content without changing the primary class.

| Commit | Subject | Classification | Mixed content |
|---|---|---|---|
| `f02db625` | centralize adjudication gate choice | doctrine/prompt text | none |
| `c0573441` | use native Founder verdict output | runtime code | doctrine, docs, release checks, tests |
| `70fb9cb7` | share review finding schema | runtime code | test deletion |
| `a615b7fb` | drop built-in tool topology snapshot | test-only | none |
| `243b1fa8` | drop redundant Sharpen import subprocess | test-only | none |
| `4960e491` | fail closed on invalid grounding grades | runtime code | grader prompt |
| `b0388ad3` | remove edge-walk judge prefetch | runtime code | test deletion |
| `20fc09f7` | remove redundant pre-PR compile smoke | test-only | none |
| `bb7307fa` | remove synthetic Sharpen composition smoke | test-only | none |
| `3e5fad04` | remove duplicate edge-walk emission suite | test-only | none |
| `db14e0be` | focus compiler fixture on inline schema | test-only | none |
| `cc2aae7d` | remove synthetic continuation branch fixture | test-only | none |
| `254bc824` | remove duplicate edge-walk shape snapshots | test-only | none |
| `9f855f8e` | remove duplicate code-review topology checks | test-only | none |
| `cf4951d5` | remove tautological flow assertions | test-only | none |
| `989f96f5` | judge provider deep lane by outcome | runtime code | release harness and test |
| `4860e4ef` | remove provider evidence narration | runtime code | release harness, Docker diagnostics, tests |

Six files were deleted completely:

- `builtin/workflows/founder/parse-verdict.mjs`
- `src/search/judge-prefetch.ts`
- `tests/founder-parser.test.ts`
- `tests/judge-prefetch.test.ts`
- `tests/directive-emission.test.ts`
- `tests/fixtures/session-continuation/action.yaml`

## Closed-seams ledger

### CS-001 — Central adjudication owns PLAN-without-evidence gate choice

- **Verdict:** EXPOSED
- **Campaign commit:** `f02db625`
- **Deleted contract:** edge-walk's local prompt explicitly required `DIRECT`
  when an interpretation or plan had no evidence. The commit moved that choice
  into the adjudication doctrine.
- **Destructive proof:** changed the centralized doctrine so `DIRECT` was only
  available after the claim had already been proved.
- **Observed result:** all 614 tests passed.
- **Surviving owner:** none executable. The rule exists only as doctrine text.

### CS-002 — Founder resolves and compiles its native verdict schema

- **Verdict:** CLOSED
- **Campaign commit:** `c0573441`
- **Deleted contracts:** the parser command step, its stdin transport, and the
  separate parser-to-schema boundary were replaced by a one-step agent with
  native `VerdictSchema` output.
- **Destructive proof:** changed Founder's `output:` reference to a nonexistent
  `missing-verdict.schema.ts`.
- **Observed failures:**
  - `provider compatibility harness — keeps Founder, Founder advice, and sharpen portable without dropping DeepSeek defaults`
  - `provider compatibility harness — passes an unlisted Mastra-routed model through instead of enforcing the test manifest`
- **Surviving owner:** the provider-compatibility integration path loads and
  compiles the real Founder workflow.

### CS-003 — Founder verdict vocabulary is exactly GO / REFINE / REJECT

- **Verdict:** CLOSED
- **Campaign commit:** `c0573441`
- **Deleted test contract:** the old parser rejected a verdict outside the
  three-value set.
- **Destructive proof:** added `MAYBE` to `VerdictCode`.
- **Observed failures:**
  - `public documentation release surface — renders the product-owned outcome, status, and exit mappings`
  - `session-view — parseListFilters + renderers — rejects an unknown --verdict, listing the legal values`
- **Surviving owner:** public outcome mapping and session-filter vocabulary
  tests both observe the real shared enum.

### CS-004 — Every Founder verdict text field is trimmed and nonempty

- **Verdict:** EXPOSED
- **Campaign commit:** `c0573441`
- **Deleted test contract:** `fails when the take is empty`.
- **Current contract:** `take`, each `grounding_points` item, each
  `decision_rules` item, and each `what_not_to_do` item use
  `z.string().trim().min(1)`.
- **Destructive proof:** weakened the shared `VerdictText` to `z.string()`.
- **Observed result:** all 614 tests passed.
- **Surviving owner:** none.

### CS-005 — Founder Markdown parser protocol and process boundary

- **Verdict:** EXPOSED — retired protocol
- **Campaign commit:** `c0573441`
- **Deleted tests and guards:**
  - `parses the five sections and validates against the schema`
  - `accepts REFINE and REJECT verdicts`
  - `strips narration glued onto the first header with no newline`
  - `tolerates a header glued to the end of a previous section`
  - `tolerates case and extra inter-word whitespace in headers`
  - `ignores a wrapping code fence`
  - `fails when a header is missing`
  - `fails when a header is duplicated`
  - `fails when headers are out of order`
  - `fails when the verdict is not one of the three`
  - `fails when the take is empty`
  - `fails on empty input`
  - Founder half of `emits its object from a symlinked directory, not silence`
  - Founder half of `both parsers remain inert when imported by a stdin-launched module`
  - compiler equality between command stdout and direct parser output
  - realpath direct-entry guard; import-inert guard; stderr plus exit-1 failure
  - exact five headers, exactly once and in order
  - preamble/header glue, case/whitespace, fence, bullet/prose tolerance
  - `$NAVI_ACTION_DIR` parser location and exact stdin transport
  - package/cold-start requirement that `parse-verdict.mjs` ship
- **Destructive proof:** the protocol and parser no longer exist. The native
  schema-path mutation in CS-002 closes only the replacement boundary; it
  cannot fail on any of these removed Markdown/process behaviors.
- **Surviving owner:** none, by design. Do not cite CS-002 as ownership of the
  deleted protocol.

### CS-006 — A numeric review finding validates through both review flows

- **Verdict:** CLOSED for the deleted fixture contract; broader schema identity
  remains EXPOSED
- **Campaign commit:** `70fb9cb7`
- **Deleted test:** `pre-pr-review — shares one finding schema with code-review`.
- **Deleted contract:** one concrete
  `{file,line:number,severity,category,summary}` object validates through both
  flows.
- **Current structure:** pre-PR imports `ReviewFindingSchema` from code-review.
- **Destructive proof for the deleted contract:** decoupled pre-PR onto a local
  schema requiring `line: string`, so the deleted test's numeric fixture no
  longer validated through both flows.
- **Observed failure:** `pre-pr-review — shape + frozen readiness schema >
  freezes the readiness contract: readiness∈ready|not_ready +
  code-review-compatible findings`.
- **Surviving owner:** the current Pre-PR schema integration test submits a
  numeric-line finding through the real loaded output schema.
- **Separate exposed observation:** a different mutation widened only Pre-PR's
  line field to `number | string`; all 614 tests passed. That does not violate
  the deleted positive fixture, so it is not proof about the deleted test.
  It does prove that no current test owns the stronger rule that future
  decoupled schemas must remain structurally identical and reject every value
  rejected by Code Review.

### CS-007 — Five built-in review/search agents use the exact shared read-only toolset

- **Verdict:** EXPOSED as a cross-flow census; three members exposed, two closed
- **Campaign commit:** `a615b7fb`
- **Deleted test:** `the five built-in flows resolve to the shared read-only tools list`.
- **Deleted contract, for each agent:**
  - `founder.judge`
  - `founder-advice.counsel`
  - `code-search.search`
  - `code-review.review`
  - `pre-pr-review.review`
  - step exists and is an agent;
  - tools equal `READ_ONLY_WORKSPACE_TOOLS`;
  - tool list is nonempty;
  - no zero-tools lint warning.
- **Destructive proof:** independently reduced each of the five tool lists to
  only `view`; for Founder, Founder Advice, and Code Search, independently
  removed every tool as well.
- **Observed results:**

  | Agent | Verdict | Destructive result / surviving owner |
  |---|---|---|
  | `founder.judge` | EXPOSED | all 614 tests passed with only `view`, and again with zero tools |
  | `founder-advice.counsel` | EXPOSED | all 614 tests passed with only `view`, and again with zero tools |
  | `code-search.search` | EXPOSED | all 614 tests passed with only `view`, and again with zero tools |
  | `code-review.review` | CLOSED | `wires the reviewer to the diff collector with read-only context` failed on the exact list |
  | `pre-pr-review.review` | CLOSED | `resolves cleanly: a command diff-collector then an agent reviewer` failed on the exact list |

- **Surviving owner:** focused Code Review and Pre-PR tests own their exact
  toolsets. Founder, Founder Advice, and Code Search have none. The general
  no-agent-shell test does not own exact topology or nonempty read access.

### CS-008 — Importing the Sharpen parser is silent and inert

- **Verdict:** EXPOSED
- **Campaign commit:** `243b1fa8`
- **Deleted test:** `remains inert when imported by a stdin-launched module`.
- **Deleted contract:** import exits 0 with empty stdout and stderr.
- **Destructive proof:** added import-only stdout output behind the inverse
  direct-entry predicate.
- **Observed result:** all 614 tests passed; the unexpected line appeared in
  Vitest's output without failing the suite.
- **Surviving owner:** none. Direct and symlink entrypoint tests do not import
  the module inertly.

### CS-009 — Quick-lane grader failures always fail closed to deep

- **Verdict:** EXPOSED
- **Campaign commit:** `4960e491`
- **Required first experiment:** `git revert --no-commit 4960e49` in the
  isolated worktree after a local `npm ci`.
- **Behavioral contract:** a thrown grader call, invalid structured grade, or
  non-`stop` finish must print conservative escalation and hand off to deep;
  none may print the pass message.
- **Observed result:** all 614 current tests passed with the fail-closed wiring
  reverted.
- **Surviving owner:** none. Existing tests cover lower-level structured
  parsing and deep-command composition separately, not these failure-to-handoff
  paths.

### CS-010 — Old raw three-line grade and independent Confidence fallback

- **Verdict:** EXPOSED — retired protocol
- **Campaign commit:** `4960e491`
- **Deleted contracts:**
  - raw model text had exactly `VERDICT`, `WEAK/MISSING`, and `ESCALATE` lines;
  - string inclusion of `ESCALATE: yes` selected deep;
  - the final `Confidence` heading was parsed independently;
  - `Low` confidence forced deep even if the grade text did not;
  - the user-facing reason distinguished grade escalation from Low confidence.
- **Destructive proof:** the raw protocol and independent confidence scan no
  longer exist; reverting the new structured fail-closed wiring did not fail
  any current test.
- **Surviving owner:** none. The structured grade is the replacement contract.

### CS-011 — Edge-walk judge deterministic prefetch and its safety/resource rails

- **Verdict:** EXPOSED — evaluation pending
- **Campaign commit:** `b0388ad3`
- **Instruction-specific handling:** not reverted.
- **Deleted feature and guards:**
  - compiler runtime `basePath` and CLI workspace propagation;
  - scope only to `edge-walk.judge`;
  - default ON with `0|off|false` emergency disable;
  - cite derivation from event evidence, prior directives/targets/required
    evidence/findings/surface map, recon, and expand;
  - denied-segment, URL, unsuitable absolute-path, finite one-based-line,
    range-clamp, nonstring, empty-input, recursion-depth-8, history-skip, and
    malformed-field guards;
  - explicit source-extension allowlist
    (`ts|tsx|js|jsx|mjs|cjs|mts|cts|json|yaml|yml|md|mdx|py|rs|go|java|rb|php|sh|bash|zsh|css|scss|html|vue|svelte`);
  - contained reads through `resolveContainedPath`;
  - read failures collapsing to no window;
  - 16-window, 250-line, and 180,000-character limits;
  - ranged-window geometry of 50 lines before and 100 lines after a cite;
  - range/window deduplication and bounded basename fallback;
  - the “head start, not a verdict” honesty header;
  - missing-window instruction to use view/search;
  - explicit warning that green tests are not proof.
- **Deleted tests:**
  - parses `file:line` and `file:start-end`;
  - derives locations from event and directive fields;
  - dedupes and merges near-overlapping ranges;
  - peeks real current bytes;
  - fences denied and escaping paths;
  - renders the founder-safe header;
  - is default ON unless the environment disables it.
- **Surviving owner:** none; production feature and test file were both
  removed. Section “Prefetch ON/OFF evaluation” preregisters the required
  decision evidence.

### CS-012 — Pre-PR compileability, graph cardinality, and Agent identity

- **Verdict:** MIXED — compileability EXPOSED; graph cardinality CLOSED;
  compiled Agent identity UNPROVEN
- **Campaign commit:** `20fc09f7`
- **Deleted test:** `compiles to a committed workflow (schema drives the reviewer's structured output)`.
- **Deleted contracts:** compile succeeds; graph length is two; only
  `pre-pr-review.review` creates an Agent.
- **Compileability proof:** added `skills.only: [missing-pre-pr-skill]`,
  preserving parse/shape resolution while making real compilation fail. All
  614 tests passed. **Surviving owner:** none.
- **Graph-cardinality proof:** appended a valid third command step,
  `audit_extra`, after `review`.
- **Observed failure:** `tests/pre-pr-review.test.ts > resolves cleanly: a
  command diff-collector then an agent reviewer` expected
  `[collect_diff, review]` and received the third step. **Surviving owner:** that
  focused shape test.
- **Agent-identity status:** changing only the workflow name changed the
  compiled key to `pre-pr-review-audit.review` while preserving two steps; the
  focused Pre-PR suite passed 9/9. The broader suite was stopped before a result,
  so exact compiled Agent identity remains **UNPROVEN**, not EXPOSED.

### CS-013 — Sharpen compiled parser composition

- **Verdict:** parser-path/command-success seam EXPOSED; stdin transport and
  output equality UNPROVEN
- **Campaign commit:** `bb7307fa`
- **Deleted test:** `the sharpen parser receives model text through compiled command stdin`.
- **Deleted contracts:** compiled command succeeds; `$NAVI_ACTION_DIR` resolves
  the parser; model text travels as stdin; direct parser accepts it; command
  JSON equals direct-parser JSON.
- **Destructive proof completed:** changed the action command to a nonexistent
  `parse-sharpen-missing.mjs`.
- **Observed result:** all 614 tests passed.
- **Surviving owner:** none for compiled parser resolution and command success.
  That mutation did not change stdin transport or make compiled output differ
  from direct-parser output while both paths still succeeded. Those two deleted
  assertions therefore remain **UNPROVEN** and are not credited to this result.

### CS-014 — A Directive requires nonempty evidence and completion criteria

- **Verdict:** CLOSED
- **Campaign commit:** `3e5fad04`
- **Deleted tests:**
  - rejects empty `required_evidence`;
  - rejects empty `completion_criteria`.
- **Destructive proof:** removed both `.min(1)` constraints from the canonical
  `Directive` schema.
- **Observed failures:**
  - `Directive — rejects an empty required_evidence[]`
  - `Directive — rejects an empty completion_criteria[]`
- **Surviving owner:** `tests/whisper.test.ts` directly exercises the canonical
  schema.

### CS-015 — Edge-walk composite validates every carried Directive

- **Verdict:** EXPOSED
- **Campaign commit:** `3e5fad04`
- **Deleted test:** `the bug shape is rejected AT THE COMPOSITE too`.
- **Deleted contract:** a present satisfied directive with both arrays blank
  is invalid in the judge's composite, not only against the base type.
- **Destructive proof:** changed the edge-walk composite from
  `z.array(Directive)` to `z.array(z.any())`.
- **Observed result:** all 614 tests passed.
- **Surviving owner:** none. CS-014 proves the base schema, not that this
  composite continues to consume it.

### CS-016 — Preserve-or-omit satisfied directives

- **Verdict:** schema acceptance CLOSED; model-facing doctrine EXPOSED;
  finding-evidence instruction UNPROVEN
- **Campaign commit:** `3e5fad04`
- **Deleted tests:**
  - satisfied directive with original arrays is accepted;
  - satisfied directive may be omitted as `directives: []`;
  - adjudication skill states the two valid shapes and never-blank rule;
  - judge prompt states the two shapes and forbids a third;
  - each emitted finding requires evidence or must be omitted.
- **Preserved-shape proof:** removed `satisfied` from the canonical Directive
  status enum. The full suite failed 22 tests across two files, including
  SessionState round-trip/append and Session View story/session paths.
  **Surviving owner:** current contract and session integration tests exercise
  carried satisfied directives.
- **Omitted-shape proof:** added `.min(1)` to the judge composite's
  `directives` array. The suite failed exactly
  `tests/whisper.test.ts > judge composite: surface_map = null normalizes to
  absent` on its `directives: []` input. **Surviving owner:** that real
  composite parse.
- **Doctrine proof:** changed the adjudication skill and edge-walk prompt to
  explicitly permit satisfied directives with empty arrays. All 614 tests
  passed. **Surviving owner:** none for the model-facing preserve-or-omit rule.
- **Finding-evidence status:** the deleted prompt assertion requiring evidence
  on every emitted finding was not independently mutated before the audit was
  stopped. It remains **UNPROVEN**.

### CS-017 — Inline workflow output schema enforces every declared field

- **Verdict:** CLOSED
- **Campaign commit:** `db14e0be`
- **Deleted/replaced contract:** a valid
  `{description,keywords}` object passes and an object missing `keywords`
  fails.
- **Destructive proof:** removed `keywords: string[]` from the real
  `hello-two-step` fixture.
- **Observed failure:** `compiler — inline output schema — enforces every declared field`.
- **Surviving owner:** the narrowed replacement test directly loads the real
  fixture and parses both objects.

### CS-018 — Compiler fixture topology, defaults, dependencies, and Agent identities

- **Verdict:** UNPROVEN as a combined deletion
- **Campaign commit:** `db14e0be`
- **Deleted tests/contracts:**
  - exact `extract → summarize` names;
  - both steps are agents;
  - default `maxSteps` is `[50,50]`;
  - summarize depends on extract;
  - lint is clean;
  - compile succeeds with graph length two;
  - exact Agent IDs and key/ID equality;
  - `shapeSummary` is a stable JSON-safe projection.
- **Discarded overbroad proof:** one experiment changed the second step into a
  broken command with an unknown dependency and reported 614 passing tests. It
  did not independently violate exact step names, two-step graph cardinality,
  the first step's default, or JSON-safe `shapeSummary`; it therefore cannot
  close or expose the eight-item assertion block as a unit.
- **Surviving owner:** CS-017 owns only inline schema enforcement. Independent
  mutations for the eight deleted assertions were interrupted before completion,
  so this ledger records them conservatively as **UNPROVEN** rather than
  recycling the overbroad result.

### CS-019 — Edge-walk continuation skip predicate has the current truth table

- **Verdict:** CLOSED
- **Campaign commit:** `cc2aae7d`
- **Deleted contract:** recon skips only for an edge-walk-owned surface map at
  the same revision; null, foreign-flow, and stale-revision states rerun recon.
- **Destructive proofs:**
  1. inverted the production condition's `prior_workflow !=` comparison;
  2. independently changed compiler `!=` evaluation to behave like `==`.
- **Observed failures:**
  - `edge-walk — carries the locked continuation-skip condition`
  - seven `tests/condition.test.ts` truth-table failures, including
    `evaluates edge-walk continuation-skip condition`.
- **Surviving owner:** the real workflow pins its condition and the generic
  condition suite executes the predicate semantics.

### CS-020 — Synthetic continuation fixture topology compiles to two exact Agents

- **Verdict:** EXPOSED — retired fixture
- **Campaign commit:** `cc2aae7d`
- **Deleted fixture/test contracts:** exact `recon, report` steps; recon
  conditional and report unconditional; lint clean; compile succeeds; graph
  length two; exact two Agent IDs.
- **Destructive proof:** the fixture was deleted. CS-019 proves the production
  predicate, not this former synthetic graph.
- **Surviving owner:** none for the deleted fixture topology.

### CS-021 — Edge-walk input argument name, type, requiredness, and cardinality

- **Verdict:** CLOSED for name/type/requiredness; EXPOSED for exact cardinality
- **Campaign commit:** `254bc824`
- **Deleted test:** `declares a single json-typed required input arg`.
- **Destructive proofs:**
  - changed the argument type from `json` to `string`;
  - renamed `input` to `payload` and updated prompt interpolation;
  - changed `required:true` to `required:false`;
  - added a second optional string argument.
- **Observed results:**
  - the type mutation failed `positional prose on the json input arg is
    refused`; it crossed the pre-model guard and timed out instead of returning
    exit 4;
  - the rename failed both edge-walk CLI tests that require the literal name
    `input`;
  - the requiredness mutation failed `no --stdin and no positional` by crossing
    the pre-model guard and timing out instead of returning exit 4;
  - the added optional argument passed all 614 tests.
- **Surviving owner:** CLI integration owns the name, JSON binding, and required
  pre-model refusal. No test owns the assertion that it is the only declared
  argument. No model result from the timeout paths was accepted as evidence.

### CS-022 — Edge-walk topology is recon → expand → judge

- **Verdict:** CLOSED
- **Campaign commit:** `254bc824`
- **Deleted test:** exact names/order and all-agent step types.
- **Destructive proofs:**
  - consistently renamed `recon` to `reconnaissance` and updated dependencies
    and prompt references;
  - independently changed each of `recon`, `expand`, and `judge` from `agent`
    to `command`.
- **Observed failures:**
  - linear dependency assertion expected `recon`;
  - compiled Agent keys expected `edge-walk.recon`.
  - each type mutation failed the corresponding resolved output-shape test and
    `builds three fresh agents, one per step`; the judge mutation also failed
    the composite GateDecision parse.
- **Surviving owner:** current edge-walk integration tests own exact dependency
  and all three compiled Agent identities.

### CS-023 — Code-review collector/reviewer topology is wired by exact name

- **Verdict:** CLOSED
- **Campaign commit:** `9f855f8e`
- **Deleted assertions:** lint clean; exact `[collect_diff,review]` order;
  collector is command; reviewer is agent.
- **Destructive proofs:**
  - consistently renamed `collect_diff` to `collect_patch`;
  - changed `collect_diff` from `command` to `agent`;
  - independently changed `review` from `agent` to `command`.
- **Observed failures:**
  - reviewer dependency expected `collect_diff`;
  - collector integration accessed `steps.collect_diff` and received
    `undefined`;
  - collector-as-agent failed the real compile test and all three isolated
    collector runs before execution;
  - reviewer-as-command failed its output-shape, finding-schema, and compile
    tests.
- **Surviving owner:** current code-review integration owns the named
  collector/reviewer seam and both exact step types.

### CS-024 — Public surfaces retain exactly the documented built-in workflow set

- **Verdict:** CLOSED
- **Campaign commit:** `cf4951d5`
- **Deleted assertion:** exactly eight built-in workflows exist.
- **Destructive proofs:**
  - deleted `builtin/workflows/web-search/action.yaml`;
  - independently added a valid ninth `audit-extra` workflow.
- **Observed failures:**
  - the full deletion run failed two catalog tests that require `web-search`
    plus five provider-artifact tests whose tracked-input digest requires its
    action file;
  - the added workflow failed `public documentation release surface —
    documents every built-in workflow`.
- **Surviving owner:** catalog and provider release-artifact tests prevent loss
  of the known workflow; docs-release prevents an undocumented extra workflow.

### CS-025 — Sharpen direct entrypoint emits nonempty parseable JSON

- **Verdict:** CLOSED
- **Campaign commit:** `cf4951d5`
- **Deleted assertion:** stdout length is greater than zero.
- **Destructive proof:** made the direct parser write empty stdout.
- **Observed failure:** current `sharpen-entrypoint` test failed at
  `JSON.parse` with unexpected end of input.
- **Surviving owner:** parseability logically and observably implies nonempty
  stdout.

### CS-026 — Provider deep lane proves an ordered repository-tool round trip

- **Verdict:** EXPOSED
- **Campaign commit:** `989f96f5`
- **Deleted runtime/test contract:**
  - deep invocation emitted JSONL progress;
  - an expected read-tool call was followed by its correlated result;
  - wrong tool names failed;
  - result-before-call failed;
  - exit 0 plus nonce alone was insufficient.
- **Destructive proof:** weakened the surviving deep predicate from
  `exit 0 + nonce` to `exit 0` only.
- **Observed result:** all 614 tests passed.
- **Surviving owner:** none in the current suite, even for the remaining nonce
  condition. The provider harness may exercise it live; that is not a
  regression owner.

### CS-027 — Provider artifact persists and validates per-lane evidence

- **Verdict:** EXPOSED
- **Campaign commit:** `4860e4ef`
- **Deleted runtime contracts:**
  - `lane_evidence`, `LANE_EVIDENCE_KEYS`, and
    `REQUIRED_LANE_EVIDENCE`;
  - quick grounding/grade bits;
  - deep nonce bit;
  - structured schema/nonce/read-route bits;
  - Founder schema/grounding/read-route bits;
  - code-review schema/collector/planted-defect bits;
  - exact evidence object shape and boolean values;
  - no cross-lane true bits;
  - every required PASS bit true;
  - no evidence on `NOT_TESTED`;
  - all-attempt evidence aggregation.
- **Deleted/changed tests:**
  - exact redacted result shape no longer includes `lane_evidence`;
  - requested-attempt aggregation no longer checks evidence;
  - complete artifact no longer checks exact evidence keys;
  - BLOCKED fixtures no longer carry zeroed evidence.
- **Destructive proof:** the field and validators are absent. Current complete
  artifact fixtures explicitly pass without `lane_evidence`.
- **Surviving owner:** none for persisted component attestation. Individual
  lane `ok` predicates still own their remaining outcome checks; they are a
  different contract.

### CS-028 — Docker provider failures report component evidence and local reason

- **Verdict:** EXPOSED
- **Campaign commit:** `4860e4ef`
- **Deleted contract:** cold-start diagnostics printed per-component evidence
  and a local failure reason rather than only the lane outcome.
- **Destructive proof:** the diagnostic fields are absent from the current
  result and Docker rendering path.
- **Surviving owner:** none.

## EXPOSED CONTRACTS

The following are not closed by the current 614-test suite:

1. centralized adjudication meaning for PLAN-without-evidence;
2. nonempty/trimmed Founder verdict text;
3. retired Founder Markdown parser/process/package protocol;
4. cross-flow review-finding parity after a future decoupling;
5. exact read-only tool topology for Founder, Founder Advice, and Code Search
   (Code Review and Pre-PR Review are closed by focused tests);
6. Sharpen import inertness;
7. all three quick-grader fail-closed runtime paths;
8. retired raw grade/confidence transport;
9. removed edge-walk judge prefetch, all of its guards, and its value;
10. pre-PR real compileability;
11. Sharpen compiled parser path and command success;
12. directive validation at the edge-walk composite;
13. model-facing preserve-or-omit directive doctrine;
14. retired continuation fixture topology;
15. exact one-argument cardinality for edge-walk;
16. provider deep repository-tool round trip;
17. persisted provider-lane evidence attestation and aggregation;
18. component-level Docker failure diagnostics.

## UNPROVEN CONTRACTS

These were not isolated by a completed destructive experiment before the audit
was stopped. They must not be described as closed:

1. exact compiled Pre-PR Agent identity across the full suite;
2. Sharpen compiled stdin transport and compiled/direct-parser JSON equality;
3. the Edge Walk prompt's evidence-or-omit rule for emitted findings;
4. the deleted compiler-fixture assertions for exact names, both Agent types,
   both default step budgets, dependency, clean lint, successful two-node
   compilation, exact Agent keys/IDs, and JSON-safe `shapeSummary`.

## `4960e49` regression-test proposal — design only

No code is proposed for this audit landing. The smallest honest test seam is the
grader transport and disposition block currently embedded in `bareQuery`.

### Seam

Extract the block at `src/cli.ts:848-919` into an import-safe
`src/search/grounding-stage.ts`. Inject one narrow `GroundingGenerate`
function; production passes `agent.generate.bind(agent)`. Keep the real
`resolveStructuredObject` and `GroundingGradeSchema` in the test path so the
invalid-object case exercises the actual adapter/text recovery boundary.

The extracted result should carry the real rendered grade text, escalation
boolean, and diagnostic. The actual next-block renderer should accept an
already-built `deepCmd`; command composition is separately covered.

Suggested home: `tests/grounding-stage.test.ts`. Do not import `src/cli.ts`,
which executes `main()` at module load, and do not force model mocks through
the child process used by `tests/cli.test.ts`.

### Three required cases

| Case | Injected result | Exact observables |
|---|---|---|
| grader call throws | rejected promise with `Error("grader exploded")` | stderr has `navi: grade stage failed (answer shown; deep handoff required):` and `grader exploded`; stdout has `Grounding grade unavailable — escalating conservatively.`; stdout has the deep warning and exact supplied command ending `--deep`; stdout never has `GROUNDING_PASS_MESSAGE` |
| structured object invalid | `finishReason:"stop"`; object and fallback JSON both use string `escalate:"no"` | same conservative message and exact deep handoff; diagnostic names declared-schema failure; never `GROUNDING_PASS_MESSAGE` |
| finish reason is not stop | `finishReason:"tool-calls"` plus an otherwise valid pass-looking COMPLETE/non-escalating object and text | same conservative message and exact deep handoff; diagnostic has `finishReason=tool-calls`; never `GROUNDING_PASS_MESSAGE` |

Add one positive control: valid `COMPLETE`, `escalate:false`,
`finishReason:"stop"` prints `GROUNDING_PASS_MESSAGE` and no deep command.
The failure cases retain process success because the answer was already shown;
they change the next move, not the answer's exit status.

Existing tests are insufficient:

- `tests/compiler.test.ts` owns lower-level structured candidate parsing;
- `tests/cli.test.ts` owns deep-command construction and same-session flags;
- `tests/docs-release.test.ts` owns a static published pass surface;
- none connects these failure seams to conservative escalation.

## `b0388ad` prefetch ON/OFF evaluation

This design intentionally does not revert `b0388ad`. Criteria are registered
before running either arm.

### Fixed comparison

- Build both arms from parent `4960e491`.
- Toggle only `NAVI_JUDGE_PREFETCH=1` versus `0`.
- Pin the judge in both arms to `deepseek/deepseek-v4-pro`,
  `temperature: 0`, `thinking: "enabled"`, no `reasoningEffort`, and
  `maxSteps: 16` except for the explicitly named `maxSteps: 4` pressure cell.
  Persist the resolved model and provider options with every run.
- Use fresh threads, cold model/context caches, randomized arm order, and
  identical event/prior/recon/expand/revision snapshots.
- Record end-to-end smoke separately from judge-only measurements.

### Repositories

1. Navi at `4960e491`.
2. `anomalyco/opencode` at `14db336e`.
3. `NVIDIA/NeMo-Agent-Toolkit` at `36fb2c2d`.
4. Diagnostic negative control, excluded from keep/restore arithmetic:
   `llama.cpp` at `0919a0f` for unsupported extension/location behavior.

### Core shapes per repository

1. wrapped plan plus structured `path:line` citations;
2. bare free text containing `path:line`;
3. weak evidence return with prior directive targets but definition-only
   source windows;
4. fresh green decoy test with target paths only in `required_evidence` prose;
5. strong call-path evidence plus a fresh boundary result;
6. concrete-defect evidence.

Use one immutable fixture per repository for each numbered shape. Shapes 1, 3,
and 5 use wrapped events; shapes 2, 4, and 6 use unwrapped events. Shape 1 has
no prior directive and a single-line cite; shape 2 has one open directive and a
range; shape 3 has one open plus one satisfied prior directive and a valid
definition-only cite; shape 4 has one open directive plus missing and
denied/escaping locations; shape 5 has one satisfied prior directive and valid
ranges; shape 6 has no prior directive and valid single-line defect evidence.
Freeze the exact fixture bytes and hashes before either arm runs.

Freeze gold before execution for 21 unique fixtures: 18 core
repository-by-shape fixtures plus one pressure fixture per core repository.
The same pressure gold applies at both step budgets and across all repeats.
Reviewers A and B independently label the normalized verdict and expected
blocking-directive presence/status without seeing arm outputs or each other's
answer. Exact tuple agreement becomes gold. On disagreement, reviewer C sees
the fixture and both written rationales, but no arm output, and must select A's
or B's tuple with a written reason. Freeze reviewer identities, prompts/model
versions, labels, and rationales before the first ON/OFF call. No abstention,
post-run relabeling, fixture exclusion, or gold-driven rerun is allowed.

### Budget-pressure cell

Duplicate shape 4 with at least 16 candidate windows across at least 12 files.
Evaluate at judge `maxSteps=4`, then run a sensitivity cell at production
`maxSteps=16`. This is the case where an unprefetched judge can plausibly
exhaust its search budget.

### Sample and measurements

- Core: eight repeats × three repositories × six shapes × two arms =
  **288 judge calls** (**144 matched ON/OFF pairs**).
- Pressure: eight repeats × three repositories × two step budgets
  (`maxSteps: 4`, `maxSteps: 16`) × two arms = **96 judge calls**. Each step
  budget therefore has 24 calls per arm and 24 matched pairs.
- Negative control: eight repeats × one repository × one frozen unsupported
  shape × two arms = **16 diagnostic calls**, excluded from acceptance
  thresholds.
- Total judge-only sample: **400 calls**. Also run six separate end-to-end
  smokes: one per core repository and arm, for **406 total evaluation runs**.
- Capture:
  - normalized verdict, blocking-directive presence, and directive status;
  - agreement with the frozen gold result and paired ON/OFF agreement;
  - model/tool steps and tool-call count;
  - finish reason and step-cap exhaustion;
  - judge latency and wall latency, median and p95;
  - input, output, reasoning, and cached tokens;
  - cost per correct verdict using a price table frozen on the run date;
  - prefetch windows, rendered characters, and prefetch milliseconds;
  - workspace-escape attempts;
  - percentile 95% paired-bootstrap confidence intervals from 10,000 resamples
    with seed `20260729`.

For core comparisons, resample the 144 matched ON/OFF pairs, stratified by
repository and shape. For pressure comparisons, analyze each step budget
separately and resample its 24 matched pairs, stratified by repository. Never
pool `maxSteps: 4` with `maxSteps: 16`; never include the negative control in
gold accuracy, exhaustion, latency, step, or cost criteria.

### Precommitted keep/restore criteria

**RESTORE prefetch only if every condition holds:**

Criteria 1–5 and 8–10 use only the 144-call-per-arm core sample. Criteria 6–7
use only the 24-call-per-arm `maxSteps: 4` pressure sample. Criterion 11 uses
only the separate 24-call-per-arm `maxSteps: 16` sensitivity sample.

1. ON gold accuracy is at least 95%: at least 137/144 correct (95.14%).
2. ON has zero false CLEAR outcomes, reported as `0/N`, where
   `N = 8 × the number of non-CLEAR fixtures among the 18 frozen core fixtures`.
3. ON has zero workspace escapes.
4. Non-pressure ON/OFF verdict agreement is at least 90%: at least 130/144
   matched verdicts (90.28%).
5. ON has at most two fewer correct calls than OFF; three fewer is
   3/144 = 2.08 percentage points and fails.
6. In the `maxSteps: 4` pressure cell, ON exhausts at most 2/24 calls
   (8.33%) and has at least five fewer exhausted calls than OFF
   (a gap of at least 5/24, or 20.83 percentage points).
7. In the `maxSteps: 4` pressure cell, ON accuracy is at least 15 percentage
   points above OFF: with this sample, at least four more correct calls than
   OFF (4/24, or 16.67 percentage points).
8. Median ON/OFF model-step ratio is at most 0.80.
9. Median ON/OFF latency ratio is at most 0.85; p95 ratio is at most 1.05.
10. ON/OFF cost-per-correct-verdict ratio is at most 1.10.
11. In the separate `maxSteps: 16` pressure sensitivity cell, ON has zero false
    CLEAR outcomes and is no more than 2 percentage points less accurate than
    OFF.

If any condition fails, **KEEP `b0388ad`**. Report all cells, including negative
or inconclusive ones; do not tune the criteria after seeing results.

## Review-gate invocation ledger

The campaign boundary for this table begins at the commit timestamp of
`23a95cc` (`2026-07-29T17:05:12Z`) and ends at the interrupted doctrine gate
created at `2026-07-29T21:23:32.900Z`.

The inventory reconciles:

1. persisted workflow snapshots and session turns from `~/.navi-home`;
2. terminal rollout JSONL for ephemeral, old, and temporary ledgers;
3. literal `navi: output schema retry N` notices for repair counts.

Internal `agentic-loop` and `executionWorkflow` snapshots are not separate user
invocations. Help, shape, and session inspection commands are excluded.

The resulting census is 98 launch attempts: 94 obtained Navi run IDs and four
failed before run creation. Among the 94 runs: 26 Founder Advice, 25 Founder,
32 Machinery Review, seven Edge Walk, one Code Search, two Code Review, and one
Pre-PR Review. Terminal model runtime totals approximately 11,274.554 seconds
(187.91 minutes), plus one persisted interrupted millisecond; pre-run launcher
failures add approximately 2.53 seconds and made no model call.

Repair count below is the count of literal numeric
`navi: output schema retry N` notices, not the largest ordinal. “Active” and
“awaiting_parent” are persisted session states, not live processes.

### Rollout-only and ephemeral runs

These 29 runs are absent from the current database and were recovered from
rollout logs, captured envelopes, temporary-ledger `session show`, or the
recorded final report.

```text
UTC      | run                                  | session                              | flow/model                 | outcome                         | runtime  | repairs | unique catch
17:06:03 | 9ae17dc9-240f-4bcd-ab22-808a89acab7d | d60c0f5c-305a-497d-b2d1-cdd1339f442e | founder-advice/pro          | advisory active                 | 123.733s | 0 | first to identify adjudication skill as semantic DIRECT/REPAIR owner; recommended Option B
17:06:25 | 73cc6894-3612-422d-a882-61ab9d1bae96 | a307d01e-b157-4add-a510-9d9ee86e45a5 | machinery-review/pro        | REFINE awaiting_parent          | 144.923s | 0 | nothing unique; independently confirmed hard-coded PLAN→DIRECT conflict
17:09:45 | a148d5a8-42e8-414c-a598-21a9053034ae | b8a6f784-ff5b-40cb-bbe7-371b10687424 | edge-walk/flash             | FAILED recon tool-calls         | 48.564s  | 0 | nothing unique
17:11:44 | 91515292-0459-4464-80eb-95930b34ab4b | 3459e9b0-7bd3-45ad-a522-388c90747e9d | machinery-review/pro        | REFINE awaiting_parent          | 153.683s | 0 | uniquely required central DIRECT definition and removal of duplicated PLAN rule
17:11:46 | 29e0b6ef-dbc8-422d-aaad-101f5853b6a9 | 4819ed25-b869-46b2-87bb-740b4ba48298 | founder/pro                 | GO complete                     | 137.863s | 0 | nothing unique
17:15:30 | 024ea477-98b4-4cdb-9e31-a5d36af0c447 | 384609e0-030f-45cf-8ec5-8a2b6bf4f88a | machinery-review/pro        | non-verdict; completed one step | 368.362s | 2 | nothing unique; no gate emitted
17:15:41 | 902027b8-2355-47e9-a8fa-027c222e2b62 | 9065605d-6e61-4848-a207-341943215785 | founder/pro                 | GO complete                     | 81.267s  | 0 | nothing unique
17:16:41 | 1f21daf3-87df-4d80-be89-d7be67a507e4 | 500c4236-f344-4448-ad46-5960c804ac91 | founder-advice/flash        | advisory active                 | 131.107s | 0 | first to nominate Founder Markdown-parser removal/native structured output
17:19:03 | 68abffd8-e424-402d-9b2b-e79c057ba3b6 | 4539ae41-e7fc-4d81-942c-5cf1e44b16ef | code-search/flash           | non-verdict active              | 148.498s | 0 | nothing unique; corroborated candidate inventory
17:29:06 | 16a07269-6e56-44cc-91b7-7c7c5db50fa7 | 98e3753a-6922-437f-a330-27c90262b32f | founder/flash               | GO complete                     | 14.097s  | 0 | provider smoke; proved abstract native Founder schema lane works
17:29:08 | 36afbb07-43c9-4f66-b6d9-64872f089fb0 | f6fa7157-d81d-43d4-b77d-dc6cae61832f | founder/flash               | REFINE awaiting_parent          | 9.214s   | 0 | uniquely demonstrated underspecified “Should we ship it?” fails closed
17:29:20 | d196cb15-6b06-4547-a8bd-ec14517250ef | 15059d95-c80f-482e-a8c3-34e15e66e15c | founder/flash               | GO complete                     | 142.515s | 1 | unique live proof that one invalid-JSON schema repair recovered
17:33:12 | 19efa355-5cef-44d7-88a5-17ea11cc1b24 | 1f6bfbb5-602e-4652-b4cc-e0027fad8519 | founder/pro                 | GO complete                     | 149.520s | 0 | nothing unique
17:33:41 | ae47bc41-9686-4eb3-b0a6-4710c1dcbe89 | 6fdb252e-1c6f-4c49-ba00-c9fba7a4a8a7 | machinery-review/pro        | GO complete                     | 125.561s | 0 | nothing unique
17:37:15 | 39ecf10a-cfee-4258-bccc-b369edbb6f9d | e0839512-9ddc-45f0-af97-e743191a8d37 | founder-advice/flash        | advisory active                 | 121.337s | 0 | nothing unique
17:37:21 | 4063d2a3-e247-4ff1-a785-657b69243f8c | a3d389a6-faf2-402b-b514-0c4ff5666b5e | machinery-review/flash      | REFINE awaiting_parent          | 95.600s  | 0 | first to nominate shared ReviewFindingSchema extraction/parity-test deletion
17:57:18 | 42fb7928-df36-444d-8d2b-0b8d54439729 | ab15fc90-58ec-4dc7-8520-8b13b4a6da75 | founder-advice/flash        | advisory active                 | 84.958s  | 0 | first to select cross-flow read-only-tools topology snapshot deletion
18:40:53 | aaafc31e-8e71-421f-aaf4-48d0358a80a9 | 3d808852-5fc3-49bd-8fce-46c76a5a8ebc | code-review/flash           | success; two raw findings       | 133.476s | 0 | uniquely raised missing direct GroundingGradeSchema/renderer tests; also made one invalid ts-pattern suggestion
19:03:31 | 7ecd7fc4-a42f-4a2f-b7bd-30cc8b53a2dc | 14696fc0-ef07-454d-8e05-3c25d09ef2f8 | edge-walk/flash; prefetch ON  | REPAIR awaiting_parent        | 110.828s | 0 | nothing unique; same orphaned-repair defect
19:03:31 | 222c065e-a435-433e-b91f-7652d2b283cc | 0ff389eb-bd9b-423b-9bec-0a6dfa1198eb | edge-walk/flash; prefetch OFF | DIRECT awaiting_parent        | 87.395s  | 0 | first live A/B result to catch orphaned repairCallRecord production wiring
19:08:42 | 90393d20-5fc7-44f1-bd30-de2eca3f1907 | 169c6252-4d78-4b00-bb94-e4cdb7d11408 | edge-walk/flash; ON         | REPAIR awaiting_parent          | 105.338s | 0 | nothing unique
19:10:23 | f751e62a-b62f-436e-bc9d-7455ee138347 | ae52e61d-343d-446c-b0f2-de91982566cf | edge-walk/flash; OFF        | REPAIR awaiting_parent          | 115.696s | 0 | nothing unique
19:13:08 | 32dc3b04-bbe5-4eba-b1ed-63dc0c0ab4a7 | 1632a14e-b64b-4fa2-9348-2947cd03d0e1 | edge-walk/flash; ON         | DIRECT awaiting_parent          | 109.156s | 0 | nothing unique
19:13:08 | 88a38546-ca44-4bee-b45c-07a9c02fc533 | f02ec2da-a784-4a62-b299-5bc6d9938b89 | edge-walk/flash; OFF        | REPAIR awaiting_parent          | 111.026s | 0 | nothing unique
19:31:37 | e70b5e64-81f4-489c-873e-9739f002f593 | 1c5bc2d2-ecbf-4823-b5b9-5ff5126e11a2 | machinery-review/flash      | REFINE awaiting_parent          | 177.874s | 0 | nothing unique; overbroad Sharpen-parser nomination
20:02:07 | d813676c-63c0-4127-a61f-1f41c8bbdc9e | 160e3721-c83d-4ca8-9114-dff6b1231fc4 | founder-advice/flash        | advisory active                 | 120.596s | 0 | identified compiler fixture block, but overbroad
20:04:41 | 79b9b5b5-099e-4def-8b01-875b85a51f7a | 40e1a60d-16d3-409f-8ab7-3b40ef35020d | founder-advice/flash        | advisory active                 | 160.904s | 0 | uniquely corrected to production-owner rule and safe compiler subset
20:20:23 | 41a21245-fb4b-4149-957d-86d644ad5384 | c722945c-f2dd-40cd-b203-0ea3c5246ab0 | founder-advice/flash        | advisory active                 | 207.438s | 0 | first to identify synthetic session-continuation branch fixture block
20:24:11 | ab626b85-52f4-4d42-b71b-0d56f5ca1ad9 | ed384a74-5830-462a-a0fb-51f737e52a67 | founder-advice/flash        | advisory active                 | 69.509s  | 0 | nothing unique; confirmed same candidate
```

### Runs in the current ledger

All 65 rows below are backed by workflow snapshots plus persisted session
messages.

```text
UTC      | run                                  | session                              | flow/model            | outcome                         | runtime  | repairs | unique catch
17:40:17 | b3a2a186-d1f6-4fe2-a2f7-3e8368d94c35 | 04473d82-333e-471d-9531-ae56690f6170 | founder-advice/pro     | advisory success                | 141.542s | 0 | nothing unique; initial Gate-token recommendation was wrong
17:44:08 | cca18577-ad59-4dcd-8909-f73fbc418b1b | 04473d82-333e-471d-9531-ae56690f6170 | founder-advice/pro     | advisory success                | 55.063s  | 0 | uniquely caught ASK/HUMAN byte collision; Gate is semantic checksum
17:46:57 | ec77c171-c878-476a-9322-b35313910853 | 3608aae1-aef9-4da0-be10-ac0868110cfe | code-review/flash      | success; findings=0             | 96.605s  | 0 | nothing unique
17:47:02 | f0821c79-86d3-4375-a3fe-cabc43c9ce40 | 8dccde5c-b60b-4fbd-bbd4-fa9c0e4c1888 | pre-pr-review/flash    | not_ready                       | 2.191s   | 0 | uniquely exposed vacuous HEAD...HEAD/no-diff invocation
17:49:52 | 9e68044c-1309-4180-a4d5-98ac9c6995dd | d63ae219-399b-4f4e-9eab-b685e1b6a5d7 | machinery-review/pro   | GO                              | 141.239s | 0 | nothing unique
17:50:21 | 7f98ba01-646f-4bf3-9135-7d6dd962fcc4 | 5991e1f8-5482-44b8-be32-f4a7dc56fa92 | founder/pro            | GO                              | 62.326s  | 0 | nothing unique
17:56:20 | 9cb29642-b143-4e4a-8c15-cfadcbbe91b6 | 835e23af-d2f9-4144-bc8e-1e0981b199ac | machinery-review/flash | REFINE                          | 80.612s  | 0 | identified Sharpen inert-import deletion, but overbroadly proposed whole entrypoint file
18:07:05 | 7e11d684-0f20-4f2d-958b-7e3a7e5183e5 | 459850c8-2df9-4294-a464-ca268d1d8e22 | founder/pro            | GO                              | 156.187s | 1 | nothing unique
18:07:23 | 3153812b-63bb-4021-96ca-c6359dfaadae | 6eb2b830-c9ec-4d09-bc63-e25e0f45dbe9 | machinery-review/pro   | GO                              | 124.993s | 0 | nothing unique
18:12:19 | e263d83d-04e7-4475-8280-87ceb54b39e2 | 071d21fc-869e-4d9f-8ff5-8cb53ef5ef3f | machinery-review/flash | REJECT                          | 119.952s | 0 | uniquely challenged naive grader migration/exact-output consumers; superseded by fail-closed design
18:12:47 | 5370e38e-15a8-4db7-8d2e-2aaf5239e2f8 | 1e41899b-e7c3-4c3b-b319-67de9744e2a1 | founder-advice/flash   | advisory success                | 81.673s  | 0 | nothing unique; shared-400KB recommendation rejected
18:24:30 | 34f8bbed-6832-4e34-ba67-ba1b008dbbf8 | 83ad0c7b-44c6-4b9e-b64b-227abc1080bd | founder/pro            | GO                              | 30.463s  | 0 | nothing unique
18:24:58 | efa84d11-6866-4a13-b6e5-caab97460d50 | 77a84e46-f1ec-41b8-8e30-da4d48a4e5c4 | machinery-review/pro   | GO                              | 319.650s | 3 | nothing unique
18:33:00 | b80cff2e-7621-4fef-95f9-dbcdbf5c7492 | 748ad611-226c-4583-8c7a-8d398e450b1c | founder-advice/flash   | advisory success                | 59.085s  | 0 | nothing unique; defects were supplied in prompt
18:34:34 | 8a4e4356-0881-447e-93be-06ee4250a3d1 | 748ad611-226c-4583-8c7a-8d398e450b1c | founder-advice/flash   | advisory success                | 49.409s  | 0 | uniquely resolved fail-closed ambiguity to deep handoff
18:43:21 | aa99f3a8-4462-4895-92a0-01eb8a384d39 | be9cc693-e842-4101-9968-627b550a8aeb | machinery-review/flash | GO                              | 71.696s  | 0 | nothing unique
18:46:46 | da44e865-2de2-4c4b-97ee-747020bfd82d | 2e5f4fd0-a739-460c-8fc7-0a989d27ce5e | founder/pro            | GO                              | 75.283s  | 0 | nothing unique
18:47:11 | 4830070d-1010-4c07-8ec4-0b0773a09bbf | 802a15f3-1047-466b-8b49-401d69d9f449 | machinery-review/pro   | GO                              | 311.107s | 1 | nothing unique
18:56:51 | 4c6937aa-cefb-47d0-87ce-5c05db31aff5 | bb7e0630-c461-4e5b-a50f-c1d34220e64a | machinery-review/flash | REFINE                          | 144.808s | 0 | uniquely identified full judge-prefetch deletion candidate
18:56:56 | bd46ed33-1ead-483d-b78f-2eb8c8471686 | 92a4f19f-1b3d-4a41-b9f6-62fcb64e032e | founder-advice/flash   | advisory success                | 173.374s | 0 | nothing unique; omitted stronger prefetch candidate
18:57:25 | 5e5ed61b-6adc-4d95-8fc3-b423146de987 | 582f7938-8af3-4b2d-8cab-7ae222b2dbf7 | machinery-review/flash | GO                              | 180.167s | 1 | nothing unique; false negative on pre-PR smoke
19:00:33 | c19fb588-e255-4d24-8b0a-e574a1822db4 | 92a4f19f-1b3d-4a41-b9f6-62fcb64e032e | founder-advice/flash   | advisory success                | 151.041s | 0 | nothing unique
19:01:47 | 23a599ba-ab2c-4843-a886-0dd6e08b0faf | 5b8ae045-6005-4ee1-958a-1cb916156076 | machinery-review/flash | REFINE                          | 295.387s | 3 | uniquely caught omitted redundant pre-PR compile smoke
19:04:55 | dc1c3a79-94a5-421a-83a0-0afd87d5d5a5 | 92a4f19f-1b3d-4a41-b9f6-62fcb64e032e | founder-advice/flash   | advisory success                | 92.173s  | 0 | nothing unique; confirmed prefetch candidate
19:22:37 | c066c5d2-5069-45cf-b417-19c70fadf7cd | 3689b63d-d36b-44c0-8f1e-223248c495af | founder/pro            | GO                              | 110.995s | 0 | nothing unique
19:22:37 | 7cea71b4-8418-4d26-ae82-cdb41bec8973 | 20169f60-4348-40a5-93e5-c0d42d5bfaa4 | founder/pro            | GO                              | 91.712s  | 1 | nothing unique
19:30:03 | bd208496-6fdb-4ade-9abf-5fe6285c0c6c | eb61d689-613c-4184-8773-25e465d48730 | founder-advice/flash   | advisory success                | 127.749s | 0 | nothing unique; selected already-caught pre-PR smoke
19:31:27 | 493009ed-161d-4e14-ae6a-c5942d6e0339 | 34bce94d-bd86-40bc-949d-6f553cc79503 | machinery-review/flash | REFINE                          | 396.392s | 2 | nothing unique
19:39:47 | 696394ec-9824-4f4d-a272-3e06b987f66e | 69dd1ed0-513e-4a04-a32e-125aed033b36 | founder/pro            | GO                              | 70.085s  | 0 | nothing unique
19:45:12 | a89487b3-6cbb-476c-a65f-ae2ebe3ff6b0 | 22f63c4f-32d4-4262-9899-f506661a7d75 | founder/pro            | GO                              | 98.886s  | 0 | nothing unique
19:53:50 | b180bed4-29b3-4632-b39b-350639f3a640 | 480da80e-90a7-4a03-9887-a9681147a818 | machinery-review/flash | REFINE                          | 28.141s  | 0 | uniquely caught stale/nonexistent target file
19:54:52 | 9d922637-3d5d-44f6-b458-cba2c1a4f861 | 8fbbefcf-ec5f-45c8-bb0b-cea1b33ad5fb | machinery-review/flash | FAILED terminated               | 89.685s  | 0 | nothing unique
19:56:37 | 1a003401-5089-4518-b619-6fe0f7052900 | 85aac2e2-9b80-4600-aa71-42c5cee1af30 | machinery-review/flash | REFINE                          | 72.631s  | 0 | uniquely raised Finding.evidence lacks min(1); later deemed prose/model-owned
19:56:52 | bd992d3f-42dc-4b8f-9813-59c43ce9066a | 50a3bf9f-6f3e-4ec6-b66e-bd898f89c19c | founder/pro            | GO                              | 131.144s | 0 | nothing unique
19:57:54 | e2da1619-4cb5-4964-9510-ef538804e691 | b52d7f75-06b1-4712-96d8-53ed933c1e67 | founder/pro            | GO                              | 72.140s  | 0 | nothing unique
19:59:06 | 2b04f08c-ae11-4984-a786-2211adc9ac7b | 76affe01-d204-4210-a58e-121b8fb8e3a6 | founder/pro            | GO                              | 76.943s  | 0 | nothing unique
20:00:30 | 0529bd61-6405-43d1-af82-99af81988e08 | 7cd5061c-b4ba-457b-9f45-c9dd2bc02b06 | founder/pro            | GO                              | 72.384s  | 0 | nothing unique
20:02:27 | 2f0bff27-c7ef-4a27-b2e3-19f893fd8a13 | 0f3932fd-1e56-4d12-8dd6-06d6dbb23c0e | machinery-review/flash | GO                              | 137.189s | 0 | nothing unique; overbroad false-positive deletion set
20:05:07 | 7b189499-0660-4784-90c5-8b3dfe613348 | 0f3932fd-1e56-4d12-8dd6-06d6dbb23c0e | machinery-review/flash | GO                              | 167.812s | 0 | uniquely corrected prior GO: retain Edge recon/expand condition and NAVI_JUDGE_MODEL wiring tests
20:10:18 | 26079e60-b8c5-4302-92d3-92edabc577ae | c202a460-d003-4c7e-93c9-44d3315caad1 | machinery-review/flash | FAILED finishReason=tool-calls  | 342.145s | 2 | nothing unique
20:16:33 | 8c688851-a706-4ebf-acae-f91a445e40cf | a44db1e7-0d9b-42d1-b302-bb0db6cc1616 | machinery-review/flash | REFINE                          | 88.194s  | 0 | uniquely retained inline YAML output-schema requiredness boundary
20:18:29 | 16599a90-1520-41b2-a95b-c5b26ef02c22 | 8e587b4c-ba1a-44c9-a52c-80ab4e5be197 | founder/pro            | GO                              | 56.172s  | 0 | nothing unique
20:20:35 | 31a331e8-f772-49f8-a383-99823ec90944 | 79e84164-48fe-4f54-922b-46bafce1fcac | machinery-review/flash | GO                              | 227.585s | 1 | nothing unique
20:25:09 | 3fdbff83-7929-4def-a4f6-8bb4ba0d8e8c | d9c30d42-8c0d-4a1e-85eb-de34e2c3a1a0 | machinery-review/flash | GO                              | 100.230s | 0 | nothing unique; confirmed session-continuation candidate
20:29:58 | e85e142d-7bd7-449b-9df4-53451378ccf8 | e499b54a-b6a1-4244-8b9c-d71a39a81e2f | founder/pro            | GO                              | 64.370s  | 0 | nothing unique
20:32:07 | 4dfef2f1-4971-44b8-800e-910d03e8edd4 | 333e57b9-d0c3-4053-b5bf-31e04873a22b | founder-advice/flash   | advisory success                | 51.443s  | 0 | first to nominate Code Review shallow step-type cut, but missed mixed-path owner
20:32:16 | 2a3e6fc7-ce08-48d2-b041-b369d807af12 | b758d9ef-3929-47bc-89ed-c5835d2e75fa | founder-advice/flash   | advisory success                | 110.103s | 0 | uniquely selected Edge Walk generic topology snapshots while preserving wiring tests
20:34:15 | 972a6ea3-a6cc-4a51-9d0a-26722d228703 | c6f1299f-43e5-4600-bb63-043d6140df35 | machinery-review/flash | GO                              | 70.421s  | 0 | nothing unique
20:37:36 | 853c2f8c-4431-4f92-b588-ffc5533a5798 | 15d4b9d9-3c24-4877-8ced-826b1b3aadb3 | founder/pro            | GO                              | 72.022s  | 0 | nothing unique
20:39:18 | ec3d50cc-9fe2-4bc6-ba4d-92db51df21c9 | 333e57b9-d0c3-4053-b5bf-31e04873a22b | founder-advice/flash   | advisory success                | 65.149s  | 0 | uniquely caught Code Review compile smoke is sole mixed command+agent owner
20:40:29 | b336d6b1-e82c-428a-a3f1-0c4b9a859625 | 330e44e8-9a72-4962-aabc-57927771b0c3 | machinery-review/flash | REFINE                          | 118.720s | 0 | nothing unique; confirmed prior advice
20:42:58 | 782c9aae-b155-4aa3-80bc-ec177c3ea0cd | c0061e04-d348-4db9-84d3-41d56b2ac2db | founder/pro            | GO                              | 84.395s  | 0 | nothing unique
20:45:50 | 58a6517e-d07e-4fe1-8676-ca4e7e83dc28 | 046605e0-79a8-401b-97c4-4d1f514941ed | machinery-review/flash | REFINE                          | 95.399s  | 0 | uniquely caught nonempty-stdout assertion subsumed by JSON.parse
20:46:08 | 9361a222-eff6-46e6-9685-3e4afa097388 | 333e57b9-d0c3-4053-b5bf-31e04873a22b | founder-advice/flash   | advisory success                | 142.375s | 0 | nothing unique; correctly recommended stopping deeper Sharpen cuts
20:51:45 | ed67876d-e2e0-404f-8be7-aacaad0293a2 | 880d39fd-5083-4d1b-ab5c-fd8c91714dc3 | founder/pro            | GO                              | 99.823s  | 0 | nothing unique
20:54:17 | 7e0b934d-689b-42b3-a979-c89a57d8e45f | 333e57b9-d0c3-4053-b5bf-31e04873a22b | founder-advice/flash   | advisory success                | 122.124s | 0 | nothing unique; digest-test recommendation was unsound
20:54:56 | c2f89f8e-457e-41d9-9d23-287923477b3c | e0843de4-0b8f-4aa3-8a94-4ce55e71994e | machinery-review/flash | REFINE                          | 114.999s | 0 | uniquely caught deep_tool_roundtrip telemetry redundant with nonce
20:56:39 | 0417c7ce-1e23-45cb-9805-10d9cc257e92 | 333e57b9-d0c3-4053-b5bf-31e04873a22b | founder-advice/flash   | advisory success                | 247.448s | 0 | uniquely caught digest verifier is not independent; rejected unsafe deletion
21:06:12 | afb88102-c3f3-4eaa-84d3-25d60c77c865 | a86f1eb2-fbdd-466d-874f-4718e1dd7f7b | founder/pro            | GO                              | 105.252s | 0 | nothing unique
21:12:32 | e69d8e41-6da8-4f56-ab5b-319234cc32df | f0fe76e4-af43-4255-89dc-2ad979bec093 | founder-advice/flash   | FAILED terminated               | 53.080s  | 0 | nothing unique
21:12:59 | ac80c5f3-21ed-41a2-8f32-19a1fb922faf | 6bb7bdc5-9b9d-443b-8af2-fab24fbee4bf | machinery-review/flash | GO                              | 152.037s | 0 | uniquely verified exact lane_evidence deletion surface/self-referential attestation
21:13:36 | 0191abb3-8e7b-4554-b4f3-0539b96b521c | f0fe76e4-af43-4255-89dc-2ad979bec093 | founder-advice/flash   | advisory success                | 88.901s  | 0 | nothing unique; same lane_evidence candidate with reverse conditions
21:13:50 | 8423705c-5a61-4d35-b3cc-06befa17f5f3 | 9af88b7d-b3e7-4a96-93f0-3e27f37375a9 | founder-advice/flash   | advisory success                | 164.758s | 0 | uniquely nominated pre-PR deterministic large-diff chunking as next model-ownership cut
21:18:49 | d4cbe957-829e-4451-93e8-2f0688a4a914 | 8876c10c-c6ba-4b3b-b358-b96c2f1f85e4 | founder/pro            | GO                              | 87.457s  | 0 | nothing unique
21:23:32 | 3701445b-d7e8-45ca-ae91-e9f249ba7479 | cec39f37-9267-4532-8504-c880c172a2c3 | machinery-review/not reached | RUNNING/interrupted; no messages | 0.001s | 0 | nothing unique
```

### Launcher failures before run creation

```text
UTC      | run/session | intended flow/model      | outcome         | runtime | repairs | unique catch / provenance
17:57:07 | none        | founder-advice/flash     | exit 1          | 0.594s  | 0 | `NAVI_DB=:memory:` rejected; nothing unique; rollout 13-55-12
18:06:46 | none        | founder/pro              | exit 4          | 0.525s  | 0 | missing required request arg; nothing unique; rollout 14-06-30
18:12:32 | none        | founder-advice/flash     | exit 1          | 0.726s  | 0 | invalid `--progress quiet`; nothing unique; rollout 14-10-44
20:04:31 | none        | founder-advice/flash     | exit 1          | 0.687s  | 0 | `-t` targeted an ephemeral session absent from current ledger; nothing unique; rollout 15-28-12
```

Campaign schema repairs: **18**. Seven unrelated `mpi-dstack` Founder
envelopes and two associated schema retries were excluded by working directory
and request.

## Dependabot alert printed on push

The repeated push notice is GitHub Dependabot alert **#1**:

- package: `@ai-sdk/provider-utils`
- ecosystem: npm
- dependency: transitive runtime dependency in `package-lock.json`
- advisory: `GHSA-866g-f22w-33x8`
- CVE: `CVE-2026-8769`
- severity: LOW
- weakness: `CWE-400`, uncontrolled resource consumption
- CVSS v3: 4.3
- CVSS v4: 2.1
- affected versions: `<= 3.0.97`
- first patched version: none published
- repository alert:
  `https://github.com/machinepathindustries/navi/security/dependabot/1`

The lock contains two affected copies:

- alias `provider-utils-v5@3.0.30`, pulled directly through Mastra's dependency
  graph;
- nested `@ai-sdk/provider-utils@2.2.8` through
  `@mastra/core → @ai-sdk/ui-utils-v5@1.2.11`.

Unaffected 4.x/5.x copies also coexist in the lock, but their presence does not
remediate the vulnerable 2.x/3.x copies. The current latest checked Mastra
release, 1.54.0, still resolves affected versions, so there is no clean
framework bump today. Do not force a 4.x override across incompatible AI SDK
majors without validation.

Disposition: track the upstream patch/backport; when available, regenerate the
lock and prove no resolved copy is `<=3.0.97`. Until then, keep untrusted
provider/model response bodies bounded by existing request-size and timeout
controls and record this as an accepted low-severity release risk.

## Audit conclusion

This campaign is **not closed** by the current suite. It removed substantial
test machinery, but destructive proof found both genuine duplicates and live
seams with no owner. The CLOSED records above may be committed as the first
closed-seams entries. Every EXPOSED record requires either a focused surviving
owner, an explicit product-level retirement decision, or the preregistered
evaluation before the campaign can be represented as fully guarded.
