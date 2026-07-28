#!/usr/bin/env bash
# Fast, model-free release checks on the host. The clean-room Docker test runs
# only after these pass.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
RUN_DIR=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  [ -z "$RUN_DIR" ] || rm -rf -- "$RUN_DIR"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

command -v bun >/dev/null || {
  printf 'coldstart: Bun is required for the local preflight\n' >&2
  exit 1
}

RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/navi-local-checks.XXXXXX")
mkdir -p "$RUN_DIR/home" "$RUN_DIR/work"
NODE=$(command -v node)
BUN=$(command -v bun)

cd "$REPO"

# Vitest and the CLI smokes stay on Node because the package entry uses tsx's
# Node loader. Run one file worker at a time: these suites spawn many real CLI
# subprocesses, and parallel workers can starve Vitest's worker RPC under host
# contention even after every assertion passes. Bun verifies the package
# surface after those checks.
node node_modules/vitest/vitest.mjs run \
  --no-file-parallelism \
  --maxWorkers=1 \
  --minWorkers=1 \
  tests/cli.test.ts \
  tests/install.test.ts \
  tests/invocation.test.ts \
  tests/package.test.ts \
  tests/provider-compat.test.ts \
  tests/docs-release.test.ts

# The smoke commands use the checkout-owned entry from an empty cwd and a
# disposable ledger. They cannot see the developer's .env, global link, or
# ~/.navi-home.
(
  cd "$RUN_DIR/work"
  env -i \
    PATH="$PATH" \
    HOME="$RUN_DIR/home" \
    NAVI_DB="file:$RUN_DIR/home/navi.db" \
    "$NODE" "$REPO/bin/navi.mjs" --version
  env -i \
    PATH="$PATH" \
    HOME="$RUN_DIR/home" \
    NAVI_DB="file:$RUN_DIR/home/navi.db" \
    "$NODE" "$REPO/bin/navi.mjs" help >/dev/null
)
"$BUN" --no-env-file pm pack --dry-run >/dev/null
