import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Gate,
  sessionStatusForGate,
} from "../src/contracts/envelope.ts";
import { exitForGate } from "../src/contracts/whisper.ts";
import { VerdictCode } from "../src/contracts/verdict.ts";
import { statusForTurn } from "../src/session-state.ts";
import { GROUNDING_PASS_MESSAGE } from "../src/search/grader-instructions.ts";

const ROOT = join(import.meta.dirname, "..");
const DOCS = join(ROOT, "docs", "mintlify");
const readRoot = (path: string) => readFileSync(join(ROOT, path), "utf8");
const readPage = (page: string) => readFileSync(join(DOCS, `${page}.mdx`), "utf8");
const config = JSON.parse(readFileSync(join(DOCS, "docs.json"), "utf8")) as {
  navigation: { groups: Array<{ pages: string[] }> };
  redirects: Array<{ source: string; destination: string }>;
};
const pageNames = config.navigation.groups.flatMap(({ pages }) => pages);
const readme = readRoot("README.md");
const publicText = [readme, ...pageNames.map(readPage)].join("\n");
const opencodeRecording = readFileSync(
  join(DOCS, "recordings", "opencode-1.17.13-navi-0.1.0.txt"),
  "utf8",
);
const envExample = readRoot(".env.example");
const testedModels = JSON.parse(readRoot("config/tested-models.json")) as {
  schema_version: string;
  purpose: string;
  runtime: {
    selector: string;
    format: string;
    policy: string;
    default_provider: string;
    router: { name: string; url: string };
    provider_adapters: { name: string; url: string };
  };
  providers: Array<{
    id: string;
    lab: string;
    classification: "direct" | "separate";
    env_keys: string[];
    router_prefix: string;
    models: { quick: string; workflow: string };
    catalog_url: string;
    model_urls: { quick: string; workflow: string };
    compatibility: {
      metadata_host: string;
      list_path: string;
      auth: string;
    };
  }>;
};
const onboardingSurfaces = [
  ["README.md", readme],
  ["quickstart.mdx", readPage("quickstart")],
  ["connect-your-agent.mdx", readPage("connect-your-agent")],
  ["opencode.mdx", readPage("opencode")],
] as const;

const humanAnswerSurfaces = [
  ["README.md", readme],
  ["index.mdx", readPage("index")],
  ["quickstart.mdx", readPage("quickstart")],
  ["ask-decide-check.mdx", readPage("ask-decide-check")],
] as const;

const proofSurfaces = [
  ["README.md", readme],
  ["index.mdx", readPage("index")],
] as const;

const retiredPages = [
  "proof",
  "hard-rails",
  "start",
  "for-your-agent",
  "what-changes-in-your-loop",
  "blast-radius",
  "time-cost",
  "make-it-yours",
  "the-platform-you-inherit",
  "built-on-mastra",
  "latency",
] as const;

describe("public documentation release surface", () => {
  it("pins the local Mintlify validator and disables telemetry", () => {
    const releaseCheck = readRoot("scripts/docs-release-check.mjs");
    expect(releaseCheck).toContain('const MINT_CLI = "mint@4.2.746"');
    expect(releaseCheck.match(/\["--yes", MINT_CLI,/g)).toHaveLength(3);
    expect(releaseCheck).toContain('MINTLIFY_TELEMETRY_DISABLED: "1"');
    expect(releaseCheck).not.toMatch(/args: \["mint",/);
  });

  it("every navigation page and redirect destination exists", () => {
    expect(new Set(pageNames).size).toBe(pageNames.length);
    for (const page of pageNames) {
      expect(existsSync(join(DOCS, `${page}.mdx`)), `missing nav page ${page}.mdx`).toBe(true);
    }
    for (const { destination } of config.redirects) {
      const page = destination.replace(/^\//, "");
      expect(existsSync(join(DOCS, `${page}.mdx`)), `missing redirect target ${destination}`).toBe(true);
    }
  });

  it("keeps retired pages deleted and covered by redirects", () => {
    const sources = new Set(config.redirects.map(({ source }) => source.replace(/^\//, "")));
    for (const page of retiredPages) {
      expect(existsSync(join(DOCS, `${page}.mdx`)), `${page}.mdx must stay retired`).toBe(false);
      expect(sources.has(page), `/${page} needs a redirect`).toBe(true);
    }
  });

  it("installs the scoped package and teaches the short local launcher", () => {
    const install = "npm install --save-dev @machinepath/navi";
    for (const [name, surface] of onboardingSurfaces) {
      const shell = surface.replace(/\\\r?\n\s*/g, "");
      expect(shell, `${name} must install the scoped package`).toContain(install);
      expect(
        shell.indexOf("npx --no-install navi-cli", shell.indexOf(install)),
        `${name} must show the short launcher after package installation`,
      ).toBeGreaterThan(shell.indexOf(install));
    }
    expect(publicText).not.toMatch(/\bnpm (?:i|install)(?: --save-dev)? navi-cli\b/);
    expect(publicText).not.toMatch(/\bnpm (?:i|install)(?: --save-dev)? navi\b/);
    expect(publicText).not.toContain("npx @machinepath/navi");
    expect(publicText).toContain("npx --no-install navi-cli");
    expect(publicText).not.toMatch(/\bnpx navi-cli\b/);
  });

  it("states one product category and the coding-agent relationship", () => {
    for (const [name, surface] of [
      ["README.md", readme],
      ["index.mdx", readPage("index")],
    ] as const) {
      expect(surface, `${name} must name the product category`).toMatch(
        /read-only review CLI for coding agents/i,
      );
    }
    for (const [name, surface] of [
      ["README.md", readme],
      ["index.mdx", readPage("index")],
    ] as const) {
      expect(surface, `${name} must state the division of responsibility`).toMatch(
        /Your coding agent writes\.[\s\S]{0,100}Navi (?:reads and checks|independently reads)/,
      );
    }
  });

  it("keeps the managed-skill route explicit and offline-safe at runtime", () => {
    const connect = readPage("connect-your-agent");
    expect(connect).toContain(
      "https://github.com/machinepathindustries/navi/tree/main/agent/skills/navi-interop",
    );
    expect(connect).toContain("--skill navi-interop");
    expect(connect).toContain("--agent universal");
    expect(connect).toContain("--yes");
    expect(connect).toContain(
      "npm exec --offline --package=@machinepath/navi -- navi-cli",
    );
    expect(connect).toContain(
      "npx skills remove navi-interop --yes",
    );
    expect(connect).not.toContain("skills remove navi-interop --agent '*'");
    expect(connect).toContain(
      "Navi removes only links that still match its ownership receipt.",
    );
  });

  it("documents the verified OpenCode interop path without local machine details", () => {
    const opencode = readPage("opencode");
    expect(opencode).toContain("opencode run");
    expect(opencode).toContain("npx --no-install navi-cli install");
    expect(opencode).toContain(".agents/skills/navi-interop/SKILL.md");
    expect(opencode).toContain("./.agents/bin/navi");
    expect(opencode).toContain("OpenCode and Navi make separate model calls.");
    expect(opencode).toContain("@machinepath/navi@0.1.0");
    expect(opencode).toContain("/usr/bin/script");
    expect(opencode).toContain("complete normalized recording");
    expect(opencode).not.toContain("packed Navi");
    expect(opencode).not.toContain("Navi requested the deep continuation");
    expect(opencode).not.toMatch(/\/Users\/|\/home\/[^<]/i);

    for (const proof of [
      "1.17.13",
      "@machinepath/navi@0.1.0",
      'Skill "navi-interop"',
      '<project>/.agents/bin/navi "What command runs the test suite in this repository?',
      "VERDICT: COMPLETE",
      "OpenCode exit: 0",
      "git status before: clean",
      "git status after: clean",
      "git status unchanged: yes",
    ]) {
      expect(opencodeRecording, `recording is missing ${proof}`).toContain(proof);
    }
    expect(opencodeRecording).not.toMatch(
      /\/Users\/|\/private\/tmp\/navi-opencode|\/tmp\/navi-opencode/i,
    );
    expect(opencodeRecording.toLowerCase()).not.toContain(["mark", "berry"].join(""));
    expect(opencodeRecording).not.toMatch(
      /\b(?:npm_|xai-|sk-(?:proj|svcacct|ant-api\d{2}|or-v1)-)[A-Za-z0-9_-]{20,}\b/,
    );
  });

  it("shows a real grounded result instead of describing an imagined one", () => {
    for (const [name, surface] of proofSurfaces) {
      expect(surface, `${name} needs the observed repository question`).toContain(
        "Where does Navi make repository access read-only?",
      );
      expect(surface, `${name} needs the observed enforcement citation`).toContain(
        "src/mastra/index.ts:70",
      );
      expect(surface).toContain(GROUNDING_PASS_MESSAGE);
    }
    for (const [name, surface] of humanAnswerSurfaces) {
      expect(surface, `${name} must not dump the grader verdict`).not.toContain("VERDICT:");
      expect(surface, `${name} must not dump weak/missing internals`).not.toContain("WEAK/MISSING:");
      expect(surface, `${name} must not dump escalation internals`).not.toContain("ESCALATE:");
    }
    expect(readPage("quickstart")).toContain("A successful first run has three observable parts:");
  });

  it("keeps internal test and account narration out of public documentation", () => {
    const internalNarration = [
      new RegExp(["private", "beta"].join("\\s+"), "i"),
      new RegExp(["authenticated access to", "machinepathindustries/navi"].join("\\s+"), "i"),
      /test account(?:'s)? (?:key|credentials?|quota)/i,
      /our (?:OpenAI )?(?:key|credentials?|quota)/i,
      /\bnonce\b/i,
      /planted[- ]defect/i,
    ];
    for (const phrase of internalNarration) {
      expect(publicText, `public docs contain internal narration: ${phrase}`).not.toMatch(phrase);
    }
  });

  it("teaches the human check command without exposing edge-walk JSON", () => {
    const checkSurfaces = [
      ["README.md", readme],
      ["ask-decide-check.mdx", readPage("ask-decide-check")],
    ] as const;
    for (const [name, surface] of checkSurfaces) {
      expect(surface, `${name} must teach the human completion command`).toContain(
        "npx --no-install navi-cli check",
      );
    }
    for (const [name, surface] of humanAnswerSurfaces) {
      expect(surface, `${name} must not make humans bind edge-walk JSON`).not.toContain(
        "run edge-walk --json --stdin",
      );
      expect(surface, `${name} must not make humans author an event envelope`).not.toMatch(
        /\{"event":\s*"Claim:/,
      );
    }
  });

  it("keeps the structured edge-walk example on integration surfaces", () => {
    const automation = readPage("automation");
    const flow = readPage("flow-schema");
    for (const surface of [automation, flow]) {
      expect(surface).toContain('{"event":"');
      expect(surface).toContain("run edge-walk --json --stdin");
      expect(surface).not.toContain('{"claim":"ready to ship"}');
    }
    const index = readPage("index");
    const sessions = readPage("sessions-and-outcomes");
    expect(index).toContain("/sessions-and-outcomes");
    expect(sessions).toContain("session show <session>");
    expect(sessions).toContain("story <session>");
  });

  it("publishes the manifest's tested targets without turning them into an allowlist", () => {
    const providersPage = readPage("providers");
    const direct = testedModels.providers.filter(
      ({ classification }) => classification === "direct",
    );
    const separate = testedModels.providers.filter(
      ({ classification }) => classification === "separate",
    );

    expect(testedModels.schema_version).toBe("navi.tested-models.v1");
    expect(testedModels.runtime.policy).toBe("open");
    expect(testedModels.purpose).toMatch(/not a runtime allowlist/i);
    expect(separate.map(({ id }) => id)).toEqual(["openrouter"]);

    for (const provider of direct) {
      expect(providersPage, `missing tested ${provider.lab} direct row`).toContain(
        `| [${provider.lab}](${provider.catalog_url}) | \`${provider.env_keys[0]}\` | [\`${provider.models.quick}\`](${provider.model_urls.quick}) | [\`${provider.models.workflow}\`](${provider.model_urls.workflow}) |`,
      );
    }

    for (const provider of testedModels.providers) {
      expect(providersPage).toContain(provider.catalog_url);
      expect(providersPage).toContain(
        `[\`${provider.models.quick}\`](${provider.model_urls.quick})`,
      );
      expect(providersPage).toContain(
        `[\`${provider.models.workflow}\`](${provider.model_urls.workflow})`,
      );
    }
    for (const source of [
      testedModels.runtime.router,
      testedModels.runtime.provider_adapters,
    ]) {
      expect(providersPage).toContain(`[${source.name}](${source.url})`);
    }

    expect(providersPage).toMatch(/tested (?:targets|selections)/i);
    expect(providersPage).toMatch(/does not maintain a runtime allowlist/i);
    expect(providersPage).toMatch(/provider key is available/i);
    expect(providersPage).not.toMatch(/certification snapshot|certified|pending/i);

    for (const provider of direct) {
      const primaryKey = provider.env_keys[0]!;
      expect(envExample, `.env.example is missing ${primaryKey}`).toMatch(
        new RegExp(`^#? ?${primaryKey}=`, "m"),
      );
    }

    const defaultProvider = direct.find(
      ({ id }) => id === testedModels.runtime.default_provider,
    )!;
    expect(readme).toContain(
      `export NAVI_MODEL="${defaultProvider.models.quick}"`,
    );
    expect(readPage("quickstart")).toContain(
      `export NAVI_MODEL="${defaultProvider.models.quick}"`,
    );
    expect(envExample).toContain(
      `# One provider key is enough. The default model is ${defaultProvider.models.quick}.`,
    );
    expect(envExample).toContain(`# NAVI_MODEL=${defaultProvider.models.workflow}`);
    const liveCheck = readRoot("docker/coldstart/live-check.sh");
    expect(liveCheck).toContain('$PACKAGE/config/tested-models.json');
    expect(liveCheck).not.toMatch(/\bNAVI_MODEL=(?:deepseek|anthropic|google|xai|openai|openrouter)\//);
  });

  it("rejects stale or untested concrete model IDs on public surfaces", () => {
    const allowed = new Set(
      testedModels.providers.flatMap(({ models }) => [
        models.quick,
        models.workflow,
      ]),
    );
    const concreteIds =
      publicText.match(
        /\b(?:deepseek|anthropic|google|xai|openai|openrouter)\/[a-z0-9][a-z0-9._/-]*/gi,
      ) ?? [];
    expect([...new Set(concreteIds)].filter((model) => !allowed.has(model))).toEqual([]);

    const allowedNames = new Set(
      [...allowed].map((model) => model.split("/").at(-1)),
    );
    const modelNames =
      publicText.match(
        /\b(?:gpt-\d|claude-(?:haiku|opus|sonnet)-\d|gemini-\d|grok-\d|deepseek-(?:v?\d|chat|reasoner))[a-z0-9.-]*/gi,
      ) ?? [];
    expect(
      [...new Set(modelNames)].filter((model) => !allowedNames.has(model)),
    ).toEqual([]);
  });

  it("renders the product-owned outcome, status, and exit mappings", () => {
    const page = readPage("automation");
    const verdictRows = VerdictCode.options.map((verdict) => {
      const status = statusForTurn({
        kind: "verdict",
        run_id: null,
        workflow: "founder",
        decision: {
          verdict,
          take: "",
          grounding_points: [],
          decision_rules: [],
          what_not_to_do: [],
        },
      });
      return ["Verdict", verdict, status, 0] as const;
    });
    const gateRows = Gate.options.map((gate) =>
      ["Gate", gate, sessionStatusForGate(gate), exitForGate(gate)] as const,
    );
    const rows = [...verdictRows, ...gateRows];
    for (const [kind, result, status, exit] of rows) {
      expect(
        page,
        `missing canonical ${result} → ${status} / ${exit} row`,
      ).toContain(`| ${kind} | \`${result}\` | \`${status}\` | ${exit} |`);
    }
    expect(page).toContain(
      "Exit `0` means Navi produced a valid result. It does not mean the work was",
    );
  });

  it("documents every built-in workflow", () => {
    const page = readPage("built-in-flows");
    const workflows = readdirSync(join(ROOT, "builtin", "workflows")).filter(
      (name) => existsSync(join(ROOT, "builtin", "workflows", name, "action.yaml")),
    );
    for (const workflow of workflows) {
      expect(page, `missing built-in flow ${workflow}`).toContain(`\`${workflow}\``);
    }
  });
});
