#!/usr/bin/env bash
# Credentialed cold-start smoke. This is a separate disposable container from
# the keyless package/setup suite, so the xAI key never shares a process
# namespace with apt, npm, npx, or the downloaded Skills CLI.
set -uo pipefail

APP=/opt/navi
NAVI="$APP/node_modules/.bin/navi"
PACKAGE="$APP/node_modules/@machinepath/navi"
WALK=/home/navi/walk
LOCAL="$WALK/.agents/bin/navi"

[ -n "${XAI_API_KEY:-}" ] || {
  printf 'live coldstart: XAI_API_KEY is absent\n' >&2
  exit 1
}

XAI_MODEL=$(node --input-type=module - "$PACKAGE/config/tested-models.json" <<'NODE'
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const provider = manifest.providers.find(({ id }) => id === "xai");
if (provider?.classification !== "direct" || typeof provider.models?.quick !== "string") {
  process.stderr.write("live coldstart: tested-model manifest has no direct xAI quick target\n");
  process.exit(1);
}
process.stdout.write(provider.models.quick);
NODE
)

tree_digest() {
  tar \
    --sort=name \
    --mtime='UTC 1970-01-01' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C "$1" -cf - . \
    | sha256sum \
    | cut -d' ' -f1
}

PACKAGE_BASELINE=$(tree_digest "$PACKAGE")
WALK_BASELINE=$(tree_digest "$WALK")

"$NAVI" install -w "$WALK" >/dev/null
[ -x "$LOCAL" ] || {
  printf 'live coldstart: project-local launcher was not installed\n' >&2
  exit 1
}

OUT=$(cd /home/navi \
  && HOME=/home/navi \
    NAVI_MODEL="$XAI_MODEL" \
    timeout 180 "$LOCAL" --ephemeral -w "$WALK" \
      "What does greet return? Cite the file and line." 2>&1)
RC=$?

"$LOCAL" uninstall -w "$WALK" >/dev/null

[ "$RC" -eq 0 ] \
  && grep -Eq '(\./)?src/greet\.js:2' <<<"$OUT" \
  && grep -q 'hello' <<<"$OUT" \
  && [ "$(tree_digest "$PACKAGE")" = "$PACKAGE_BASELINE" ] \
  && [ "$(tree_digest "$WALK")" = "$WALK_BASELINE" ] \
  && [ -z "$(git -C "$WALK" status --porcelain)" ] \
  || {
    printf 'live coldstart: installed xAI interop smoke failed (rc=%s)\n' "$RC" >&2
    exit 1
  }

printf 'live coldstart: PASS xAI through installed project-local launcher\n'
