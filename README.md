# Navi

**Navi is a read-only review CLI for coding agents.** Ask a codebase question,
judge a decision, or challenge a completion claim. Navi returns cited evidence
or a clear next action and keeps the work in a session you can continue.

Your coding agent writes. Navi reads and checks.

[Documentation](https://machine-path.mintlify.site) ·
[Quickstart](https://machine-path.mintlify.site/quickstart) ·
[OpenCode](https://machine-path.mintlify.site/opencode) ·
[CLI guide](https://machine-path.mintlify.site/cli) ·
[Built-in flows](https://machine-path.mintlify.site/built-in-flows)

## See Navi check the repository

This is an abridged result from Navi's own repository:

```console
$ npx --no-install navi-cli \
  "Where does Navi make repository access read-only? Cite the exact file and line."

Answer
Navi constructs the workspace filesystem with `readOnly: true`.

Sources
- `src/mastra/index.ts:70`

✓ Grounding grade passed — the answer stands.
```

The answer is useful because it carries the evidence behind it. If that
evidence is too weak, Navi says so and gives the next command to run.

## Install and ask

Add Navi to the repository where your coding agent works:

The shortest path below uses DeepSeek. If you use another lab, set its key and
tested model from [Providers](https://machine-path.mintlify.site/providers)
instead.

```bash
npm install --save-dev @machinepath/navi
export DEEPSEEK_API_KEY="<your-key>"
npx --no-install navi-cli "Where is retry behavior configured?"
```

Keep provider keys in your shell or an ignored `.env` file. Never paste a real
key into a prompt, terminal recording, issue, or commit.

Requirements: macOS or Linux, Node.js 22.13 or newer,
[ripgrep](https://github.com/BurntSushi/ripgrep), and one model-provider API
key. Git is needed for revision-aware checks and flows that inspect a diff.

The scoped package installs two short launchers: `navi` and `navi-cli`. The docs
use `npx --no-install navi-cli` so every command runs the project-local version.

## One review loop, three jobs

| Job | Use it when | Command | Result |
|---|---|---|---|
| **Ask** | You need a fact about the repository | `npx --no-install navi-cli "Where is the retry cap set?"` | An answer with file-and-line citations |
| **Decide** | A product or design call needs judgment | `npx --no-install navi-cli run founder "Should retries be configurable?"` | `GO`, `REFINE`, or `REJECT` |
| **Check** | You are about to call work done | `npx --no-install navi-cli check "Claim: retries are covered. Evidence: tests pass."` | A clear result or one concrete next action |

Navi reviews boundaries, not every implementation step. For a clear task, make
ordinary reversible choices and run the relevant tests without asking Navi to
approve each file, phase, repair, or command. Use one consolidated Check when
the coherent delivery is ready. Add a pre-work Brainstorm or Founder call only
when its outcome could materially change the direction or authorize a
consequential commitment.

These are separate checks with one shared record. A session holds the question,
result, follow-up evidence, and any recorded override.

```bash
npx --no-install navi-cli session list
npx --no-install navi-cli session show <session>
npx --no-install navi-cli story <session>

# Return evidence to the same completion check.
npx --no-install navi-cli check \
  "Evidence: src/mastra/index.ts:70 constructs the workspace with readOnly: true." \
  -t <session>
```

`session show` prints the complete timeline. `story` gives a deterministic
summary of how the session reached its current result; neither command calls a
model.

## Built-in flows

Flows are reusable review procedures defined in readable `action.yaml` files.
Navi ships with eight:

| Flow | Reach for it when |
|---|---|
| `code-search` | A repository question needs a deeper, tool-backed read |
| `code-review` | A diff needs a correctness-first review |
| `pre-pr-review` | A branch needs a readiness check before a pull request |
| `founder` | A decision needs a `GO`, `REFINE`, or `REJECT` verdict |
| `founder-advice` | An open question needs options and a recommendation |
| `edge-walk` | A completion claim needs an adversarial check |
| `brainstorm` | Consequentially different ideas need expansion, challenge, and convergence |
| `web-search` | A question needs current web evidence through Tavily |

Run `npx --no-install navi-cli catalog` for the installed inventory or
`npx --no-install navi-cli help <flow>` for one flow's arguments and defaults.

## Connect your coding agent

Let compatible agents discover Navi without copying its skill into the
repository:

```bash
npx --no-install navi-cli install
```

Navi creates a project-local launcher at `.agents/bin/navi` and an interop-skill
symlink at `.agents/skills/navi-interop`. Both point to the installed package.
`npx --no-install navi-cli uninstall` removes only the links recorded by Navi's ownership
receipt.

[Connect your agent](https://machine-path.mintlify.site/connect-your-agent)
also documents the `npx skills` alternative.

## Bring your model

Set `NAVI_MODEL` to a `provider/model` identifier and provide that lab's API
key. Navi passes the identifier to Mastra's Model Router, which uses the
underlying AI SDK provider adapter. Navi does not maintain a model allowlist.

```bash
export NAVI_MODEL="deepseek/deepseek-v4-flash"
```

[Providers](https://machine-path.mintlify.site/providers) lists the tested
direct-provider targets and keys. The machine-readable source of truth is
[`config/tested-models.json`](config/tested-models.json).

## What Navi can touch

Model-driven repository tools are read-only and fenced to the selected
workspace. Navi keeps its session ledger outside the repository at
`~/.navi-home/navi.db`.

Two explicit surfaces can write:

- `navi install` creates the documented interop links and ownership receipt.
- A flow author's command steps are trusted code and can invoke local programs.

The built-in review flows use read-only inspection commands. See
[Security and storage](https://machine-path.mintlify.site/security-and-storage)
for the full boundary.

## Documentation

| You want to | Read |
|---|---|
| Get a first cited answer | [Quickstart](https://machine-path.mintlify.site/quickstart) |
| Connect Claude Code, Codex, Cursor, or another agent | [Connect your agent](https://machine-path.mintlify.site/connect-your-agent) |
| Use Navi from OpenCode | [OpenCode guide](https://machine-path.mintlify.site/opencode) |
| Pick the right command | [Ask, decide, and check](https://machine-path.mintlify.site/ask-decide-check) |
| See every built-in review | [Built-in flows](https://machine-path.mintlify.site/built-in-flows) |
| Continue or inspect work | [Sessions](https://machine-path.mintlify.site/sessions-and-outcomes) |
| Learn the command line | [CLI guide](https://machine-path.mintlify.site/cli) |
| Fix a setup or runtime problem | [Troubleshooting](https://machine-path.mintlify.site/troubleshooting) |
| Write a reusable review | [Write a flow](https://machine-path.mintlify.site/write-a-flow) |

## Develop from source

```bash
git clone https://github.com/machinepathindustries/navi.git
cd navi
npm install
bun link
navi --version
```

`bun link` makes both `navi` and `navi-cli` available from the checkout. Without
Bun, use `npm run navi -- <args>`.

Before opening a pull request:

```bash
npm run typecheck
npm test
docker/coldstart/local-checks.sh
docker/coldstart/run.sh
```

Navi is built on [Mastra](https://mastra.ai).
[CONTRIBUTING.md](CONTRIBUTING.md) describes the enforced code and
documentation rules.

Found a bug? [Open an issue](https://github.com/machinepathindustries/navi/issues).

MIT
