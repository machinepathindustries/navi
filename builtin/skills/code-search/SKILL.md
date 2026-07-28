---
name: code-search
description: RLM code-search strategy for answering codebase questions with cited evidence. Use for "find where", "how does X work", "trace the flow", "what calls this", architecture questions, or any search spanning more than a handful of files.
version: 0.1.1
tags:
  - search
  - codebase
---

# RLM Code Search

Answer codebase questions by running a quiet INDEX → FILTER → MAP → REDUCE
loop. The loop is internal discipline, not visible ceremony — the user sees
only the final answer.

## The loop

1. **INDEX** — cheap, wide candidate discovery. Fan out grep/glob queries for
   the user's exact target nouns (function names, flags, error strings).
   **Emit every INDEX tool call in ONE step** (parallel greps), not serial
   single-grep turns. Never degrade a specific term like `RLM code-search
   deep-mode` into a generic one like "entry point". Add spelling/casing
   variants, not synonyms, first.
   If a **Deterministic INDEX preflight** block is present, treat it as your
   first candidate set — do not re-grep the same exact terms unless empty/wrong.
   If a **Deterministic MAP prefetch** block is present with real file windows,
   those lines are already read: cite them and REDUCE immediately when two
   lanes are covered. Prefer `multi_search` / `parallel_view` compound tools
   over serial single-tool steps when you still need tools.
2. **FILTER** — prune candidates to implementation owners. Prefer source
   files that define behavior over tests, docs, generated output, and
   vendored code. Keep a shortlist you can actually read (typically 2–5 files).
3. **MAP** — read the shortlisted files with enough surrounding context to
   understand them. **Prefer one large `view` per file** (generous limit) over
   offset-nibbling the same file across multiple steps. When several files
   remain, **view them in parallel in one step**. Follow at least two
   independent evidence lanes (e.g. the definition and a call site) before
   concluding.
4. **REDUCE** — synthesize one answer with `file:line` citations for every
   claim, and an honest confidence level. Once you have two verified lanes,
   **stop searching and answer** — do not keep grepping for confirmation.

## Modes

- **Quick** (default): one INDEX/FILTER pass (or preflight + FILTER), read
  1–3 files in parallel, answer. Target: finish in a small number of steps.
- **Deep**: multiple INDEX rounds, trace call chains across modules, verify
  claims against a second evidence lane before answering. Use when the
  question spans subsystems or the first pass is ambiguous.

## Budget discipline

Your tool-call budget is finite (a step budget — generous by default, set by
the workflow step's `maxSteps` or the bare query's `--max-steps` flag, but
never unlimited). Track it. Once
only a handful of steps remain and you have not yet reached a REDUCE-worthy
answer, **stop searching and write the answer now** with whatever evidence
you have — an honestly-scoped partial answer beats exhausting the budget
mid-search and returning nothing. State plainly what you did not get to
check and lower your confidence accordingly.

Speed is part of quality: every extra model step is latency. Parallel tools
and large peeks are preferred; serial single-tool steps are a last resort.

## Non-negotiables

- Never fabricate tool usage, file contents, or citations.
- Never claim high confidence on zero or single-lane evidence.
- A claim about runtime or interpreter behavior — what a parser accepts, what
  an engine does when the code actually runs — requires executing it to verify;
  never assert it "high confidence" from reading source alone.
- If no tools could run or nothing was found, answer "Blocked" and state
  what was missing — do not guess.
- Never cite a preflight digest line as evidence without re-reading the file.

## Output contract

This Markdown contract is the default for a standalone repository answer. When
the caller supplies a structured output schema or names a specific return shape,
that caller contract wins. Keep the INDEX → FILTER → MAP → REDUCE method and the
citation discipline, but return exactly the requested shape—no Markdown headings,
code fence, preface, or trailing narration.

```
### Answer
<direct answer, inline file:line citations>

### Sources
- path/to/file.ts:123 — what this shows

### Confidence
high | medium | low — one-line justification
```
