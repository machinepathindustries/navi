import { afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invocationPrefix as runtimeInvocationPrefix, shellQuote } from "../src/invocation.ts";

// The self-steering `next.command` prefix is derived from Navi's invocation, so the
// emitted command is executable by construction in whatever context navi runs in —
// both the absolute tsx form and the installed shebang form. The representative
// invocation shapes enforce that the NODE BINARY in
// argv[0] is never emitted, and the tsx form matches the dialog allowlist prefix
// (`Bash(<repo>/node_modules/.bin/tsx *)`) exactly.

const REPO = "/workspace/navi";
const NODE = "/opt/node/bin/node"; // argv[0] must never appear in the prefix
const CLI = `${REPO}/src/cli.ts`;
const LIVE_ROOT = process.cwd();
const LOCAL_SCRATCH = mkdtempSync(join(tmpdir(), "navi-invocation-"));
const ORIGINAL_INVOKED_AS = process.env.NAVI_INVOKED_AS;
const ORIGINAL_INSTALL_ROOT = process.env.NAVI_INSTALL_ROOT;

// Synthetic argv tests are independent of whichever command launched Vitest.
// Individual npx cases pass their npm invocation metadata explicitly.
function invocationPrefix(argv: readonly string[], execArgv: readonly string[]): string {
  return runtimeInvocationPrefix(argv, execArgv, {});
}

afterAll(() => {
  if (ORIGINAL_INVOKED_AS === undefined) delete process.env.NAVI_INVOKED_AS;
  else process.env.NAVI_INVOKED_AS = ORIGINAL_INVOKED_AS;
  if (ORIGINAL_INSTALL_ROOT === undefined) delete process.env.NAVI_INSTALL_ROOT;
  else process.env.NAVI_INSTALL_ROOT = ORIGINAL_INSTALL_ROOT;
  rmSync(LOCAL_SCRATCH, { recursive: true, force: true });
});

// The execArgv tsx ALWAYS injects (verified live via an argv-probe under
// ./node_modules/.bin/tsx): a plain-path `--require` preflight + a file:// `--import`
// loader, both absolute, under <repo>/node_modules/tsx/dist/.
const tsxExecArgv = [
  "--require",
  `${REPO}/node_modules/tsx/dist/preflight.cjs`,
  "--import",
  `file://${REPO}/node_modules/tsx/dist/loader.mjs`,
];

describe("invocationPrefix — argv self-derivation", () => {
  it("tsx direct form → <repo>/node_modules/.bin/tsx <repo>/src/cli.ts (matches the allowlist prefix)", () => {
    const prefix = invocationPrefix([NODE, CLI, "run", "edge-walk"], tsxExecArgv);
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
    // The exact allowlist form: the emitted command starts with `<tsx> ` so
    // `Bash(<repo>/node_modules/.bin/tsx *)` grants it.
    expect(prefix.startsWith(`${REPO}/node_modules/.bin/tsx `)).toBe(true);
  });

  it("NEVER emits the node binary from argv[0] (the binding rail)", () => {
    const prefix = invocationPrefix([NODE, CLI], tsxExecArgv);
    expect(prefix).not.toContain(NODE);
    // the prefix is exactly the tsx bin + entry, node binary nowhere in it.
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
  });

  it("derives the tsx bin from the --import loader ALONE (file:// URL form)", () => {
    const importOnly = ["--import", `file://${REPO}/node_modules/tsx/dist/loader.mjs`];
    expect(invocationPrefix([NODE, CLI], importOnly)).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
  });

  it("derives the tsx bin from the --require preflight ALONE (plain-path form)", () => {
    const requireOnly = ["--require", `${REPO}/node_modules/tsx/dist/preflight.cjs`];
    expect(invocationPrefix([NODE, CLI], requireOnly)).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
  });

  it("npm-run indirection carries the SAME split execArgv shape, so the prefix is invariant", () => {
    // Honest framing (was overclaimed as a distinct shape): `npm run navi` execs
    // `tsx src/cli.ts` with node_modules/.bin on PATH; the child node process carries
    // the IDENTICAL split-form tsx loader on execArgv and an absolute argv[1] — so this
    // pins invariance to the indirection, NOT a different encoding. The genuinely
    // different encoding node can produce (the combined `--import=…` equals form) is
    // exercised by the equals-form tests below with its own constructed argv.
    expect(invocationPrefix([NODE, CLI, "run", "x"], tsxExecArgv)).toBe(
      `${REPO}/node_modules/.bin/tsx ${CLI}`,
    );
  });

  it("resolves a relative entry script to an absolute path (never a bare relative leaks out)", () => {
    // node normally hands argv[1] absolute; resolve() is the defensive floor.
    const prefix = invocationPrefix([NODE, "src/cli.ts", "run"], tsxExecArgv);
    const [, entry] = prefix.split(" ");
    expect(entry!.startsWith("/")).toBe(true);
    expect(entry).toBe(`${process.cwd()}/src/cli.ts`);
  });

  it("no tsx loader (compiled/shebang entry) → the absolute entry alone (packaging horizon)", () => {
    // A directly-executable entry (shebang'd .js, no tsx loader in execArgv) needs no
    // runtime prefix — the script path IS the executable form.
    const compiled = `${REPO}/dist/cli.js`;
    expect(invocationPrefix([NODE, compiled], [])).toBe(compiled);
  });

  it("the derived prefix is composable into a runnable continuation command", () => {
    // The shape the CLI actually builds: `<prefix> run <wf> --json --stdin -t <id>`.
    const prefix = invocationPrefix([NODE, CLI], tsxExecArgv);
    const cmd = `${prefix} run edge-walk --json --stdin -t abc123`;
    expect(cmd).toBe(`${REPO}/node_modules/.bin/tsx ${CLI} run edge-walk --json --stdin -t abc123`);
  });
});

// When launched as the installed bin (no tsx loader, a `bin/navi`
// entry), next.command must emit the PORTABLE bare `navi` — the form the interop skill
// teaches and a consumer has on PATH — NOT the machine-specific absolute `<repo>/bin/
// navi.mjs` that argv[1] carries. An absolute path would couple continuations to
// one checkout and break portability.
describe("invocationPrefix — packaged bin emits the portable command", () => {
  const PACKAGE_ENTRY = `${REPO}/bin/navi.mjs`;

  it("bin/navi.mjs under node → the bare portable `navi`, not the absolute path", () => {
    const prefix = invocationPrefix([NODE, PACKAGE_ENTRY, "run", "edge-walk"], []);
    expect(prefix).toBe("navi");
    expect(prefix).not.toContain("/"); // no filesystem path leaks into the envelope
  });

  it("npm's node_modules/.bin/navi symlink form also emits portable `navi`", () => {
    expect(invocationPrefix([NODE, `${REPO}/node_modules/.bin/navi`], [])).toBe("navi");
  });

  it("the navi-cli bin alias remains navi-cli outside npx", () => {
    expect(invocationPrefix([NODE, `${REPO}/node_modules/.bin/navi-cli`], [])).toBe(
      "navi-cli",
    );
  });

  it("a global bin symlink form (`/usr/local/bin/navi`) still emits `navi`", () => {
    expect(invocationPrefix([NODE, "/usr/local/bin/navi"], [])).toBe("navi");
  });

  it("composes into a runnable portable continuation the parent can copy verbatim", () => {
    const prefix = invocationPrefix([NODE, PACKAGE_ENTRY], []);
    expect(`${prefix} run edge-walk --json --stdin -t abc123`).toBe(
      "navi run edge-walk --json --stdin -t abc123",
    );
  });

  it("tsx loader still WINS over a bin entry (dev `tsx bin/navi.mjs` stays runnable, not bare `navi`)", () => {
    // A source-checkout dev has no global `navi`; if they run the bin under tsx, the
    // emitted form must remain the absolute tsx command, never a bare `navi` they lack.
    const prefix = invocationPrefix([NODE, PACKAGE_ENTRY, "run"], tsxExecArgv);
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${PACKAGE_ENTRY}`);
  });

  it("a NON-bin directly-executable entry (dist/cli.js) keeps its absolute form (unchanged)", () => {
    // The portable-name rule fires ONLY for a `bin/navi*` entry; a bespoke compiled entry
    // is not the installed `navi` command, so it stays the absolute self-executable path.
    const compiled = `${REPO}/dist/cli.js`;
    expect(invocationPrefix([NODE, compiled], [])).toBe(compiled);
    // and a `navi`-stemmed script NOT under bin/ does not false-trigger the rule.
    expect(invocationPrefix([NODE, `${REPO}/src/navi.js`], [])).toBe(`${REPO}/src/navi.js`);
  });
});

describe("invocationPrefix — project-local install", () => {
  it("honors only the fixed launcher link backed by this running package", () => {
    const launcher = join(LOCAL_SCRATCH, "project", ".agents", "bin", "navi");
    mkdirSync(join(LOCAL_SCRATCH, "project", ".agents", "bin"), { recursive: true });
    symlinkSync(join(LIVE_ROOT, "bin", "navi-local"), launcher);
    const entry = join(LIVE_ROOT, "bin", "navi.mjs");
    process.env.NAVI_INVOKED_AS = launcher;
    process.env.NAVI_INSTALL_ROOT = LIVE_ROOT;

    expect(invocationPrefix([process.execPath, entry], [])).toBe(launcher);

    process.env.NAVI_INSTALL_ROOT = join(LOCAL_SCRATCH, "project");
    expect(invocationPrefix([process.execPath, entry], [])).toBe("navi");
  });
});

describe("invocationPrefix — npx continuation", () => {
  const PACKAGE_ENTRY = `${REPO}/node_modules/@machinepath/navi/bin/navi.mjs`;
  const NPX = { command: "exec", lifecycleEvent: "npx" };

  it("keeps the next command runnable after npx removes its temporary PATH entry", () => {
    expect(runtimeInvocationPrefix([NODE, PACKAGE_ENTRY], [], NPX)).toBe(
      "npm exec --offline --package=@machinepath/navi -- navi-cli",
    );
    expect(
      runtimeInvocationPrefix(
        [NODE, `${REPO}/node_modules/.bin/navi-cli`],
        [],
        NPX,
      ),
    ).toBe("npm exec --offline --package=@machinepath/navi -- navi-cli");
  });

  it("does not override source-checkout or project-local launchers", () => {
    expect(runtimeInvocationPrefix([NODE, PACKAGE_ENTRY], tsxExecArgv, NPX)).toBe(
      `${REPO}/node_modules/.bin/tsx ${PACKAGE_ENTRY}`,
    );

    const launcher = join(LOCAL_SCRATCH, "npx-project", ".agents", "bin", "navi");
    mkdirSync(join(LOCAL_SCRATCH, "npx-project", ".agents", "bin"), {
      recursive: true,
    });
    symlinkSync(join(LIVE_ROOT, "bin", "navi-local"), launcher);
    process.env.NAVI_INVOKED_AS = launcher;
    process.env.NAVI_INSTALL_ROOT = LIVE_ROOT;
    expect(
      runtimeInvocationPrefix(
        [process.execPath, join(LIVE_ROOT, "bin", "navi.mjs")],
        [],
        NPX,
      ),
    ).toBe(launcher);
  });
});

// Node preserves `--import=file://…`, `--require=…`, and `--loader=…` as one
// execArgv element. The assignment prefix is syntax, not part of the loader path,
// so equals and split encodings must derive the same executable.
describe("invocationPrefix — combined equals-form loader flags", () => {
  const importEq = [`--import=file://${REPO}/node_modules/tsx/dist/loader.mjs`];
  const requireEq = [`--require=${REPO}/node_modules/tsx/dist/preflight.cjs`];
  const loaderEq = [`--experimental-loader=file://${REPO}/node_modules/tsx/dist/loader.mjs`];

  it("--import=file://… (one element) derives the tsx bin, not a `--import=file:` garbage token", () => {
    const prefix = invocationPrefix([NODE, CLI], importEq);
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
    expect(prefix).not.toContain("--import=");
    expect(prefix).not.toContain("file:");
  });

  it("--require=… (one element) derives the tsx bin, not a `--require=` garbage token", () => {
    const prefix = invocationPrefix([NODE, CLI], requireEq);
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
    expect(prefix).not.toContain("--require=");
  });

  it("--experimental-loader=file://… (one element) derives the tsx bin", () => {
    expect(invocationPrefix([NODE, CLI], loaderEq)).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
  });
});

// The emitted command is pasted into /bin/sh;
// an install path with a space or a shell metacharacter must still yield the intended
// argv. A path of only safe characters stays VERBATIM so the dialog allowlist prefix
// (`Bash(<repo>/node_modules/.bin/tsx *)`) still matches byte-for-byte.
describe("invocationPrefix — shell-safety of the emitted command", () => {
  const SREPO = "/workspace/My Projects/navi"; // space in the install path
  const sEntry = `${SREPO}/src/cli.ts`;
  const sExec = [
    "--require",
    `${SREPO}/node_modules/tsx/dist/preflight.cjs`,
    "--import",
    `file://${SREPO}/node_modules/tsx/dist/loader.mjs`,
  ];

  it("a space-free install path is emitted VERBATIM (allowlist prefix preserved)", () => {
    // Safe paths remain unquoted so `Bash(<repo>/node_modules/.bin/tsx *)`
    // continues to match the emitted command.
    const prefix = invocationPrefix([NODE, CLI], tsxExecArgv);
    expect(prefix).toBe(`${REPO}/node_modules/.bin/tsx ${CLI}`);
    expect(prefix).not.toContain("'");
  });

  it("a spaced install path single-quotes BOTH tokens (shell-safe, not word-split)", () => {
    const prefix = invocationPrefix([NODE, sEntry], sExec);
    expect(prefix).toBe(
      `'${SREPO}/node_modules/.bin/tsx' '${sEntry}'`,
    );
  });

  it("shellQuote: safe → verbatim; space/metacharacters → single-quoted; empty → ''", () => {
    expect(shellQuote("/workspace/navi/node_modules/.bin/tsx")).toBe(
      "/workspace/navi/node_modules/.bin/tsx",
    );
    expect(shellQuote("edge-walk")).toBe("edge-walk");
    expect(shellQuote("/a b/tsx")).toBe("'/a b/tsx'");
    // metacharacters that a shell would otherwise evaluate ($ ; ` | & > *)
    expect(shellQuote("/a/$x;`id`/tsx")).toBe("'/a/$x;`id`/tsx'");
    // an embedded single quote closes-escapes-reopens
    expect(shellQuote("/it's/tsx")).toBe("'/it'\\''s/tsx'");
    expect(shellQuote("")).toBe("''");
  });

  // The load-bearing proof: the emitted command, run through a REAL /bin/sh -c, splits
  // into exactly the intended argv even when the install path has a space. `for w in
  // <cmd>` lets the shell perform its own word-splitting; a correctly quoted token is
  // one word, so a space-bearing path arrives intact.
  it("round-trips through /bin/sh -c into the intended argv (spaced path)", () => {
    const prefix = invocationPrefix([NODE, sEntry], sExec);
    const cmd = `${prefix} run ${shellQuote("edge-walk")} --json --stdin -t ${shellQuote("abc-123")}`;
    const out = execFileSync("/bin/sh", ["-c", `for w in ${cmd}; do printf '%s\\n' "$w"; done`], {
      encoding: "utf8",
    });
    const words = out.split("\n").filter(Boolean);
    expect(words).toEqual([
      `${SREPO}/node_modules/.bin/tsx`,
      sEntry,
      "run",
      "edge-walk",
      "--json",
      "--stdin",
      "-t",
      "abc-123",
    ]);
  });
});
