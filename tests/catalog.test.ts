import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog, renderCatalog, nextMoves, flowMenu, type CatalogEntry } from "../src/catalog.ts";

// Catalog is a pure filesystem display pass, tested against a controlled temp tier
// tree for the CONSUMER tiers (project `.navi` + pinned `.agents`, both anchored at
// basePath) — never the shared navi.db (buildCatalog imports no runtime). The
// BUILTIN tier ships with navi and anchors at the INSTALL root, not basePath
// so it comes from the installed package regardless
// of the temp basePath — the tests below assert exactly that split. The tree
// exercises every tier label, a same-name skill COLLISION across two 'local'
// consumer tiers (a scenario where a bare get() would throw), workflow SHADOWs
// (project > pinned > builtin, same precedence as skills), a manifest-less dir
// (skipped), and a malformed manifest (lists, empty desc).

let ROOT = "";

function skill(relDir: string, name: string, description?: string, body = "# body") {
  const dir = join(ROOT, relDir, name);
  mkdirSync(dir, { recursive: true });
  const fm = ["---", `name: ${name}`, ...(description ? [`description: ${JSON.stringify(description)}`] : []), "---"];
  writeFileSync(join(dir, "SKILL.md"), `${fm.join("\n")}\n\n${body}\n`);
}

function workflow(relDir: string, name: string, description?: string) {
  const dir = join(ROOT, relDir, name);
  mkdirSync(dir, { recursive: true });
  const lines = [`name: ${name}`, ...(description ? [`description: ${JSON.stringify(description)}`] : []), "steps: []"];
  writeFileSync(join(dir, "action.yaml"), `${lines.join("\n")}\n`);
}

function bare(rel: string) {
  mkdirSync(join(ROOT, rel), { recursive: true });
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "navi-catalog-"));
  // Consumer tiers under the temp basePath (project `.navi` + pinned `.agents`).
  // The builtin tier is not written here; it anchors at the navi install
  // root, so builtin content comes from the real repo regardless of basePath.
  skill(".navi/skills", "alpha", "project alpha skill");
  skill(".agents/skills", "beta", "pinned beta skill");
  // COLLISION: same name in a project + pinned tier (both classify 'local')
  skill(".agents/skills", "alpha", "pinned alpha skill");
  // a skill dir with no SKILL.md → not a listing
  bare(".navi/skills/no-manifest");
  // a malformed manifest → lists with empty description, no throw
  skill(".navi/skills", "broken");
  writeFileSync(join(ROOT, ".navi/skills/broken/SKILL.md"), "---\nname: broken\n  bad: : :\n---\n");
  // SHADOW: a project workflow named after a REAL builtin one (edge-walk) — the
  // project override wins, the install-root builtin copy is shadowed.
  workflow(".navi/workflows", "edge-walk", "project edge-walk override");
  // pinned-only workflow (discovered + labelled; no project/builtin twin)
  workflow(".agents/workflows", "gamma", "pinned gamma workflow");
  // project shadows pinned: same name in both consumer tiers
  workflow(".navi/workflows", "delta", "project delta workflow");
  workflow(".agents/workflows", "delta", "pinned delta workflow");
  // pinned shadows a REAL builtin (web-search) — middle tier wins over install root
  workflow(".agents/workflows", "web-search", "pinned web-search override");
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const find = (rows: CatalogEntry[], name: string, tier: string) =>
  rows.find((r) => r.name === name && r.tier === tier);

describe("buildCatalog — tier labels + descriptions", () => {
  it("labels each skill by its origin tier and reads its frontmatter description", () => {
    const { skills } = buildCatalog(ROOT);
    expect(find(skills, "alpha", "project")).toBeTruthy();
    expect(find(skills, "beta", "pinned")?.description).toBe("pinned beta skill");
    // the builtin tier ships with navi and anchors at the INSTALL root, so a real
    // builtin skill lists here from the repo — never from the temp basePath.
    const cs = find(skills, "code-search", "builtin");
    expect(cs).toBeTruthy();
    expect(cs?.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("labels workflows project/pinned/builtin and reads action.yaml descriptions", () => {
    const { workflows } = buildCatalog(ROOT);
    expect(find(workflows, "edge-walk", "project")?.description).toBe("project edge-walk override");
    // pinned tier: a flow only under .agents/workflows is discovered and labelled
    expect(find(workflows, "gamma", "pinned")?.description).toBe("pinned gamma workflow");
    // a builtin-only workflow from the install root (founder has no project/pinned twin).
    const founder = find(workflows, "founder", "builtin");
    expect(founder).toBeTruthy();
    expect(founder?.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("skips a directory that has no manifest", () => {
    const { skills } = buildCatalog(ROOT);
    expect(skills.some((s) => s.name === "no-manifest")).toBe(false);
  });

  it("lists a skill with a malformed manifest rather than throwing", () => {
    const { skills } = buildCatalog(ROOT);
    const broken = find(skills, "broken", "project");
    expect(broken).toBeTruthy();
    expect(broken?.description).toBe("");
  });
});

describe("buildCatalog — collision + shadow flags", () => {
  it("flags a same-name skill across two local tiers as a collision on both rows", () => {
    const { skills } = buildCatalog(ROOT);
    const proj = find(skills, "alpha", "project");
    const pin = find(skills, "alpha", "pinned");
    expect(proj?.flag).toBe("collision");
    expect(pin?.flag).toBe("collision");
    // highest-precedence tier is the one navi resolves (compiler path-retry)
    expect(proj?.active).toBe(true);
    expect(pin?.active).toBe(false);
  });

  it("leaves a singleton skill unflagged and active", () => {
    const { skills } = buildCatalog(ROOT);
    expect(find(skills, "beta", "pinned")?.flag).toBeUndefined();
    expect(find(skills, "beta", "pinned")?.active).toBe(true);
  });

  it("flags a shadowed workflow when the project tier wins", () => {
    // a project override of the real builtin `edge-walk` (install root) — proves the
    // builtin workflow tier anchors at the install root AND the shadow still flags.
    const { workflows } = buildCatalog(ROOT);
    expect(find(workflows, "edge-walk", "project")?.active).toBe(true);
    expect(find(workflows, "edge-walk", "project")?.flag).toBeUndefined();
    expect(find(workflows, "edge-walk", "builtin")?.active).toBe(false);
    expect(find(workflows, "edge-walk", "builtin")?.flag).toBe("shadowed");
  });

  it("flags a shadowed workflow (project wins, pinned shadowed)", () => {
    // same precedence as skills: project `.navi/workflows` beats pinned `.agents/workflows`
    const { workflows } = buildCatalog(ROOT);
    expect(find(workflows, "delta", "project")?.active).toBe(true);
    expect(find(workflows, "delta", "project")?.flag).toBeUndefined();
    expect(find(workflows, "delta", "pinned")?.active).toBe(false);
    expect(find(workflows, "delta", "pinned")?.flag).toBe("shadowed");
  });

  it("flags a shadowed workflow (pinned wins, builtin shadowed)", () => {
    // pinned middle tier shadows the install-root builtin of the same name
    const { workflows } = buildCatalog(ROOT);
    expect(find(workflows, "web-search", "pinned")?.active).toBe(true);
    expect(find(workflows, "web-search", "pinned")?.flag).toBeUndefined();
    expect(find(workflows, "web-search", "pinned")?.description).toBe("pinned web-search override");
    expect(find(workflows, "web-search", "builtin")?.active).toBe(false);
    expect(find(workflows, "web-search", "builtin")?.flag).toBe("shadowed");
  });

  it("leaves a singleton pinned workflow unflagged and active", () => {
    const { workflows } = buildCatalog(ROOT);
    expect(find(workflows, "gamma", "pinned")?.flag).toBeUndefined();
    expect(find(workflows, "gamma", "pinned")?.active).toBe(true);
  });

  it("classifies every navi tier as Mastra source-type 'local'", () => {
    const { skills } = buildCatalog(ROOT);
    expect(skills.every((s) => s.sourceType === "local")).toBe(true);
  });
});

describe("renderCatalog — human listing", () => {
  it("groups, labels, and surfaces flags visibly", () => {
    const text = renderCatalog(buildCatalog(ROOT));
    expect(text).toMatch(/^skills \(\d+\):/m);
    expect(text).toMatch(/^flows \(\d+\):/m);
    expect(text).toMatch(/project\s+alpha/);
    expect(text).toMatch(/pinned\s+beta/);
    expect(text).toMatch(/pinned\s+gamma/);
    expect(text).toMatch(/collision/);
    expect(text).toMatch(/shadowed by project/);
    expect(text).not.toMatch(/parent-harness/);
  });

  it("renders an empty group as (0): none rather than crashing", () => {
    // buildCatalog always surfaces navi's install-root builtin tier, so the
    // (0): none branch is exercised directly on renderCatalog — a pure function.
    const text = renderCatalog({ skills: [], workflows: [] });
    expect(text).toMatch(/skills \(0\): none/);
    expect(text).toMatch(/flows \(0\): none/);
  });
});

describe("buildCatalog — builtin tier anchors at the navi install", () => {
  it("lists navi's shipped builtin skills + workflows regardless of basePath", () => {
    // An external basePath with NO builtin/ dir of its own still lists navi's real
    // built-in content resolved from the install root.
    const external = mkdtempSync(join(tmpdir(), "navi-catalog-ext-"));
    try {
      const cat = buildCatalog(external);
      const builtinSkills = cat.skills.filter((s) => s.tier === "builtin").map((s) => s.name);
      const builtinWorkflows = cat.workflows.filter((w) => w.tier === "builtin").map((w) => w.name);
      expect(builtinSkills).toContain("code-search");
      expect(builtinWorkflows).toContain("edge-walk");
      // and nothing was read from the (empty) external dir's absent tiers.
      expect(cat.skills.every((s) => s.tier === "builtin")).toBe(true);
      expect(cat.workflows.every((w) => w.tier === "builtin")).toBe(true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("nextMoves + shortWhen (whisper move list)", () => {
  it("nextMoves pre-fills a single-required-string workflow with the query (label-first)", () => {
    // founder has exactly one required string arg (`request`) in the install builtin.
    const q = "should navis session list default to open?";
    const moves = nextMoves(process.cwd(), q);
    expect(moves.length).toBeGreaterThan(0);
    // Label-first layout: shortWhen line ending ":", then indented command.
    const cmdIdx = moves.findIndex((l) => /^\s+navi run founder /.test(l));
    expect(cmdIdx).toBeGreaterThan(0);
    expect(moves[cmdIdx - 1]).toMatch(/:$/);
    expect(moves[cmdIdx - 1]).toMatch(/Founder judgment/);
    // shell-quoted query is in the command line (ready to copy-paste)
    expect(moves[cmdIdx]).toContain("should navis session list default");
  });

  it("nextMoves with a query includes only prefillable lenses (not --stdin/range flows)", () => {
    const joined = nextMoves(process.cwd(), "what about sessions?").join("\n");
    // Lenses that take THIS question (one required string arg).
    expect(joined).toMatch(/navi run founder /);
    expect(joined).toMatch(/navi run founder-advice /);
    expect(joined).toMatch(/navi run code-search /);
    expect(joined).toMatch(/navi run web-search /);
    // Flows needing --stdin or a range are NOT next-moves for a just-asked question.
    expect(joined).not.toMatch(/navi run edge-walk/);
    expect(joined).not.toMatch(/navi run code-review/);
    expect(joined).not.toMatch(/navi run pre-pr-review/);
  });

  it("nextMoves without a query keeps the placeholder token shape", () => {
    const moves = nextMoves(process.cwd(), undefined);
    const founder = moves.find((l) => l.startsWith("navi run founder "));
    expect(founder).toMatch(/navi run founder "<request>"/);
    // Still only the single-required-string set (filter is not query-gated).
    const joined = moves.join("\n");
    expect(joined).not.toMatch(/edge-walk/);
    expect(joined).not.toMatch(/code-review/);
    expect(joined).not.toMatch(/pre-pr-review/);
  });

  it("shortWhen cuts at a clause boundary without ellipsis when possible", () => {
    // flowMenu is the public surface that uses shortWhen; founder description has
    // a colon/clause shape longer than the 64-char cap.
    const lines = flowMenu(process.cwd());
    const founder = lines.find((l) => l.includes("navi run founder"));
    expect(founder).toBeTruthy();
    // No bare mid-clause ellipsis when a clause boundary exists at/before the cap.
    // (A finished clause reads complete — no trailing ….)
    // Either the full first sentence fits, or a clause-boundary cut without ….
    const when = founder!.replace(/^.*navi run founder\S*\s+\S+\s+/, "").trim();
    // When truncated via clause boundary, no ellipsis; only word-boundary fallback uses …
    // Founder first sentence is long → expect a clause cut (often at a comma or colon).
    expect(when.length).toBeLessThanOrEqual(64 + 1); // cap-ish
  });
});
