#!/usr/bin/env bash
# Assertions for a consumer machine that has only the production npm package.
# Every omitted provider call is a named SKIP; the separate compatibility
# harness owns credentialed live testing.
set -uo pipefail

APP=/opt/navi
NAVI="$APP/node_modules/.bin/navi"
NAVI_CLI="$APP/node_modules/.bin/navi-cli"
PACKAGE="$APP/node_modules/@machinepath/navi"
WALK=/home/navi/walk
PROBE=/home/navi/probe
CHECK=/home/navi/check
PASS=0
FAIL=0
SKIP=0
declare -a FAILED=()

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33mSKIP\033[0m %s\n' "$*"; }

tree_digest() {
  tar \
    --sort=name \
    --mtime='UTC 1970-01-01' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --exclude='./.git' \
    -C "$1" -cf - . \
    | sha256sum \
    | cut -d' ' -f1
}

package_unchanged() {
  local label=$1
  local now
  now=$(tree_digest "$PACKAGE")
  [ "$now" = "$PACKAGE_BASELINE" ] \
    && ok "installed package unchanged after $label" \
    || bad "installed package changed after $label"
}

# Prevent a caller's shell from turning a keyless assertion into a keyed one.
KEYLESS=(
  env
  -u DEEPSEEK_API_KEY
  -u OPENAI_API_KEY
  -u ANTHROPIC_API_KEY
  -u GOOGLE_GENERATIVE_AI_API_KEY
  -u GOOGLE_API_KEY
  -u XAI_API_KEY
  -u OPENROUTER_API_KEY
  -u TAVILY_API_KEY
  -u NAVI_MODEL
  -u NAVI_JUDGE_MODEL
  -u NAVI_DB
)

mkdir -p "$PROBE"

say "0 · a real production package on clean Node"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
' && ok "Node satisfies >=22.13.0" || bad "Node is too old: $(node --version)"
command -v bun >/dev/null \
  && bad "bun is present" \
  || ok "no bun"
command -v sqlite3 >/dev/null \
  && bad "sqlite3 is present; fresh-start independence is not being tested" \
  || ok "no sqlite3"
[ ! -e /src ] \
  && ok "no source checkout is mounted" \
  || bad "source checkout leaked into the runtime"
[ -x "$NAVI" ] \
  && ok "installed navi bin is executable" \
  || bad "installed navi bin is missing or not executable"
[ -x "$NAVI_CLI" ] \
  && ok "installed navi-cli bin is executable" \
  || bad "installed navi-cli bin is missing or not executable"
command -v navi >/dev/null \
  && ok "navi resolves on PATH" \
  || bad "the installed command is absent from PATH"
command -v navi-cli >/dev/null \
  && ok "navi-cli resolves on PATH" \
  || bad "the installed navi-cli command is absent from PATH"
[ "$(readlink "$NAVI")" = "../@machinepath/navi/bin/navi.mjs" ] \
  && ok "npm bin points at bin/navi.mjs" \
  || bad "npm bin target is $(readlink "$NAVI" 2>/dev/null || printf missing)"
[ "$(readlink "$NAVI_CLI")" = "../@machinepath/navi/bin/navi.mjs" ] \
  && ok "navi-cli npm bin points at bin/navi.mjs" \
  || bad "navi-cli npm bin target is $(readlink "$NAVI_CLI" 2>/dev/null || printf missing)"
[ -f "$PACKAGE/builtin/workflows/edge-walk/judge.schema.ts" ] \
  && [ -f "$PACKAGE/builtin/workflows/founder/parse-verdict.mjs" ] \
  && [ -f "$PACKAGE/agent/skills/navi-interop/SKILL.md" ] \
  && [ -f "$PACKAGE/config/tested-models.json" ] \
  && [ -f "$PACKAGE/.env.example" ] \
  && [ -x "$PACKAGE/bin/navi-local" ] \
  && ok "runtime builtins, schemas, parsers, model ground truth, env template, interop skill, and local launcher shipped" \
  || bad "the tarball omitted a runtime artifact"
[ ! -e "$APP/node_modules/.bin/vitest" ] \
  && [ ! -e "$APP/node_modules/.bin/mastra" ] \
  && [ ! -e "$APP/node_modules/typescript" ] \
  && ok "development toolchain is absent" \
  || bad "a development dependency reached the production install"
# Inspect navi's own published files, not production dependencies nested beneath
# it by npm (for example zod legitimately ships its own source tests).
FORBIDDEN=$(find "$PACKAGE" \
  -path "$PACKAGE/node_modules" -prune -o \
  \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) \
     -o -name 'navi.db*' -o -name '.mastra' \
     -o -name 'tests' -o -name 'docs' -o -name '.agents' -o -name '.claude' \) \
  -print | head -5)
[ -z "$FORBIDDEN" ] \
  && ok "package contains no secrets, ledgers, tests, docs, or agent state" \
  || bad "forbidden package residue: $FORBIDDEN"
[ ! -d "$HOME/.navi-home" ] \
  && ok "HOME has no ledger before first invocation" \
  || bad "HOME was warm before the test"
PACKAGE_BASELINE=$(tree_digest "$PACKAGE")

say "1 · --ephemeral leaves no ledger or temp directory"
EPHEMERAL_HOME=/home/navi/ephemeral-home
mkdir "$EPHEMERAL_HOME"
BEFORE_EPHEMERAL=$(find /tmp -maxdepth 1 -type d -name 'navi-ephemeral-*' -print | sort)
OUT=$(cd "$PROBE" && HOME="$EPHEMERAL_HOME" "${KEYLESS[@]}" "$NAVI" --ephemeral --version 2>&1)
RC=$?
AFTER_EPHEMERAL=$(find /tmp -maxdepth 1 -type d -name 'navi-ephemeral-*' -print | sort)
[ "$RC" -eq 0 ] \
  && ok "--ephemeral command exits 0" \
  || bad "--ephemeral command exited $RC: $(head -1 <<<"$OUT")"
[ ! -e "$EPHEMERAL_HOME/.navi-home" ] \
  && ok "--ephemeral creates no home ledger" \
  || bad "--ephemeral created a home ledger"
[ "$BEFORE_EPHEMERAL" = "$AFTER_EPHEMERAL" ] \
  && ok "--ephemeral removes its temp directory" \
  || bad "--ephemeral left a temp directory"
rmdir "$EPHEMERAL_HOME"
package_unchanged "--ephemeral"

say "2 · installed, model-free CLI surfaces work"
OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" --version 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -q '^navi 0\.1\.1$' <<<"$OUT" \
  && ok "version" \
  || bad "version failed (rc=$RC): $(head -1 <<<"$OUT")"
package_unchanged "version"

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI_CLI" --version 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -q '^navi 0\.1\.1$' <<<"$OUT" \
  && ok "navi-cli version" \
  || bad "navi-cli version failed (rc=$RC): $(head -1 <<<"$OUT")"
package_unchanged "navi-cli version"

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" help 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -q "flows · when to reach for each" <<<"$OUT" \
  && ok "help" \
  || bad "help failed (rc=$RC): $(head -1 <<<"$OUT")"
package_unchanged "help"

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" catalog -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] \
  && grep -q 'builtin  founder' <<<"$OUT" \
  && grep -q 'project  cold-gate' <<<"$OUT" \
  && ok "catalog resolves package builtins and consumer flows" \
  || bad "catalog failed (rc=$RC)"
package_unchanged "catalog"

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" run founder --shape -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] \
  && grep -q '^workflow: founder' <<<"$OUT" \
  && grep -q 'skills=\[founder\]' <<<"$OUT" \
  && ok "founder shape resolves from the package" \
  || bad "founder shape failed (rc=$RC)"
package_unchanged "founder shape"

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" run edge-walk --shape -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] \
  && grep -q '^workflow: edge-walk' <<<"$OUT" \
  && grep -q 'output={subject,entry_points,callers' <<<"$OUT" \
  && grep -q 'output={gate,reason,blocking_directive_ids' <<<"$OUT" \
  && ok "edge-walk dynamically imports packaged TypeScript schemas" \
  || bad "edge-walk shape/schema load failed (rc=$RC)"
package_unchanged "edge-walk shape"

say "3 · the installed bin emits a portable continuation"
OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" run cold-gate -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$OUT" \
  && ok "model-free consumer gate returned DIRECT" \
  || bad "model-free gate failed (rc=$RC): $(head -2 <<<"$OUT")"
NEXT=$(sed -n 's/^[[:space:]]*\(navi run cold-gate.*\)$/\1/p' <<<"$OUT" | head -1)
grep -Eq '^navi run cold-gate -t [^ ]+ -w /home/navi/walk$' <<<"$NEXT" \
  && ok "continuation starts with portable navi and preserves -w" \
  || bad "continuation is not the portable installed command"
grep -Eq '^[[:space:]]+/(home|opt)/' <<<"$OUT" \
  && bad "continuation leaked an absolute install path" \
  || ok "continuation contains no absolute install path"
FOLLOW=$(cd "$PROBE" && "${KEYLESS[@]}" bash -c "$NEXT" 2>&1)
FOLLOW_RC=$?
[ "$FOLLOW_RC" -eq 0 ] && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$FOLLOW" \
  && ok "the emitted continuation runs verbatim from the original cwd" \
  || bad "the emitted continuation did not run (rc=$FOLLOW_RC)"
package_unchanged "consumer gate"

say "3a · the documented npx command refuses network fallback"
OUT=$(cd "$APP" && "${KEYLESS[@]}" \
  env npm_config_offline=true \
  npx --no-install navi-cli run cold-gate -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$OUT" \
  && ok "documented local-only npx command returned the model-free gate" \
  || bad "documented local-only npx command failed (rc=$RC): $(head -2 <<<"$OUT")"
NEXT=$(sed -n 's|^[[:space:]]*\(npm exec --offline --package=@machinepath/navi -- navi-cli run cold-gate.*\)$|\1|p' <<<"$OUT" | head -1)
grep -Eq '^npm exec --offline --package=@machinepath/navi -- navi-cli run cold-gate -t [^ ]+ -w /home/navi/walk$' <<<"$NEXT" \
  && ok "npx continuation stays offline and preserves -w" \
  || bad "npx continuation is not the documented installed command"
FOLLOW=$(cd "$APP" && "${KEYLESS[@]}" bash -c "$NEXT" 2>&1)
FOLLOW_RC=$?
[ "$FOLLOW_RC" -eq 0 ] && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$FOLLOW" \
  && ok "the npx continuation runs verbatim after the first process exits" \
  || bad "the npx continuation did not run (rc=$FOLLOW_RC)"
package_unchanged "npx consumer gate"

say "3b · verdicts stay verdicts in the installed session ledger"
VERDICT_ERR="$PROBE/cold-verdict.stderr"
OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" run cold-verdict --json -w "$WALK" 2>"$VERDICT_ERR")
RC=$?
SESSION_ID=$(node -e '
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString());
      process.stdout.write(value.session_id || "");
    } catch {}
  });
' <<<"$OUT")
[ "$RC" -eq 0 ] && [ -n "$SESSION_ID" ] \
  && ok "model-free verdict produced a durable session" \
  || bad "model-free verdict failed (rc=$RC): $(head -2 "$VERDICT_ERR")"
rm -f "$VERDICT_ERR"

LIST=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" session list --verdict REFINE --json 2>&1)
printf '%s' "$LIST" | node -e '
  const id = process.argv[1];
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const rows = JSON.parse(Buffer.concat(chunks).toString());
    const row = rows.find(value => value.session_id === id);
    process.exit(
      row?.status === "awaiting_parent" &&
      row?.turn_kind === "verdict" &&
      row?.verdict === "REFINE" &&
      row?.gate === null ? 0 : 1
    );
  });
' "$SESSION_ID" \
  && ok "REFINE remains verdict/awaiting_parent with no fabricated gate" \
  || bad "session list translated or hid the REFINE verdict"
package_unchanged "verdict session"

say "3c · the public check command stays human-readable"
mkdir -p "$CHECK/.navi/workflows/edge-walk"
cat > "$CHECK/.navi/workflows/edge-walk/action.yaml" <<'YAML'
name: edge-walk
description: Model-free project override for the installed check alias.
args:
  input:
    type: json
    required: true
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"DIRECT","reason":"{{ input.event }}","blocking_directive_ids":[],"non_blocking_risks":[],"human_escalation":null,"confidence":1}'
YAML

OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" check \
  "the packaged check alias works" -w "$CHECK" 2>&1)
RC=$?
CHECK_NEXT=$(sed -n "s|^[[:space:]]*\\(navi check '<new evidence>' -t .*\\)|\\1|p" \
  <<<"$OUT" | head -1)
CHECK_SESSION=$(sed -n "s|^navi check '<new evidence>' -t \\([^ ]*\\).*$|\\1|p" \
  <<<"$CHECK_NEXT")
[ "$RC" -eq 0 ] \
  && grep -q 'DIRECT — the packaged check alias works' <<<"$OUT" \
  && [ -n "$CHECK_SESSION" ] \
  && ok "navi check accepts prose and emits a readable continuation" \
  || bad "navi check did not preserve its human contract (rc=$RC)"

STORY=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" story "$CHECK_SESSION" --json 2>&1)
printf '%s' "$STORY" | node -e '
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const story = JSON.parse(Buffer.concat(chunks).toString());
    process.exit(story.task === "the packaged check alias works" ? 0 : 1);
  });
' \
  && ok "the check prose is preserved in the session story" \
  || bad "the session story lost the check prose"

grep -Fq "navi check '<new evidence>' -t $CHECK_SESSION" <<<"$CHECK_NEXT" \
  && ok "the readable check continuation is an explicit fill-in template" \
  || bad "the readable check continuation lost its evidence placeholder"

FOLLOW_COMMAND=${CHECK_NEXT//<new evidence>/new evidence from the installed package}
FOLLOW=$(cd "$PROBE" && "${KEYLESS[@]}" bash -c "$FOLLOW_COMMAND" 2>&1)
FOLLOW_RC=$?
[ "$FOLLOW_RC" -eq 0 ] \
  && grep -q 'DIRECT — new evidence from the installed package' <<<"$FOLLOW" \
  && ok "the filled-in check continuation runs on the same session" \
  || bad "the filled-in check continuation failed (rc=$FOLLOW_RC)"
package_unchanged "check alias"

say "4 · normal state lands only in HOME"
[ -f "$HOME/.navi-home/navi.db" ] \
  && ok "ledger created at ~/.navi-home/navi.db" \
  || bad "normal commands did not create the home ledger"
HOME_RESIDUE=$(find "$HOME/.navi-home" -mindepth 1 -maxdepth 1 -type f \
  ! -name 'navi.db' ! -name 'navi.db-wal' ! -name 'navi.db-shm' -print | head -5)
[ -z "$HOME_RESIDUE" ] \
  && ok "home ledger directory contains only SQLite files" \
  || bad "unexpected home ledger residue: $HOME_RESIDUE"
RUNTIME_RESIDUE=$(find "$PACKAGE" "$WALK" "$PROBE" \
  \( -name 'navi.db*' -o -name '.mastra' -o -name '.navi-home' \) -print | head -5)
[ -z "$RUNTIME_RESIDUE" ] \
  && ok "package, target, and invocation cwd contain no runtime residue" \
  || bad "runtime residue outside HOME: $RUNTIME_RESIDUE"
[ -z "$(cd "$WALK" && git status --porcelain)" ] \
  && ok "consumer repository is clean" \
  || bad "a model-free command dirtied the consumer repository"

say "5 · HOME='' exits successfully and scatters nothing"
HOSTILE=/home/navi/hostile-cwd
mkdir "$HOSTILE"
BEFORE_HOSTILE=$(tree_digest "$HOSTILE")
OUT=$(cd "$HOSTILE" && HOME= "${KEYLESS[@]}" "$NAVI" --version 2>&1)
RC=$?
AFTER_HOSTILE=$(tree_digest "$HOSTILE")
[ "$RC" -eq 0 ] \
  && ok "HOME='' command exits 0" \
  || bad "HOME='' command exited $RC: $(head -1 <<<"$OUT")"
[ "$BEFORE_HOSTILE" = "$AFTER_HOSTILE" ] \
  && ok "HOME='' writes nothing to cwd" \
  || bad "HOME='' scattered files into cwd"
package_unchanged "HOME=''"

say "6 · missing ripgrep is loud"
RG_SHIM=/home/navi/no-rg
mkdir "$RG_SHIM"
printf '#!/bin/sh\nexit 127\n' > "$RG_SHIM/rg"
chmod +x "$RG_SHIM/rg"
OUT=$(cd "$PROBE" && PATH="$RG_SHIM:$PATH" "${KEYLESS[@]}" \
  timeout 120 "$NAVI" --ephemeral -w "$WALK" "what does greet() return?" 2>&1)
RC=$?
[ "$RC" -ne 124 ] \
  && ok "missing-rg probe did not hang" \
  || bad "missing-rg probe timed out"
grep -q "ripgrep (rg) is not installed" <<<"$OUT" \
  && ok "missing rg is reported" \
  || bad "missing rg was hidden"
grep -q "scanned the repo" <<<"$OUT" \
  && bad "navi claimed it scanned without rg" \
  || ok "no false scan claim"
package_unchanged "missing-rg path"

say "7 · install/uninstall restores the consumer tree exactly"
WALK_BASELINE=$(tree_digest "$WALK")
OUT=$(cd "$PROBE" && "${KEYLESS[@]}" "$NAVI" install -w "$WALK" 2>&1)
RC=$?
TARGET="$WALK/.agents/skills/navi-interop"
LOCAL="$WALK/.agents/bin/navi"
RECEIPT="$WALK/.navi-interop-install.json"
[ "$RC" -eq 0 ] \
  && [ -L "$TARGET" ] \
  && [ "$(realpath "$TARGET")" = "$PACKAGE/agent/skills/navi-interop" ] \
  && [ -L "$LOCAL" ] \
  && [ "$(realpath "$LOCAL")" = "$PACKAGE/bin/navi-local" ] \
  && grep -q '"state": "installed"' "$RECEIPT" \
  && ok "install creates the skill link, local launcher, and ownership receipt" \
  || bad "install did not create its complete project-local surface (rc=$RC)"

LOCAL_PATH=/usr/local/bin:/usr/bin:/bin
OUT=$(cd "$PROBE" && PATH="$LOCAL_PATH" "${KEYLESS[@]}" \
  "$LOCAL" run cold-gate -w "$WALK" 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$OUT" \
  && ok "project-local launcher runs with global navi removed from PATH" \
  || bad "project-local launcher failed without global navi (rc=$RC)"
LOCAL_NEXT=$(sed -n \
  's|^[[:space:]]*\(/home/navi/walk/.agents/bin/navi run cold-gate.*\)$|\1|p' \
  <<<"$OUT" | head -1)
grep -Eq '^/home/navi/walk/.agents/bin/navi run cold-gate -t [^ ]+ -w /home/navi/walk$' \
  <<<"$LOCAL_NEXT" \
  && ok "project-local continuation preserves its absolute launcher and workspace" \
  || bad "project-local continuation is not self-contained"
FOLLOW=$(cd "$PROBE" && PATH="$LOCAL_PATH" "${KEYLESS[@]}" bash -c "$LOCAL_NEXT" 2>&1)
FOLLOW_RC=$?
[ "$FOLLOW_RC" -eq 0 ] \
  && grep -Eq '^[[:space:]]+DIRECT — cold-start continuation probe$' <<<"$FOLLOW" \
  && ok "project-local continuation runs verbatim from an unrelated cwd" \
  || bad "project-local continuation failed (rc=$FOLLOW_RC)"

skip "credentialed project-local interop — isolated in the --live container"

OUT=$(cd "$PROBE" && PATH="$LOCAL_PATH" "${KEYLESS[@]}" "$LOCAL" uninstall -w "$WALK" 2>&1)
RC=$?
WALK_AFTER=$(tree_digest "$WALK")
[ "$RC" -eq 0 ] \
  && [ "$WALK_BASELINE" = "$WALK_AFTER" ] \
  && [ -z "$(cd "$WALK" && git status --porcelain)" ] \
  && ok "uninstall restores bytes, modes, links, and git status" \
  || bad "uninstall left consumer residue (rc=$RC)"
package_unchanged "install/uninstall"

say "7a · a managed skill can use the project dependency without a symlink launcher"
MANAGED=/home/navi/managed-skill
mkdir -p "$MANAGED"
git -C "$MANAGED" init -q
printf '{"private":true}\n' >"$MANAGED/package.json"
ln -s "$APP/node_modules" "$MANAGED/node_modules"
OUT=$(cd "$MANAGED" && "${KEYLESS[@]}" npx --yes skills add \
  "$PACKAGE/agent/skills/navi-interop" \
  --skill navi-interop \
  --agent universal \
  --yes 2>&1)
RC=$?
[ "$RC" -eq 0 ] \
  && [ -f "$MANAGED/.agents/skills/navi-interop/SKILL.md" ] \
  && [ -f "$MANAGED/skills-lock.json" ] \
  && ok "npx skills installs the managed interop skill and lockfile" \
  || bad "npx skills did not reproduce the documented managed-skill route (rc=$RC)"
[ ! -e "$MANAGED/.agents/bin/navi" ] \
  && [ -x "$MANAGED/node_modules/.bin/navi-cli" ] \
  && ok "managed-skill fixture has a project dependency and no Navi launcher link" \
  || bad "managed-skill fixture does not match the documented setup"
OUT=$(cd "$MANAGED" && "${KEYLESS[@]}" \
  npm exec --offline --package=@machinepath/navi -- \
  navi-cli --version 2>&1)
RC=$?
[ "$RC" -eq 0 ] && grep -q '^navi 0\.1\.1$' <<<"$OUT" \
  && ok "scoped offline npm exec runs from the managed-skill setup" \
  || bad "managed-skill launcher fallback failed (rc=$RC)"

OFFLINE_MISS=/home/navi/offline-miss
mkdir -p "$OFFLINE_MISS/work" "$OFFLINE_MISS/cache"
printf '{"private":true}\n' >"$OFFLINE_MISS/work/package.json"
OUT=$(cd "$OFFLINE_MISS/work" && "${KEYLESS[@]}" \
  env npm_config_cache="$OFFLINE_MISS/cache" \
  npm exec --offline --package=@machinepath/navi -- \
  navi-cli --version 2>&1)
RC=$?
[ "$RC" -ne 0 ] && grep -q 'ENOTCACHED' <<<"$OUT" \
  && ok "offline fallback refuses to download a missing package" \
  || bad "offline fallback did not fail closed when the package was absent"
package_unchanged "managed skill fallback"

say "8 · credentials stay out of the cold-start image"
for provider in \
  "DeepSeek:DEEPSEEK_API_KEY" \
  "OpenAI:OPENAI_API_KEY" \
  "Anthropic:ANTHROPIC_API_KEY" \
  "Google:GOOGLE_GENERATIVE_AI_API_KEY" \
  "xAI:XAI_API_KEY" \
  "OpenRouter:OPENROUTER_API_KEY"
do
  label=${provider%%:*}
  key=${provider#*:}
  value=${!key:-}
  [ -z "$value" ] \
    && skip "$label direct gateway — $key was not passed to this container" \
    || bad "$label credential reached the keyless cold-start container"
done

say "result"
printf '  %d passed · %d failed · %d skipped\n' "$PASS" "$FAIL" "$SKIP"
printf '  provider skips are explicit and are not counted as coverage\n'
[ "$FAIL" -eq 0 ] || {
  printf '  failed:\n'
  printf '    - %s\n' "${FAILED[@]}"
  exit 1
}
exit 0
