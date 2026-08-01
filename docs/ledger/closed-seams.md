# Closed seams ledger

This ledger turns the destructive-mutation evidence in
`docs/audit/CAMPAIGN-AUDIT-2026-07-29.md` into durable decisions.

Statuses:

- **CLOSED** — a focused surviving test fails when the named contract is broken.
- **EXPOSED** — the contract is live, but no surviving test owns it yet.
- **RETIRED** — the behavior is intentionally no longer a product contract.
- **ACCEPTED** — the gap is known and accepted until its stated reopen condition.

Evidence strength:

- **Strong** — a destructive mutation failed at the named surviving boundary.
- **Moderate** — the decision is grounded in current structure or measured
  behavior, but not a dedicated mutation-owning test.
- **Accepted risk** — the gap is explicit and carries a concrete reopen trigger.

## Existing closed seams

| ID | Contract | Evidence strength | What would reopen it |
|---|---|---|---|
| CS-002 | Founder resolves and compiles its native verdict schema. | Strong — a missing schema path fails the real provider-compatibility compile path. | Founder stops using the native schema, or those integration owners are removed. |
| CS-003 | Founder verdicts are exactly `GO`, `REFINE`, or `REJECT`. | Strong — adding `MAYBE` fails public outcome and session-filter tests. | The verdict enum or either shared consumer changes. |
| CS-006a | A numeric review finding validates through both Code Review and Pre-PR. | Strong — making Pre-PR require a string line fails its loaded-schema integration test. | Either flow stops using the canonical numeric finding shape. |
| CS-007a | Code Review uses its exact read-only reviewer tools. | Strong — reducing the tool list fails the focused workflow test. | The workflow's required tool capability changes. |
| CS-007b | Pre-PR uses its exact read-only reviewer tools. | Strong — reducing the tool list fails the focused workflow test. | The workflow's required tool capability changes. |
| CS-012a | Pre-PR remains a two-step graph. | Strong — appending a third step fails the focused shape test. | The product deliberately changes the graph. |
| CS-014 | Every Directive has nonempty evidence and completion criteria. | Strong — weakening either canonical `.min(1)` fails direct schema tests. | The Directive contract changes. |
| CS-016a | A satisfied Directive with its original arrays is accepted. | Strong — removing `satisfied` from the canonical enum fails contract and session integration tests. | Satisfied directives are removed from the product. |
| CS-016b | A satisfied Directive may be omitted as `directives: []`. | Strong — requiring a nonempty composite array fails the real composite parse. | Empty directive output stops being valid. |
| CS-017 | The `hello-two-step` inline output schema requires its declared `keywords` field. | Strong — deleting `keywords` from the real fixture fails the compiler test. | That fixture's `keywords` requiredness or inline-schema compiler path changes. |
| CS-019 | Edge Walk continuation skips recon only for its own current-revision surface map. | Strong — production and predicate mutations fail workflow and truth-table tests. | Continuation ownership or revision semantics change. |
| CS-021a | Edge Walk's input is named `input`, JSON-typed, and required. | Strong — independent name, type, and requiredness mutations fail CLI integration. | The public input contract changes. |
| CS-022 | Edge Walk topology remains `recon → expand → judge`, all Agent steps. | Strong — name and type mutations fail real output, dependency, and compile owners. | The shipped workflow topology changes. |
| CS-023 | Code Review keeps its command collector wired to its Agent reviewer. | Strong — independent name and type mutations fail collector, schema, and compile tests. | The shipped review topology changes. |
| CS-024 | Public surfaces retain the documented built-in workflow set. | Strong — removing or adding a workflow fails catalog or release-surface tests. | The documented built-in catalog changes intentionally. |

## Fix queue

### CS-004 — Founder verdict text is trimmed and nonempty

- **Status:** CLOSED
- **Evidence strength:** Strong — a focused schema test proves trimming and
  rejects whitespace-only text in `take` and every verdict array. Weakening
  `VerdictText` to `z.string()` failed that test; restoration returned it to
  green.
- **Owner:** `tests/envelope.test.ts`.
- **Gate:** GO on DeepSeek V4 Flash, one call, 24.7 seconds.
- **Reopen when:** the shared text schema or its focused owner changes.

### CS-007c — Founder, Founder Advice, and Code Search retain the exact shared read-only toolset

- **Status:** CLOSED
- **Evidence strength:** Strong — one focused census loads all three shipped
  shapes and asserts Agent type, exact equality to
  `READ_ONLY_WORKSPACE_TOOLS`, nonempty access, and no zero-tool warning. Each
  flow failed independently when reduced to only `view`, and each failed again
  at zero tools; every restoration returned the census to green.
- **Owner:** `tests/compiler.test.ts`.
- **Gate:** GO on DeepSeek V4 Flash, one call, 40.7 seconds.
- **Reopen when:** any of the three flows changes its required read capability.

### CS-009 — Quick grader failures fail closed to deep

- **Status:** CLOSED
- **Evidence strength:** Strong — focused tests cover a thrown grader call, an
  invalid structured object, a non-`stop` finish, and a valid positive control.
  Changing only the failure result's `escalate: true` to `false` failed all three
  failure cases while the positive control stayed green; restoration returned
  all four to green.
- **Owner:** `tests/grounding-stage.test.ts`.
- **Gate:** GO on DeepSeek V4 Flash, one call, 51.8 seconds.
- **Reopen when:** grader disposition or deep-handoff rendering changes.

### CS-012b — Pre-PR compiles successfully

- **Status:** CLOSED
- **Evidence strength:** Strong — a focused test compiles the shipped Pre-PR
  shape with the production workspace and asserts its reviewer agent identity.
  Binding a nonexistent required skill made the test fail; restoration returned
  it to green.
- **Owner:** `tests/pre-pr-review.test.ts`.
- **Gate:** GO on DeepSeek V4 Flash, one call, 44.8 seconds.
- **Reopen when:** Pre-PR skill binding or compilation changes.

### CS-015 — Edge Walk's composite consumes the canonical Directive schema

- **Status:** CLOSED
- **Evidence strength:** Strong — a focused identity assertion owns the
  composite's canonical `Directive` binding. Replacing `z.array(Directive)` with
  `z.array(z.any())` failed that assertion; restoration returned it to green.
- **Owner:** `tests/whisper.test.ts`.
- **Gates:** REFINE on DeepSeek V4 Flash in 49.7 seconds for a redundant
  behavioral composition test; after narrowing to the exact binding seam, GO in
  40.1 seconds. Two calls total.
- **Reopen when:** the composite or canonical `Directive` binding changes.

## Retired contracts

| ID | Retired contract | Evidence strength | What would reopen it |
|---|---|---|---|
| CS-013 | **RETIRED** — Sharpen's Markdown parser lane was replaced by Brainstorm's one native structured Agent result. | Moderate — the parser and command step are absent; Brainstorm's atomic shape has a focused compile/schema owner. | Brainstorm introduces a parser or command protocol. |
| CS-005 | **RETIRED** — the Founder Markdown parser/process/package protocol was replaced by native structured output; its files and runtime path are absent. | Moderate — grounded in the absent runtime path, not a mutation-owning test. | A Markdown parser or equivalent process boundary returns. |
| CS-006b | **RETIRED** — exact structural parity after hypothetical schema decoupling is not a present contract; both flows currently share one imported schema. | Moderate — grounded in the shared import, not a hypothetical decoupling test. | Pre-PR stops importing the canonical finding schema. |
| CS-008 | **RETIRED** — Sharpen parser import inertness disappeared with the parser lane; Brainstorm uses native structured output. | Moderate — grounded in the absent runtime path, not an import-inertness owner. | Product code introduces or imports an equivalent parser. |
| CS-010 | **RETIRED** — the raw three-line grade and independent Confidence fallback were replaced by structured grading. | Moderate — grounded in the removed protocol, not a legacy-parser test. | Raw-text grade or Confidence parsing returns. |
| CS-020 | **RETIRED** — the synthetic continuation fixture topology was removed; the production continuation predicate has independent owners. | Moderate — grounded in the fixture's removal and current production owners. | The fixture becomes a shipped or contract-bearing workflow. |
| CS-021b | **RETIRED** — exact one-argument cardinality is not promised; name, JSON type, and requiredness remain CLOSED. | Moderate — grounded in the narrower live contract and its strong owners. | A public consumer requires exactly one declared argument. |
| CS-025 | **RETIRED** — the Sharpen parser entrypoint was removed; Brainstorm's native structured result is the product boundary. | Moderate — the entrypoint and its parser-only test are absent. | Brainstorm introduces a standalone output parser. |
| CS-026 | **RETIRED** — an exact provider deep tool-call/result trace is an implementation detail, not a promised route; the current lane uses exit plus a random nonce as its outcome predicate. | Moderate — no surviving test owns the retired ordered trace or the remaining nonce predicate. | The product promises a specific provider tool-call/result route. |
| CS-027 | **RETIRED** — persisted per-lane component narration was intentionally removed from the provider artifact. | Moderate — grounded in the current lane-level artifact contract. | A consumer requires per-component attestation rather than lane outcomes. |
| CS-028 | **RETIRED** — component-level Docker evidence narration was intentionally removed. | Moderate — decision-backed; no surviving test owns that narration. | A consumer or real incident requires component-level Docker evidence. |

## Accepted risks

### CS-001 — PLAN-without-evidence adjudication meaning

- **Status:** ACCEPTED
- **Evidence strength:** Accepted risk — this is model-owned semantic doctrine;
  exact-token tests would own wording rather than judgment.
- **Reopen when:** the centralized DIRECT/REPAIR doctrine changes, a real gate
  misclassifies this case, or a stable semantic evaluation can own the behavior
  without compiling it into string machinery.

### CS-011 — Removed Edge Walk judge prefetch

- **Status:** ACCEPTED
- **Evidence strength:** Accepted risk — the feature and guards are absent; the
  audit preregisters a multi-repository ON/OFF evaluation.
- **Reopen when:** that evaluation meets every restore criterion, or a measured
  accuracy, budget, latency, or workspace-safety regression appears.

### CS-016c — Model-facing preserve-or-omit doctrine

- **Status:** ACCEPTED
- **Evidence strength:** Accepted risk — schema acceptance is CLOSED, while
  exact prompt wording remains deliberately untested.
- **Reopen when:** preserve-or-omit prompt or skill semantics change, or a live
  run/evaluation emits the forbidden third shape: a satisfied directive with
  blank evidence or completion arrays.

### DEP-001 — `@ai-sdk/provider-utils` resource-consumption advisory

- **Status:** ACCEPTED
- **Evidence strength:** Accepted risk — Dependabot alert 1,
  `GHSA-866g-f22w-33x8` / `CVE-2026-8769`, is LOW severity and has no published
  patched version. The lock contains the affected transitive 3.x alias; Mastra
  1.55 removed the prior affected 2.x copy.
- **Disposition:** keep response bodies bounded by existing request-size and
  timeout controls; do not force an incompatible AI SDK major override.
- **Reopen when:** an upstream patch/backport appears, severity or exploitability
  changes, a relevant incident occurs, or the vulnerable dependency leaves the
  lock.
