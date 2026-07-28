import { afterAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEnvFiles,
  validatedInstallRoot,
  validatedProjectRoot,
} from "../src/env-file.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "navi-env-"));
const KEYS = [
  "NAVI_ENV_TEST_SHARED",
  "NAVI_ENV_TEST_INSTALL_ONLY",
  "NAVI_ENV_TEST_CWD_ONLY",
  "NAVI_ENV_TEST_EXPLICIT",
] as const;

afterAll(() => {
  KEYS.forEach((key) => delete process.env[key]);
  rmSync(SCRATCH, { recursive: true, force: true });
});

function fixture(): { install: string; cwd: string } {
  const install = join(SCRATCH, "install");
  const cwd = join(SCRATCH, "project");
  mkdirSync(install, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(install, ".env"),
    [
      "NAVI_ENV_TEST_SHARED=install",
      "NAVI_ENV_TEST_INSTALL_ONLY=from-install",
      "NAVI_ENV_TEST_EXPLICIT=from-file",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, ".env"),
    [
      "NAVI_ENV_TEST_SHARED=project",
      "NAVI_ENV_TEST_CWD_ONLY=from-project",
      "",
    ].join("\n"),
  );
  return { install, cwd };
}

describe("env files for a project-local launcher", () => {
  it("loads cwd first, then the validated install root, while explicit env wins", () => {
    const { install, cwd } = fixture();
    KEYS.forEach((key) => delete process.env[key]);
    process.env.NAVI_ENV_TEST_EXPLICIT = "from-process";

    const loaded = loadEnvFiles(install, cwd, install);

    expect(loaded.sort()).toEqual(
      [
        "NAVI_ENV_TEST_CWD_ONLY",
        "NAVI_ENV_TEST_INSTALL_ONLY",
        "NAVI_ENV_TEST_SHARED",
      ].sort(),
    );
    expect(process.env.NAVI_ENV_TEST_SHARED).toBe("project");
    expect(process.env.NAVI_ENV_TEST_INSTALL_ONLY).toBe("from-install");
    expect(process.env.NAVI_ENV_TEST_CWD_ONLY).toBe("from-project");
    expect(process.env.NAVI_ENV_TEST_EXPLICIT).toBe("from-process");
  });

  it("ignores an install-root hint that is not the running package", () => {
    const { install, cwd } = fixture();
    const other = join(SCRATCH, "other");
    mkdirSync(other, { recursive: true });
    KEYS.forEach((key) => delete process.env[key]);

    expect(validatedInstallRoot(other, install)).toBeUndefined();
    const loaded = loadEnvFiles(other, cwd, install);

    expect(loaded).toEqual(["NAVI_ENV_TEST_CWD_ONLY", "NAVI_ENV_TEST_SHARED"]);
    expect(process.env.NAVI_ENV_TEST_INSTALL_ONLY).toBeUndefined();
    expect(process.env.NAVI_ENV_TEST_SHARED).toBe("project");
  });

  it("loads the installed project's .env from an unrelated cwd only for the fixed launcher", () => {
    const { install, cwd: project } = fixture();
    const unrelated = join(SCRATCH, "unrelated");
    const wrapper = join(install, "bin", "navi-local");
    const launcher = join(project, ".agents", "bin", "navi");
    const spoof = join(unrelated, "navi");
    mkdirSync(join(install, "bin"), { recursive: true });
    mkdirSync(join(project, ".agents", "bin"), { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(wrapper, "#!/bin/sh\n");
    symlinkSync(wrapper, launcher);
    symlinkSync(wrapper, spoof);
    writeFileSync(
      join(unrelated, ".env"),
      "NAVI_ENV_TEST_SHARED=unrelated\n",
    );
    KEYS.forEach((key) => delete process.env[key]);

    expect(validatedProjectRoot(project, launcher, install, install)).toBe(
      realpathSync(project),
    );
    expect(validatedProjectRoot(project, spoof, install, install)).toBeUndefined();

    const loaded = loadEnvFiles(install, unrelated, install, project, launcher);

    expect(loaded.sort()).toEqual(
      [
        "NAVI_ENV_TEST_CWD_ONLY",
        "NAVI_ENV_TEST_INSTALL_ONLY",
        "NAVI_ENV_TEST_SHARED",
        "NAVI_ENV_TEST_EXPLICIT",
      ].sort(),
    );
    expect(process.env.NAVI_ENV_TEST_SHARED).toBe("project");
    expect(process.env.NAVI_ENV_TEST_CWD_ONLY).toBe("from-project");
    expect(process.env.NAVI_ENV_TEST_INSTALL_ONLY).toBe("from-install");
  });
});
