import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

type PackedFile = {
  path: string;
  size: number;
  mode: number;
};

type PackResult = {
  name: string;
  filename: string;
  size: number;
  entryCount: number;
  files: PackedFile[];
};

const ROOT = process.cwd();
const SCRATCH = mkdtempSync(join(tmpdir(), "navi-package-"));
const DISALLOWED_TOP_LEVEL =
  /^(?:\.agents|\.claude|\.navi|docker|docs|experiments|external|scripts|skills|tests|node_modules)(?:\/|$)/;
const DISALLOWED_ARTIFACT =
  /(?:^|\/)(?:\.env(?!\.example$)(?:\..*)?|navi\.db(?:[-.].*)?|package-lock\.json|bun\.lock|skills-lock\.json|tsconfig\.json|vitest\.config\.ts)$/;
let packed: PackResult;
let publishWarnings = "";

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

beforeAll(() => {
  const result = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", SCRATCH],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  packed = (JSON.parse(result.stdout) as PackResult[])[0]!;

  const publish = spawnSync(
    "npm",
    // A release test must remain valid after the version exists on npm.
    // `--force` affects only this dry-run: npm still builds and validates the
    // publication payload, but does not reject it as an attempted overwrite.
    ["publish", "--dry-run", "--json", "--ignore-scripts", "--force"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(publish.status, publish.stderr).toBe(0);
  publishWarnings = publish.stderr;
});

function filesUnder(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [relative(ROOT, path).split(sep).join("/")];
    });
  return walk(join(ROOT, root)).sort();
}

describe("npm package — the tarball is the product boundary", () => {
  it("uses the releasable scoped identity and a Node-only runtime contract", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      engines: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      publishConfig: Record<string, string>;
    };
    expect(packed.name).toBe("@machinepath/navi");
    expect(manifest).toMatchObject({
      name: "@machinepath/navi",
      bin: {
        navi: "bin/navi.mjs",
        "navi-cli": "bin/navi.mjs",
      },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
    });
    expect(manifest.dependencies.tsx).toBeDefined();
    expect(manifest.devDependencies.tsx).toBeUndefined();
    expect(publishWarnings).not.toMatch(/auto-corrected|invalid and removed/i);
  });

  it("stays below the size and file-count ceilings", () => {
    expect(packed.size).toBeLessThan(1_000_000);
    expect(packed.entryCount).toBeLessThan(100);
  });

  it("contains every runtime source and builtin", () => {
    const paths = packed.files.map(({ path }) => path).sort();
    const expected = [...filesUnder("src"), ...filesUnder("builtin"), ...filesUnder("agent")]
      .filter((path) => !DISALLOWED_ARTIFACT.test(path))
      .sort();
    expect(
      paths.filter(
        (path) =>
          path.startsWith("src/") ||
          path.startsWith("builtin/") ||
          path.startsWith("agent/"),
      ),
    ).toEqual(expected);
  });

  it("contains the Node entry, package metadata, interop skill, schemas, and command parsers", () => {
    const paths = packed.files.map(({ path }) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        ".env.example",
        "README.md",
        "LICENSE",
        "bin/navi.mjs",
        "bin/navi-local",
        "config/tested-models.json",
        "agent/skills/navi-interop/SKILL.md",
        "builtin/workflows/founder/action.yaml",
        "builtin/workflows/founder/verdict.schema.ts",
        "builtin/workflows/founder/parse-verdict.mjs",
      ]),
    );
    expect(paths.filter((path) => path.endsWith("/navi-interop/SKILL.md"))).toEqual([
      "agent/skills/navi-interop/SKILL.md",
    ]);
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).not.toMatch(
      /(?:API_KEY|AUTH_TOKEN|SECRET)=\S+/,
    );
    const packagedReadme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(packagedReadme).toContain(
      "npm install --save-dev @machinepath/navi",
    );
    expect(packagedReadme).toContain("npx --no-install navi-cli");
    expect(packagedReadme).not.toMatch(/\bnpx navi-cli\b/);
    expect(
      JSON.parse(readFileSync(join(ROOT, "config", "tested-models.json"), "utf8")),
    ).toMatchObject({
      schema_version: "navi.tested-models.v1",
      runtime: { selector: "NAVI_MODEL", policy: "open" },
    });
    const interop = readFileSync(
      join(ROOT, "agent/skills/navi-interop/SKILL.md"),
      "utf8",
    );
    expect(interop).toContain(
      "npm exec --offline --package=@machinepath/navi -- navi-cli",
    );
    expect(interop.indexOf("<repo>/node_modules/.bin/navi-cli")).toBeLessThan(
      interop.indexOf("resolves on `PATH`"),
    );
    expect(interop).toMatch(/navi check \\\n\s+"Task:/);
    expect(interop).not.toMatch(
      /Open one edge-walk session|navi run edge-walk --json --stdin -w/,
    );
  });

  it("ships no development tree, private environment file, database, or lock", () => {
    const paths = packed.files.map(({ path }) => path);
    expect(
      paths.filter(
        (path) => DISALLOWED_TOP_LEVEL.test(path) || DISALLOWED_ARTIFACT.test(path),
      ),
    ).toEqual([]);
  });

  it("has no top-level files outside the explicit package surface", () => {
    const allowed = packed.files.filter(
      ({ path }) =>
        path === "package.json" ||
        path === ".env.example" ||
        path === "README.md" ||
        path === "LICENSE" ||
        path === "bin/navi.mjs" ||
        path === "bin/navi-local" ||
        path === "config/tested-models.json" ||
        path.startsWith("src/") ||
        path.startsWith("builtin/") ||
        path.startsWith("agent/"),
    );
    expect(allowed).toHaveLength(packed.files.length);
  });

  it("packs executable canonical and local launchers and leaves the tarball outside the checkout", () => {
    const entry = packed.files.find(({ path }) => path === "bin/navi.mjs");
    const local = packed.files.find(({ path }) => path === "bin/navi-local");
    expect((entry?.mode ?? 0) & 0o111).not.toBe(0);
    expect((local?.mode ?? 0) & 0o111).not.toBe(0);
    expect(readFileSync(join(ROOT, "bin/navi.mjs"), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(readFileSync(join(ROOT, "bin/navi-local"), "utf8")).toMatch(/^#!\/bin\/sh\n/);
    expect(existsSync(join(SCRATCH, packed.filename))).toBe(true);
    expect(existsSync(join(ROOT, packed.filename))).toBe(false);
  });

  it("keeps credentialed cold-start runs on local Docker", () => {
    const runner = join(ROOT, "docker", "coldstart", "run.sh");
    const source = readFileSync(runner, "utf8");
    const hosted = spawnSync("bash", [runner, "--live"], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_ACTIONS: "true" },
      encoding: "utf8",
    });

    expect(hosted.status).toBe(1);
    expect(hosted.stderr).toContain("local-only and refuses GitHub Actions");
    expect(source).toContain("refusing non-local DOCKER_HOST");
    expect(source).not.toContain("export XAI_API_KEY");
    expect(source).toContain('--name "$LIVE_CONTAINER"');
    expect(source).toContain("--entrypoint bash");
    expect(source).toContain("/home/navi/live-check.sh");
    expect(source).not.toMatch(/RUN_ARGS=.*env-file/);
    expect(source).toContain('rm -f "$RUNTIME_ENV_FILE"');
    expect(source.indexOf("docker buildx build")).toBeLessThan(
      source.indexOf("RUNTIME_ENV_FILE=$(mktemp"),
    );
    expect(source.indexOf("local-checks.sh")).toBeLessThan(
      source.indexOf("RUNTIME_ENV_FILE=$(mktemp"),
    );
  });

  it("uses a recursive Docker-context denylist before the exact cold-start allowlist", () => {
    const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const included = dockerignore.filter((line) => line.startsWith("!"));
    const expectedIncludes = [
      "!package.json",
      "!README.md",
      "!LICENSE",
      "!.env.example",
      "!bin/",
      "!bin/**/*.mjs",
      "!bin/navi-local",
      "!src/",
      "!src/**/*.ts",
      "!builtin/",
      "!builtin/**/*.md",
      "!builtin/**/*.yaml",
      "!builtin/**/*.mjs",
      "!builtin/**/*.ts",
      "!agent/",
      "!agent/skills/",
      "!agent/skills/**/*.md",
      "!config/",
      "!config/tested-models.json",
      "!docker/",
      "!docker/coldstart/",
      "!docker/coldstart/Dockerfile",
      "!docker/coldstart/checks.sh",
      "!docker/coldstart/live-check.sh",
    ];

    expect(dockerignore[0]).toBe("**");
    expect(included).toEqual(expectedIncludes);
    expect(included).toContain("!docker/coldstart/Dockerfile");
    expect(included).toContain("!docker/coldstart/checks.sh");
    expect(included).toContain("!docker/coldstart/live-check.sh");
    expect(included).toContain("!config/tested-models.json");
    for (const secret of [
      "!.env",
      "!docker/coldstart/.env",
      "!.git/",
      "!.agents/",
      "!.claude/",
    ]) {
      expect(included).not.toContain(secret);
    }
  });
});
