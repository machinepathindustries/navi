import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createWorkspaceTools } from "@mastra/core/workspace";
import { createWorkspace } from "../src/mastra/index.ts";
import {
  pathHasDeniedSegment,
  findGuardViolation,
  escapesWorkspace,
  isContainedIn,
  resolveContainedPath,
  formatResolveErr,
  deniedRgGlobs,
} from "../src/mastra/path-guard.ts";
import { makeMultiSearchTool, makeParallelViewTool } from "../src/search/tools.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("path-guard credential files", () => {
  let base: string;
  const secretNonce = `navi-secret-${process.pid}-${Date.now()}`;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "navi-path-guard-env-"));
    writeFileSync(join(base, ".env"), `NAVI_TEST_CREDENTIAL=${secretNonce}`);
    writeFileSync(join(base, ".env.example"), "NAVI_TEST_CREDENTIAL=public-template");
    writeFileSync(join(base, "policy.ts"), 'export const deniedName = ".env";\n');
    symlinkSync(join(base, ".env"), join(base, "credential-alias"));
    mkdirSync(join(base, "folder with spaces"));
    symlinkSync(
      join(base, ".env"),
      join(base, "folder with spaces", "credential-alias"),
    );
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("denies a harmless-looking path symlink whose target is .env", () => {
    expect(findGuardViolation({ path: "credential-alias" }, base)).toEqual({
      target: "credential-alias",
      kind: "denied",
    });
    const resolved = resolveContainedPath(base, "credential-alias");
    expect(resolved.isErr()).toBe(true);
    expect(resolved.isErr() ? resolved.error.kind : "ok").toBe("denied");
    expect(
      findGuardViolation({ path: "folder with spaces/credential-alias" }, base),
    ).toEqual({
      target: "folder with spaces/credential-alias",
      kind: "denied",
    });
  });

  it("allows the explicit .env.example template through both guard surfaces", () => {
    expect(findGuardViolation({ path: ".env.example" }, base)).toBeUndefined();
    expect(resolveContainedPath(base, ".env.example").isOk()).toBe(true);
  });

  it("allows auditing a sensitive basename while excluding the sensitive file from results", async () => {
    expect(findGuardViolation({ pattern: String.raw`\.env` }, base)).toBeUndefined();
    const tool = makeMultiSearchTool(base);
    const out = await tool.execute!(
      { patterns: [String.raw`\.env`], maxHitsPerPattern: 20 },
      {} as never,
    );
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("policy.ts");
    expect(text).not.toContain(secretNonce);
    expect(text).not.toMatch(/\.env(?:\.[^:\s]+)?:\d+:/i);
  });

  it("blocks Mastra's broad hidden-file grep before it can capture .env", () => {
    expect(
      findGuardViolation(
        { pattern: "NAVI_TEST_CREDENTIAL", path: ".", includeHidden: true },
        base,
        "search_content",
      ),
    ).toEqual({ target: "includeHidden=true", kind: "denied" });
    expect(
      findGuardViolation(
        { pattern: "NAVI_TEST_CREDENTIAL", path: ".", includeHidden: true },
        base,
        "mastra_workspace_grep",
      ),
    ).toEqual({ target: "includeHidden=true", kind: "denied" });
    expect(
      findGuardViolation(
        { pattern: "workflow", path: ".github", includeHidden: false },
        base,
        "search_content",
      ),
    ).toBeUndefined();
    expect(
      findGuardViolation(
        { pattern: "NAVI_TEST_CREDENTIAL", path: ".", includeHidden: true },
        base,
        "multi_search",
      ),
    ).toBeUndefined();
  });

  it("Mastra's native default grep skips .env and still finds visible files", async () => {
    const tools = await createWorkspaceTools(createWorkspace(base, { skills: false }));
    const grep = tools.search_content;
    const hidden = await grep.execute(
      { pattern: "NAVI_TEST_CREDENTIAL", path: ".", includeHidden: false },
      { toolCallId: "hidden-proof", messages: [] },
    );
    const visible = await grep.execute(
      { pattern: "deniedName", path: ".", includeHidden: false },
      { toolCallId: "visible-proof", messages: [] },
    );
    expect(String(hidden)).not.toContain(secretNonce);
    expect(String(hidden)).not.toMatch(/\.env(?:\.[^:\s]+)?:\d+:/i);
    expect(String(visible)).toContain("policy.ts");
  });

  it("excludes .env files before ripgrep captures their contents", async () => {
    const globArgs = deniedRgGlobs();
    expect(globArgs).toContain("--glob-case-insensitive");
    expect(globArgs).toEqual(
      expect.arrayContaining(["!.env", "!**/.env", "!.env.*", "!**/.env.*"]),
    );

    const tool = makeMultiSearchTool(base);
    const out = await tool.execute!(
      { patterns: ["NAVI_TEST_CREDENTIAL"], maxHitsPerPattern: 20 },
      {} as never,
    );
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).not.toContain("rg failed");
    expect(text).not.toContain(secretNonce);
    expect(text).not.toMatch(/\.env(?:\.[^:\s]+)?:\d+:/i);
  });
});

describe("path-guard", () => {
  it("pathHasDeniedSegment is case-insensitive + navi.db sidecar stem", () => {
    expect(pathHasDeniedSegment("Node_Modules/typescript/package.json")).toBe(true);
    expect(pathHasDeniedSegment("node_modules/foo")).toBe(true);
    expect(pathHasDeniedSegment("External/vendor/package.json")).toBe(true);
    expect(pathHasDeniedSegment(".Git/config")).toBe(true);
    expect(pathHasDeniedSegment("navi.db")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-wal")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-shm")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-journal")).toBe(true);
    expect(pathHasDeniedSegment("navi.dbutil")).toBe(false);
    expect(pathHasDeniedSegment("navi.database")).toBe(false);
    expect(pathHasDeniedSegment("mynavi.db")).toBe(false);
    expect(pathHasDeniedSegment(".ENV")).toBe(true);
    expect(pathHasDeniedSegment(".ENV.EXAMPLE")).toBe(false);
    expect(pathHasDeniedSegment(".env.example.local")).toBe(true);
    expect(pathHasDeniedSegment(".environment")).toBe(false);
    expect(pathHasDeniedSegment(".envrc")).toBe(false);
    expect(pathHasDeniedSegment("src/cli.ts")).toBe(false);
  });

  it("findGuardViolation PATH_KEYS: path escape refused, search pattern not containment-checked", () => {
    expect(findGuardViolation({ path: "Node_Modules/x" }, ROOT)?.kind).toBe("denied");
    expect(findGuardViolation({ path: "navi.db-wal" }, ROOT)?.kind).toBe("denied");
    expect(findGuardViolation({ path: "../outside" }, ROOT)?.kind).toBe("escape");
    // H2: grep pattern / query must not be containment-refused
    expect(findGuardViolation({ pattern: "repairCallRecord" }, ROOT)).toBeUndefined();
    expect(findGuardViolation({ pattern: "../../etc/passwd" }, ROOT)).toBeUndefined();
    expect(findGuardViolation({ query: "normalizeNumber" }, ROOT)).toBeUndefined();
    expect(findGuardViolation("not an object", ROOT)).toBeUndefined();
  });

  it("guards every member of a paths array", () => {
    expect(
      findGuardViolation({ paths: ["src/cli.ts", "node_modules/pkg/index.js"] }, ROOT),
    ).toEqual({ target: "node_modules/pkg/index.js", kind: "denied" });
    expect(
      findGuardViolation({ paths: ["src/cli.ts", "../outside/package.json"] }, ROOT),
    ).toEqual({ target: "../outside/package.json", kind: "escape" });
    expect(
      findGuardViolation({ paths: ["src/cli.ts", "tests/path-guard.test.ts"] }, ROOT),
    ).toBeUndefined();
  });

  it("escapesWorkspace refuses ../ and absolute out-of-tree; allows contained", () => {
    expect(escapesWorkspace(ROOT, "../outside")).toBe(true);
    expect(escapesWorkspace(ROOT, "/etc/hosts")).toBe(true);
    expect(escapesWorkspace(ROOT, "src/cli.ts")).toBe(false);
    expect(escapesWorkspace(ROOT, "grep foo ../sibling")).toBe(false); // whitespace
  });

  it("isContainedIn requires a separator boundary (no ../sibling escape)", () => {
    const base = "/workspace/project";
    expect(isContainedIn(base, base)).toBe(true);
    expect(isContainedIn(base, base + "/src/cli.ts")).toBe(true);
    // The classic startsWith footgun: sibling worktree shares a prefix.
    expect(isContainedIn(base, base + "-other-worktree/src/cli.ts")).toBe(false);
    expect(isContainedIn(base, "/workspace/other")).toBe(false);
  });

  it("resolveContainedPath refuses denied segments and escapes", () => {
    const denied = resolveContainedPath(ROOT, "Node_Modules/typescript/package.json");
    expect(denied.isErr()).toBe(true);
    if (denied.isErr()) expect(denied.error.kind).toBe("denied");

    const external = resolveContainedPath(ROOT, "External/vendor/package.json");
    expect(external.isErr()).toBe(true);

    const escape = resolveContainedPath(ROOT, "../sibling/package.json");
    // May be denied, escape, or missing depending on layout — never Ok for a sibling.
    // A sibling worktree must not resolve as contained.
    if (escape.isOk()) {
      // If somehow the join lands inside ROOT, that's fine; sibling must fail.
      expect(escape.value.startsWith(ROOT)).toBe(true);
    } else {
      expect(["denied", "escape", "missing", "io"]).toContain(escape.error.kind);
    }

    const okPath = resolveContainedPath(ROOT, "package.json");
    expect(okPath.isOk()).toBe(true);
  });

  it("parallel_view refuses Node_Modules and emits Blocked wording", async () => {
    const tool = makeParallelViewTool(ROOT);
    const out = await tool.execute!(
      { paths: ["Node_Modules/typescript/package.json"] } as never,
      {} as never,
    );
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toMatch(/Blocked:|refusing to access/i);
    expect(text).not.toMatch(/"name"\s*:\s*"typescript"/);
  });

  it("parallel_view still reads a legit workspace file", async () => {
    const tool = makeParallelViewTool(ROOT);
    const out = await tool.execute!({ paths: ["package.json"], maxLinesPerFile: 20 } as never, {} as never);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toMatch(/package\.json/);
    expect(text).toMatch(/"name"/);
    expect(text).not.toMatch(/Blocked:/);
  });

  it("formatResolveErr denied produces the audit-facing Blocked line", () => {
    // Don't assert console.error here; just the returned string contract.
    expect(formatResolveErr({ kind: "denied", target: "node_modules/x" })).toMatch(/Blocked:/);
    expect(formatResolveErr({ kind: "escape", target: "../x" })).toMatch(/escapes workspace/);
  });
});
