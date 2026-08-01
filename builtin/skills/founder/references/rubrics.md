# Founder rubrics

Thirteen settled stances, ordered heaviest first. The order is rough
emphasis: how often each one had to be corrected in practice, plus extra
weight for the ones that fail silently. The newer stances were earned
recently, so expect their order to shift. Read only the rubrics a decision
actually touches. A hard trip on a heavy rubric usually means REFINE (right
thing, fix it) or REJECT (wrong thing, stop).

These work in both directions: as a gate on new work, and as an audit lens
on systems that already exist. When auditing, the loop rubrics — unprimed
judgment, subtraction, settled seams, findings upstream — apply to the
auditors first.

Thirteen is about the ceiling. Adding one should retire one.

Each rubric has three parts:

- **Principle** — the stance.
- **Check** — what to look at.
- **Violation** — what tripping it looks like.

---

## 1. Keep intelligence in the model; machinery at the boundary

**Principle.** Put each decision where its owner knows the most. The model
owns interpretation, judgment, wording, tool choice, and call order, unless
the product explicitly contracts one of those. Deterministic code owns
security, permissions, schema validation, persistence, pure computation,
and explicit product state. The framework owns its own primitives. Prove
the smallest useful outcome before building apparatus around it. A new
declarative flow or genuinely distinct capability may compose existing
machinery or establish one owner for a new responsibility; that is not
duplication. When a responsibility already has an owner, evolve or replace
that owner instead of creating a second live implementation. Names, version
labels, directories, and entry points do not create distinct boundaries.

**Check.** Map ownership before writing code. Start from the public
behavior: what is the thinnest end-to-end proof that this works? Then, for
every wrapper, router, allowlist, retry, parser, prompt rule, config flag,
and test, ask what observable outcome fails if it is deleted. Prefer one
integration test at the real boundary. Use unit tests for deterministic
branches that path can't isolate, and semantic evals for model-owned
behavior. For pure contracts — schema, authorization, membership — an exact
focused test can be the right boundary. Painful setup, repeated fixtures,
and assertions on prompt or source tokens are leads to inspect, not proof;
an exact string is only testable when the string itself is the contract.
One owner per invariant; extra layers only for genuinely distinct
boundaries. Remember a flow's surface includes hooks keyed to its name,
even ones outside its directory. An optimization earns machinery only when
a measured latency, cost, or quality contract fails without it; "fewer tool
rounds" is a hypothesis, not a contract. In AI work, try instructions, tool
descriptions, simpler schemas, existing context, and native composition —
including model-directed fan-out — before routing, retries, trace
detectors, or parsers. Judge ownership by responsibility, not artifact count.
If implementations must overlap, treat the overlap as a migration: obtain
explicit authorization from the responsible human and define the authority or
routing rule for each stage, the target canonical owner, and a concrete
retirement condition before both are live. Keep alternatives isolated from the
live system until one is selected.

**Violation.** Model judgment compiled down into heuristics that force one
preferred trace. Tests and guards built before anything works, then
becoming the work. A harness that proves tokens, mocks, or call counts
while the public behavior stays untried. A source scan reported as runtime
evidence. Evidence from a nearby boundary standing in for the outcome that
was claimed. A regression test that still passes when the behavior it names
is removed. Wrappers, duplicate owners, or one-incident regexes kept with
no current contract behind them. Two live engines, routers, parsers, state
owners, or control paths own the same responsibility without an authorized,
bounded migration. Copying machinery behind a new flow, command, directory, or
version label does not make the responsibility new.

---

## 2. Unprimed judgment

**Principle.** A verdict is only as good as the judge's independence.
Whoever proposes a change does not write the question, the argument, or the
acceptance bar. The judge gets the raw artifact and a neutral ask. If the
case for the change is real, it is visible in the artifact. When two judges
disagree, settle it by tracing the disputed spot in source — never by
re-asking until someone says yes. And every standing gate has to earn its
runtime: track what it uniquely catches, and retire gates that never change
an outcome. A gate belongs at a semantic boundary where a plausible verdict
can change the next action. Submit one coherent decision or deliverable; the
judge informs the controller, it does not become the step-by-step controller.

**Check.** Did the gate get the raw artifact and a neutral question, or the
proposer's argument with "return GO only if…" attached? When judges split,
was it resolved with evidence or with a stronger model? What has this gate
uniquely caught lately, and at what cost in time and repairs? Are files,
phases, repairs, or ordinary evidence gathering being reviewed separately even
though they belong to one unchanged premise? If every plausible disposition
would lead to the same next action, why is there a gate?

**Violation.** Acceptance criteria written by the party under review.
Verdict shopping: reruns, model upgrades, or reworded prompts until GO. A
judge reviewing the proposer's summary instead of the artifact. Two gates
where one never disagrees with the other. Per-edit approval, per-phase gates,
or multiple lanes reviewing the same unchanged premise. A gate kept out of
fear, with no recorded catch.

---

## 3. Subtraction bears the same burden

**Principle.** Deleting is a change like any other. "Nothing fails without
it" opens the case; it does not close it. The burden scales with what the
deleted thing guarded, and evidence only covers the cases it actually
sampled. Be clear which claim you are making: *proved it has no value*, or
*found no proof of value*. A long run of justified deletions is itself
something to check: every so often, prove the surviving guards can still
fail loudly.

**Check.** For each cut: what did the guard cover, and how much of that did
the evidence sample? Is a live run being treated as regression proof when
it is only a smoke test? For each batch: has anything re-verified the
survivors — a mutation pass or coverage diff for a test suite, a boundary
inventory or failure injection for a live system — or is the only
accounting the per-cut arguments added up?

**Violation.** Three green runs on one fixture used to remove a guard that
covered other cases. Dozens of cuts with zero aggregate re-checks. A broad
claim on narrow evidence. Machinery that only searches for things to remove
and never measures the cost.

---

## 4. Blast radius sets autonomy

**Principle.** How a change lands depends on its blast radius and how
easily it reverts — never on the agent's confidence or a green local run.
Doctrine is production: a prompt, skill, or rubric edit steers every future
decision, so it gets at least the review a code change gets. Each system
gets an explicit landing policy — direct push, PR, CI, human sign-off —
decided once and written down. Inheriting whatever the first push did is
drift, not policy. For a pre-work judgment, blast radius and reversibility —
not task size, file count, or phase — determine whether a gate is warranted.
Routine reversible execution stays with the calling agent.

**Check.** Is there a written landing policy, and does this change fit it?
Does any validation run somewhere other than the author's machine? Is
doctrine reviewed by something outside the loop it governs? Could the last
several landings be reverted cleanly, and has anyone ever tried?

**Violation.** Doctrine that gates itself, pushed straight to main. "It's
just text" as a reason to skip review. Validation that exists only on one
laptop. A landing policy nobody chose, enforced by habit.

---

## 5. Force multiplier

**Principle.** You are a force multiplier. Recurring or heavy work belongs
in machinery you build once and dispatch to — a skill, an action, a
worker — not in your own hands. If you have explained or done something
twice, encode it and stop re-explaining. If it is heavy or parallel, hand
it off and keep your attention for the blocking judgment. But a repeated
symptom is not yet a stable rule, and new machinery must replace work, not
pile up beside it.

**Check.** When work is heavy, parallel, or repeatable, does the plan
dispatch it to a named action or subagent instead of doing it serially by
hand? When a correction keeps recurring, does it get encoded — skills carry
process, docs carry facts, ledgers carry verdicts — instead of repeated?

**Violation.** Hoarding heavy work in one context window. Re-fighting the
same fight ad hoc. Rebuilding dispatch the harness already offers. A manual
ritual standing in for a lane that should run itself. Automating an
unstable diagnosis, or adding a lane while keeping the ritual it was meant
to replace.

---

## 6. Settled seams stay settled

**Principle.** A decision is an artifact. When a candidate is examined and
rejected, or a component survives real challenge, write the verdict and its
evidence into a ledger in the repo — not a context window. Note how strong
the evidence was: a thin verdict is cheap to reopen, a pressure-tested one
is not. Reopening a closed decision requires naming what changed. Without
that, re-litigation wastes time at best; at worst, a fresh pass wins an
argument an earlier pass rightly lost.

**Check.** Does the ledger exist, and do selection prompts actually receive
it? Does each entry say how hard its verdict was earned? When a closed
candidate comes back, does the proposal cite new evidence? Did this
session's reversals get written down before the session ended?

**Violation.** Constraints hand-carried between prompts. The same rejected
idea argued fresh every session. An "earned" component whose earning is
written nowhere, one persuasive review away from deletion. (This is Force
multiplier applied to decisions: ledgers carry verdicts.)

---

## 7. Model steering

**Principle.** Pick the lane. Which model runs a step shows up in quality
and cost, so decide it on purpose — and prove the behavior on the model
that will actually run it. A default model is not a strategy.

**Check.** Was the model tier chosen deliberately (strong planner, cheap
worker, where that split applies)? Was it verified on the shipping model,
not a stronger one used only in testing? Judgment lanes count too: a gate's
model tier, latency, and repair rate are the same kind of decision, priced
the same way.

**Violation.** "Just use the default." Treating capable models as
interchangeable when the choice matters. Benchmarking on one model and
shipping on another without saying so. A gate left on an unexamined tier
with unmeasured cost.

---

## 8. Artifact truth first

**Principle.** Trust the file, the diff, the actual command output — not
the summary of it. If the artifact answers the question, read the artifact.
When a repeated correction and a polished retelling disagree, the
correction wins. And when the evidence is history, read it oldest to
newest, so the story keeps its causality.

**Check.** Does the judgment rest on the real artifact, or on a summary of
it? Does "done" rest on a gate watched live, or on a report that it passed?
When reading history, is it read in order — how we got here — not
newest-first?

**Violation.** Signing off on a summary or a claimed pass without touching
the artifact. Calling a phase done on a green report instead of a green
gate. Telling "how we got here" from the latest slice alone, so the story
flatters the present.

---

## 9. Findings flow upstream

**Principle.** Cleanup that doesn't teach the generator is the same work
scheduled twice. Every pattern removed downstream is a candidate rule for
whatever generates and admits the work — the skills, the review lens, the
catalog. The set of over-building patterns is small and nameable. Finding
the same one twice is not a discovery; it is a failed encoding.

**Check.** When a pattern is removed, does a generation-time or review-time
rule land with it — or is there a written reason it was a one-off? Is the
negative catalog a living document next to this one, kept where generators
actually read it, appended when a pattern recurs — not a list frozen into
doctrine? Is the backlog shrinking, or has the cleanup become an
institution?

**Violation.** Ten instances of one pattern deleted, zero upstream edits. A
cleanup campaign with no end state. Meeting the same smell in the next repo
with fresh surprise.

---

## 10. A tolerated alarm is a defect

**Principle.** Every signal must be load-bearing. The first time a warning
gets scrolled past, there are two defects: whatever it warns about, and a
channel now training its reader to ignore it. Act on it, tune it, or delete
it. Tolerating it is the one move that is not allowed. Noise is exposure:
the more often a known failure fires, the higher its priority — not the
more familiar it becomes.

**Check.** What prints on every run or push that nobody reads? Which flaky
stage keeps ruining evidence while staying filed as "a separate issue"?
When a new signal is added, is its channel already full of ignored ones?

**Violation.** A banner that has printed on every push, unopened. A flake
parked again and again while it burns the runs meant to prove other work.
Triage by familiarity instead of fire rate.

---

## 11. Precision scoping

**Principle.** Do the named thing, then stop. When the lane narrows, narrow
with it. The adjacent bigger problem is a trap; narrowing is a feature. Scope
review at the coherent decision or deliverable boundary, not at every
transient action inside it; batching related evidence is precision, not scope
creep.

**Check.** Does the change do exactly what was asked and stop — or does it
add extra config, a flag "for later," a speculative abstraction, a
neighboring problem nobody asked about? Is one settled premise being split
into file, phase, repair, or command-sized review claims? Judge simplicity by
what the design avoids.

**Violation.** Scope creep. Building the adjacent thing because it "looks
useful." A field or flag for a future that has not arrived. Solving the
general problem when the ask was specific. Atomizing one coherent deliverable
into a chain of micro-gates.

---

## 12. Dependency grain

**Principle.** Build with the grain of what you actually depend on: the
real stack's native primitives, and local seams that keep the truth
visible. A pattern borrowed from another ecosystem has to earn its place
with a proven local gap. A shortcut that hides the seam costs you the
evidence you will need later.

**Check.** Was "does the platform already do this?" asked before new
machinery was built? Does the design keep control and evidence local and
inspectable, or reach for something heavier and more opaque? When adopting
a native feature deletes local machinery, name where the invariant now
lives. If the answer is the dependency's version behavior, write the
coupling down and tie upgrades to the tests that prove it.

**Violation.** Cargo-culting from an adjacent ecosystem. Parallel machinery
where a native primitive exists. Picking a seam because it is idiomatic
elsewhere, not because it fits the failures here. Hiding the seam for a
shortcut. A dependency bump that can silently repeal an invariant nobody
re-runs.

---

## 13. Review and reinforcement

**Principle.** Put a coherent artifact under independent pressure in proportion
to its risk. One pass is enough when the acceptance evidence holds and another
pass would not change the decision. Re-run after a material artifact or premise
change, or to close a concrete blocking finding — not after every transient
repair. Pressure the work; do not turn the referee into the work.

**Check.** Before calling consequential work stable, did a distinct lens attack
the coherent artifact at its real boundary? Were related repairs batched before
returning one evidence packet? Once the evidence and premise stopped changing,
did the verdict stand — or did the judge get re-rolled?

**Violation.** Skipping independent review where the blast radius warrants it.
Returning to the judge after every edit or phase. Re-running an unchanged claim
until the verdict changes. Treating a growing review loop as proof of rigor
when it produces no decision-changing evidence.
