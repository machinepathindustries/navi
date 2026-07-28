#!/usr/bin/env bash
# Local provider compatibility run. Usage:
#
#   docker/provider-compat/run.sh
#
# The runner measures committed HEAD in a clean local clone. It reads credentials
# from .env and docker/coldstart/.env into a mode-600 temporary file. The
# container starts, installs dependencies, and proves a clean checkout with no
# credentials. Only the trusted measurement process receives the reduced env via
# `docker exec --env-file`; no key reaches apt, npm, an image layer, or stdout.
# Cleanup removes this run's exact container and temporary paths; it never prunes
# Docker or builds a project image.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
TARGET="$REPO/artifacts/provider-compat.json"
TEMP_ROOT=${TMPDIR:-/tmp}
RUN_ID="$(id -u)-$$-${RANDOM}"
CONTAINER="navi-provider-compat-${RUN_ID}"
RUN_DIR=""
ENV_FILE=""
TARGET_STAGE=""
SOURCE_DIR=""

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM

  if command -v docker >/dev/null 2>&1 \
    && docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    docker container rm --force "$CONTAINER" >/dev/null 2>&1 || cleanup_status=1
  fi

  [ -z "$TARGET_STAGE" ] || rm -f -- "$TARGET_STAGE" || cleanup_status=1
  [ -z "$ENV_FILE" ] || rm -f -- "$ENV_FILE" || cleanup_status=1
  [ -z "$RUN_DIR" ] || rm -rf -- "$RUN_DIR" || cleanup_status=1
  [ "$status" -ne 0 ] || [ "$cleanup_status" -eq 0 ] || status=1
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$#" -eq 0 ] || {
  printf 'usage: docker/provider-compat/run.sh\n' >&2
  exit 2
}

[ "${GITHUB_ACTIONS:-}" != "true" ] || {
  printf 'provider-compat: this runner is local-only and refuses GitHub Actions\n' >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || {
  printf 'provider-compat: docker is required\n' >&2
  exit 1
}

case "${DOCKER_HOST:-}" in
  "" | unix://* | npipe://*) ;;
  *)
    printf 'provider-compat: refusing non-local DOCKER_HOST\n' >&2
    exit 1
    ;;
esac

DOCKER_CONTEXT=$(docker context show)
DOCKER_ENDPOINT=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
case "$DOCKER_ENDPOINT" in
  unix://* | npipe://*) ;;
  *)
    printf 'provider-compat: docker context %s is not local\n' "$DOCKER_CONTEXT" >&2
    exit 1
    ;;
esac

docker exec --help | grep -q -- '--env-file' || {
  printf 'provider-compat: this Docker version lacks exec --env-file\n' >&2
  exit 1
}

REVISION=$(git -C "$REPO" rev-parse --verify HEAD)
RUN_DIR=$(mktemp -d "$TEMP_ROOT/navi-provider-compat.XXXXXX")
SOURCE_DIR="$RUN_DIR/source"
git init --quiet "$SOURCE_DIR"
git -C "$SOURCE_DIR" fetch --quiet --depth=1 "file://$REPO" "$REVISION"
git -C "$SOURCE_DIR" checkout --detach --quiet FETCH_HEAD
[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$REVISION" ] \
  && [ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ] \
  || {
    printf 'provider-compat: could not prepare a clean committed source tree\n' >&2
    exit 1
  }
ENV_FILE=$(mktemp "$TEMP_ROOT/navi-provider-compat-env.XXXXXX")
chmod 600 "$ENV_FILE"
HOST_OUTPUT="$RUN_DIR/provider-compat.json"

# Node parses dotenv as data; neither file is sourced. The repo-level value wins
# when both files define the same key. Comments and unrelated variables are
# discarded before Docker sees the temporary file.
node --input-type=module - \
  "$REPO/.env" \
  "$REPO/docker/coldstart/.env" \
  "$REPO/config/tested-models.json" \
  "$ENV_FILE" <<'__NAVI_PROVIDER_ENV__'
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [repoPath, coldstartPath, manifestPath, outputPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const keyNames = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
];
const manifestKeys = [
  ...new Set(manifest.providers.flatMap((provider) => provider.env_keys)),
];
if (
  keyNames.length !== manifestKeys.length ||
  keyNames.some((name, index) => name !== manifestKeys[index])
) {
  throw new Error("tested-model manifest does not match the provider credential trust boundary");
}

function read(path) {
  if (!existsSync(path)) return {};
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`provider environment file must not be group/world accessible: ${path}`);
  }
  try {
    return { ...parseEnv(readFileSync(path, "utf8")) };
  } catch {
    throw new Error(`could not parse provider environment file: ${path}`);
  }
}

const values = { ...read(coldstartPath), ...read(repoPath) };
const lines = keyNames.flatMap((name) => {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) return [];
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`provider key ${name} contains a character Docker env files cannot represent`);
  }
  return [`${name}=${value}`];
});

if (lines.length === 0) {
  throw new Error("no recognized provider keys were found in the local environment files");
}
writeFileSync(outputPath, `${lines.join("\n")}\n`, { mode: 0o600 });
__NAVI_PROVIDER_ENV__
chmod 600 "$ENV_FILE"

# No Dockerfile and no custom image: a keyless disposable container clones the
# read-only checkout, installs dependencies, and proves the exact revision clean.
# The source credential files are masked. Only after setup completes does a
# second process receive the reduced env file and run the compatibility script.
docker run \
  --name "$CONTAINER" \
  --rm \
  --detach \
  --mount "type=bind,source=$SOURCE_DIR,target=/source,readonly" \
  --mount "type=bind,source=$RUN_DIR,target=/out" \
  --workdir /work \
  node:22-slim \
  sleep infinity \
  >/dev/null

docker exec \
  --env "NAVI_PROVIDER_COMPAT_REVISION=$REVISION" \
  "$CONTAINER" \
  bash -ceu '
    apt-get update -qq
    apt-get install -y --no-install-recommends git ripgrep >/dev/null
    rm -rf /var/lib/apt/lists/*

    test ! -s /source/.env
    test ! -s /source/docker/coldstart/.env
    git -c safe.directory=/source clone --local --no-hardlinks /source /work/repo
    cd /work/repo
    git checkout --detach --quiet "$NAVI_PROVIDER_COMPAT_REVISION"
    test "$(git rev-parse HEAD)" = "$NAVI_PROVIDER_COMPAT_REVISION"
    test -z "$(git status --porcelain)"
    npm ci
  '

DOCKER_STATUS=0
docker exec \
  --env-file "$ENV_FILE" \
  --env "NAVI_PROVIDER_COMPAT_CONTAINER=1" \
  "$CONTAINER" \
  bash -ceu '
    cd /work/repo
    measurement_status=0
    node scripts/provider-compat.mjs \
      --attempts 2 \
      --output /out/provider-compat.json \
      >/dev/null \
      || measurement_status=$?
    test "$measurement_status" -le 1
    node scripts/provider-compat.mjs \
      --verify-artifact /out/provider-compat.json \
      >/dev/null
  ' \
  || DOCKER_STATUS=$?

# A failed matrix never replaces the result artifact, but its already-redacted
# booleans remain useful for diagnosis. Print only catalog/evidence fields that
# the artifact schema permits; never print prompts, model output, or credentials.
if [ "$DOCKER_STATUS" -ne 0 ]; then
  [ ! -f "$HOST_OUTPUT" ] || node --input-type=module - "$HOST_OUTPUT" <<'__NAVI_PROVIDER_DIAGNOSTIC__'
import { readFileSync } from "node:fs";

const artifact = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const row of artifact.results.filter((entry) => entry.status !== "PASS")) {
  const evidence = Object.entries(row.lane_evidence)
    .filter(([, present]) => present)
    .map(([name]) => name)
    .join(",");
  process.stderr.write(
    [
      `${row.provider}/${row.lane}`,
      `status=${row.status}`,
      `model_listed=${row.model_listed}`,
      `host_verified=${row.metadata_host_verified}`,
      `catalog_verified=${row.provider_catalog_verified}`,
      `attempts=${row.attempts}`,
      `evidence=${evidence || "none"}`,
      `reason=${row.reason ?? "none"}`,
    ].join(" ") + "\n",
  );
}
__NAVI_PROVIDER_DIAGNOSTIC__
  exit "$DOCKER_STATUS"
fi

[ -f "$HOST_OUTPUT" ] && [ ! -L "$HOST_OUTPUT" ] || {
  printf 'provider-compat: completed without a regular output artifact at %s\n' "$HOST_OUTPUT" >&2
  exit 1
}

# Copy to a same-directory stage, then rename. The result changes
# atomically and only after Docker and the offline artifact verifier both pass.
mkdir -p "$(dirname "$TARGET")"
TARGET_STAGE=$(mktemp "$(dirname "$TARGET")/.provider-compat.json.XXXXXX")
cp "$HOST_OUTPUT" "$TARGET_STAGE"
chmod 644 "$TARGET_STAGE"
mv -f -- "$TARGET_STAGE" "$TARGET"
TARGET_STAGE=""

printf 'provider compatibility artifact updated: %s\n' "$TARGET"
