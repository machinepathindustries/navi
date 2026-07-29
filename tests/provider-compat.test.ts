import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_WORKFLOW_MODEL } from "../src/model-targets.ts";
import {
  MEASUREMENT_DIGEST_INPUTS,
  PROVIDERS,
  PROVIDER_TRUST,
  TESTED_MODELS,
  artifactValidationErrors,
  compatibilityArtifact,
  digestTrackedInputs,
  hasExactFounderGrounding,
  hasExpectedCodeReviewFinding,
  hasFounderReadRouteEvidence,
  hasOnlyResultFields,
  initializeAttemptRuntime,
  keyForProvider,
  modelIdsFromList,
  notTestedRows,
  parseArgs,
  parseEnvText,
  providerChildEnv,
  releaseArtifactErrors,
  summarizeAttempts,
  upstreamBlockReason,
  validateTestedModelManifest,
  validFounderResult,
  verifyProviderCatalog,
} from "../scripts/provider-compat.mjs";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "provider-compat.mjs");
const TEMP = mkdtempSync(join(tmpdir(), "navi-provider-test-"));

type ArtifactRow = {
  provider: string;
  model: string;
  lane: string;
  metadata_host: string;
  status: string;
  attempts: number;
  model_listed: boolean;
  provider_catalog_verified: boolean;
  metadata_host_verified: boolean;
  timing: {
    started_at: string | null;
    duration_ms: number;
    attempt_ms: number[];
  };
};

type MeasurementRow = ArtifactRow & {
  key_present: boolean;
  reason: string | null;
};

type CheckedArtifact = {
  schema_version: string;
  tested_at: string;
  attempts_required: number;
  lanes: string[];
  provider_order: string[];
  note: string;
  evidence: {
    git: { revision: string; dirty: boolean };
    digests: {
      algorithm: string;
      runtime_source: string;
      measurement_harness_and_fixture: string;
    };
    versions: {
      navi: string;
      node: string;
      platform: string;
      arch: string;
      dependencies: Record<string, string>;
    };
  };
  results: ArtifactRow[];
};

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

function keylessEnv(extra: Record<string, string> = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || key.endsWith("_BASE_URL")) delete env[key];
  }
  return env;
}

function completeArtifactFixture(): CheckedArtifact {
  const rows = notTestedRows(PROVIDERS).map((row: MeasurementRow) => ({
    ...row,
    status: "PASS",
    attempts: 2,
    key_present: true,
    model_listed: true,
    provider_catalog_verified: true,
    metadata_host_verified: true,
    timing: {
      started_at: "2026-07-27T00:00:00.000Z",
      duration_ms: 2,
      attempt_ms: [1, 1],
    },
  }));
  const artifact = compatibilityArtifact(
    PROVIDERS,
    rows,
    2,
    "2026-07-27T00:00:00.000Z",
  ) as CheckedArtifact;
  artifact.evidence.git.dirty = false;
  return artifact;
}

describe("provider compatibility harness — no paid calls", () => {
  it("parses dotenv assignments as inert text and ignores commented keys", () => {
    const marker = join(TEMP, "must-not-exist");
    const parsed = parseEnvText(
      [
        "# XAI_API_KEY=commented",
        "export OPENAI_API_KEY='literal value'",
        `ANTHROPIC_API_KEY=$(touch ${marker})`,
        'GOOGLE_GENERATIVE_AI_API_KEY="quoted-key"',
        "",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      OPENAI_API_KEY: "literal value",
      ANTHROPIC_API_KEY: `$(touch ${marker})`,
      GOOGLE_GENERATIVE_AI_API_KEY: "quoted-key",
    });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("builds a minimal child environment with only the selected provider key", () => {
    const xai = PROVIDERS.find((provider) => provider.provider === "xai")!;
    const env = providerChildEnv(
      xai,
      xai.models.workflow,
      {
        PATH: process.env.PATH!,
        OPENAI_API_KEY: "openai-secret",
        XAI_API_KEY: "xai-secret",
        TAVILY_API_KEY: "tavily-secret",
        MASTRA_API_KEY: "mastra-secret",
        OPENAI_BASE_URL: "https://proxy.invalid",
        SOME_BASE_URL: "https://other.invalid",
        CUSTOM_GATEWAY_URL: "https://gateway.invalid",
        HTTPS_PROXY: "https://proxy.invalid",
        NODE_OPTIONS: "--require=/tmp/intercept.cjs",
        GITHUB_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        DATABASE_URL: "postgres://secret",
        ANTHROPIC_AUTH_TOKEN: "anthropic-token",
        NAVI_JUDGE_MODEL: "deepseek/other",
        NAVI_INSTALL_ROOT: ROOT,
      },
      { ANTHROPIC_API_KEY: "file-secret" },
      { db: "/tmp/provider.db", home: "/tmp/provider-home" },
    );

    expect(env.XAI_API_KEY).toBe("xai-secret");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.MASTRA_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.SOME_BASE_URL).toBeUndefined();
    expect(env.CUSTOM_GATEWAY_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.NAVI_JUDGE_MODEL).toBeUndefined();
    expect(env.NAVI_INSTALL_ROOT).toBeUndefined();
    expect(env.NAVI_MODEL).toBe("xai/grok-4.5");
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "NAVI_DB", "NAVI_MODEL", "PATH", "XAI_API_KEY"].sort(),
    );
  });

  it("prefers an explicit process key over the .env value without exposing either", () => {
    const anthropic = PROVIDERS.find((provider) => provider.provider === "anthropic")!;
    expect(
      keyForProvider(
        anthropic,
        { ANTHROPIC_API_KEY: "process-secret" },
        { ANTHROPIC_API_KEY: "file-secret" },
      ),
    ).toEqual({ name: "ANTHROPIC_API_KEY", value: "process-secret" });
  });

  it("--list reports key presence as booleans and never prints key values", () => {
    const envFile = join(TEMP, "list.env");
    writeFileSync(
      envFile,
      "XAI_API_KEY=list-secret-value\n# OPENAI_API_KEY=commented-secret\n",
    );
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--list", "--provider", "xai,openai", "--env", envFile],
      { cwd: ROOT, env: keylessEnv(), encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("list-secret-value");
    expect(run.stdout).not.toContain("commented-secret");
    const rows = JSON.parse(run.stdout);
    expect(rows.map((row: { provider: string; key_present: boolean }) => [
      row.provider,
      row.key_present,
    ])).toEqual([
      ["openai", false],
      ["xai", true],
    ]);
    expect(
      rows.every(
        (row: {
          provider_catalog_verified: unknown;
          metadata_host_verified: unknown;
          model_listed: unknown;
        }) =>
          row.provider_catalog_verified === true &&
          row.metadata_host_verified === false &&
          row.model_listed === false,
      ),
    ).toBe(true);
  });

  it("--help identifies --list as the zero-call preflight", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--help"], {
      cwd: ROOT,
      env: keylessEnv(),
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/--list\s+Zero-call preflight/);
    expect(run.stdout).toContain("--verify-artifact");
  });

  it("a missing key returns NOT_TESTED and exits nonzero; --dry-run is not supported", () => {
    const emptyEnv = join(TEMP, "empty.env");
    writeFileSync(emptyEnv, "# no credentials\n");
    const host = spawnSync(
      process.execPath,
      [SCRIPT, "--provider", "xai", "--env", emptyEnv],
      { cwd: ROOT, env: keylessEnv(), encoding: "utf8" },
    );
    expect(host.status).toBe(1);
    expect(host.stdout).toBe("");
    expect(host.stderr).toContain("local-Docker-only");

    const missing = spawnSync(
      process.execPath,
      [SCRIPT, "--provider", "xai", "--env", emptyEnv],
      {
        cwd: ROOT,
        env: keylessEnv({ NAVI_PROVIDER_COMPAT_CONTAINER: "1" }),
        encoding: "utf8",
      },
    );
    expect(missing.status).toBe(1);
    const artifact = JSON.parse(missing.stdout);
    expect(artifact.schema_version).toBe("navi.provider-compat.v7");
    expect(artifact.attempts_required).toBe(2);
    expect(artifact.provider_order).toEqual(["xai"]);
    expect(artifact.results).toHaveLength(5);
    expect(
      artifact.results.every((row: { status: string }) => row.status === "NOT_TESTED"),
    ).toBe(true);
    expect(
      artifact.results.every((row: Record<string, unknown>) => hasOnlyResultFields(row)),
    ).toBe(true);
    expect(missing.stderr).toContain("xai: NOT_TESTED (missing XAI_API_KEY)");
    expect(missing.stdout).not.toContain("key_present");
    expect(missing.stdout).not.toContain("reason");
    expect(missing.stdout).not.toContain("prompt");
    expect(missing.stdout).not.toContain("output");
    expect(missing.stdout).not.toContain("secret");

    const removed = spawnSync(process.execPath, [SCRIPT, "--dry-run"], {
      cwd: ROOT,
      env: keylessEnv(),
      encoding: "utf8",
    });
    expect(removed.status).toBe(1);
    expect(removed.stdout).toBe("");
    expect(removed.stderr).toMatch(/unknown option: --dry-run/);
  });

  it("keeps OpenRouter separate and last in the matrix", () => {
    const openrouter = TESTED_MODELS.providers.at(-1);
    expect(PROVIDERS.at(-1)?.provider).toBe("openrouter");
    expect(openrouter?.classification).toBe("separate");
    expect(PROVIDERS.at(-1)?.models).toEqual(openrouter?.models);
    expect(PROVIDERS.find((provider) => provider.provider === "openai")?.metadataHost).toBe(
      "api.openai.com",
    );
    expect(PROVIDERS.find((provider) => provider.provider === "openrouter")?.metadataHost).toBe(
      "openrouter.ai",
    );
  });

  it("measures the Docker runner that supplies quick-lane retrieval", () => {
    const runnerPath = join(ROOT, "docker", "provider-compat", "run.sh");
    const runner = readFileSync(runnerPath, "utf8");
    const installLine = runner
      .split(/\r?\n/)
      .find((line) => line.includes("apt-get install"));

    expect(MEASUREMENT_DIGEST_INPUTS).toContain("docker/provider-compat/run.sh");
    expect(MEASUREMENT_DIGEST_INPUTS).toContain("config/tested-models.json");
    expect(installLine).toContain("ripgrep");
    expect(runner).toContain('"$REPO/config/tested-models.json"');
    expect(runner).toContain("provider credential trust boundary");
    expect(runner).toContain('docker exec \\\n  --env-file "$ENV_FILE"');
    const containerStart = runner.indexOf("docker run \\");
    const containerReady = runner.indexOf("sleep infinity", containerStart);
    expect(runner.slice(containerStart, containerReady)).not.toContain("--env-file");
    for (const provider of TESTED_MODELS.providers) {
      for (const key of provider.env_keys) expect(runner).toContain(`"${key}"`);
    }
  });

  it("derives every compatibility target from the open-runtime manifest", () => {
    expect(TESTED_MODELS.runtime).toMatchObject({
      selector: "NAVI_MODEL",
      format: "provider/model",
      policy: "open",
      default_provider: "deepseek",
    });
    expect(TESTED_MODELS.providers.map(({ id }) => id)).toEqual([
      "deepseek",
      "openai",
      "anthropic",
      "google",
      "xai",
      "openrouter",
    ]);
    const runtimeDefault = TESTED_MODELS.providers.find(
      ({ id }: { id: string }) => id === TESTED_MODELS.runtime.default_provider,
    );
    expect(DEFAULT_MODEL).toBe(runtimeDefault?.models.quick);
    expect(DEFAULT_WORKFLOW_MODEL).toBe(runtimeDefault?.models.workflow);
    expect(PROVIDERS).toEqual(
      TESTED_MODELS.providers.map(
        (entry: {
          id: string;
          lab: string;
          classification: string;
          router_prefix: string;
          models: { quick: string; workflow: string };
          catalog_url: string;
          model_urls: { quick: string; workflow: string };
          env_keys: string[];
          compatibility: { metadata_host: string; list_path: string; auth: string };
        }) => {
          const trust = PROVIDER_TRUST[entry.id as keyof typeof PROVIDER_TRUST];
          return {
            provider: entry.id,
            lab: entry.lab,
            classification: trust.classification,
            modelPrefix: entry.router_prefix,
            models: entry.models,
            catalogUrl: entry.catalog_url,
            modelUrls: entry.model_urls,
            metadataHost: trust.metadataHost,
            keyNames: trust.keyNames,
            listPath: trust.listPath,
            auth: trust.auth,
          };
        },
      ),
    );
  });

  it("keeps model targets editable without letting the manifest redirect credentials", () => {
    const changedHost = structuredClone(TESTED_MODELS);
    changedHost.providers[0].compatibility.metadata_host = "attacker.invalid";
    expect(() => validateTestedModelManifest(changedHost)).toThrow(
      /credential trust boundary/,
    );

    const changedKey = structuredClone(TESTED_MODELS);
    changedKey.providers[0].env_keys = ["DATABASE_PASSWORD"];
    expect(() => validateTestedModelManifest(changedKey)).toThrow(
      /credential trust boundary/,
    );

    const missingProvider = structuredClone(TESTED_MODELS);
    missingProvider.providers = missingProvider.providers.slice(1);
    expect(() => validateTestedModelManifest(missingProvider)).toThrow(
      /must contain exactly/,
    );
  });

  it("validates argument bounds and emits an exact redacted result shape", () => {
    expect(parseArgs([]).attempts).toBe(2);
    expect(() => parseArgs(["--attempts", "0"])).toThrow(/--attempts/);
    expect(() => parseArgs(["--timeout-ms", "999"])).toThrow(/--timeout-ms/);
    expect(() => parseArgs(["--dry-run"])).toThrow(/unknown option/);
    const localRows = notTestedRows([PROVIDERS[0]!]);
    const rows = compatibilityArtifact(
      [PROVIDERS[0]!],
      localRows,
      2,
      "2026-07-27T00:00:00.000Z",
    ).results;
    expect(rows.every(hasOnlyResultFields)).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "provider",
        "model",
        "lane",
        "metadata_host",
        "status",
        "attempts",
        "model_listed",
        "provider_catalog_verified",
        "metadata_host_verified",
        "timing",
      ].sort(),
    );
  });

  it("refuses a model override that would put a provider on another gateway", () => {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--list", "--provider", "xai", "--env", "/dev/null"],
      {
        cwd: ROOT,
        env: keylessEnv({ NAVI_COMPAT_XAI_WORKFLOW_MODEL: "openrouter/x-ai/grok-4.5" }),
        encoding: "utf8",
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/must start with xai\//);
    expect(run.stdout).toBe("");
  });

  it("normalizes first-party model-list shapes without retaining response bodies", () => {
    const xai = PROVIDERS.find((provider) => provider.provider === "xai")!;
    const google = PROVIDERS.find((provider) => provider.provider === "google")!;
    expect([...modelIdsFromList(xai, { data: [{ id: "grok-4.5" }] })]).toEqual([
      "grok-4.5",
    ]);
    expect([
      ...modelIdsFromList(google, {
        models: [{ name: "models/gemini-3.5-flash-lite" }],
      }),
    ]).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("pins every provider prefix and key mapping to the installed Mastra adapter catalog", () => {
    expect(PROVIDERS.every((provider) => verifyProviderCatalog(provider))).toBe(true);
    const xai = PROVIDERS.find((provider) => provider.provider === "xai")!;
    expect(
      verifyProviderCatalog(xai, {
        gateway: "models.dev",
        apiKeyEnvVar: "XAI_API_KEY",
        models: [],
      }),
    ).toBe(true);
    expect(
      verifyProviderCatalog(
        { ...xai, modelPrefix: "openrouter/" },
        {
          gateway: "models.dev",
          apiKeyEnvVar: "XAI_API_KEY",
          models: ["grok-4.5"],
        },
      ),
    ).toBe(false);
  });

  it("keeps Founder, Founder advice, and sharpen portable without dropping DeepSeek defaults", () => {
    const entry = join(ROOT, "bin", "navi.mjs");
    for (const flow of ["founder", "founder-advice", "sharpen"]) {
      const anthropic = spawnSync(
        process.execPath,
        [entry, "run", flow, "--shape", "--json", "--progress", "off"],
        {
          cwd: ROOT,
          env: keylessEnv({
            HOME: TEMP,
            NAVI_DB: `file:${join(TEMP, `${flow}-anthropic.db`)}`,
            NAVI_MODEL: "anthropic/claude-sonnet-5",
          }),
          encoding: "utf8",
        },
      );
      expect(anthropic.status, anthropic.stderr).toBe(0);
      const anthropicShape = JSON.parse(anthropic.stdout);
      expect(
        anthropicShape.lint.some(
          (finding: { level: string; message: string }) =>
            finding.level === "error" && finding.message.includes("DeepSeek-only"),
        ),
      ).toBe(false);
      expect(
        anthropicShape.steps
          .filter((step: { type: string }) => step.type === "agent")
          .every((step: { settings: Record<string, unknown> }) =>
            Object.keys(step.settings).length === 0,
          ),
      ).toBe(true);

      const deepseek = spawnSync(
        process.execPath,
        [entry, "run", flow, "--shape", "--json", "--progress", "off"],
        {
          cwd: ROOT,
          env: keylessEnv({
            HOME: TEMP,
            NAVI_DB: `file:${join(TEMP, `${flow}-deepseek.db`)}`,
            NAVI_MODEL: "deepseek/deepseek-v4-pro",
          }),
          encoding: "utf8",
        },
      );
      expect(deepseek.status, deepseek.stderr).toBe(0);
      const deepseekShape = JSON.parse(deepseek.stdout);
      expect(
        deepseekShape.steps
          .filter((step: { type: string }) => step.type === "agent")
          .every(
            (step: { settings: Record<string, unknown> }) =>
              step.settings.temperature === 0 && step.settings.thinking === "enabled",
          ),
      ).toBe(true);
    }
  });

  it("passes an unlisted Mastra-routed model through instead of enforcing the test manifest", () => {
    const model = "openai/gpt-navi-unlisted-pass-through";
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, "bin", "navi.mjs"),
        "run",
        "founder",
        "--shape",
        "--json",
        "--progress",
        "off",
      ],
      {
        cwd: ROOT,
        env: keylessEnv({
          HOME: TEMP,
          NAVI_DB: `file:${join(TEMP, "unlisted-model.db")}`,
          NAVI_MODEL: model,
        }),
        encoding: "utf8",
      },
    );

    expect(run.status, run.stderr).toBe(0);
    const shape = JSON.parse(run.stdout);
    expect(
      shape.steps
        .filter((step: { type: string }) => step.type === "agent")
        .map((step: { model: string }) => step.model),
    ).toEqual([model]);
  });

  it("requires code review to find the planted line-2 first-vs-second defect", () => {
    const finding = {
      file: "src/review-target.js",
      line: 2,
      severity: "high",
      category: "off-by-one",
      summary: "first() returns the second item because it uses at(1), not at(0).",
    };
    expect(hasExpectedCodeReviewFinding({ summary: "Found one defect.", findings: [finding] })).toBe(
      true,
    );
    expect(hasExpectedCodeReviewFinding({ summary: "Clear.", findings: [] })).toBe(false);
    expect(
      hasExpectedCodeReviewFinding({
        summary: "Unrelated.",
        findings: [{ ...finding, file: "src/other.js" }],
      }),
    ).toBe(false);
    expect(
      hasExpectedCodeReviewFinding({
        summary: "Wrong line.",
        findings: [{ ...finding, line: 1 }],
      }),
    ).toBe(false);
  });

  it("requires a schema-valid Founder verdict grounded on the exact release-brief marker", () => {
    const nonce = "navi-provider-founder-unit-test";
    const verdict = {
      verdict: "GO",
      take: "Ship after the compatibility matrix passes.",
      grounding_points: [
        `docs/release-brief.md carries compatibility marker ${nonce}.`,
      ],
      decision_rules: ["Measured compatibility precedes release."],
      what_not_to_do: ["Do not infer compatibility from model metadata."],
    };

    expect(validFounderResult(verdict)).toBe(true);
    expect(hasExactFounderGrounding(verdict, nonce)).toBe(true);
    expect(hasFounderReadRouteEvidence(verdict, ["view"], nonce)).toBe(true);
    expect(hasFounderReadRouteEvidence(verdict, ["search_content"], nonce)).toBe(false);
    expect(
      hasFounderReadRouteEvidence(
        {
          ...verdict,
          grounding_points: [`src/nonce.txt carries ${nonce}.`],
        },
        ["view"],
        nonce,
      ),
    ).toBe(false);
    expect(hasExactFounderGrounding(verdict, `${nonce}-wrong`)).toBe(false);
    expect(validFounderResult({ ...verdict, verdict: "CLEAR" })).toBe(false);
  });

  it("creates a fresh project, nonce, HOME, and database path for every attempt", () => {
    const first = initializeAttemptRuntime("xai", "deep");
    const second = initializeAttemptRuntime("xai", "deep");
    try {
      expect(first.scratch).not.toBe(second.scratch);
      expect(first.project).not.toBe(second.project);
      expect(first.home).not.toBe(second.home);
      expect(first.db).not.toBe(second.db);
      expect(first.nonce).not.toBe(second.nonce);
      expect(first.founderNonce).not.toBe(second.founderNonce);
      expect(first.founderNonce).not.toBe(first.nonce);
      expect(readFileSync(join(first.project, "src", "nonce.txt"), "utf8").trim()).toBe(first.nonce);
      expect(readFileSync(join(second.project, "src", "nonce.txt"), "utf8").trim()).toBe(
        second.nonce,
      );
      expect(
        readFileSync(join(first.project, "docs", "release-brief.md"), "utf8"),
      ).toContain(first.founderNonce);
      expect(
        readFileSync(join(second.project, "docs", "release-brief.md"), "utf8"),
      ).toContain(second.founderNonce);
      expect(existsSync(first.db)).toBe(false);
      expect(existsSync(second.db)).toBe(false);
    } finally {
      rmSync(first.scratch, { recursive: true, force: true });
      rmSync(second.scratch, { recursive: true, force: true });
    }
  });

  it("hashes tracked release inputs without absorbing ignored local ledgers", () => {
    const root = mkdtempSync(join(TEMP, "tracked-digest-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "runtime.ts"), "export const value = 1;\n");
    writeFileSync(join(root, ".gitignore"), "*.db\n");
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", ".gitignore", "src/runtime.ts"]).status).toBe(0);

    const before = digestTrackedInputs(["src"], root);
    writeFileSync(join(root, "src", "navi.db"), "local ledger bytes");
    expect(digestTrackedInputs(["src"], root)).toBe(before);

    writeFileSync(join(root, "src", "runtime.ts"), "export const value = 2;\n");
    expect(digestTrackedInputs(["src"], root)).not.toBe(before);
  });

  it("orders evidence paths by code point instead of the host locale", () => {
    const root = mkdtempSync(join(TEMP, "portable-digest-"));
    mkdirSync(join(root, "builtin", "skill", "doctrine"), { recursive: true });
    writeFileSync(join(root, "builtin", "skill", "SKILL.md"), "skill\n");
    writeFileSync(
      join(root, "builtin", "skill", "doctrine", "promotion.md"),
      "promotion\n",
    );
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    expect(git(["add", "builtin"]).status).toBe(0);
    chmodSync(join(root, "builtin", "skill", "SKILL.md"), 0o777);

    const names = [
      "builtin/skill/SKILL.md",
      "builtin/skill/doctrine/promotion.md",
    ].sort();
    const hash = createHash("sha256");
    for (const name of names) {
      const path = join(root, name);
      const bytes = readFileSync(path);
      hash.update(
        `${JSON.stringify({
          name,
          type: "file",
          mode: 0o644,
          size: bytes.length,
        })}\n`,
      );
      hash.update(bytes);
      hash.update("\n");
    }

    expect(digestTrackedInputs(["builtin"], root)).toBe(hash.digest("hex"));
  });

  it("initializes the fixture without inheriting parent credentials or Git hooks", () => {
    const scratch = mkdtempSync(join(TEMP, "hostile-git-"));
    const hooks = join(scratch, "hooks");
    const marker = join(scratch, "hook-ran");
    const globalConfig = join(scratch, "global.gitconfig");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf '%s' \"$GITHUB_TOKEN\" > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);

    const runtime = initializeAttemptRuntime("xai", "quick", {
      PATH: process.env.PATH!,
      GIT_CONFIG_GLOBAL: globalConfig,
      GITHUB_TOKEN: "must-not-reach-hook",
      NODE_OPTIONS: "--require=/tmp/intercept.cjs",
    });
    try {
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(runtime.project, ".git"))).toBe(true);
    } finally {
      rmSync(runtime.scratch, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("requires every requested attempt to pass and keeps each duration auditable", () => {
    const summary = summarizeAttempts([
      { ok: true, blockReason: null, durationMs: 101 },
      { ok: false, blockReason: null, durationMs: 202 },
    ]);
    expect(summary).toEqual({
      passed: false,
      status: "FAIL",
      reason: null,
      attemptMs: [101, 202],
    });
  });

  it("records upstream account blocks separately from compatibility failures", () => {
    expect(upstreamBlockReason("error code: insufficient_quota")).toBe("account_quota");
    expect(upstreamBlockReason("RATE_LIMIT: try later")).toBe("rate_limit");
    expect(upstreamBlockReason("invalid_api_key")).toBe("authentication");
    expect(upstreamBlockReason("schema validation failed")).toBeNull();
    expect(
      summarizeAttempts([
        {
          ok: false,
          blockReason: "account_quota",
          durationMs: 10,
        },
        {
          ok: false,
          blockReason: "account_quota",
          durationMs: 20,
        },
      ]),
    ).toMatchObject({
      passed: false,
      status: "BLOCKED",
      reason: "account_quota",
    });
    expect(
      summarizeAttempts(
        [
          {
            ok: false,
            blockReason: "authentication",
            durationMs: 10,
          },
          {
            ok: false,
            blockReason: "authentication",
            durationMs: 20,
          },
        ],
        true,
      ),
    ).toMatchObject({
      passed: false,
      status: "FAIL",
      reason: null,
    });
  });

  it("validates a complete artifact and keeps its shape strictly redacted", () => {
    const artifact = completeArtifactFixture();
    const raw = JSON.stringify(artifact);
    const expectedProviders = PROVIDERS.map((provider) => provider.provider);
    const expectedPairs = expectedProviders.flatMap((provider) =>
      ["quick", "deep", "structured", "founder", "code-review"].map(
        (lane) => `${provider}/${lane}`,
      ),
    );

    expect(artifactValidationErrors(artifact, raw)).toEqual([]);
    expect(artifact.schema_version).toBe("navi.provider-compat.v7");
    expect(Number.isNaN(Date.parse(artifact.tested_at))).toBe(false);
    expect(artifact.attempts_required).toBe(2);
    expect(artifact.lanes).toEqual([
      "quick",
      "deep",
      "structured",
      "founder",
      "code-review",
    ]);
    expect(artifact.provider_order).toEqual(expectedProviders);
    expect(artifact.provider_order.at(-1)).toBe("openrouter");
    expect(artifact.results.map((row) => `${row.provider}/${row.lane}`)).toEqual(expectedPairs);
    expect(new Set(artifact.results.map((row) => `${row.provider}/${row.lane}`)).size).toBe(
      expectedPairs.length,
    );

    for (const row of artifact.results) {
      expect(hasOnlyResultFields(row)).toBe(true);
      expect(row).not.toHaveProperty("key_present");
      expect(row).not.toHaveProperty("reason");
      expect(["PASS", "FAIL", "BLOCKED", "NOT_TESTED"]).toContain(row.status);
    }

    expect(artifact.evidence.versions.node).toMatch(/^v\d+\./);
    expect(artifact.evidence.git.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof artifact.evidence.git.dirty).toBe("boolean");
    expect(raw).not.toMatch(/(?:api[_-]?key|token|secret)"?\s*[:=]\s*"[^"]+/i);
    expect(raw).not.toContain("key_present");
    expect(raw).not.toContain("account_quota");
    expect(raw).not.toContain("rate_limit");

    const localRows = notTestedRows(PROVIDERS) as MeasurementRow[];
    for (const row of localRows.filter((entry) => entry.provider === "openai")) {
      row.status = "BLOCKED";
      row.attempts = 2;
      row.key_present = true;
      row.reason = "account_quota";
    }
    const publicArtifact = compatibilityArtifact(
      PROVIDERS,
      localRows,
      2,
      "2026-07-27T00:00:00.000Z",
    ) as CheckedArtifact;
    const publicRaw = JSON.stringify(publicArtifact);
    expect(publicRaw).not.toContain("key_present");
    expect(publicRaw).not.toContain("account_quota");
    expect(publicArtifact.results.every(hasOnlyResultFields)).toBe(true);

    const leakedReason = structuredClone(artifact);
    leakedReason.note = "local result: account_quota";
    expect(
      artifactValidationErrors(leakedReason, JSON.stringify(leakedReason)),
    ).toContain("artifact contains local provider failure details");

    const leakedPresence = structuredClone(artifact) as CheckedArtifact & {
      results: Array<ArtifactRow & { key_present?: boolean }>;
    };
    leakedPresence.results[0]!.key_present = true;
    expect(
      artifactValidationErrors(leakedPresence, JSON.stringify(leakedPresence)),
    ).toContain("artifact contains local credential-presence evidence");
  });

  it("verifies release-artifact freshness and completeness", () => {
    const clean = completeArtifactFixture();
    const current = { digests: structuredClone(clean.evidence.digests) };

    expect(releaseArtifactErrors(clean, JSON.stringify(clean), current, true)).toEqual([]);

    const dirty = structuredClone(clean);
    dirty.evidence.git.dirty = true;
    expect(releaseArtifactErrors(dirty, JSON.stringify(dirty), current, true)).toContain(
      "artifact was measured from a dirty worktree",
    );

    const stale = {
      digests: {
        ...current.digests,
        runtime_source: "0".repeat(64),
      },
    };
    expect(releaseArtifactErrors(clean, JSON.stringify(clean), stale, true)).toContain(
      "artifact source or harness digest does not match the current tree",
    );
    expect(releaseArtifactErrors(clean, JSON.stringify(clean), current, false)).toContain(
      "artifact revision is not an ancestor of HEAD",
    );

    const incomplete = structuredClone(clean);
    incomplete.results[0]!.status = "NOT_TESTED";
    expect(
      releaseArtifactErrors(incomplete, JSON.stringify(incomplete), current, true),
    ).toContain("artifact contains NOT_TESTED rows");

    const failed = structuredClone(clean);
    failed.results[0]!.status = "FAIL";
    expect(
      releaseArtifactErrors(failed, JSON.stringify(failed), current, true),
    ).toContain("artifact contains compatibility failures");
  });

  it("accepts a measured upstream block and rejects incomplete blocked rows", () => {
    const clean = completeArtifactFixture();
    const current = { digests: structuredClone(clean.evidence.digests) };
    const openaiBlocked = structuredClone(clean);
    for (const row of openaiBlocked.results.filter((entry) => entry.provider === "openai")) {
      row.status = "BLOCKED";
    }
    expect(artifactValidationErrors(openaiBlocked, JSON.stringify(openaiBlocked))).toEqual([]);
    expect(
      releaseArtifactErrors(openaiBlocked, JSON.stringify(openaiBlocked), current, true),
    ).toEqual([]);

    const malformed = structuredClone(clean);
    for (const row of malformed.results) {
      row.status = "BLOCKED";
      row.attempts = 0;
      row.model_listed = false;
      row.provider_catalog_verified = false;
      row.metadata_host_verified = false;
      row.timing = { started_at: null, duration_ms: 0, attempt_ms: [] };
    }
    const malformedErrors = artifactValidationErrors(malformed, JSON.stringify(malformed));
    expect(malformedErrors).toContain("result 0 did not complete every required attempt");
    expect(malformedErrors).toContain(
      "result 0 is missing provider evidence required for an exercised lane",
    );
    expect(
      releaseArtifactErrors(malformed, JSON.stringify(malformed), current, true),
    ).toContain("artifact contains no direct provider with a complete PASS matrix");
  });
});
