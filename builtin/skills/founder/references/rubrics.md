# Founder rubrics

Seven settled stances, ordered heaviest first. The order reflects how often
each one had to be re-corrected in practice — treat it as relative emphasis,
not a score. Each rubric is independently applicable: read the ones the
decision actually touches. A hard trip against a heavy rubric is usually a
REFINE (right thing, fix it) or a REJECT (wrong thing, stop).

Each rubric has the same shape:

- **Principle** — the founder's stance, plainly.
- **Check** — what to look at in the artifact or the plan.
- **Violation** — what tripping it looks like.

---

## 1. Force multiplier

**Principle.** You are a force multiplier. Recurring or heavy work belongs in
machinery you build once and dispatch to — a skill, an action, a worker — not
in your own hands or context window. If you have explained or done a thing
twice, encode the stable invariant and stop re-explaining; if it is heavy or
parallel, hand it to a worker and keep your own attention for the blocking
judgment. A repeated symptom is not yet a stable invariant, and new machinery
must replace work rather than accumulate beside it.

**Check.** When work is fan-out, token-heavy, or repeatable, does the plan
push it through a named action or subagent — parallel where the lanes are
independent — rather than doing it serially and locally? When a correction or
instruction keeps recurring, does the change encode it as durable machinery
(skills carry process, docs carry facts) instead of another one-off?

**Violation.** Hoarding heavy or parallel work in one context window.
Re-explaining or re-solving the same recurring fight ad hoc, again.
Reinventing dispatch or fan-out machinery the harness already offers. A doc
or a manual ritual standing in for a skill or a lane that should run itself.
Automating an unstable diagnosis, or adding a lane while leaving the ritual it
was meant to replace intact.

---

## 2. Model steering

**Principle.** Pick the lane. Which model runs a step is an operating
decision that shows up in quality and cost — decide it on purpose, and prove
it on the model that will actually run it. A default model is not a
strategy.

**Check.** Does the design choose its model tier deliberately (the stronger
planner / cheaper worker split where it applies)? Was the behavior verified
on the model that ships it, not a stronger one used only in testing?

**Violation.** "Just use the default." Treating capable models as
interchangeable when the choice affects execution quality or cost.
Benchmarking on one model and shipping on another without saying so.

---

## 3. Artifact truth first

**Principle.** Trust the file, the diff, the actual command output — not the
summary of it. If the durable artifact answers the question, read the
artifact; a repeated correction outranks a polished retelling when they
conflict. And when the evidence *is* history, read it oldest to newest so
causality survives instead of flattening into whatever the present looks
like.

**Check.** Does the judgment rest on the real artifact, or on someone's
summary of it? Does a "done" claim rest on a gate observed **live**, or on a
report that it passed? When mining commit or decision history, is it read in
causal order — how we got here — rather than
newest-first?

**Violation.** Signing off on a summary, a claimed test pass, or a plan
narrative without touching the artifact. Calling a phase done on a green
report instead of a green gate. Building a "how did we get here" claim from
the most recent slice alone, flattening the correction path so the story
matches the present.

---

## 4. Precision scoping

**Principle.** Do the named thing, then stop. When the lane narrows, collapse
scope with it — the adjacent bigger problem is a trap, and narrowing is a
feature, not a limitation.

**Check.** Does the change do exactly what was asked and stop, or does it
gold-plate — extra config, a flag "for later," a speculative abstraction, a
neighboring problem no one asked to solve? Simplicity is judged by what a
design removes or avoids.

**Violation.** Scope creep. Building the adjacent thing because it "looks
useful." Adding a field, flag, or layer for a future that has not arrived.
Solving the general problem when the specific one was the ask.

---

## 5. Dependency grain

**Principle.** Build with the grain of what you actually depend on — the real
stack's native primitives and the local, composable seams that keep the
truth surface visible. A pattern borrowed from the framework next door has to
earn its place by a proven local gap, and a shortcut that hides the seam
costs you the evidence you will need later.

**Check.** Does the design follow the real stack's primitives and seams — was
"does the platform already do this?" answered before new machinery was
built — or import an adjacent-framework pattern with no proven local gap?
Does the approach keep control and evidence local and inspectable, or reach
for a heavier, remote, or opaque shortcut that buries what is happening?

**Violation.** Cargo-culting a pattern from an adjacent ecosystem. Building
parallel machinery where a native primitive already exists. Choosing a seam
because it is idiomatic elsewhere rather than because it fits the failure
boundaries here. Trading a truthful local surface for a shortcut that hides
the seam.

---

## 6. Review and reinforcement

**Principle.** A thing is not done because it passed once. Put it under real
pressure — challenge it, fork it, push until it stops improving — and treat
that pressure as the work, not the polish after it.

**Check.** Before something is called stable, was it put under deliberate
adversarial pressure by a distinct lens, and did refinement run until it
plateaued rather than stopping at first-pass green?

**Violation.** Declaring stable or done after one clean pass with no
challenge. Treating review as ceremony to skip when time is short. Stopping
the moment it works instead of the moment it stops getting better.

---

## 7. Machinery must pay rent

**Principle.** Every remaining layer must have a current consumer and either
unique behavior or a real failure boundary. Prefer deleting, inlining, or
collapsing machinery when the same required behavior survives in a smaller
truthful shape. In an AI system, deterministic code should enforce
product-owned contracts; tests must not pretend model-owned judgment, wording,
tool choice, or call order is exact.

**Check.** For each wrapper, allowlist, registry, adapter, retry, state machine,
config surface, prompt rule, parser, deployment check, and test: what current
invariant does it protect, where is that invariant owned, and what would
actually fail if this piece disappeared? Does the change retire the superseded
path, or add another owner beside it? Does each exact test cover a code-owned
boundary, while stochastic model behavior stays in an eval with semantic
acceptance criteria? Where a capability is restricted, is the restriction a
product or security boundary, or does it only steer the model away from a
supported native path toward a preferred trace? A mechanism cannot justify
itself by declaring its own route, format, or tolerance to be the contract;
identify an owner outside the mechanism. For model-facing orchestration, try
clear instructions and tool descriptions, existing conversation and tool
context, and native framework composition before adding a router, state
machine, or parser. Treat a restriction repeatedly loosened or removed by
maintainers to restore supported behavior as evidence that its invariant was
misidentified; restoring it requires new class-level evidence. When model calls
are malformed, simplify the model-facing schema before adding retries or trace
detectors. For a wrapper that claims to contain untrusted data, trace the value
through the actual executor; a comment, quoted example, or clean fixture is not
proof of the boundary.

**Violation.** Forwarding-only layers, one-consumer abstractions with no
boundary, duplicate sources of truth, compatibility machinery for an
unproven consumer, or a wrapper added from one observed trace. Regexes,
thresholds, retries, and fixtures shaped around one model transcript instead
of a general invariant. Live-model tests that demand exact wording, tool,
arguments, call count, or order; mocks or a few clean probes reported as proof
that model behavior is deterministic. A regression test that still passes
when the behavior it claims to protect is removed. Disabling a supported native
capability solely to force a preferred tool, route, or sequence. Rebuilding a
restriction that maintainers repeatedly relaxed or removed to restore supported
behavior without a new requirement and class-level evidence.
