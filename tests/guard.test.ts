import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  escapesWorkspace,
  findGuardViolation,
  createWorkspace,
} from "../src/mastra/index.ts";

const ROOT = process.cwd();

describe("guard — workspace hook integration", () => {
  it("wires the exposed search_content name into the workspace hook", async () => {
    const hook = createWorkspace(ROOT, { skills: false }).getToolsConfig().hooks
      ?.beforeToolCall;
    const result = await hook?.({
      toolName: "search_content",
      workspaceToolName: "mastra_workspace_grep",
      input: { pattern: "secret", path: ".", includeHidden: true },
      context: {},
    });
    expect(result).toMatchObject({ proceed: false });
    expect(JSON.stringify(result)).toContain("includeHidden=true");
  });
});

// Containment canonicalizes a symlinked workspace root and its candidate
// together. Only path-bearing fields are checked; patterns remain regular
// expressions.
describe("guard — symlinked workspace roots and path-bearing fields", () => {
  let realBase: string;
  let linkBase: string;

  beforeAll(() => {
    realBase = realpathSync(mkdtempSync(join(tmpdir(), "guard-real-")));
    linkBase = join(realpathSync(tmpdir()), `guard-link-${process.pid}-${Date.now()}`);
    symlinkSync(realBase, linkBase);
  });

  afterAll(() => {
    rmSync(linkBase, { force: true, recursive: true });
    rmSync(realBase, { recursive: true, force: true });
  });

  it("allows a not-yet-existing leaf under a symlinked root", () => {
    expect(escapesWorkspace(linkBase, "repairCallRecord")).toBe(false);
    expect(escapesWorkspace(linkBase, "src/cli.ts")).toBe(false);
  });

  it("still refuses a real escape from a symlinked root", () => {
    expect(escapesWorkspace(linkBase, "../outside")).toBe(true);
    expect(escapesWorkspace(linkBase, "/etc/hosts")).toBe(true);
  });

  it("never containment-checks a grep pattern or search query", () => {
    expect(findGuardViolation({ pattern: "repairCallRecord" }, linkBase)).toBeUndefined();
    expect(findGuardViolation({ pattern: "import.*repair", path: "src" }, linkBase)).toBeUndefined();
  });

  it("allows a real path under the symlinked root and refuses traversal", () => {
    expect(findGuardViolation({ path: "src" }, linkBase)).toBeUndefined();
    expect(findGuardViolation({ path: "../outside" }, linkBase)?.kind).toBe("escape");
  });

  it("keeps denied paths blocked while their names remain searchable", () => {
    expect(findGuardViolation({ pattern: "node_modules" }, linkBase)).toBeUndefined();
    expect(findGuardViolation({ path: "Node_Modules/typescript/package.json" }, linkBase)?.kind).toBe("denied");
    expect(findGuardViolation({ path: "navi.db-wal" }, linkBase)?.kind).toBe("denied");
  });
});
