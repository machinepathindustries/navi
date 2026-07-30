import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedPaths(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
  });
  expect(result.status, result.stderr.toString("utf8")).toBe(0);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function trackedText(paths: string[]): Array<{ path: string; text: string }> {
  return paths.flatMap((path) => {
    const absolute = join(ROOT, path);
    if (!existsSync(absolute)) return [];
    if (!lstatSync(absolute).isFile()) return [];
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) return [];
    return [{ path, text: bytes.toString("utf8") }];
  });
}

const paths = trackedPaths();
const textFiles = trackedText(paths);
const releaseTextFiles = textFiles.filter(
  ({ path }) =>
    path !== "tests/release-surface.test.ts" &&
    (["src/", "builtin/", "scripts/", "tests/", "agent/", "docs/mintlify/"].some(
      (prefix) => path.startsWith(prefix),
    ) ||
      ["README.md", "CONTRIBUTING.md", "docs/README.md"].includes(path)),
);

describe("public release surface", () => {
  it("tracks no private development tree or generated result", () => {
    const forbiddenPrefixes = [
      ".agents/",
      ".claude/",
      ".navi/",
      "docs/research/",
      "experiments/",
      "skills/",
      "tests/dialog/",
      "tests/repeat/",
      ".github/workflows/",
    ];
    const forbiddenNames = new Set(["CLAUDE.md", "skills-lock.json"]);
    const allowedPaths = new Set([".github/workflows/test.yml"]);
    const violations = paths.filter(
      (path) =>
        !allowedPaths.has(path) &&
        (forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
          forbiddenNames.has(path) ||
          path.endsWith(".runlog.txt") ||
          path.includes("/results/")),
    );

    expect(violations).toEqual([]);
  });

  it("contains no private path, project name, email, key, or high-confidence token", () => {
    const fragments = [
      ["/", "Users/"],
      [".clau", "de/jobs"],
      ["on", "script"],
      ["ber", "castle"],
      ["mark", "berry"],
    ].map((parts) => parts.join(""));
    const privateKey = new RegExp(
      `${"-".repeat(5)}BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?${"-".repeat(5)}`,
      "i",
    );
    const tokenPatterns = [
      /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
      /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
      /\bsk-svcacct-[A-Za-z0-9_-]{20,}\b/,
      /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}\b/,
      /\bsk-or-v1-[A-Fa-f0-9]{64}\b/,
      /\bAIza[A-Za-z0-9_-]{35}\b/,
      /\bxai-[A-Za-z0-9_-]{20,}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
      /\bglpat-[A-Za-z0-9_-]{20,}\b/,
      /\bhf_[A-Za-z0-9]{34,}\b/,
      /\bnpm_[A-Za-z0-9]{36}\b/,
      /\bsk_live_[A-Za-z0-9]{20,}\b/,
      /\b[A-Za-z0-9._%+-]+@gmail\.com\b/i,
    ];
    const violations = textFiles.flatMap(({ path, text }) => {
      const names = fragments.filter((fragment) =>
        text.toLowerCase().includes(fragment.toLowerCase()),
      );
      const secrets = [
        ...(privateKey.test(text) ? ["private key"] : []),
        ...tokenPatterns.flatMap((pattern) => (pattern.test(text) ? [pattern.source] : [])),
      ];
      return [...names, ...secrets].map((match) => ({ path, match }));
    });

    expect(violations).toEqual([]);
  });

  it("contains no internal development archaeology in release source", () => {
    const patterns = [
      /§\d/,
      /\bP0\b/,
      /\b(?:phase|wave)[ -]?\d+\b/i,
    ];
    const violations = releaseTextFiles.flatMap(({ path, text }) =>
      patterns.flatMap((pattern) =>
        pattern.test(text) ? [{ path, match: pattern.source }] : [],
      ),
    );

    expect(violations).toEqual([]);
  });

  it("tracks no file larger than one MiB", () => {
    const violations = paths
      .filter((path) => existsSync(join(ROOT, path)))
      .map((path) => ({ path, size: lstatSync(join(ROOT, path)).size }))
      .filter(({ size }) => size > 1024 * 1024);

    expect(violations).toEqual([]);
  });

  it("leaves the package dry-run and boundary audit in tests/package.test.ts only", () => {
    const packageAudit = /spawnSync\(\s*"npm",\s*\[\s*"(?:pack|publish)"/s;
    const owners = textFiles
      .filter(({ path, text }) => path.endsWith(".test.ts") && packageAudit.test(text))
      .map(({ path }) => path);
    const source = readFileSync(join(ROOT, "tests/package.test.ts"), "utf8");

    expect(owners).toEqual(["tests/package.test.ts"]);
    expect(source).toContain("DISALLOWED_TOP_LEVEL");
    expect(source).toContain("DISALLOWED_ARTIFACT");
    expect(source).toMatch(/\.agents.*\.claude.*\.navi.*docs.*tests/s);
    expect(source).toMatch(/navi\\\.db/);
    expect(source).toMatch(/package-lock\\\.json/);
    expect(source).toMatch(/bun\\\.lock/);
    expect(source).toMatch(/skills-lock\\\.json/);
    expect(source).toMatch(/\\\.env/);
  });
});
