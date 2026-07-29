---
name: adjudication
description: >-
  Judgment discipline for weighing evidence and choosing a gate: claims are
  never evidence, so re-read the cited locations yourself; a five-check test for
  weak vs strong evidence; how to disambiguate CLEAR / REPAIR / BLOCKED /
  ESCALATE when more than one looks plausible; and the one-directive economy.
  Load when a step must evaluate returned evidence against a directive and
  decide the disposition — the method a judge applies, not the shape of what it
  writes down.
version: 0.1.0
tags:
  - judge
  - evidence
  - gate
---

# Adjudication

This is judgment discipline: how to weigh evidence and choose a gate. It is the
method, not the output shape — the disposition and directives you emit have
their own schema elsewhere. It is also the highest-stakes step: a weak judge
collapses the weak-versus-strong evidence discrimination that is the whole
point.

## Claims are never evidence

A claim is an assertion — "the change is backward compatible," "the path is
wired." Evidence is an inspectable artifact — the reader code that accepts a
missing field, the fixture that covers the old payload, the command output
showing it passes. Re-read every cited file:line yourself before letting it
close a directive; do not accept the parent's characterization of what a
location shows. A list of file paths or command names, with no content actually
inspected, is a claim *about* evidence, not evidence. Verification here is
re-reading the repository: the judge inspects the cited locations, it does not
re-run commands.

## Weak vs strong — the five-check test

Apply each check to every evidence item:

1. Does it point at an inspectable artifact — an exact file:line, or a command
   and its exit code — rather than prose describing what was done?
2. Does re-reading that exact location actually support the specific claim it
   is offered for, or only something weaker (it shows the function exists, not
   that anything calls it)?
3. If it is a test result, is it fresh for the *current* revision? A passing
   result computed before the diff changed proves nothing about the diff.
4. Does it trace the seam end to end — from the real trigger through to the
   target — or touch only one endpoint? A function's own definition, or a unit
   test of it in isolation, proves the function exists and behaves alone; it
   does not prove anything is wired to it.
5. Is it actually new information, or one agent's prior claim restated in
   different words? A restatement of a claim is not fresh evidence.

Apply the checks that match the decision's owner. Cross-layer wiring needs a
fresh runtime or integration result; a pure deterministic schema, permission,
or state contract can be closed by a focused test at that boundary; model-owned
interpretation, tool choice, and semantic output need a live semantic eval, not
assertions about exact tokens, call counts, or one internal trace. A captured
workflow command, exit status, and result are runtime evidence. Do not demand a
new test when the current outcome has already been exercised at its real
boundary.

Only an item that passes every applicable check closes a blocking directive.
One that fails on freshness or end-to-end tracing is unsupported: the directive
stays open — DIRECT (keep investigating) or REPAIR (fix the named defect), not
CLEAR — and you say plainly which check it failed.

## Choosing the gate

The non-terminal gates blur easily. Separate them by what would resolve the
situation:

- **CLEAR** — the specific directive in front of you is satisfied by strong
  evidence. This is the checkpoint clearing, not necessarily the whole session.
- **REPAIR** — you have a concrete finding that something *is broken*: the
  evidence itself shows the failure (the path is wired, but old data fails to
  load). REPAIR names the defect and directs a fix; it does not ask for more
  investigation.
- **BLOCKED** — progress cannot continue because something is missing that the
  *parent can still go get*: a dependency, a fact, a failed invariant, an open
  blocking obligation. This is "come back with X," not a call for a human.
- **ESCALATE** — resolution needs authority the parent lacks: genuinely
  ambiguous product intent, materially different external-behavior
  alternatives, an irreversible action, production/security/legal/financial/
  safety exposure, or dissent the models cannot resolve from the evidence. If
  more work by the parent would resolve it, it is BLOCKED, not ESCALATE.

When the budget runs out before a directive is settled, prefer BLOCKED (or an
explicitly partial, low-confidence clearance) over a false CLEAR. Never exit
silently, as if the question had been answered.

## Directive economy

Default to one directive. More than one is acceptable only with a stated reason
for needing it. Choose the single unresolved question with the highest expected
risk reduction — a long list just transfers orchestration back to the parent
and invites shallow, box-checking compliance. A directive is concrete when it
names the exact seam and the exact evidence that would close it: "trace the new
field from its producer through every serializer and consumer; return the
producer location, each serialization boundary, and the test proving old
payloads without the field are still accepted." It is not a directive when it
is a category — "think through edge cases," "review the architecture,"
"consider backward compatibility" are topics, not directives.

## A satisfied directive keeps its terms

CLEAR does not blank a directive. When strong evidence satisfies the open
directive, there are exactly two honest ways to record it, and no third: keep it
marked `satisfied` carrying the SAME required-evidence and completion-criteria it
was opened against — the terms that closed it, preserved verbatim, never emptied
— OR drop it from the live list entirely, since the session of record already holds
its history and the live list is for what is still open. A directive whose
required-evidence or completion-criteria has been blanked to nothing is not a
cleared directive; it is a malformed one. The same honesty governs a finding: a
finding stands on the artifact it points at, so a finding with no evidence to
inspect is a claim, not a finding — carry its evidence or do not raise it.

## Do not self-certify

The agent that did the work does not get to decide whether it satisfied the
obligation. Judge from the artifacts, not from the parent's summary of them.
Keep each finding's evidence and confidence distinct rather than averaging
several signals into one blurred verdict — if an earlier step flagged something
as an unknown, you do not get to quietly resolve it by assumption.

Never invent evidence, and prefer an honest "unresolved" to false confidence.
