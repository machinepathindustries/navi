#!/usr/bin/env bash
# Run the Bun preflight, build the npm tarball from the current tree, install
# production dependencies in a clean Node image, and run the out-of-box checks.
# `--live` reads docker/coldstart/.env at CONTAINER RUNTIME only, then exercises
# the xAI route through the project-local interop launcher. The key is absent
# from the repo-root .env and is never copied into an image layer.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
RUN_ID="$$-${RANDOM}"
IMAGE_REPOSITORY=${NAVI_COLDSTART_IMAGE_REPOSITORY:-navi-coldstart}
IMAGE="${IMAGE_REPOSITORY}:run-${RUN_ID}"
BUILDER="navi-coldstart-${RUN_ID}"
CONTAINER="navi-coldstart-${RUN_ID}"
LIVE_CONTAINER="${CONTAINER}-live"
RUN_ARGS=(--name "$CONTAINER" --rm)
LIVE=0
RUNTIME_ENV_FILE=""

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM

  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    docker container rm --force "$CONTAINER" >/dev/null || cleanup_status=1
  fi

  if docker container inspect "$LIVE_CONTAINER" >/dev/null 2>&1; then
    docker container rm --force "$LIVE_CONTAINER" >/dev/null || cleanup_status=1
  fi

  [ -z "$RUNTIME_ENV_FILE" ] \
    || rm -f "$RUNTIME_ENV_FILE" \
    || cleanup_status=1

  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker image rm "$IMAGE" >/dev/null || cleanup_status=1
  fi

  if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    docker buildx rm "$BUILDER" >/dev/null || cleanup_status=1
  fi

  [ "$status" -ne 0 ] || [ "$cleanup_status" -eq 0 ] || status=1
  exit "$status"
}

[ "${GITHUB_ACTIONS:-}" != "true" ] || {
  printf 'coldstart: this runner is local-only and refuses GitHub Actions\n' >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || {
  printf 'coldstart: docker is required\n' >&2
  exit 1
}

case "${DOCKER_HOST:-}" in
  "" | unix://* | npipe://*) ;;
  *)
    printf 'coldstart: refusing non-local DOCKER_HOST\n' >&2
    exit 1
    ;;
esac

DOCKER_CONTEXT=$(docker context show)
DOCKER_ENDPOINT=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}')
case "$DOCKER_ENDPOINT" in
  unix://* | npipe://*) ;;
  *)
    printf 'coldstart: docker context %s is not local\n' "$DOCKER_CONTEXT" >&2
    exit 1
    ;;
esac

if [ "${1:-}" = "--live" ]; then
  LIVE=1
  shift
fi

[ "$#" -eq 0 ] || {
  printf 'usage: docker/coldstart/run.sh [--live]\n' >&2
  exit 2
}

"$HERE/local-checks.sh"

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
docker buildx build \
  --builder "$BUILDER" \
  --file "$HERE/Dockerfile" \
  --tag "$IMAGE" \
  --load \
  "$REPO"

docker run "${RUN_ARGS[@]}" "$IMAGE"

if [ "$LIVE" -eq 1 ]; then
  [ -f "$HERE/.env" ] || {
    printf 'coldstart: --live requires %s/.env\n' "$HERE" >&2
    exit 1
  }
  RUNTIME_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/navi-coldstart-env.XXXXXX")
  chmod 600 "$RUNTIME_ENV_FILE"
  node --input-type=module -e '
    import { readFileSync, statSync, writeFileSync } from "node:fs";
    import { parseEnv } from "node:util";
    if ((statSync(process.argv[1]).mode & 0o077) !== 0) {
      process.stderr.write(`coldstart: ${process.argv[1]} must not be group/world accessible\n`);
      process.exit(1);
    }
    const value = parseEnv(readFileSync(process.argv[1], "utf8")).XAI_API_KEY ?? "";
    if (value.length === 0) {
      process.stderr.write(`coldstart: --live requires XAI_API_KEY in ${process.argv[1]}\n`);
      process.exit(1);
    }
    if (/[\0\r\n]/.test(value)) {
      process.stderr.write("coldstart: XAI_API_KEY contains a character that is unsafe in a Docker env file\n");
      process.exit(1);
    }
    writeFileSync(
      process.argv[2],
      `XAI_API_KEY=${value}\n`,
      { mode: 0o600 },
    );
  ' "$HERE/.env" "$RUNTIME_ENV_FILE"
  docker run \
    --name "$LIVE_CONTAINER" \
    --rm \
    --env-file "$RUNTIME_ENV_FILE" \
    --entrypoint bash \
    "$IMAGE" \
    /home/navi/live-check.sh
fi
