# Contributing to Navi

Thanks for helping improve Navi. Contributions should keep the CLI small,
read-only by default, and easy to verify from a clean checkout.

## Prerequisites

- Node.js 22.13 or newer
- npm
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- Git
- Local Docker
- Bun (optional, for a faster linked development command)

## Set up the repository

```bash
git clone https://github.com/machinepathindustries/navi.git
cd navi
npm install
npm run typecheck
npm test
```

If you use Bun, `bun link` exposes the checkout as `navi` and `navi-cli`.
Otherwise, run source commands with `npm run navi -- <args>`.

## Product-code invariants

- Use `ts-pattern` for dispatch. `scripts/control-flow.mjs` enforces the
  branch invariant in `src/`.
- Return `neverthrow` results across fallible project boundaries. Wrap
  third-party exceptions where they enter Navi.
- Use Mastra primitives before adding parallel framework machinery. Native and
  local layers must still satisfy
  [Machinery must pay rent](./builtin/skills/founder/references/rubrics.md#7-machinery-must-pay-rent).
- Keep model-facing workspace tools read-only and fenced to the selected
  workspace.
- Cover behavior at the real integration boundary: the CLI, compiler, storage,
  path guard, package, or Docker cold start.

## Documentation

Public documentation lives in `docs/mintlify/`.

- Keep commands executable from a clean project installation.
- Use only tested model IDs from `config/tested-models.json`.
- Run `node scripts/docs-release-check.mjs` before submitting documentation
  changes.

## Pull requests

Before opening a pull request:

```bash
npm run typecheck
npm test
npm pack --dry-run --json
docker/coldstart/local-checks.sh
docker/coldstart/run.sh
```

Explain what changed, why it belongs in Navi, and how you verified it. Keep the
pull request focused so reviewers can reproduce the result.
