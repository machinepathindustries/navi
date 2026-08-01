#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { getProviderConfig } from "@mastra/core/llm";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures", "provider-compat");
const NAVI_ENTRY = join(REPO_ROOT, "bin", "navi.mjs");
const TESTED_MODELS_PATH = join(REPO_ROOT, "config", "tested-models.json");
const LANES = ["quick", "deep", "structured", "founder", "code-review"];
const RUNTIME_DIGEST_INPUTS = ["package.json", "package-lock.json", "bin", "src", "builtin"];
export const MEASUREMENT_DIGEST_INPUTS = [
  "config/tested-models.json",
  "docker/provider-compat/run.sh",
  "scripts/provider-compat.mjs",
  "tests/fixtures/provider-compat",
];
const ARTIFACT_SCHEMA_VERSION = "navi.provider-compat.v7";
const ARTIFACT_KEYS = [
  "schema_version",
  "tested_at",
  "attempts_required",
  "lanes",
  "provider_order",
  "note",
  "evidence",
  "results",
];
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
];
const LOCAL_RESULT_KEYS = [
  "provider",
  "model",
  "lane",
  "metadata_host",
  "status",
  "attempts",
  "key_present",
  "model_listed",
  "provider_catalog_verified",
  "metadata_host_verified",
  "reason",
  "timing",
];
const RESULT_KEYS = LOCAL_RESULT_KEYS.filter(
  (key) => key !== "key_present" && key !== "reason",
);
const RESULT_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT_TESTED"]);
const LOCAL_BLOCK_REASONS = new Set(["account_quota", "rate_limit"]);

export const TESTED_MODELS = JSON.parse(readFileSync(TESTED_MODELS_PATH, "utf8"));

// Model IDs and documentation links change; credential destinations do not get
// to change with them. This independent trust map is the security boundary for
// which local secrets may be read and which host may receive each one. The
// manifest must match it exactly before any provider row is constructed.
export const PROVIDER_TRUST = Object.freeze({
  deepseek: {
    classification: "direct",
    keyNames: ["DEEPSEEK_API_KEY"],
    metadataHost: "api.deepseek.com",
    listPath: "/models",
    auth: "bearer",
  },
  openai: {
    classification: "direct",
    keyNames: ["OPENAI_API_KEY"],
    metadataHost: "api.openai.com",
    listPath: "/v1/models",
    auth: "bearer",
  },
  anthropic: {
    classification: "direct",
    keyNames: ["ANTHROPIC_API_KEY"],
    metadataHost: "api.anthropic.com",
    listPath: "/v1/models",
    auth: "anthropic",
  },
  google: {
    classification: "direct",
    keyNames: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    metadataHost: "generativelanguage.googleapis.com",
    listPath: "/v1beta/models",
    auth: "google",
  },
  xai: {
    classification: "direct",
    keyNames: ["XAI_API_KEY"],
    metadataHost: "api.x.ai",
    listPath: "/v1/models",
    auth: "bearer",
  },
  openrouter: {
    classification: "separate",
    keyNames: ["OPENROUTER_API_KEY"],
    metadataHost: "openrouter.ai",
    listPath: "/api/v1/models",
    auth: "bearer",
  },
});

export function validateTestedModelManifest(manifest) {
  const trustedIds = Object.keys(PROVIDER_TRUST);
  const manifestIds = manifest.providers?.map((entry) => entry.id) ?? [];
  if (!sameArray(manifestIds, trustedIds)) {
    throw new Error(`tested-model manifest must contain exactly: ${trustedIds.join(", ")}`);
  }
  for (const entry of manifest.providers) {
    const trusted = PROVIDER_TRUST[entry.id];
    const mismatched =
      entry.classification !== trusted.classification ||
      !sameArray(entry.env_keys, trusted.keyNames) ||
      entry.compatibility?.metadata_host !== trusted.metadataHost ||
      entry.compatibility?.list_path !== trusted.listPath ||
      entry.compatibility?.auth !== trusted.auth;
    if (mismatched) {
      throw new Error(
        `tested-model manifest cannot change the credential trust boundary for ${entry.id}`,
      );
    }
  }
}

validateTestedModelManifest(TESTED_MODELS);

// The manifest records compatibility targets, not a Navi runtime allowlist.
// OpenRouter remains a separate route and runs last, so it cannot supply
// evidence for a direct provider.
export const PROVIDERS = TESTED_MODELS.providers.map((entry) => {
  const trusted = PROVIDER_TRUST[entry.id];
  return {
    provider: entry.id,
    lab: entry.lab,
    classification: trusted.classification,
    modelPrefix: entry.router_prefix,
    models: entry.models,
    catalogUrl: entry.catalog_url,
    modelUrls: entry.model_urls,
    metadataHost: trusted.metadataHost,
    keyNames: trusted.keyNames,
    listPath: trusted.listPath,
    auth: trusted.auth,
  };
});

// Node owns dotenv grammar. parseEnv parses assignments without evaluating,
// expanding, sourcing, importing, or printing a value.
export function parseEnvText(text) {
  return { ...parseEnv(text) };
}

export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseEnvText(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`could not parse provider environment file: ${path}`);
  }
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

export function keyForProvider(provider, processValues, fileValues) {
  for (const name of provider.keyNames) {
    if (nonempty(processValues[name])) return { name, value: processValues[name] };
    if (nonempty(fileValues[name])) return { name, value: fileValues[name] };
  }
  return null;
}

// A compatibility child starts from a small runtime allowlist, then receives one
// provider credential. A denylist is not a credential boundary: token/password
// names, proxy variables, NODE_OPTIONS loaders, and future provider overrides
// would all survive until someone remembered to add them.
export function providerChildEnv(provider, model, processValues, fileValues, runtime) {
  const env = runtimeEnv(processValues);
  const selected = keyForProvider(provider, processValues, fileValues);
  if (selected) env[selected.name] = selected.value;
  env.NAVI_MODEL = model;
  env.NAVI_DB = `file:${runtime.db}`;
  env.HOME = runtime.home;
  return env;
}

function runtimeEnv(processValues) {
  return Object.fromEntries(
    CHILD_ENV_ALLOWLIST.flatMap((name) =>
      nonempty(processValues[name]) ? [[name, processValues[name]]] : [],
    ),
  );
}

function stringSet(value) {
  return new Set(Array.isArray(value) ? value : typeof value === "string" ? [value] : []);
}

// The installed Mastra registry is the authority for the provider prefix that
// selects an adapter. This proves catalog/adapter selection, not the destination
// of an inference request: the harness never intercepts TLS and must not imply
// that an authenticated metadata request observed the later inference socket.
export function verifyProviderCatalog(provider, config = getProviderConfig(provider.provider)) {
  const registeredKeys = stringSet(config?.apiKeyEnvVar);
  const configuredKeys = new Set(provider.keyNames);
  const keysMatch =
    registeredKeys.size === configuredKeys.size &&
    [...registeredKeys].every((name) => configuredKeys.has(name));
  return (
    provider.modelPrefix === `${provider.provider}/` &&
    config?.gateway === "models.dev" &&
    keysMatch
  );
}

function providerModelId(provider, model) {
  return model.slice(provider.modelPrefix.length);
}

export function modelIdsFromList(provider, body) {
  if (provider.provider === "google") {
    return new Set(
      Array.isArray(body?.models)
        ? body.models
            .map((model) => model?.name)
            .filter((name) => typeof name === "string")
            .map((name) => name.replace(/^models\//, ""))
        : [],
    );
  }
  return new Set(
    Array.isArray(body?.data)
      ? body.data.map((model) => model?.id).filter((id) => typeof id === "string")
      : [],
  );
}

function modelListHeaders(provider, key) {
  if (provider.auth === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
  if (provider.auth === "google") return { "x-goog-api-key": key };
  return { Authorization: `Bearer ${key}` };
}

// One authenticated metadata request proves three things without retaining a
// response body: the selected key reaches the first-party hostname, the exact
// model ids are visible to that key, and no base-url override was involved.
// redirect:error prevents a successful result from silently changing hosts.
export async function verifyProviderModels(provider, key, timeoutMs) {
  const providerCatalogVerified = verifyProviderCatalog(provider);
  try {
    const response = await fetch(`https://${provider.metadataHost}${provider.listPath}`, {
      method: "GET",
      headers: modelListHeaders(provider, key),
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
    });
    const exactHost = new URL(response.url).hostname === provider.metadataHost;
    const body = response.ok ? await response.json() : null;
    const ids = modelIdsFromList(provider, body);
    return {
      providerCatalogVerified,
      metadataHostVerified: response.ok && exactHost,
      listed: {
        quick: ids.has(providerModelId(provider, provider.models.quick)),
        workflow: ids.has(providerModelId(provider, provider.models.workflow)),
      },
    };
  } catch {
    return {
      providerCatalogVerified,
      metadataHostVerified: false,
      listed: { quick: false, workflow: false },
    };
  }
}

function providerWithOverride(provider, processValues) {
  const stem = `NAVI_COMPAT_${provider.provider.toUpperCase().replaceAll("-", "_")}`;
  const models = {
    quick: nonempty(processValues[`${stem}_QUICK_MODEL`])
      ? processValues[`${stem}_QUICK_MODEL`]
      : provider.models.quick,
    workflow: nonempty(processValues[`${stem}_WORKFLOW_MODEL`])
      ? processValues[`${stem}_WORKFLOW_MODEL`]
      : provider.models.workflow,
  };
  for (const [role, model] of Object.entries(models)) {
    if (!model.startsWith(provider.modelPrefix)) {
      throw new Error(
        `${stem}_${role.toUpperCase()}_MODEL must start with ${provider.modelPrefix}; cross-provider overrides would falsify the provider-catalog result`,
      );
    }
  }
  return { ...provider, models };
}

export function listProviders(processValues, fileValues) {
  return PROVIDERS.map((original) => {
    const provider = providerWithOverride(original, processValues);
    return {
      provider: provider.provider,
      quick_model: provider.models.quick,
      workflow_model: provider.models.workflow,
      metadata_host: provider.metadataHost,
      key_present: keyForProvider(provider, processValues, fileValues) !== null,
      provider_catalog_verified: verifyProviderCatalog(provider),
      metadata_host_verified: false,
      model_listed: false,
    };
  });
}

function modelForLane(provider, lane) {
  return lane === "quick" ? provider.models.quick : provider.models.workflow;
}

function resultRow({
  provider,
  lane,
  status,
  attempts,
  keyPresent,
  modelListed,
  providerCatalogVerified,
  metadataHostVerified,
  startedAt,
  attemptMs,
  reason = null,
}) {
  return {
    provider: provider.provider,
    model: modelForLane(provider, lane),
    lane,
    metadata_host: provider.metadataHost,
    status,
    attempts,
    key_present: Boolean(keyPresent),
    model_listed: Boolean(modelListed),
    provider_catalog_verified: Boolean(providerCatalogVerified),
    metadata_host_verified: Boolean(metadataHostVerified),
    reason,
    timing: {
      started_at: startedAt,
      duration_ms: attemptMs.reduce((sum, duration) => sum + duration, 0),
      attempt_ms: attemptMs,
    },
  };
}

export function notTestedRows(providers, processValues = {}, fileValues = {}) {
  return providers.flatMap((provider) =>
    LANES.map((lane) =>
      resultRow({
        provider,
        lane,
        status: "NOT_TESTED",
        attempts: 0,
        keyPresent: keyForProvider(provider, processValues, fileValues) !== null,
        modelListed: false,
        providerCatalogVerified: false,
        metadataHostVerified: false,
        startedAt: null,
        attemptMs: [],
      }),
    ),
  );
}

export function hasOnlyResultFields(row) {
  return hasOnlyFields(row, RESULT_KEYS);
}

function hasOnlyLocalResultFields(row) {
  return hasOnlyFields(row, LOCAL_RESULT_KEYS);
}

function artifactResultRow(row) {
  return Object.fromEntries(RESULT_KEYS.map((key) => [key, row[key]]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value, fields) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort())
  );
}

function sameArray(left, right) {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function artifactValidationErrors(artifact, raw = JSON.stringify(artifact)) {
  const errors = [];
  if (!hasOnlyFields(artifact, ARTIFACT_KEYS)) {
    return ["artifact contains unexpected top-level fields"];
  }

  if (artifact.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${ARTIFACT_SCHEMA_VERSION}`);
  }
  if (!validTimestamp(artifact.tested_at)) errors.push("tested_at must be an ISO timestamp");
  if (
    !Number.isInteger(artifact.attempts_required) ||
    artifact.attempts_required < 1 ||
    artifact.attempts_required > 3
  ) {
    errors.push("attempts_required must be an integer from 1 to 3");
  }
  if (!sameArray(artifact.lanes, LANES)) errors.push("lanes are incomplete or out of order");

  const expectedProviders = PROVIDERS.map((provider) => provider.provider);
  if (!sameArray(artifact.provider_order, expectedProviders)) {
    errors.push("provider_order must contain every provider with OpenRouter last");
  }
  if (typeof artifact.note !== "string") errors.push("note must be a string");

  const evidence = artifact.evidence;
  if (!hasOnlyFields(evidence, ["git", "digests", "versions"])) {
    errors.push("evidence must contain only git, digests, and versions");
  } else {
    if (!hasOnlyFields(evidence.git, ["revision", "dirty"])) {
      errors.push("evidence.git has an invalid shape");
    } else {
      if (!/^[0-9a-f]{40}$/.test(evidence.git.revision)) {
        errors.push("evidence.git.revision must be a full commit hash");
      }
      if (typeof evidence.git.dirty !== "boolean") {
        errors.push("evidence.git.dirty must be boolean");
      }
    }

    if (
      !hasOnlyFields(evidence.digests, [
        "algorithm",
        "runtime_source",
        "measurement_harness_and_fixture",
      ])
    ) {
      errors.push("evidence.digests has an invalid shape");
    } else {
      if (evidence.digests.algorithm !== "sha256") {
        errors.push("evidence digest algorithm must be sha256");
      }
      for (const field of ["runtime_source", "measurement_harness_and_fixture"]) {
        if (!/^[0-9a-f]{64}$/.test(evidence.digests[field])) {
          errors.push(`evidence.digests.${field} must be a SHA-256 digest`);
        }
      }
    }

    if (
      !hasOnlyFields(evidence.versions, [
        "navi",
        "node",
        "platform",
        "arch",
        "dependencies",
      ])
    ) {
      errors.push("evidence.versions has an invalid shape");
    } else {
      for (const field of ["navi", "node", "platform", "arch"]) {
        if (!nonempty(evidence.versions[field])) {
          errors.push(`evidence.versions.${field} must be a non-empty string`);
        }
      }
      const dependencyNames = [
        "@mastra/core",
        "@mastra/libsql",
        "@mastra/memory",
        "tsx",
        "zod",
      ];
      if (!hasOnlyFields(evidence.versions.dependencies, dependencyNames)) {
        errors.push("evidence.versions.dependencies has an invalid shape");
      } else {
        for (const name of dependencyNames) {
          if (!nonempty(evidence.versions.dependencies[name])) {
            errors.push(`dependency version is missing for ${name}`);
          }
        }
      }
    }
  }

  const expectedPairs = PROVIDERS.flatMap((provider) =>
    LANES.map((lane) => `${provider.provider}/${lane}`),
  );
  if (!Array.isArray(artifact.results)) {
    errors.push("results must be an array");
  } else {
    const actualPairs = artifact.results.map((row) =>
      isRecord(row) ? `${row.provider}/${row.lane}` : "",
    );
    if (!sameArray(actualPairs, expectedPairs)) {
      errors.push("results must contain every provider/lane pair exactly once and in order");
    }

    for (const [index, row] of artifact.results.entries()) {
      if (!hasOnlyResultFields(row)) {
        errors.push(`result ${index} has an invalid shape`);
        continue;
      }
      const provider = PROVIDERS.find((entry) => entry.provider === row.provider);
      if (
        provider === undefined ||
        !LANES.includes(row.lane) ||
        row.model !== modelForLane(provider, row.lane) ||
        row.metadata_host !== provider.metadataHost
      ) {
        errors.push(`result ${index} does not match the provider catalog`);
      }
      if (!RESULT_STATUSES.has(row.status)) errors.push(`result ${index} has an invalid status`);
      if (!Number.isInteger(row.attempts) || row.attempts < 0) {
        errors.push(`result ${index} has an invalid attempt count`);
      }
      for (const field of [
        "model_listed",
        "provider_catalog_verified",
        "metadata_host_verified",
      ]) {
        if (typeof row[field] !== "boolean") {
          errors.push(`result ${index}.${field} must be boolean`);
        }
      }
      if (!hasOnlyFields(row.timing, ["started_at", "duration_ms", "attempt_ms"])) {
        errors.push(`result ${index}.timing has an invalid shape`);
      } else {
        if (row.timing.started_at !== null && !validTimestamp(row.timing.started_at)) {
          errors.push(`result ${index}.timing.started_at must be null or an ISO timestamp`);
        }
        if (
          !Array.isArray(row.timing.attempt_ms) ||
          row.timing.attempt_ms.some(
            (duration) => !Number.isInteger(duration) || duration < 0,
          )
        ) {
          errors.push(`result ${index}.timing.attempt_ms has an invalid duration`);
        } else {
          const total = row.timing.attempt_ms.reduce((sum, duration) => sum + duration, 0);
          if (row.timing.attempt_ms.length !== row.attempts) {
            errors.push(`result ${index} attempt timings are incomplete`);
          }
          if (row.timing.duration_ms !== total) {
            errors.push(`result ${index} duration does not match its attempts`);
          }
        }
      }

      if (row.status === "PASS" || row.status === "BLOCKED") {
        if (row.attempts !== artifact.attempts_required) {
          errors.push(`result ${index} did not complete every required attempt`);
        }
        if (
          !row.model_listed ||
          !row.provider_catalog_verified ||
          !row.metadata_host_verified
        ) {
          errors.push(`result ${index} is missing provider evidence required for an exercised lane`);
        }
      }
      if (
        row.status === "NOT_TESTED" &&
        (row.attempts !== 0 || row.timing.started_at !== null)
      ) {
        errors.push(`result ${index} records execution for a NOT_TESTED lane`);
      }
    }
  }

  if (/(?:api[_-]?key|token|secret)"?\s*[:=]\s*"[^"]+/i.test(raw)) {
    errors.push("artifact contains credential-like material");
  }
  if (/"(?:prompt|output|stdout|stderr)"\s*:/.test(raw)) {
    errors.push("artifact contains unredacted command or model text fields");
  }
  if (/"key_present"\s*:/.test(raw)) {
    errors.push("artifact contains local credential-presence evidence");
  }
  if ([...LOCAL_BLOCK_REASONS].some((reason) => raw.includes(reason))) {
    errors.push("artifact contains local provider failure details");
  }
  return errors;
}

export function releaseArtifactErrors(
  artifact,
  raw,
  currentEvidence,
  revisionIsAncestor,
) {
  const errors = artifactValidationErrors(artifact, raw);
  if (artifact?.evidence?.git?.dirty !== false) {
    errors.push("artifact was measured from a dirty worktree");
  }
  if (artifact?.results?.some((row) => row?.status === "NOT_TESTED")) {
    errors.push("artifact contains NOT_TESTED rows");
  }
  if (artifact?.results?.some((row) => row?.status === "FAIL")) {
    errors.push("artifact contains compatibility failures");
  }
  if (artifact?.provider_order?.at(-1) !== "openrouter") {
    errors.push("OpenRouter must be the final provider");
  }
  const directProviders = artifact?.provider_order?.filter((provider) => provider !== "openrouter");
  const completeDirectPass =
    Array.isArray(directProviders) &&
    directProviders.some((provider) =>
      artifact?.lanes?.every((lane) =>
        artifact?.results?.some(
          (row) => row?.provider === provider && row?.lane === lane && row?.status === "PASS",
        ),
      ),
    );
  if (!completeDirectPass) {
    errors.push("artifact contains no direct provider with a complete PASS matrix");
  }
  if (revisionIsAncestor !== true) {
    errors.push("artifact revision is not an ancestor of HEAD");
  }
  if (
    JSON.stringify(artifact?.evidence?.digests) !==
    JSON.stringify(currentEvidence?.digests)
  ) {
    errors.push("artifact source or harness digest does not match the current tree");
  }
  return errors;
}

export function digestTrackedInputs(inputs, root = REPO_ROOT) {
  const listed = spawnSync("git", ["ls-files", "--stage", "-z", "--", ...inputs], {
    cwd: root,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error("git ls-files failed while hashing release evidence");
  }
  const hash = createHash("sha256");
  const entries = listed.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      if (tab < 0) throw new Error("git ls-files returned an invalid stage entry");
      const mode = entry.slice(0, tab).split(" ")[0];
      const name = entry.slice(tab + 1);
      return { mode, name };
    });
  const modes = new Map(entries.map(({ mode, name }) => [name, mode]));
  // Array#sort's default UTF-16 code-unit order is deterministic. localeCompare
  // is not: macOS and Linux order paths such as `SKILL.md` and `doctrine/`
  // differently.
  const names = entries.map(({ name }) => name).sort();
  for (const name of names) {
    const path = join(root, name);
    // The index still lists a tracked file after it has been deleted in the
    // working tree. Hash the source that is actually present; `git.dirty`
    // independently prevents this development state from becoming release
    // evidence. lstat preserves tracked symlinks, including broken ones.
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) continue;
    const mode = modes.get(name);
    if (mode === "120000") {
      hash.update(
        `${JSON.stringify({ name, type: "link", mode: 0o777, target: readlinkSync(path) })}\n`,
      );
      continue;
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`unsupported git mode ${String(mode)} for ${name}`);
    }
    const bytes = readFileSync(path);
    hash.update(
      `${JSON.stringify({
        name: relative(root, path).replaceAll("\\", "/"),
        type: "file",
        mode: mode === "100755" ? 0o755 : 0o644,
        size: bytes.length,
      })}\n`,
    );
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function gitOutput(args, root = REPO_ROOT) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed while recording evidence`);
  return result.stdout.trim();
}

export function currentEvidenceMetadata(root = REPO_ROOT) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const installedVersion = (name) => {
    const manifest = join(root, "node_modules", ...name.split("/"), "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  };
  return {
    git: {
      revision: gitOutput(["rev-parse", "HEAD"], root),
      dirty: gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], root) !== "",
    },
    digests: {
      algorithm: "sha256",
      runtime_source: digestTrackedInputs(RUNTIME_DIGEST_INPUTS, root),
      measurement_harness_and_fixture: digestTrackedInputs(MEASUREMENT_DIGEST_INPUTS, root),
    },
    versions: {
      navi: packageJson.version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dependencies: {
        "@mastra/core": installedVersion("@mastra/core"),
        "@mastra/libsql": installedVersion("@mastra/libsql"),
        "@mastra/memory": installedVersion("@mastra/memory"),
        tsx: installedVersion("tsx"),
        zod: installedVersion("zod"),
      },
    },
  };
}

export function compatibilityArtifact(providers, rows, attempts, testedAt, root = REPO_ROOT) {
  return {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    tested_at: testedAt,
    attempts_required: attempts,
    lanes: [...LANES],
    provider_order: providers.map((provider) => provider.provider),
    note: "OpenRouter is a separate provider and is never evidence for a first-party gateway.",
    evidence: currentEvidenceMetadata(root),
    results: rows.map(artifactResultRow),
  };
}

function gitRevisionIsAncestor(revision, root = REPO_ROOT) {
  if (!/^[0-9a-f]{40}$/.test(revision)) return false;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", revision, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0;
}

export function verifyArtifactFile(path, root = REPO_ROOT) {
  const raw = readFileSync(path, "utf8");
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch {
    throw new Error(`could not parse provider compatibility artifact: ${path}`);
  }
  const revision = artifact?.evidence?.git?.revision;
  const errors = releaseArtifactErrors(
    artifact,
    raw,
    currentEvidenceMetadata(root),
    gitRevisionIsAncestor(revision, root),
  );
  if (errors.length > 0) {
    throw new Error(`artifact verification failed:\n- ${errors.join("\n- ")}`);
  }
  return artifact;
}

function commandResult(args, cwd, env, timeoutMs) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [NAVI_ENTRY, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    durationMs: Date.now() - started,
  };
}

export function upstreamBlockReason(stderr) {
  const text = stderr.toLowerCase();
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("check your plan and billing details") ||
    text.includes("insufficient credits")
  ) {
    return "account_quota";
  }
  if (text.includes("rate limit") || text.includes("rate_limit")) return "rate_limit";
  if (
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("authentication_error")
  ) {
    return "authentication";
  }
  return null;
}

function parsedEnvelope(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function validCodeReviewResult(result) {
  // The workflow itself validates this object with the canonical schema in
  // builtin/workflows/code-review/findings.schema.ts. Importing that TypeScript
  // file here would require a loader on supported Node 22 releases and would
  // change the standalone measurement runtime, so this evidence check mirrors
  // the canonical fields and enum without becoming a second runtime schema.
  return (
    result !== null &&
    typeof result === "object" &&
    typeof result.summary === "string" &&
    Array.isArray(result.findings) &&
    result.findings.every(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        typeof finding.file === "string" &&
        typeof finding.line === "number" &&
        ["low", "medium", "high"].includes(finding.severity) &&
        typeof finding.category === "string" &&
        typeof finding.summary === "string",
    )
  );
}

export function validFounderResult(result) {
  return (
    result !== null &&
    typeof result === "object" &&
    ["GO", "REFINE", "REJECT"].includes(result.verdict) &&
    typeof result.take === "string" &&
    Array.isArray(result.grounding_points) &&
    result.grounding_points.every((point) => typeof point === "string") &&
    Array.isArray(result.decision_rules) &&
    result.decision_rules.every((rule) => typeof rule === "string") &&
    Array.isArray(result.what_not_to_do) &&
    result.what_not_to_do.every((warning) => typeof warning === "string")
  );
}

export function hasExactFounderGrounding(result, nonce) {
  return (
    validFounderResult(result) &&
    result.grounding_points.some((point) => point.includes(nonce))
  );
}

// Workflow progress does not expose nested agent tool calls. The random nonce,
// which exists only in docs/release-brief.md and never in the prompt, proves the
// file was read; trace.tools separately proves that `view` was a legal route.
// This deliberately does not claim that `view` itself was the route selected.
export function hasFounderReadRouteEvidence(result, tools, nonce) {
  return (
    hasExactFounderGrounding(result, nonce) &&
    Array.isArray(tools) &&
    tools.includes("view") &&
    result.grounding_points.some((point) =>
      point.replaceAll("\\", "/").includes("docs/release-brief.md"),
    )
  );
}

export function hasExpectedCodeReviewFinding(result) {
  if (!validCodeReviewResult(result) || result.findings.length === 0) return false;
  return result.findings.some((finding) => {
    const file = finding.file.replace(/^\.\//, "");
    const explanation = `${finding.category}\n${finding.summary}`.toLowerCase();
    const identifiesDefect =
      /off[- ]by[- ]one/.test(explanation) ||
      (/first/.test(explanation) &&
        /(second|index\s*1|at\s*\(\s*1\s*\))/.test(explanation)) ||
      (/at\s*\(\s*0\s*\)/.test(explanation) && /at\s*\(\s*1\s*\)/.test(explanation));
    return file === "src/review-target.js" && finding.line === 2 && identifiesDefect;
  });
}

function laneAttempt(lane, context, env, timeoutMs) {
  if (lane === "quick") {
    const run = commandResult(
      [
        "What exact string is assigned to NAVI_PROVIDER_COMPAT_MARKER? Cite the file.",
        "-w",
        context.project,
        "--progress",
        "off",
      ],
      context.project,
      env,
      timeoutMs,
    );
    const gradePassed =
      run.stdout.includes("✓ Grounding grade passed — the answer stands.") &&
      /VERDICT:\s*COMPLETE/i.test(run.stdout) &&
      /ESCALATE:\s*no/i.test(run.stdout) &&
      !run.stderr.includes("grade stage failed");
    const grounded = run.status === 0 && run.stdout.includes(context.nonce);
    return {
      ok: grounded && gradePassed,
      blockReason: upstreamBlockReason(run.stderr),
      durationMs: run.durationMs,
    };
  }

  if (lane === "deep") {
    const run = commandResult(
      [
        `Read src/nonce.txt and report its exact value. Do not infer it.`,
        "-w",
        context.project,
        "--deep",
        "--progress",
        "off",
      ],
      context.project,
      env,
      timeoutMs,
    );
    const nonceMatch = run.stdout.includes(context.nonce);
    return {
      ok: run.status === 0 && nonceMatch,
      blockReason: upstreamBlockReason(run.stderr),
      durationMs: run.durationMs,
    };
  }

  if (lane === "structured") {
    const run = commandResult(
      [
        "run",
        join(FIXTURE_ROOT, "action.yaml"),
        "--json",
        "--progress",
        "off",
        "-w",
        context.project,
      ],
      context.project,
      env,
      timeoutMs,
    );
    const envelope = parsedEnvelope(run.stdout);
    const result = envelope?.result;
    const schema =
      result !== null &&
      typeof result === "object" &&
      typeof result.nonce === "string" &&
      result.read_with_tool === true;
    // Workflow progress currently exposes step boundaries, not nested agent tool
    // events. The trace proves `view` was the only configured workspace route;
    // matching a fresh random nonce that exists only in the viewed file proves
    // the model actually obtained its contents rather than inferring an answer.
    const nonceMatch = schema && result.nonce === context.nonce;
    const readRouteDeclared =
      Array.isArray(envelope?.trace?.tools) && envelope.trace.tools.includes("view");
    return {
      ok:
        run.status === 0 &&
        envelope?.status !== "failed" &&
        schema &&
        nonceMatch &&
        readRouteDeclared,
      blockReason: upstreamBlockReason(run.stderr),
      durationMs: run.durationMs,
    };
  }

  if (lane === "founder") {
    const run = commandResult(
      [
        "run",
        "founder",
        "Judge docs/release-brief.md as a release plan. Include its exact compatibility marker and file path in a grounding point.",
        "--json",
        "--progress",
        "off",
        "-w",
        context.project,
      ],
      context.project,
      env,
      timeoutMs,
    );
    const envelope = parsedEnvelope(run.stdout);
    const result = envelope?.result;
    const schema = validFounderResult(result);
    const nonceGrounded = hasExactFounderGrounding(result, context.founderNonce);
    const readRouteDeclared = hasFounderReadRouteEvidence(
      result,
      envelope?.trace?.tools,
      context.founderNonce,
    );
    return {
      ok:
        run.status === 0 &&
        envelope?.status !== "failed" &&
        schema &&
        nonceGrounded &&
        readRouteDeclared,
      blockReason: upstreamBlockReason(run.stderr),
      durationMs: run.durationMs,
    };
  }

  const run = commandResult(
    ["run", "code-review", "HEAD", "--json", "--progress", "off", "-w", context.project],
    context.project,
    env,
    timeoutMs,
  );
  const envelope = parsedEnvelope(run.stdout);
  const schema = validCodeReviewResult(envelope?.result);
  // A schema-valid empty review does not prove review compatibility. The planted
  // change makes `first()` return the second element; PASS requires a finding on
  // that exact line which identifies first-vs-second or the off-by-one defect.
  const foundPlantedDefect = hasExpectedCodeReviewFinding(envelope?.result);
  const collectDiffCompleted =
    Array.isArray(envelope?.trace?.steps) && envelope.trace.steps.includes("collect_diff");
  return {
    ok:
      run.status === 0 &&
      envelope?.status !== "failed" &&
      schema &&
      collectDiffCompleted &&
      foundPlantedDefect,
    blockReason: upstreamBlockReason(run.stderr),
    durationMs: run.durationMs,
  };
}

export function summarizeAttempts(attemptResults, metadataAuthenticated = false) {
  const passed = attemptResults.length > 0 && attemptResults.every((result) => result.ok);
  const failures = attemptResults.filter((result) => !result.ok);
  const blockReasons = failures.map((result) =>
    metadataAuthenticated && result.blockReason === "authentication"
      ? null
      : result.blockReason,
  );
  const blocked =
    failures.length > 0 && blockReasons.every((reason) => reason !== null);
  const reason = blocked
    ? blockReasons.find((value) => value !== null)
    : null;
  return {
    passed,
    status: passed ? "PASS" : blocked ? "BLOCKED" : "FAIL",
    reason,
    attemptMs: attemptResults.map((result) => result.durationMs),
  };
}

function makeNonce() {
  return `navi-provider-${randomUUID()}`;
}

function initializeProject(root, processValues) {
  const project = join(root, "repo");
  cpSync(join(FIXTURE_ROOT, "repo"), project, { recursive: true });
  const nonce = makeNonce();
  const founderNonce = makeNonce();
  writeFileSync(join(project, "src", "nonce.txt"), `${nonce}\n`);
  writeFileSync(
    join(project, "src", "quick-marker.js"),
    `export const NAVI_PROVIDER_COMPAT_MARKER = ${JSON.stringify(nonce)};\n`,
  );
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(
    join(project, "docs", "release-brief.md"),
    [
      "# Release plan",
      "",
      `Compatibility marker: ${founderNonce}`,
      "",
      "Ship after the compatibility matrix passes. Roll back to the prior release if the cold-start check fails.",
      "",
    ].join("\n"),
  );
  const gitEnv = {
    ...runtimeEnv(processValues),
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig.empty"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Navi Provider Test",
    GIT_AUTHOR_EMAIL: "navi-provider@example.invalid",
    GIT_COMMITTER_NAME: "Navi Provider Test",
    GIT_COMMITTER_EMAIL: "navi-provider@example.invalid",
  };
  const noHooks = `core.hooksPath=${join(root, "disabled-hooks")}`;
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "provider fixture"]]) {
    const git = spawnSync("git", ["-c", noHooks, ...args], {
      cwd: project,
      env: gitEnv,
      encoding: "utf8",
    });
    if (git.status !== 0) throw new Error("could not initialize provider compatibility fixture");
  }
  writeFileSync(
    join(project, "src", "review-target.js"),
    "export function first(items) {\n  return items.at(1);\n}\n",
  );
  const diff = spawnSync("git", ["--no-pager", "diff", "--", "src/review-target.js"], {
    cwd: project,
    env: gitEnv,
    encoding: "utf8",
  });
  if (diff.status !== 0 || !diff.stdout.includes("items.at(1)")) {
    throw new Error("provider compatibility fixture has no real code-review diff");
  }
  return { project, nonce, founderNonce };
}

export function initializeAttemptRuntime(providerName, lane, processValues = process.env) {
  const scratch = mkdtempSync(join(tmpdir(), `navi-provider-${providerName}-${lane}-`));
  const home = join(scratch, "home");
  const db = join(scratch, "navi.db");
  mkdirSync(home, { recursive: true });
  return { scratch, home, db, ...initializeProject(scratch, processValues) };
}

async function runProvider(provider, fileValues, options) {
  const selectedKey = keyForProvider(provider, process.env, fileValues);
  if (selectedKey === null) {
    process.stderr.write(
      `${provider.provider}: NOT_TESTED (missing ${provider.keyNames.join(" or ")})\n`,
    );
    return notTestedRows([provider]);
  }
  const verification = await verifyProviderModels(provider, selectedKey.value, options.timeoutMs);

  const rows = [];
  for (const lane of LANES) {
    const modelListed =
      lane === "quick" ? verification.listed.quick : verification.listed.workflow;
    if (
      !verification.providerCatalogVerified ||
      !verification.metadataHostVerified ||
      !modelListed
    ) {
      rows.push(
        resultRow({
          provider,
          lane,
          status: "FAIL",
          attempts: 0,
          keyPresent: true,
          modelListed,
          providerCatalogVerified: verification.providerCatalogVerified,
          metadataHostVerified: verification.metadataHostVerified,
          startedAt: null,
          attemptMs: [],
        }),
      );
      process.stderr.write(`${provider.provider}/${lane}: FAIL\n`);
      continue;
    }
    const startedAt = new Date().toISOString();
    const attemptResults = [];
    while (attemptResults.length < options.attempts) {
      const runtime = initializeAttemptRuntime(provider.provider, lane);
      try {
        const env = providerChildEnv(
          provider,
          modelForLane(provider, lane),
          process.env,
          fileValues,
          { db: runtime.db, home: runtime.home },
        );
        attemptResults.push(laneAttempt(lane, runtime, env, options.timeoutMs));
      } finally {
        rmSync(runtime.scratch, { recursive: true, force: true });
      }
    }
    const summary = summarizeAttempts(attemptResults, true);
    rows.push(
      resultRow({
        provider,
        lane,
        status: summary.status,
        attempts: attemptResults.length,
        keyPresent: true,
        modelListed,
        providerCatalogVerified: verification.providerCatalogVerified,
        metadataHostVerified: verification.metadataHostVerified,
        startedAt,
        attemptMs: summary.attemptMs,
        reason: summary.reason,
      }),
    );
    const detail = summary.reason === null ? "" : ` (${summary.reason})`;
    process.stderr.write(`${provider.provider}/${lane}: ${summary.status}${detail}\n`);
  }
  return rows;
}

export function parseArgs(argv) {
  const options = {
    providers: [],
    envPath: join(REPO_ROOT, ".env"),
    output: null,
    attempts: 2,
    timeoutMs: 240_000,
    list: false,
    verifyArtifact: null,
    help: false,
  };
  const liveOptions = new Set();
  const nextValue = (index, option) => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--verify-artifact") {
      options.verifyArtifact = resolve(nextValue(index, arg));
      index += 1;
    } else if (arg === "--provider") {
      options.providers.push(nextValue(index, arg));
      liveOptions.add(arg);
      index += 1;
    } else if (arg === "--env") {
      options.envPath = resolve(nextValue(index, arg));
      liveOptions.add(arg);
      index += 1;
    } else if (arg === "--output") {
      options.output = resolve(nextValue(index, arg));
      liveOptions.add(arg);
      index += 1;
    } else if (arg === "--attempts") {
      options.attempts = Number(nextValue(index, arg));
      liveOptions.add(arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(nextValue(index, arg));
      liveOptions.add(arg);
      index += 1;
    }
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 3) {
    throw new Error("--attempts must be an integer from 1 to 3");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  if (options.verifyArtifact !== null && (options.list || liveOptions.size > 0)) {
    throw new Error("--verify-artifact cannot be combined with live-run or --list options");
  }
  return options;
}

function selectedProviders(names) {
  if (names.length === 0) return PROVIDERS;
  const requested = new Set(names.flatMap((name) => name.split(",")).filter(Boolean));
  const unknown = [...requested].filter(
    (name) => !PROVIDERS.some((provider) => provider.provider === name),
  );
  if (unknown.length > 0) throw new Error(`unknown provider: ${unknown.join(", ")}`);
  return PROVIDERS.filter((provider) => requested.has(provider.provider));
}

function emitJson(value, output) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (output) writeFileSync(output, text, { mode: 0o600 });
  process.stdout.write(text);
}

function helpText() {
  return `Usage:
  node scripts/provider-compat.mjs [live options]
  node scripts/provider-compat.mjs --list [--provider <names>] [--env <path>]
  node scripts/provider-compat.mjs --verify-artifact <path>

Modes:
  --list                    Zero-call preflight: list models, catalog matches, and key presence
  --verify-artifact <path>  Offline release check for a complete checked artifact

Live options:
  --provider <names>        Comma-separated provider names (default: all)
  --env <path>              Provider credential file (default: .env)
  --output <path>           Write the redacted artifact as well as stdout
  --attempts <1..3>         Required attempts per lane (default: 2)
  --timeout-ms <ms>         Per-call timeout (default: 240000)

Live runs make provider calls. FAIL, BLOCKED, or NOT_TESTED rows exit nonzero.
`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.verifyArtifact !== null) {
    verifyArtifactFile(options.verifyArtifact);
    process.stdout.write(`provider compatibility artifact verified: ${options.verifyArtifact}\n`);
    return;
  }
  if (!options.list && process.env.NAVI_PROVIDER_COMPAT_CONTAINER !== "1") {
    throw new Error(
      "live provider calls are local-Docker-only; run docker/provider-compat/run.sh",
    );
  }

  const fileValues = readEnvFile(options.envPath);
  const providers = selectedProviders(options.providers).map((provider) =>
    providerWithOverride(provider, process.env),
  );
  if (options.list) {
    emitJson(
      listProviders(process.env, fileValues).filter((entry) =>
        providers.some((provider) => provider.provider === entry.provider),
      ),
      options.output,
    );
    return;
  }

  const testedAt = new Date().toISOString();
  const rows = [];
  for (const provider of providers) {
    rows.push(...(await runProvider(provider, fileValues, options)));
  }
  if (!rows.every(hasOnlyLocalResultFields)) {
    throw new Error("provider result contains an unexpected field");
  }
  emitJson(compatibilityArtifact(providers, rows, options.attempts, testedAt), options.output);
  if (rows.some((row) => row.status !== "PASS")) {
    process.exitCode = 1;
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => {
    process.stderr.write(`provider compatibility: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
