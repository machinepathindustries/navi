# Slop detection

A catalog of symptoms and false-positive boundaries for the numbered Founder
rubrics. It provides examples for inspection, not independent rules or
verdicts.

## Duplicate live ownership

**Signal.** A proposal adds a sibling engine, router, parser, state owner, or
control path that can perform a responsibility already owned elsewhere. A
version-like name, new entry point, or copied directory may reveal the pattern,
but no label proves it; overlapping live responsibility is the issue.

**Inspect.** Apply Rubric 1: identify the responsibility and current owner;
distinguish a declarative composition or genuinely new capability from another
implementation owner; and look for an explicitly authorized, bounded migration
when implementations overlap.

**Common false positives.** A declarative flow that composes existing
machinery; one owner for a genuinely distinct capability; a serialized protocol
or persisted-schema version used at a compatibility boundary; a compatibility
adapter or temporary dual path governed by a bounded migration; or an alternate
implementation isolated in a branch or worktree and not connected to the live
system. An experiment becomes parallel ownership only when both implementations
are made live without choosing an owner or defining the migration.

## Approval fan-out

**Signal.** One coherent decision or deliverable is split into pre-edit,
per-file, per-phase, post-diff, and pre-delivery reviews even though its premise
and risk have not materially changed. The judge becomes an executive controller
and ordinary evidence gathering waits for approval.

**Inspect.** Apply Rubrics 2, 11, and 13: ask whether different dispositions
could change the next action, whether the review claims are really one coherent
unit, and whether a prior pass already tested the unchanged premise. Batch
related repairs and evidence before returning to the judge.

**Common false positives.** A materially changed premise or blast radius; a
continuation that answers one concrete blocking directive; a separate authority
decision; or independently required release validation at a genuinely distinct
boundary. These are new semantic boundaries, not approval fan-out.
