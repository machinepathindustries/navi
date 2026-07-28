#!/usr/bin/env node
/**
 * Reproduce the public-documentation release gate locally.
 *
 * This intentionally invokes only repository checks and Mintlify's local CLI.
 * It does not call GitHub Actions, deploy anything, or use provider credentials.
 *
 *   node scripts/docs-release-check.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCS = resolve(ROOT, "docs/mintlify");
const MINT_CLI = "mint@4.2.746";

const checks = [
  {
    name: "TypeScript, control-flow, and citation walls",
    command: "npm",
    args: ["run", "typecheck"],
    cwd: ROOT,
  },
  {
    name: "Test suite",
    command: "npm",
    args: ["test"],
    cwd: ROOT,
  },
  {
    name: "Mintlify validation",
    command: "npx",
    args: ["--yes", MINT_CLI, "validate"],
    cwd: DOCS,
  },
  {
    name: "Mintlify links, anchors, and redirects",
    command: "npx",
    args: ["--yes", MINT_CLI, "broken-links", "--check-anchors", "--check-redirects"],
    cwd: DOCS,
  },
  {
    name: "Mintlify accessibility",
    command: "npx",
    args: ["--yes", MINT_CLI, "a11y"],
    cwd: DOCS,
  },
];

for (const check of checks) {
  process.stdout.write(`\n==> ${check.name}\n`);
  const result = spawnSync(check.command, check.args, {
    cwd: check.cwd,
    env: { ...process.env, MINTLIFY_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`${check.name}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`${check.name}: failed with exit ${result.status ?? "unknown"}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\nDocs release checks passed.\n");
