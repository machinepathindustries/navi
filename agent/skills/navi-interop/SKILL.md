---
name: navi-interop
description: >-
  Use Navi at semantic decision and delivery boundaries: expand a consequentially
  underdetermined idea space, judge a consequential commitment, check one
  coherent delivery claim, or answer a repository question with cited
  evidence. Trigger when a plausible Navi disposition could materially change
  the calling agent's next action, not because work is multi-file, behavioral,
  or has a meaningful diff. Run Navi yourself and preserve the session when
  returning evidence for the same premise.
---

# Use Navi

Run Navi yourself. Do not ask the user to operate it. Navi reads the repository
and returns evidence or a bounded next step; make changes with your normal tools.

Choose one launcher and keep it for the task:

1. Prefer the absolute `<repo>/.agents/bin/navi` when it exists and is
   executable. `navi install` creates that project-local link.
2. Otherwise, when `<repo>/node_modules/.bin/navi-cli` exists, run
   `npm exec --offline --package=@machinepath/navi -- navi-cli` from
   the repository. This is the launcher for a
   project-local package installed without Navi's symlink installer.
3. Otherwise use `navi` only when it resolves on `PATH`.
4. If none exists, stop and report that setup is incomplete. Do not guess a
   source path or internal launcher, and do not let `npx` download a package
   implicitly.

Examples below use `navi`. Replace only that leading token with the launcher
selected above. Continuations preserve the launcher that began the run; run
them unchanged.

## Invocation economy

Navi reviews semantic boundaries; it does not supervise implementation. The
calling agent owns ordinary, reversible choices inside the user's authorized
scope. Before invoking Navi, ask whether two plausible dispositions could lead
to materially different next actions. If every disposition leads to the same
work, skip the call.

Choose at most one pre-work lane for an unchanged premise:

- Use Brainstorm only when materially different viable ideas remain and the
  choice among them would change the outcome.
- Use Founder only before a consequential commitment: one that can change
  authorized scope, a public contract, responsibility ownership, security or
  data integrity, costly or irreversible external state, doctrine, or release
  policy.
- Use neither for a clear, reversible implementation task. Implement and test
  it with normal tools, then use one consolidated final check when the
  deliverable is consequential or the caller will claim it is ready.

Do not invoke Navi for an individual command, file, edit, name, routine local
refactor, tool choice, repository inspection, test selection, status check,
debugging step, provider/runtime troubleshooting step, phase transition,
ordinary evidence collection, or each finding separately. Task size and file
count are not blast radius. During an active outage or runtime recovery, act
and verify first; review the coherent result afterward when warranted.

Re-enter a review midstream only to answer its concrete blocking directive or
because fresh evidence materially changed the reviewed premise, scope, or risk.
Return related repairs and evidence as one packet. Never open a fresh session to
reroll an unchanged premise, recursively gate work requested by a gate, or ask
Navi whether Navi should be called. Post-diff and pre-delivery are the same
checkpoint when the artifact and evidence have not changed.

## Choose the call

- Expand, challenge, and harden consequential underdetermination with
  `navi run brainstorm --json --stdin`.
- Ask a repository question with `navi "<question>" -w <repo>`.
- Judge a concrete consequential decision with `navi run founder`.
- Challenge one coherent completion claim with `navi check` after ordinary
  implementation and verification.

Use the repository root for `-w`. Narrow it only when the task is fully contained
in a subtree.

## Brainstorm consequential underdetermination

Send the calling agent's task, candidate ideas, known facts, and boundaries as
one JSON event. Multiple materially different ideas make the deliberation more
useful; one idea is also valid, and Brainstorm will generate alternatives:

```bash
printf '%s\n' \
  '{"event":{"task":"Choose a persistence contract","ideas":["Append-only events","Mutable snapshots"],"context":["Consumers need audit history"],"constraints":["One live writer"]}}' \
  | navi run brainstorm --json --stdin -w /absolute/path/to/repo
```

Use `context` for known facts and observed evidence. Use `constraints` only for
non-negotiable boundaries; preferences and unverified assumptions belong in
context with their status made explicit.

Read the returned `result.arc`: it expands distinct candidates, challenges
their seams, records the deliberation, and either returns a hardened concept or
one bounded demanding gate. A completed hardened concept includes its
`controller_next_action`; carry that action and its named context into your
normal implementation work. Do not automatically send the same unchanged
premise through Founder or another check. Capture the immediate JSON envelope;
the reduced session view is not a substitute for the full arc.

For DIRECT, REPAIR, or BLOCKED, obtain exactly what the returned directive asks
for, rebuild the same event with `response_to.directive_id` and one
requirement/value return for every requested item, then pipe that JSON into
Navi's exact continuation command unchanged:

```bash
printf '%s\n' \
  '{"event":{"task":"...","ideas":["..."],"context":[],"constraints":[],"response_to":{"directive_id":"<returned-id>","returns":[{"requirement":"<returned-requirement>","value":"<observed-value>"}]}}}' \
  | /absolute/path/.agents/bin/navi run brainstorm --json --stdin -t <session_id> -w /absolute/path/to/repo
```

The command after the pipe must be copied from `next.command`; the example only
shows its shape. Preserve its launcher, workspace, and `-t <session_id>`. Branch
on the envelope's `gate`, not its process exit code: COMPLETE and demanding
gates are all valid executions. COMPLETE closes that session. If later evidence
materially invalidates its premise, open a fresh Brainstorm session and include
the prior session/run/conclusion plus the new evidence in `event.context`.
ESCALATE is the only Brainstorm gate that requests a human authority decision.

## Protect sensitive data

Apply this rule to every Navi prompt, JSON event, handed command, and quoted
output:

- Never send or repeat credential values, tokens, private keys, or unrelated
  private data. Redact the value as `<redacted>`; retaining the variable name is
  fine when it is relevant.
- Treat a value the user marks private as sensitive even when it looks fake.
- Safety outranks "run the exact command." If a handed command contains
  sensitive data, writes to the target repository, or names the wrong
  workspace, do not run, repair, or regenerate it yourself. Explain the
  conflict as a Navi defect and keep the claim unresolved.
- If sensitive data was already sent or printed, stop, tell the user what kind
  of credential was exposed without repeating its value, and recommend
  revocation or rotation.

## Verify one coherent delivery

After implementation and relevant verification, use one check for the coherent
delivery claim. Bundle the artifact, runtime or test evidence, known limits, and
any related repairs. A clear reversible task needs no pre-change check.

Send one prose claim that names the task, current claim or plan, and evidence
already observed:

```bash
navi check \
  "Task: ... Claim or plan: ... Evidence observed: ..." \
  -w /absolute/path/to/repo
```

Follow Navi's reply instead of reconstructing its transport. A machine-readable
continuation may use `run edge-walk --json --stdin`; that is Navi's internal
handoff, not the initial command you need to author.

- Run the exact next command it hands you unless the sensitive-data rule above
  applies.

- If it is malformed, fails, or cannot resume its session, report that
  failure and keep the claim unresolved; do not invent a replacement command.
- Preserve its `-t <session_id>`; omitting it opens a different session.
- Return only files, lines, commands, and results you actually observed.
- Make all related requested changes with your normal tools, then return one
  evidence packet to the same session. Do not open one gate per repair.
- Treat a blocking reply as unresolved. An ordinary continuation is a Navi
  command that preserves the session, asks for evidence or re-checks work, and
  contains neither `--override` nor a request for human judgment. Collect its
  requested evidence and run it without waiting for the user.
- Stop for the user when Navi asks for human judgment or when proceeding would
  require an override. Summarize the unresolved claim, concrete risk, requested
  evidence, and available choices.
- Never authorize an override yourself or infer permission from vague assent.
  Require the user to say `override` and give a concrete reason. Append that
  reason as one safely shell-quoted `--override` argument to the handed
  continuation while preserving every existing argument. Do not reuse an older
  authorization for a later blocker.

Resolve only the claim Navi judged. A result about one artifact does not clear
the rest of the task. Unrelated work may continue, but do not close a task whose
completion claim remains blocked.

## Ask a repository question

Ask for a cited answer with:

```bash
navi "<question>" -w /absolute/path/to/repo
```

Treat the quick result as a lead. When Navi supplies a required `--deep`
command, run that exact command before treating the answer as settled. If it
fails, is malformed, lacks cited evidence, or conflicts with the quick result,
report the discrepancy and leave the answer unsettled rather than guessing.
You may share the quick result only when clearly labeled provisional.
