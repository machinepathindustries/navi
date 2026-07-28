import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  pathHasDeniedSegment,
  isContainedIn,
  escapesWorkspace,
  findGuardViolation,
  createWorkspace,
} from "../src/mastra/index.ts";

// Guard coverage includes case variants, database sidecars, and traversal.
const ROOT = process.cwd();

describe("guard — case-folded segment denial", () => {
  it("blocks the canonical lowercase denied segments", () => {
    expect(pathHasDeniedSegment("node_modules/typescript/package.json")).toBe(true);
    expect(pathHasDeniedSegment("external/vendor/package.json")).toBe(true);
    expect(pathHasDeniedSegment(".git/config")).toBe(true);
  });

  it("blocks case variants that read THROUGH an exact-match guard (APFS bypass)", () => {
    expect(pathHasDeniedSegment("Node_Modules/typescript/package.json")).toBe(true);
    expect(pathHasDeniedSegment("External/vendor/package.json")).toBe(true);
    expect(pathHasDeniedSegment(".Git/config")).toBe(true);
    expect(pathHasDeniedSegment("NODE_MODULES/x")).toBe(true);
  });

  it("does not over-block a legit source path", () => {
    expect(pathHasDeniedSegment("src/cli.ts")).toBe(false);
    expect(pathHasDeniedSegment("docs/architecture.md")).toBe(false);
    // a filename merely CONTAINING a denied word as a substring is not a segment.
    expect(pathHasDeniedSegment("src/external-facing.ts")).toBe(false);
    expect(pathHasDeniedSegment("my_node_modules_helper.ts")).toBe(false);
  });
});

describe("guard — navi.db sidecar denial", () => {
  it("blocks navi.db and its SQLite journal/wal/shm sidecars", () => {
    expect(pathHasDeniedSegment("navi.db")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-wal")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-shm")).toBe(true);
    expect(pathHasDeniedSegment("navi.db-journal")).toBe(true);
    // case-folded too
    expect(pathHasDeniedSegment("Navi.DB-WAL")).toBe(true);
    // nested
    expect(pathHasDeniedSegment("run/navi.db-wal")).toBe(true);
  });

  it("does not over-block a legit name that merely starts with the stem", () => {
    expect(pathHasDeniedSegment("navi.dbutil")).toBe(false);
    expect(pathHasDeniedSegment("navi.database")).toBe(false);
    expect(pathHasDeniedSegment("mynavi.db")).toBe(false);
    expect(pathHasDeniedSegment("database.db")).toBe(false);
  });
});

describe("guard — credential file denial", () => {
  it("blocks .env and .env.* basenames case-insensitively", () => {
    expect(pathHasDeniedSegment(".env")).toBe(true);
    expect(pathHasDeniedSegment(".ENV")).toBe(true);
    expect(pathHasDeniedSegment("config/.env.local")).toBe(true);
    expect(pathHasDeniedSegment("config/.ENV.PRODUCTION")).toBe(true);
  });

  it("allows only the public .env.example variant", () => {
    expect(pathHasDeniedSegment(".env.example")).toBe(false);
    expect(pathHasDeniedSegment(".ENV.EXAMPLE")).toBe(false);
    expect(pathHasDeniedSegment(".env.example.local")).toBe(true);
    expect(pathHasDeniedSegment(".environment")).toBe(false);
    expect(pathHasDeniedSegment(".envrc")).toBe(false);
  });

  it("applies the literal-name rule to path inputs", () => {
    expect(findGuardViolation({ path: ".env.local" }, ROOT)?.kind).toBe("denied");
    expect(findGuardViolation({ path: ".env.example" }, ROOT)).toBeUndefined();
  });
});

describe("guard — realpath containment and traversal", () => {
  it("isContainedIn requires a separator boundary (no sibling-prefix escape)", () => {
    const base = "/workspace/navi";
    expect(isContainedIn(base, base)).toBe(true);
    expect(isContainedIn(base, base + "/src/cli.ts")).toBe(true);
    expect(isContainedIn(base, base + "-sibling/src/cli.ts")).toBe(false);
    expect(isContainedIn(base, "/workspace/other")).toBe(false);
  });

  it("escapesWorkspace refuses ../ traversal and absolute out-of-tree paths", () => {
    expect(escapesWorkspace(ROOT, "../outside/package.json")).toBe(true);
    expect(escapesWorkspace(ROOT, "/etc/hosts")).toBe(true);
    expect(escapesWorkspace(ROOT, "../../../../../etc/passwd")).toBe(true);
  });

  it("escapesWorkspace allows a contained relative or absolute path", () => {
    expect(escapesWorkspace(ROOT, "src/cli.ts")).toBe(false);
    expect(escapesWorkspace(ROOT, "package.json")).toBe(false);
    expect(escapesWorkspace(ROOT, join(ROOT, "src/cli.ts"))).toBe(false);
  });

  it("escapesWorkspace never treats whitespace-bearing free text as one path", () => {
    expect(escapesWorkspace(ROOT, "grep foo ../sibling")).toBe(false);
    expect(escapesWorkspace(ROOT, "some free text query")).toBe(false);
    expect(escapesWorkspace(ROOT, "")).toBe(false);
  });
});

describe("guard — findGuardViolation (the beforeToolCall hook shape)", () => {
  it("flags a denied segment in a path field", () => {
    expect(findGuardViolation({ path: "Node_Modules/x" }, ROOT)).toEqual({
      target: "Node_Modules/x",
      kind: "denied",
    });
    expect(findGuardViolation({ path: "navi.db-wal" }, ROOT)?.kind).toBe("denied");
  });

  it("flags an escape for a lone traversal / absolute out-of-tree path", () => {
    expect(findGuardViolation({ path: "../outside/package.json" }, ROOT)?.kind).toBe("escape");
    expect(findGuardViolation({ path: "/etc/hosts" }, ROOT)?.kind).toBe("escape");
  });

  it("passes a legit workspace read and a free-text query untouched", () => {
    expect(findGuardViolation({ path: "src/cli.ts" }, ROOT)).toBeUndefined();
    expect(findGuardViolation({ query: "handleBatch", path: "src" }, ROOT)).toBeUndefined();
    // a query with spaces AND a ".." token is not a path — allowed.
    expect(findGuardViolation({ query: "foo ../ bar" }, ROOT)).toBeUndefined();
    expect(findGuardViolation("not an object", ROOT)).toBeUndefined();
  });

  it("blocks broad hidden traversal under both native grep names", () => {
    const input = { pattern: "secret", path: ".", includeHidden: true };
    expect(findGuardViolation(input, ROOT, "search_content")).toEqual({
      target: "includeHidden=true",
      kind: "denied",
    });
    expect(findGuardViolation(input, ROOT, "mastra_workspace_grep")).toEqual({
      target: "includeHidden=true",
      kind: "denied",
    });
    expect(findGuardViolation(input, ROOT, "multi_search")).toBeUndefined();
  });

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

// Containment canonicalizes a symlinked workspace root and its candidate together.
// Only path-bearing fields are checked; search patterns remain regular expressions.
describe("guard — symlinked workspace roots and path-bearing fields", () => {
  // Reproduce the /tmp -> /private/tmp shape DETERMINISTICALLY on any platform: a symlink
  // `linkBase` pointing at a real dir, used as the workspace root. realpath(linkBase) then
  // differs from linkBase itself.
  let realBase: string;
  let linkBase: string;
  beforeAll(() => {
    realBase = realpathSync(mkdtempSync(join(tmpdir(), "guard-real-")));
    linkBase = join(realpathSync(tmpdir()), `guard-link-${process.pid}-${Date.now()}`);
    symlinkSync(realBase, linkBase);
  });
  afterAll(() => {
    // Node ≥23 treats a dir-symlink as a directory for rmSync unless recursive is set
    // (force alone raises "Path is a directory"). recursive still unlinks the symlink
    // itself without descending into the target when the path is a symlink.
    rmSync(linkBase, { force: true, recursive: true });
    rmSync(realBase, { recursive: true, force: true });
  });

  it("a not-yet-existing leaf under a symlinked root is not an escape", () => {
    expect(escapesWorkspace(linkBase, "repairCallRecord")).toBe(false);
    expect(escapesWorkspace(linkBase, "src/cli.ts")).toBe(false); // nonexistent, still contained
  });

  it("still refuses a REAL escape from a symlinked root", () => {
    expect(escapesWorkspace(linkBase, "../outside")).toBe(true);
    expect(escapesWorkspace(linkBase, "/etc/hosts")).toBe(true);
  });

  it("the hook: a grep `pattern` / search `query` regex is never containment-checked", () => {
    expect(findGuardViolation({ pattern: "repairCallRecord" }, linkBase)).toBeUndefined();
    expect(findGuardViolation({ pattern: "import.*repair", path: "src" }, linkBase)).toBeUndefined();
    // a path-shaped regex is a regex, not a traversal — must not refuse.
    expect(findGuardViolation({ pattern: "../../etc/passwd" }, ROOT)).toBeUndefined();
    expect(findGuardViolation({ query: "normalizeNumber" }, ROOT)).toBeUndefined();
  });

  it("the hook: a genuine `path` arg under the symlinked root is allowed; a traversal still refused", () => {
    expect(findGuardViolation({ path: "src" }, linkBase)).toBeUndefined();
    expect(findGuardViolation({ path: "../outside" }, linkBase)?.kind).toBe("escape");
  });

  it("denied segments stay blocked on paths while search patterns remain auditable", () => {
    // Search result paths are filtered before capture, so source can audit the
    // denylist by name without granting a read of the denied tree.
    expect(findGuardViolation({ pattern: "node_modules" }, ROOT)).toBeUndefined();
    // H1 case-fold + navi.db-wal sidecar rules remain intact under the new key scoping.
    expect(findGuardViolation({ path: "Node_Modules/typescript/package.json" }, ROOT)?.kind).toBe("denied");
    expect(findGuardViolation({ path: "navi.db-wal" }, ROOT)?.kind).toBe("denied");
  });
});
