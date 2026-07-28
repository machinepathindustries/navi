# syntax=docker/dockerfile:1

# Pack exactly what npm would publish from the current working tree. The final
# image receives only the tarball, never the source checkout.
FROM node:22-slim AS pack
WORKDIR /package

COPY package.json README.md LICENSE .env.example ./
COPY bin ./bin
COPY src ./src
COPY builtin ./builtin
COPY agent ./agent
COPY config ./config

RUN mkdir /tarball \
 && npm pack --ignore-scripts --pack-destination /tarball >/tmp/npm-pack.log

# A clean consumer machine: Node and the two external commands navi documents.
# Bun, sqlite3, source-control metadata, and provider keys are deliberately absent.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

COPY --from=pack /tarball/*.tgz /tmp/navi.tgz

# Install as a normal production dependency. Keeping the install root-owned makes
# an accidental runtime write to the package fail instead of contaminating later
# checks.
RUN mkdir -p /opt/navi \
 && npm install --omit=dev --no-audit --no-fund --prefix /opt/navi /tmp/navi.tgz \
 && rm /tmp/navi.tgz

ENV PATH="/opt/navi/node_modules/.bin:${PATH}"

RUN useradd --create-home --shell /bin/bash navi

# A small consumer repository. cold-gate is command-only: it returns DIRECT
# without a provider key so the installed bin's real continuation command can be
# tested independently of model behavior.
RUN mkdir -p /home/navi/walk/src \
      /home/navi/walk/.navi/workflows/cold-gate \
      /home/navi/walk/.navi/workflows/cold-verdict \
 && printf 'export function greet(name) {\n  return `hello ${name}`;\n}\n' \
      > /home/navi/walk/src/greet.js \
 && printf 'import { greet } from "./greet.js";\nconsole.log(greet("world"));\n' \
      > /home/navi/walk/src/main.js \
 && printf '# walk\n\nA tiny repo for navi to read during cold-start checks.\n' \
      > /home/navi/walk/README.md \
 && printf '%s\n' \
      'name: cold-gate' \
      'description: Model-free installed-bin continuation probe.' \
      'steps:' \
      '  - name: gate' \
      '    type: command' \
      '    command: >-' \
      "      printf '%s' '{\"gate\":\"DIRECT\",\"reason\":\"cold-start continuation probe\",\"blocking_directive_ids\":[],\"non_blocking_risks\":[],\"human_escalation\":null,\"confidence\":1}'" \
      > /home/navi/walk/.navi/workflows/cold-gate/action.yaml \
 && printf '%s\n' \
      'name: cold-verdict' \
      'description: Model-free installed-bin verdict/session probe.' \
      'steps:' \
      '  - name: verdict' \
      '    type: command' \
      '    command: >-' \
      "      printf '%s' '{\"verdict\":\"REFINE\",\"take\":\"cold-start verdict probe\",\"grounding_points\":[],\"decision_rules\":[],\"what_not_to_do\":[]}'" \
      > /home/navi/walk/.navi/workflows/cold-verdict/action.yaml \
 && cd /home/navi/walk \
 && git init -q . \
 && git config user.email coldstart@example.invalid \
 && git config user.name "cold start" \
 && git add -A \
 && git commit -q -m "the walk repo" \
 && chown -R navi:navi /home/navi/walk

COPY --chown=navi:navi docker/coldstart/checks.sh /home/navi/checks.sh
COPY --chown=navi:navi docker/coldstart/live-check.sh /home/navi/live-check.sh

USER navi
WORKDIR /home/navi
ENTRYPOINT ["bash", "/home/navi/checks.sh"]
