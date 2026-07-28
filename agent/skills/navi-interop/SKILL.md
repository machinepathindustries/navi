---
name: navi-interop
description: >-
  Use Navi to challenge nontrivial repository work before implementation and
  before completion. Trigger after interpreting a multi-file, behavioral, or
  architectural request; after a meaningful diff; before saying work is done,
  verified, or ready to ship; when checking another completion claim; or when a
  repository question needs cited evidence. Run Navi yourself and keep one
  session through the task.
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

## Choose the call

- Ask a repository question with `navi "<question>" -w <repo>`.
- Challenge a plan or completion claim with `navi check`.
- Ask which flow fits with `navi` when neither route is clear.

Use the repository root for `-w`. Narrow it only when the task is fully contained
in a subtree.

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

## Challenge and verify work

Open one check session after interpreting a nontrivial task and before changing
files. Reuse it after the diff and before declaring completion.

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
- Make requested changes with your normal tools, then return evidence to the
  same session.
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
