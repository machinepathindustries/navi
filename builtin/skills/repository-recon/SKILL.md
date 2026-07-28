---
name: repository-recon
description: >-
  Wiring reconnaissance for a task: map its real production trigger, direct
  callers and consumers, and the call path to the parent's claimed location —
  as file:line facts. Rides alongside code-search (which carries the search
  loop); this adds the mission: is the claimed change actually reachable from a
  real trigger, and is there a second path that bypasses it? Load when a step
  must ground a task's subject in entry points, consumers, and call paths
  before its seams can be reasoned about.
version: 0.1.0
tags:
  - recon
  - wiring
  - codebase
---

# Repository Recon

Runs alongside code-search. That skill carries the search loop
(INDEX → FILTER → MAP → REDUCE) and the citation-and-honesty output contract —
do not re-teach them here. This skill carries the mission: you are not
answering an open codebase question, you are mapping the wiring around ONE
task's subject — the function, route, field, or behavior under discussion —
and the parent's claimed plan, so a later step has grounded facts to reason
about seams from. Stop when the trigger→target path (or its confirmed absence)
is settled with file:line evidence, or the budget runs low — code-search's
near-budget wrap-up rule applies here too.

## What to establish

For the task's subject and the parent's claimed location, settle three things,
each with file:line evidence:

1. **The production trigger** — the CLI command, HTTP route, event handler,
   cron entry, or UI action that would reach this behavior in the running
   system, not just its own module.
2. **The direct callers and consumers** — who currently calls the changed
   symbol, and who consumes its output.
3. **Whether the claimed location sits on that path** — trace from the trigger
   *forward* into the claimed location. Do not confirm the location exists and
   stop: a function's own definition and its own unit test are not evidence
   that anything calls it.

## Check for a bypass

Before treating the wiring as settled, look for a second path that reaches the
same externally visible effect without passing through the code in question.
This is the exact shape of a partially wired feature: one path was updated, a
sibling was not.

## Use a similar implementation as a reference

If an analogous, already-shipped feature exists, find how *it* is wired end to
end and compare shape. A conspicuous absence — every sibling feature is
registered in the same router or registry, and the new one is not — is a fact
worth reporting.

## Output: file:line facts, no verdict

Report what was and was not found — the trigger (or "no trigger found"), the
callers (or "none found"), whether the claimed location sits between them, and
any bypass noticed — each with a citation. A call site you read is a fact;
"probably called from the CLI layer," unread, is a hypothesis — label it as
one, and never let a plausible guess stand in for a citation. A claim about
runtime or interpreter behavior (what a parser accepts, what an engine does at
runtime) is not readable from source — it requires execution to verify, so
phrase it that way, never as high-confidence fact from reading alone. Render no
verdict on whether the task is correctly wired; that judgment belongs to the
steps downstream, not to recon.
