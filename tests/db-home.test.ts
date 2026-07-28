import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it, expect, afterAll } from "vitest";
import { match } from "ts-pattern";
import { localPathOf } from "../src/db-home.ts";

// The default ledger lives outside cwd. Explicit NAVI_DB URLs are passed through
// after rejecting in-memory SQLite, which cannot be shared by both store clients.

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");

const SCRATCH = mkdtempSync(join(tmpdir(), "navi-dbhome-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("db-home — NAVI_DB URL parsing", () => {
  it("extracts the local path from every libsql file form", () => {
    expect(localPathOf("file:/a/b.db")).toBe("/a/b.db");
    expect(localPathOf("file:///a/b.db")).toBe("/a/b.db");
    expect(localPathOf("FILE:/a/b.db")).toBe("/a/b.db");
    expect(localPathOf("file:/a/b.db?authToken=x")).toBe("/a/b.db");
    expect(localPathOf("file:b.db")).toBe("b.db");
    expect(localPathOf("/a/b.db")).toBe("/a/b.db");
  });

  it("returns undefined for a remote store — no local path to guard", () => {
    expect(localPathOf("libsql://example.invalid/db")).toBeUndefined();
    expect(localPathOf("http://example.invalid/db")).toBeUndefined();
  });
});

describe("db-home — unsafe in-memory URLs fail before store construction", () => {
  it.each([
    ":memory:",
    "file::memory:",
    "file:shared-ledger?mode=memory&cache=shared",
  ])("refuses the in-memory form %s before two clients can diverge", (url) => {
    const cwd = mkdtempSync(join(tmpdir(), "navi-memory-url-"));
    const r = spawnSync(TSX, [CLI, "--version"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NAVI_DB: url },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NAVI_DB cannot use an in-memory SQLite URL/);
    expect(r.stderr).toMatch(/Use --ephemeral/);
    expect(r.stderr).not.toMatch(/at Object\.|at Module\.|node:internal/);
    expect(r.stdout).not.toMatch(/navi \d+\.\d+\.\d+/);
    expect(existsSync(join(cwd, "shared-ledger"))).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("db-home — an EMPTY HOME never scatters a ledger into the cwd", () => {
  it("writes nothing to the working directory when HOME is empty", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navi-emptyhome-"));
    const r = spawnSync(TSX, [CLI, "--version"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: "", NAVI_DB: undefined },
    });
    // Either it recovers the real home via the passwd database, or it refuses
    // loudly. What it must never do is create a ledger next to the user's work.
    expect(existsSync(join(cwd, ".navi-home"))).toBe(false);
    expect(existsSync(join(cwd, "navi.db"))).toBe(false);
    match(r.status)
      .with(0, () => expect(r.stdout).toMatch(/navi \d+\.\d+\.\d+/))
      .otherwise(() => expect(r.stderr).toMatch(/cannot locate your home directory/));
    rmSync(cwd, { recursive: true, force: true });
  });

});

describe("db-home — the default ledger has one home-independent of cwd", () => {
  it("creates the default ledger under ~/.navi-home", () => {
    const cwd = join(SCRATCH, "cwd-default");
    const home = join(SCRATCH, "home-default");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const r = spawnSync(TSX, [CLI, "--version"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: home, NAVI_DB: undefined },
    });
    expect(r.status).toBe(0);
    const dest = join(home, ".navi-home", "navi.db");
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(cwd, "navi.db"))).toBe(false);
    expect(existsSync(join(cwd, ".navi-home"))).toBe(false);
  });

  it("honors an explicit NAVI_DB verbatim", () => {
    const home = join(SCRATCH, "home-fresh");
    mkdirSync(home, { recursive: true });
    const r = spawnSync(TSX, [CLI, "--version"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: home, NAVI_DB: `file:${join(home, "explicit.db")}` },
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, "explicit.db"))).toBe(true);
    expect(existsSync(join(home, ".navi-home", "navi.db"))).toBe(false);
  });
});
