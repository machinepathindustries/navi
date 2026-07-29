import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, it, expect, afterAll } from "vitest";
import { deepHandoffCommand } from "../src/invocation.ts";
import { handleOf } from "../src/session-view.ts";

// Exercise the CLI paths that need no model, as a real subprocess — the honest
// way to prove flag wiring and exit codes. Model-driven paths
// are proven by the live gate, not here.

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const CLI = join(ROOT, "src/cli.ts");
const FIXTURE = "tests/fixtures/hello-two-step/action.yaml";

// Every real CLI subprocess gets a throwaway database. Controlling cwd does not
// isolate the user-owned default ledger.
const DB_DIR = mkdtempSync(join(tmpdir(), "navi-cli-test-"));
const TEST_ENV = { ...process.env, NAVI_DB: `file:${join(DB_DIR, "navi.db")}` };

afterAll(() => {
  rmSync(DB_DIR, { recursive: true, force: true });
});

function navi(args: string[], input?: string) {
  const r = spawnSync(TSX, [CLI, ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    timeout: 60_000,
    env: TEST_ENV,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("navi CLI — no-model paths + exit map", () => {
  it("prints release-facing help and exits 0", () => {
    const r = navi(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/navi run <name\|path>/);
    expect(r.stdout).toMatch(/navi check "<claim>"/);
    expect(r.stdout).toMatch(/List discovered skills \+ flows/);
    expect(r.stdout).toMatch(/Create interop \+ launcher symlinks and an ownership receipt/);
    expect(r.stdout).toMatch(/Remove those owned links and receipt; preserve everything else/);
    expect(r.stdout).toMatch(/--progress <mode>\s+Progress on stderr: off \| live \| jsonl/);
    expect(r.stdout).toMatch(/0 completed \(inspect --json gate\/verdict\)/);
    expect(r.stdout).not.toMatch(/0 ok/);
    expect(r.stdout).not.toMatch(/skills \+ actions|parent-harness/);
  });

  it("--shape prints the resolved plan and exits 0 without a model call", () => {
    const r = navi(["run", FIXTURE, "--shape"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/extract/);
    expect(r.stdout).toMatch(/summarize/);
    expect(r.stdout).toMatch(/depends=\[extract\]/);
  });

  it("--shape --json emits a JSON plan with both steps", () => {
    const r = navi(["run", FIXTURE, "--shape", "--json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.steps.map((s: { name: string }) => s.name)).toEqual(["extract", "summarize"]);
    expect(plan.name).toBe("hello-two-step");
  });

  it("an unknown workflow is a load failure → exit 1", () => {
    expect(navi(["run", "no-such-workflow"]).code).toBe(1);
  });

  it("invalid --stdin JSON is a schema failure → exit 4", () => {
    const r = navi(["run", FIXTURE, "--stdin"], "not json {");
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/invalid stdin JSON/);
  });

  it("a missing required arg is an input schema failure → exit 4", () => {
    expect(navi(["run", FIXTURE]).code).toBe(4);
  });

  it("-t refuses an unknown session instead of silently starting from blank", () => {
    const id = `missing-session-${Date.now()}`;
    const run = navi(["run", FIXTURE, "topic", "-t", id]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`no session named "${id}"`));
    expect(run.stderr).toMatch(/navi session list/);

    const bare = navi(["where is retry?", "-t", id]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toMatch(new RegExp(`no session named "${id}"`));
  });

  // A value-taking flag with no value (immediately followed by another flag or the
  // end of input) is an honest usage error — never a silent swallow of the next
  // flag's name that would drop --shape and fire a real paid model run instead.
  // Keyless: the guard trips in parseArgs, before any model or workflow is reached.
  it("a value flag with no value is refused (never swallows the next flag) → exit 1", () => {
    // `-t --shape` must treat "--shape" as a flag, not a session id, and stop
    // during argument parsing rather than starting a workflow.
    const swallow = navi(["run", FIXTURE, "-t", "--shape"]);
    expect(swallow.code).toBe(1);
    expect(swallow.stderr).toMatch(/-t requires a value/);
    expect(swallow.stderr).toMatch(/-t <session_id> continues a previous session — ids from: navi session list/);
    // Same guard on a bare-query tuning flag, and at end-of-input.
    const dangling = navi(["what is 2+2", "--max-steps"]);
    expect(dangling.code).toBe(1);
    expect(dangling.stderr).toMatch(/--max-steps requires a value \(got end of input\)/);
    const adjacent = navi(["q", "--thinking", "--json"]);
    expect(adjacent.code).toBe(1);
    expect(adjacent.stderr).toMatch(/--thinking requires a value \(got "--json"\)/);
  });

  // A typo flag (e.g. `--verison`) must NEVER fall through as a positional and
  // become a paid bare-query model call on the literal typo text. Loud usage error
  // in parseArgs, keyless, exit 1.
  it("an unknown flag is a loud usage error (never a paid bare-query) → exit 1", () => {
    const r = navi(["--verison"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown flag "--verison"/);
    expect(r.stderr).toMatch(/navi --help for the flag reference/);
    // No model path: stdout must stay empty (no answer text, no whisper).
    expect(r.stdout).toBe("");
  });

  // --version / -V: print `navi <version>` from package.json, exit 0, zero model.
  it("--version and -V print navi <version> and exit 0", () => {
    const long = navi(["--version"]);
    expect(long.code).toBe(0);
    expect(long.stdout.trim()).toMatch(/^navi \d+\.\d+\.\d+/);
    const short = navi(["-V"]);
    expect(short.code).toBe(0);
    expect(short.stdout.trim()).toBe(long.stdout.trim());
  });
});

describe("navi CLI — human check alias over edge-walk", () => {
  function edgeWalkFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "navi-check-"));
    const flowDir = join(dir, ".navi/workflows/edge-walk");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(
      join(flowDir, "action.yaml"),
      `name: edge-walk
description: Model-free edge-walk override for the human check alias.
args:
  input:
    type: json
    required: true
steps:
  - name: judge
    type: command
    command: >-
      printf '%s' '{"gate":"CLEAR","reason":"{{ input.event }}","blocking_directive_ids":[],"non_blocking_risks":[],"human_escalation":null,"confidence":1}'
`,
    );
    return dir;
  }

  it("wraps positional prose for edge-walk and records it as the session task", () => {
    const dir = edgeWalkFixture();
    try {
      const run = navi(["check", "the install path is ready", "-w", dir, "--json"]);
      expect(run.code).toBe(0);
      const env = JSON.parse(run.stdout) as {
        session_id: string;
        workflow: string;
        gate: string;
        result: { reason: string };
        next: { command: string | null };
      };
      expect(env).toMatchObject({
        workflow: "edge-walk",
        gate: "CLEAR",
        result: { reason: "the install path is ready" },
      });
      expect(env.next.command).toMatch(/run edge-walk --json --stdin -t /);

      const story = navi(["story", env.session_id, "--json"]);
      expect(story.code).toBe(0);
      const view = JSON.parse(story.stdout) as {
        task: string;
        beats: { lines: string[] }[];
      };
      expect(view.task).toBe("the install path is ready");
      expect(view.beats.flatMap((beat) => beat.lines)).toContain(
        "parent: the install path is ready",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps human continuation readable and machine continuation structured", () => {
    const dir = edgeWalkFixture();
    try {
      const human = navi(["check", "the release is complete", "-w", dir]);
      expect(human.code).toBe(0);
      expect(human.stdout).toMatch(/check '<new evidence>' -t /);
      expect(human.stdout).toContain("replace `<new evidence>`");
      expect(human.stdout).not.toMatch(/--json --stdin/);

      const machine = navi(
        ["check", "--stdin", "--json", "-w", dir],
        JSON.stringify({ event: "machine transport" }),
      );
      expect(machine.code).toBe(0);
      const env = JSON.parse(machine.stdout) as {
        result: { reason: string };
        next: { command: string | null };
      };
      expect(env.result.reason).toBe("machine transport");
      expect(env.next.command).toMatch(/run edge-walk --json --stdin -t /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing and ambiguous human input before any workflow run", () => {
    const missing = navi(["check"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/missing claim/);

    const ambiguous = navi(["check", "claim", "--stdin"], JSON.stringify({ event: "other" }));
    expect(ambiguous.code).toBe(4);
    expect(ambiguous.stderr).toMatch(/choose positional text or --stdin/);
  });
});

// The three bare-query tuning flags validate BEFORE any model call, so their
// failure paths are keyless (no DEEPSEEK_API_KEY needed) — the honest way to prove
// the parse without spending a token.
describe("navi CLI — bare-query tuning flags validate before the model call", () => {
  it("--max-steps rejects a non-positive-integer, exits 1, never reaches a model", () => {
    for (const bad of ["0", "abc", "-3", "2.5"]) {
      const r = navi([`what is 2+2`, "--max-steps", bad]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--max-steps must be a positive integer/);
    }
  });

  it("--thinking and --reasoning-effort reject out-of-enum values, exit 1", () => {
    const t = navi(["q", "--thinking", "sometimes"]);
    expect(t.code).toBe(1);
    expect(t.stderr).toMatch(/--thinking must be adaptive\|enabled\|disabled/);
    const e = navi(["q", "--reasoning-effort", "extreme"]);
    expect(e.code).toBe(1);
    expect(e.stderr).toMatch(/--reasoning-effort must be low\|medium\|high\|xhigh\|max/);
  });

  // Help is a deterministic CLI surface and must never spend a model call.
  it("`navi help` prints the front door with no model call", () => {
    const r = navi(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/flows · when to reach for each/);
    expect(r.stdout).not.toMatch(/scanned the repo|quick pass/);
  });

  it("`navi help <flow>` and `navi run <flow> --help` are the same request", () => {
    const a = navi(["help", "founder"]);
    const b = navi(["run", "founder", "--help"]);
    const c = navi(["help", "run", "founder"]);
    for (const r of [a, b, c]) {
      expect(r.code).toBe(0);
      // Flow help reads argument descriptions from the resolved shape because
      // catalog entries intentionally omit them.
      expect(r.stdout).toMatch(/artifact-grounded judgment/);
      expect(r.stdout).toMatch(/navi run founder "<request>"/);
    }
    expect(a.stdout).toBe(b.stdout);
    expect(c.stdout).toBe(b.stdout);
  });

  // The invocation line is copyable: JSON arguments bind through --stdin, using
  // the same argument-token derivation as the catalog.
  it("a json-typed arg shows --stdin, not a positional placeholder", () => {
    const r = navi(["help", "edge-walk"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/navi run edge-walk --stdin/);
    expect(r.stdout).not.toMatch(/navi run edge-walk <input>/);
  });

  it("`navi help <path>` works, as HELP advertises", () => {
    // Accepting only catalog NAMES made the documented behaviour silently false:
    // a path printed the generic front door and exited 0.
    const r = navi(["help", "tests/fixtures/gate-command/action.yaml"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gate-command/);
    expect(r.stdout).not.toMatch(/flows · when to reach for each/);
  });

  it("flow help resolves a PATH token, which the name-keyed catalog cannot", () => {
    const r = navi(["run", "tests/fixtures/gate-command/action.yaml", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/gate-command/);
    expect(r.stdout).toMatch(/CLEAR\|DIRECT\|REPAIR/);
  });

  it("`navi help <not-a-flow>` keeps the front door instead of erroring or querying", () => {
    const r = navi(["help", "nonsense"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/flows · when to reach for each/);
    expect(r.stderr).not.toMatch(/no such/);
  });

  it("the help path validates -w like every verb, instead of silently ignoring it", () => {
    const r = navi(["--help", "-w", "/nonexistent-navi-dir"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/-w: no such directory/);
  });

  it("deepseek-native flags on a non-deepseek NAVI_MODEL are refused loudly (never silently dropped)", () => {
    const r = spawnSync(TSX, [CLI, "q", "--thinking", "enabled"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...TEST_ENV, NAVI_MODEL: "anthropic/claude-x" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DeepSeek-only, but model is "anthropic\/claude-x"/);
  });

  it("the quick-lane deep handoff continues on the same session", () => {
    expect(
      deepHandoffCommand(
        "where does retry stop?",
        "session-123",
        "/repo with spaces",
        "navi",
      ),
    ).toBe(
      "navi 'where does retry stop?' -w '/repo with spaces' -t session-123 --deep",
    );
  });
});

// The command-JSON unwrap + verdict-aware next block, proven end-to-end through a
// real subprocess run of a MODEL-FREE fixture (a single JSON-emitting command
// step). Keyed on the result's `verdict` field, not the workflow name.
describe("navi CLI — command-JSON unwrap + verdict-aware next (model-free)", () => {
  const JSON_CMD = "tests/fixtures/json-command/action.yaml";
  const ECHO_CMD = "tests/fixtures/echo-command/action.yaml";
  const FAIL_CMD = "tests/fixtures/failing-command/action.yaml";

  function envelopeOf(args: string[]) {
    const r = navi(["run", ...args, "--json"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as {
      session_id: string;
      gate: string | null;
      verdict: string | null;
      result: Record<string, unknown>;
      next: { instruction: string; command: string | null };
    };
    const shown = navi(["session", "show", env.session_id, "--json"]);
    expect(shown.code, `returned session ${env.session_id} must resolve`).toBe(0);
    return env;
  }

  it("REFINE: result is the parsed verdict object; next names the fix and bakes the -t re-run", () => {
    const env = envelopeOf([JSON_CMD, "REFINE"]);
    // result is the CLEAN parsed object, not the {stdout,stderr,exitCode} wrapper.
    expect(env.result.verdict).toBe("REFINE");
    expect(env.result).not.toHaveProperty("stdout");
    expect(env.next.instruction).toMatch(/Verdict REFINE/);
    // the fix is named from the verdict's own decision_rules.
    expect(env.next.instruction).toMatch(/tighten the schema first/);
    // REFINE keeps the baked re-run command.
    expect(env.next.command).toMatch(/run .*json-command.* '<verdict>' -t /);
    expect(env.gate).toBeNull();
    expect(env.verdict).toBe("REFINE");
    const filtered = navi(["session", "list", "--verdict", "REFINE", "--json"]);
    expect(filtered.code).toBe(0);
    expect(
      (JSON.parse(filtered.stdout) as Array<{ session_id: string }>).some(
        (row) => row.session_id === env.session_id,
      ),
    ).toBe(true);

    // The human list prints a word handle, so -t must accept that exact public
    // token and still append on the underlying session id.
    const handle = handleOf(env.session_id);
    const listed = navi(["session", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(handle);
    const continued = navi(["run", JSON_CMD, "GO", "-t", handle, "--json"]);
    expect(continued.code).toBe(0);
    const next = JSON.parse(continued.stdout) as { session_id: string; verdict: string | null };
    expect(next).toEqual(expect.objectContaining({ session_id: env.session_id, verdict: "GO" }));
  });

  it("GO: proceeds with no re-run (command null); REJECT: stops (command null)", () => {
    const go = envelopeOf([JSON_CMD, "GO"]);
    expect(go.result.verdict).toBe("GO");
    expect(go.next.instruction).toMatch(/Verdict GO — proceed as scoped/);
    expect(go.next.command).toBeNull();

    const rej = envelopeOf([JSON_CMD, "REJECT"]);
    expect(rej.result.verdict).toBe("REJECT");
    expect(rej.next.instruction).toMatch(/Verdict REJECT — stop/);
    expect(rej.next.command).toBeNull();
  });

  // A verdict-shaped command tail (founder's structural shape: the final step is a
  // command emitting a verdict object, not an agent) is glossed for `summary` from
  // its parsed verdict + take — NOT from a previous step's raw text. Proven on the
  // human render, whose first line IS env.summary.
  it("a command-tail verdict result is glossed from verdict + take, not a raw dump", () => {
    const r = navi(["run", JSON_CMD, "GO"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("GO — a test take");
  });

  it("a non-JSON command's output stays the honest {stdout,…} wrapper — never a guessed parse", () => {
    const env = envelopeOf([ECHO_CMD]);
    expect(env.result.stdout).toMatch(/plain-text-not-json/);
    expect(env.result).toHaveProperty("exitCode");
    // no verdict → the default continuation next, with the re-run command intact.
    expect(env.next.instruction).toMatch(/Workflow complete/);
    expect(env.next.command).toMatch(/run .*echo-command.* -t /);
    expect(env.gate).toBeNull();
    expect(env.verdict).toBeNull();
  });

  it("a post-thread workflow failure is recorded on the returned session", () => {
    const r = navi(["run", FAIL_CMD, "--json"]);
    expect(r.code).toBe(1);
    const env = JSON.parse(r.stdout) as {
      session_id: string;
      status: string;
      gate: string | null;
      verdict: string | null;
    };
    expect(env).toMatchObject({ status: "failed", gate: null, verdict: null });

    const shown = navi(["session", "show", env.session_id, "--json"]);
    expect(shown.code).toBe(0);
    const view = JSON.parse(shown.stdout) as {
      current: { latest_turn: { kind: string; reason?: string } };
    };
    expect(view.current.latest_turn).toMatchObject({
      kind: "failure",
      reason: expect.stringMatching(/fixture failed|exit/i),
    });
  });
});

// -w overrides the workspace root for any command. catalog is the model-free way
// to PROVE the override resolved to another tree (its listing is a pure filesystem
// pass), and a bad -w dir is a loud usage error before any work — keyless throughout.
describe("navi CLI — -w workspace override (model-free)", () => {
  it("-w <dir> reads that dir's CONSUMER tiers; the builtin tier ships with navi", () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-w-"));
    try {
      // A scratch project tier with one skill; the -w dir has no builtin/ of its
      // own. Consumer tiers (project/pinned) resolve from -w; the builtin tier
      // anchors at the navi install root and appears regardless of -w.
      mkdirSync(join(dir, ".navi/skills/scratch-skill"), { recursive: true });
      writeFileSync(
        join(dir, ".navi/skills/scratch-skill/SKILL.md"),
        `---\nname: scratch-skill\ndescription: "a scratch skill under -w"\n---\n\n# body\n`,
      );
      const r = navi(["catalog", "-w", dir, "--json"]);
      expect(r.code).toBe(0);
      const cat = JSON.parse(r.stdout) as {
        skills: { name: string; tier: string }[];
        workflows: { name: string; tier: string }[];
      };
      // the project tier is read from -w: exactly the scratch skill, and no pinned
      // tier exists under -w.
      expect(cat.skills.filter((s) => s.tier === "project").map((s) => s.name)).toEqual(["scratch-skill"]);
      expect(cat.skills.some((s) => s.tier === "pinned")).toBe(false);
      // the builtin tier comes from the navi install, not the scratch dir:
      // present, labeled builtin, and never labeled project.
      expect(cat.skills.filter((s) => s.tier === "builtin").map((s) => s.name)).toContain("code-search");
      expect(cat.workflows.every((w) => w.tier === "builtin")).toBe(true);
      expect(cat.workflows.map((w) => w.name)).toContain("edge-walk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("-w a nonexistent dir is a loud usage error → exit 1", () => {
    const r = navi(["catalog", "-w", "/no/such/navi/dir/xyz"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/-w: no such directory "\/no\/such\/navi\/dir\/xyz"/);
  });

  it("-w a FILE (not a directory) is refused → exit 1", () => {
    const r = navi(["catalog", "-w", "package.json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/-w: not a directory "package.json"/);
  });
});

// --fork clones a thread and continues on the clone; without -t there is nothing
// to fork — a loud, model-free usage error (never a silent no-op). The guard trips
// before any model call, so these are keyless even with a key present.
describe("navi CLI — --fork thread fork guard (model-free)", () => {
  it("--fork without -t is refused with a loud error → exit 1", () => {
    const r = navi(["what is 2+2", "--fork"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--fork needs a source session/);
  });

  it("--fork parses as a boolean flag (a value flag before it still needs its own value)", () => {
    // `-t --fork` proves --fork is a RECOGNIZED flag: -t sees it as the next flag,
    // not a thread-id value, so it's the honest missing-value error — never a swallow.
    const r = navi(["q", "-t", "--fork"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/-t requires a value \(got "--fork"\)/);
  });
});

// edge-walk's `input` is a required JSON argument.
// Both loud paths trip at input binding — BEFORE any compile or model call — so they
// are keyless. They also exercise FIX 2 in-repo: `edge-walk` resolves BY NAME from
// the install-root builtin tier (cwd == install root here).
describe("navi CLI — edge-walk json-arg loud paths (model-free, by name)", () => {
  it("positional prose on the json `input` arg is refused, naming --stdin → exit 4", () => {
    const r = navi(["run", "edge-walk", "some prose interpretation"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/arg "input" is JSON-typed — provide it via --stdin/);
  });

  it("no --stdin and no positional → the loud missing-required-arg error, no model → exit 4", () => {
    const r = navi(["run", "edge-walk"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/missing required arg\(s\): input/);
  });
});

// --stdin binds the whole stdin object to the workflow's declared json arg BY NAME
// (not the hardcoded literal `input`), applies defaults for the other args, and runs
// the same required-arg check the positional path runs. Both are keyless: the
// binding + required check trip at input binding, and the command step needs no model.
describe("navi CLI — --stdin binds by declared json-arg name + required-arg check (model-free)", () => {
  function tmpWorkflow(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "navi-stdin-"));
    const path = join(dir, "action.yaml");
    writeFileSync(path, yaml);
    return path;
  }

  it("a json arg named something OTHER than `input` binds the stdin object correctly", () => {
    // Binding must follow the declared name rather than assuming a literal
    // `input` field.
    const path = tmpWorkflow(`
name: json-name-test
args:
  payload:
    type: json
    required: true
steps:
  - name: s
    type: command
    command: echo bound
`);
    const dir = join(path, "..");
    try {
      const r = navi(["run", path, "--stdin", "--json"], JSON.stringify({ hello: "world" }));
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as {
        status: string;
        gate: string | null;
        verdict: string | null;
      };
      expect(env).toMatchObject({ status: "active", gate: null, verdict: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a required NON-stdin arg missing on a --stdin run errs loudly at the boundary → exit 4", () => {
    // the json arg binds from stdin, but a second required arg (no default) is
    // unfilled. Required-argument validation applies to both input transports.
    const path = tmpWorkflow(`
name: json-plus-required
args:
  payload:
    type: json
    required: true
  extra:
    required: true
steps:
  - name: s
    type: command
    command: echo ok
`);
    const dir = join(path, "..");
    try {
      const r = navi(["run", path, "--stdin", "--json"], JSON.stringify({ hello: "world" }));
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/missing required arg\(s\): extra/);
      expect(r.stdout).toBe(""); // no envelope — refused before compile/model
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The repo ships a .env.example and start.mdx told readers to copy it and put a
// provider key in it. Nothing loaded it — a key placed there produced
// "Could not find API key process.env.DEEPSEEK_API_KEY" on the one page whose job
// is the first five minutes. Found by an audit of the docs against the code.
describe("navi loads .env, and an explicit variable still wins", () => {
  it("reads a variable from .env in the current directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-envfile-"));
    writeFileSync(join(dir, ".env"), "NAVI_ENV_PROBE=from-file\n");
    const r = spawnSync(TSX, [join(ROOT, "src/cli.ts"), "--version"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...TEST_ENV, NAVI_ENV_PROBE: undefined },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/loaded 1 variable from \.env/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never overrides a variable that is already set", () => {
    // --ephemeral sets NAVI_DB, CI sets secrets, and `KEY=x navi …` is explicit.
    // A file someone forgot about must not silently win over any of them.
    const dir = mkdtempSync(join(tmpdir(), "navi-envwin-"));
    writeFileSync(join(dir, ".env"), "NAVI_ENV_PROBE=from-file\n");
    const r = spawnSync(TSX, [join(ROOT, "src/cli.ts"), "--version"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...TEST_ENV, NAVI_ENV_PROBE: "from-environment" },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/loaded \d+ variable/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is silent and harmless when there is no .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "navi-noenv-"));
    const r = spawnSync(TSX, [join(ROOT, "src/cli.ts"), "--version"], {
      cwd: dir, encoding: "utf8", timeout: 60_000, env: TEST_ENV,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/\.env/);
    rmSync(dir, { recursive: true, force: true });
  });
});
