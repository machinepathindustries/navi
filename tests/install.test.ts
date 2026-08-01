import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyInstall,
  interopSource,
  localLauncherSource,
  planInstall,
  RECEIPT_REL,
  renderInstall,
  uninstall,
} from "../src/install.ts";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");
const GATE = join(ROOT, "tests/fixtures/gate-command/action.yaml");
const SCRATCH = mkdtempSync(join(tmpdir(), "navi-install-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.txt"), "hi\n");
  return dir;
}

function tree(dir: string): string[] {
  return spawnSync("find", [dir], { encoding: "utf8" }).stdout.trim().split("\n").sort();
}

function snapshot(dir: string): string {
  return spawnSync(
    "sh",
    [
      "-c",
      `find "$1" -print | sort | while IFS= read -r p; do ` +
        `printf '%s|' "$p"; ` +
        `if [ -L "$p" ]; then printf 'link|%s\\n' "$(readlink "$p")"; ` +
        `elif [ -f "$p" ]; then printf 'file|'; shasum -a 256 "$p"; ` +
        `else printf 'dir\\n'; fi; done`,
      "snapshot",
      dir,
    ],
    { encoding: "utf8" },
  ).stdout;
}

function install(dir: string, installRoot: string = ROOT) {
  const plan = planInstall(installRoot, dir)._unsafeUnwrap();
  return applyInstall(plan)._unsafeUnwrap();
}

describe("navi install — owned skill, launcher, and receipt", () => {
  it("creates two symlinks and a versioned receipt, never a copy", () => {
    const dir = repo("links");
    const plan = install(dir);
    const skill = join(dir, ".agents", "skills", "navi-interop");
    const launcher = join(dir, ".agents", "bin", "navi");
    const receipt = join(dir, RECEIPT_REL);

    expect(readlinkSync(skill)).toBe(interopSource(ROOT));
    expect(readlinkSync(launcher)).toBe(localLauncherSource(ROOT));
    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
      schema: "navi.interop-install.v1",
      state: "installed",
      install_root: ROOT,
      skill_source: interopSource(ROOT),
      launcher_source: localLauncherSource(ROOT),
      created_dirs: [".agents", ".agents/skills", ".agents/bin"],
    });
    const rendered = renderInstall(plan, dir);
    expect(rendered).toContain(launcher);
    expect(rendered).toContain(`ownership receipt: ${plan.receiptPath}`);
    expect(rendered).toContain(`${plan.launcherTarget} catalog -w ${plan.projectRoot}`);
    expect(rendered).toContain(`${plan.launcherTarget} help brainstorm -w ${plan.projectRoot}`);
  });

  it("is idempotent and refuses either foreign target", () => {
    const dir = repo("foreign");
    install(dir);
    expect(planInstall(ROOT, dir)._unsafeUnwrap().action).toBe("already-linked");

    const skill = join(dir, ".agents", "skills", "navi-interop");
    unlinkSync(skill);
    symlinkSync(join(SCRATCH, "someone-else"), skill, "dir");
    expect(planInstall(ROOT, dir)._unsafeUnwrapErr()).toMatch(/ownership receipt/);
    expect(readlinkSync(skill)).toBe(join(SCRATCH, "someone-else"));
  });

  it("replans at mutation time and rejects a parent swapped outside the project", () => {
    const dir = repo("stale-plan");
    const outside = join(SCRATCH, "outside");
    mkdirSync(outside, { recursive: true });
    const stale = planInstall(ROOT, dir)._unsafeUnwrap();
    symlinkSync(outside, join(dir, ".agents"), "dir");

    expect(applyInstall(stale)._unsafeUnwrapErr()).toMatch(/outside the requested project/);
    expect(existsSync(join(outside, "skills", "navi-interop"))).toBe(false);
    expect(existsSync(join(outside, "bin", "navi"))).toBe(false);
  });

  it("preflights a launcher conflict before mutation and leaves the tree byte-identical", () => {
    const dir = repo("launcher-preflight");
    const stale = planInstall(ROOT, dir)._unsafeUnwrap();
    const launcher = join(dir, ".agents", "bin", "navi");
    mkdirSync(dirname(launcher), { recursive: true });
    symlinkSync(join(SCRATCH, "foreign-launcher"), launcher);
    const before = snapshot(dir);

    expect(applyInstall(stale)._unsafeUnwrapErr()).toMatch(/launcher|targets changed/);
    expect(snapshot(dir)).toBe(before);
  });

  it("refuses a broken .agents symlink before writing its ownership receipt", () => {
    const dir = repo("broken-agents-parent");
    symlinkSync(join(SCRATCH, "missing-agents-target"), join(dir, ".agents"), "dir");
    const before = snapshot(dir);

    const result = planInstall(ROOT, dir).andThen(applyInstall);

    expect(result._unsafeUnwrapErr()).toMatch(/outside|symlink|real directory|project install paths/);
    expect(snapshot(dir)).toBe(before);
    expect(existsSync(join(dir, RECEIPT_REL))).toBe(false);
  });

  it("reports a pre-transaction write failure without claiming rollback failed", () => {
    const dir = repo("unwritable-project-root");
    const plan = planInstall(ROOT, dir)._unsafeUnwrap();
    const before = snapshot(dir);
    chmodSync(dir, 0o555);

    const result = applyInstall(plan);

    chmodSync(dir, 0o755);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).not.toContain("rollback was incomplete");
    expect(snapshot(dir)).toBe(before);
    expect(existsSync(join(dir, RECEIPT_REL))).toBe(false);
  });

  it("never removes a foreign receipt that appears after planning", () => {
    const dir = repo("receipt-race");
    const stale = planInstall(ROOT, dir)._unsafeUnwrap();
    const receipt = join(dir, RECEIPT_REL);
    mkdirSync(dirname(receipt), { recursive: true });
    const foreign = `${JSON.stringify(
      {
        schema: "navi.interop-install.v1",
        state: "installed",
        install_root: join(SCRATCH, "another-navi"),
        skill_source: join(SCRATCH, "another-skill"),
        launcher_source: join(SCRATCH, "another-launcher"),
        created_dirs: [],
        transaction_id: "00000000-0000-4000-8000-000000000001",
      },
      null,
      2,
    )}\n`;
    writeFileSync(receipt, foreign);
    const before = snapshot(dir);

    expect(applyInstall(stale)._unsafeUnwrapErr()).toMatch(/different navi installation/);
    expect(snapshot(dir)).toBe(before);
    expect(readFileSync(receipt, "utf8")).toBe(foreign);
  });

  it("rejects a receipt that repeats an owned directory", () => {
    const dir = repo("duplicate-created-dirs");
    install(dir);
    const receipt = join(dir, RECEIPT_REL);
    const value = JSON.parse(readFileSync(receipt, "utf8")) as {
      created_dirs: string[];
    };
    value.created_dirs = [".agents", ".agents"];
    writeFileSync(receipt, `${JSON.stringify(value, null, 2)}\n`);

    expect(planInstall(ROOT, dir)._unsafeUnwrapErr()).toMatch(/not a valid/);
  });
});

describe("navi uninstall — exact restoration and exact ownership", () => {
  for (const [name, dirs] of [
    ["none", []],
    ["agents", [".agents"]],
    ["skills", [".agents", ".agents/skills"]],
    ["bin", [".agents", ".agents/bin"]],
    ["all", [".agents", ".agents/skills", ".agents/bin"]],
  ] as const) {
    it(`restores pre-existing empty parent directories: ${name}`, () => {
      const dir = repo(`restore-${name}`);
      dirs.forEach((rel) => mkdirSync(join(dir, rel), { recursive: true }));
      const before = tree(dir);
      install(dir);
      uninstall(ROOT, dir)._unsafeUnwrap();
      expect(tree(dir)).toEqual(before);
    });
  }

  it("preserves other skills and refuses a foreign owned link without partial removal", () => {
    const dir = repo("shared");
    install(dir);
    const theirs = join(dir, ".agents", "skills", "theirs");
    mkdirSync(theirs);
    writeFileSync(join(theirs, "SKILL.md"), "theirs\n");
    uninstall(ROOT, dir)._unsafeUnwrap();
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("theirs\n");

    const foreign = repo("uninstall-foreign");
    install(foreign);
    const launcher = join(foreign, ".agents", "bin", "navi");
    unlinkSync(launcher);
    symlinkSync(join(SCRATCH, "foreign-launcher"), launcher);
    expect(uninstall(ROOT, foreign)._unsafeUnwrapErr()).toMatch(/ownership receipt/);
    expect(existsSync(join(foreign, ".agents", "skills", "navi-interop"))).toBe(true);
  });

  it("treats permission errors as errors, never as absent owned links", () => {
    const dir = repo("unreadable-owned-links");
    install(dir);
    const skills = join(dir, ".agents", "skills");
    const bin = join(dir, ".agents", "bin");
    const receipt = join(dir, RECEIPT_REL);
    chmodSync(skills, 0o000);
    chmodSync(bin, 0o000);

    const result = uninstall(ROOT, dir);

    chmodSync(skills, 0o755);
    chmodSync(bin, 0o755);
    expect(result.isErr()).toBe(true);
    expect(existsSync(receipt)).toBe(true);
    expect(lstatSync(join(skills, "navi-interop")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(bin, "navi")).isSymbolicLink()).toBe(true);
  });

  it("preflights a non-writable launcher parent before removing either link", () => {
    const dir = repo("non-writable-launcher-parent");
    install(dir);
    const skill = join(dir, ".agents", "skills", "navi-interop");
    const bin = join(dir, ".agents", "bin");
    const launcher = join(bin, "navi");
    const receipt = join(dir, RECEIPT_REL);
    const before = readFileSync(receipt, "utf8");
    chmodSync(bin, 0o555);

    const result = uninstall(ROOT, dir);

    chmodSync(bin, 0o755);
    expect(result.isErr()).toBe(true);
    expect(readFileSync(receipt, "utf8")).toBe(before);
    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
  });

  it("keeps the receipt until every recorded directory has been handled", () => {
    const dir = repo("non-writable-prune-parent");
    install(dir);
    const agents = join(dir, ".agents");
    const skill = join(agents, "skills", "navi-interop");
    const launcher = join(agents, "bin", "navi");
    const receipt = join(dir, RECEIPT_REL);
    const before = readFileSync(receipt, "utf8");
    chmodSync(agents, 0o555);

    const result = uninstall(ROOT, dir);

    chmodSync(agents, 0o755);
    expect(result.isErr()).toBe(true);
    expect(readFileSync(receipt, "utf8")).toBe(before);
    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
  });

  it("uses a valid receipt to uninstall dangling links after Navi moves", () => {
    const dir = repo("moved-install-project");
    const oldRoot = join(SCRATCH, "moved-install-old");
    const newRoot = join(SCRATCH, "moved-install-new");
    mkdirSync(join(oldRoot, "agent", "skills", "navi-interop"), { recursive: true });
    mkdirSync(join(oldRoot, "bin"), { recursive: true });
    writeFileSync(join(oldRoot, "agent", "skills", "navi-interop", "SKILL.md"), "owned\n");
    writeFileSync(join(oldRoot, "bin", "navi-local"), "#!/bin/sh\n");
    install(dir, oldRoot);
    const skill = join(dir, ".agents", "skills", "navi-interop");
    const launcher = join(dir, ".agents", "bin", "navi");
    expect(readlinkSync(skill)).toBe(interopSource(oldRoot));
    expect(readlinkSync(launcher)).toBe(localLauncherSource(oldRoot));

    renameSync(oldRoot, newRoot);
    uninstall(newRoot, dir)._unsafeUnwrap();

    expect(tree(dir)).toEqual([dir, join(dir, "a.txt")].sort());
  });

  it("recovers a compatible interrupted receipt write without leaving a temp file", () => {
    const dir = repo("receipt-temp-recovery");
    install(dir);
    const receipt = join(dir, RECEIPT_REL);
    const installed = JSON.parse(readFileSync(receipt, "utf8")) as {
      state: string;
      transaction_id: string;
    };
    const temp = `${receipt}.${installed.transaction_id}.tmp`;
    writeFileSync(temp, `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o600 });
    installed.state = "installing";
    writeFileSync(receipt, `${JSON.stringify(installed, null, 2)}\n`);

    const recovered = planInstall(ROOT, dir)._unsafeUnwrap();
    expect(recovered.action).toBe("recovered");
    applyInstall(recovered)._unsafeUnwrap();

    expect(existsSync(temp)).toBe(false);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
      state: "installed",
    });
  });

  it("recovers an empty partial receipt temp left by an interrupted write", () => {
    const dir = repo("empty-receipt-temp-recovery");
    install(dir);
    const receipt = join(dir, RECEIPT_REL);
    const interrupted = JSON.parse(readFileSync(receipt, "utf8")) as {
      state: string;
      transaction_id: string;
    };
    const temp = `${receipt}.${interrupted.transaction_id}.tmp`;
    interrupted.state = "installing";
    writeFileSync(receipt, `${JSON.stringify(interrupted, null, 2)}\n`);
    writeFileSync(temp, "", { mode: 0o600 });

    const recovered = planInstall(ROOT, dir)._unsafeUnwrap();
    expect(recovered.action).toBe("recovered");
    applyInstall(recovered)._unsafeUnwrap();

    expect(existsSync(temp)).toBe(false);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
      state: "installed",
    });
  });

  it("never claims or removes a generic receipt temp filename", () => {
    const dir = repo("foreign-generic-receipt-temp");
    const foreign = join(dir, `${RECEIPT_REL}.tmp`);
    writeFileSync(foreign, "foreign user data\n");

    install(dir);
    uninstall(ROOT, dir)._unsafeUnwrap();

    expect(readFileSync(foreign, "utf8")).toBe("foreign user data\n");
  });

  it("refuses a valid foreign receipt at the owned transaction scratch path", () => {
    const dir = repo("foreign-transaction-receipt-temp");
    install(dir);
    const receipt = join(dir, RECEIPT_REL);
    const interrupted = JSON.parse(readFileSync(receipt, "utf8")) as {
      state: string;
      transaction_id: string;
    };
    interrupted.state = "installing";
    writeFileSync(receipt, `${JSON.stringify(interrupted, null, 2)}\n`);
    const temp = `${receipt}.${interrupted.transaction_id}.tmp`;
    const foreign = {
      ...interrupted,
      transaction_id: "00000000-0000-4000-8000-000000000002",
    };
    const foreignText = `${JSON.stringify(foreign, null, 2)}\n`;
    writeFileSync(temp, foreignText, { mode: 0o600 });

    const plan = planInstall(ROOT, dir)._unsafeUnwrap();
    expect(applyInstall(plan).isErr()).toBe(true);

    expect(readFileSync(temp, "utf8")).toBe(foreignText);
    expect(lstatSync(join(dir, ".agents", "skills", "navi-interop")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(dir, ".agents", "bin", "navi")).isSymbolicLink()).toBe(true);
  });

  it("removes a receipt-less current link but conservatively preserves its parents", () => {
    const dir = repo("receiptless-remove");
    const skill = join(dir, ".agents", "skills", "navi-interop");
    mkdirSync(dirname(skill), { recursive: true });
    symlinkSync(interopSource(ROOT), skill, "dir");
    uninstall(ROOT, dir)._unsafeUnwrap();
    expect(existsSync(skill)).toBe(false);
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(true);
  });
});

describe("navi install — checkout bootstrap without global PATH", () => {
  it("the project-local launcher emits and runs its own continuation", () => {
    const dir = repo("local-launcher");
    const db = join(SCRATCH, "local-launcher.db");
    writeFileSync(join(dir, ".env"), `NAVI_DB=file:${db}\n`);
    const installRun = spawnSync(TSX, [CLI, "install", "-w", dir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NAVI_DB: `file:${db}` },
    });
    expect(installRun.status, installRun.stderr).toBe(0);

    const launcher = join(dir, ".agents", "bin", "navi");
    const nodePath = dirname(process.execPath);
    const cleanPath = `${nodePath}:/usr/bin:/bin`;
    const canonicalLauncher = join(realpathSync(dirname(launcher)), "navi");
    const help = spawnSync(launcher, ["help", "brainstorm", "-w", dir], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: cleanPath, NAVI_DB: undefined },
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain(`${canonicalLauncher} run brainstorm --json --stdin`);
    expect(help.stdout).not.toMatch(/(^|\s)navi run brainstorm/);

    const catalog = spawnSync(launcher, ["catalog", "-w", dir], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: cleanPath, NAVI_DB: undefined },
    });
    expect(catalog.status, catalog.stderr).toBe(0);
    expect(catalog.stdout).toContain(`${canonicalLauncher} run brainstorm --json --stdin`);
    expect(catalog.stdout).toMatch(/pinned\s+navi-interop/);

    const first = spawnSync(launcher, ["run", GATE, "DIRECT", "-w", ROOT, "--json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: cleanPath, NAVI_DB: undefined },
    });
    expect(first.status, first.stderr).toBe(0);
    const envelope = JSON.parse(first.stdout) as { session_id: string; next: { command: string } };
    expect(envelope.next.command.startsWith(canonicalLauncher)).toBe(true);
    expect(envelope.next.command.startsWith("navi ")).toBe(false);

    const unrelated = join(SCRATCH, "unrelated-cwd");
    mkdirSync(unrelated, { recursive: true });
    const continued = spawnSync("sh", ["-c", envelope.next.command], {
      cwd: unrelated,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: cleanPath, NAVI_DB: undefined },
    });
    expect(continued.status, continued.stderr).toBe(0);
    expect(continued.stdout).toContain(`-t ${envelope.session_id}`);
  });

  it("the wrapper is executable and uninstall can remove the launcher running it", () => {
    const dir = repo("self-remove");
    install(dir);
    const launcher = join(dir, ".agents", "bin", "navi");
    const result = spawnSync(launcher, ["uninstall", "-w", dir], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NAVI_DB: `file:${join(SCRATCH, "self-remove.db")}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(launcher)).toBe(false);
    expect(tree(dir)).toEqual([dir, join(dir, "a.txt")].sort());
  });
});
