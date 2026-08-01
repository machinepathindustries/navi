// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { match, P } from "ts-pattern";
import { Result } from "neverthrow";
import { parse as parseYaml } from "yaml";
import { shortClause } from "./style.ts";

// The catalog is a display pass over Navi's configured skill and workflow tiers,
// not a resolver. Mastra throws when same-named local skills collide, while the
// catalog must still render and flag that collision. It therefore derives labels
// from the configured source directories and reads only manifest metadata.

export type Kind = "skill" | "workflow";
export type SourceType = "local" | "managed" | "external";
export type FlagKind = "collision" | "shadowed";

export type TierLabel = "project" | "pinned" | "builtin";

// One arg from an action.yaml `args:` block. Skills have no args → [].
// `type` is the DSL token ("string" | "json"); omitted in the yaml ⇒ "string".
export interface ArgInfo {
  name: string;
  required: boolean;
  type: string;
}

interface Tier {
  label: TierLabel;
  dir: string;
}

export interface CatalogEntry {
  kind: Kind;
  name: string; // directory name = what `navi run <name>` / `skills.only: [name]` reference
  tier: TierLabel; // origin-tier label: project | pinned | builtin
  dir: string; // origin-tier dir, e.g. ".navi/skills"
  path: string; // repo-relative path to the manifest (SKILL.md / action.yaml)
  description: string; // "" when the manifest is missing/unreadable — never a throw
  args: ArgInfo[]; // from action.yaml `args:`; skills and absent/malformed → []
  sourceType: SourceType; // Mastra's path-shape classification (drives collision-vs-shadow)
  active: boolean; // the entry navi actually resolves for this name (highest tier wins)
  flag?: FlagKind | undefined; // set when the name appears in more than one tier
}

export interface Catalog {
  skills: CatalogEntry[];
  workflows: CatalogEntry[];
}

// Ordered highest-precedence first. Keep these lists aligned with SKILL_SOURCES
// in src/mastra/skill-sources.ts and resolveWorkflowPath in
// src/compiler/index.ts. Importing either module would boot the runtime and open
// the shared database, so the catalog keeps its own side-effect-free constants.
//
// Built-in content is rooted at the installed package, while project and pinned
// tiers stay rooted at basePath. Deriving the install root here keeps catalog
// listing a pure filesystem operation that never boots Mastra or opens navi.db.
const INSTALL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SKILL_TIERS = [
  { label: "project", dir: ".navi/skills" },
  { label: "pinned", dir: ".agents/skills" },
  { label: "builtin", dir: "builtin/skills" },
] as const satisfies readonly Tier[];
const WORKFLOW_TIERS = [
  { label: "project", dir: ".navi/workflows" },
  { label: "pinned", dir: ".agents/workflows" },
  { label: "builtin", dir: "builtin/workflows" },
] as const satisfies readonly Tier[];

// Mastra derives source type from path shape alone: node_modules/ is external,
// .mastra/skills is managed, and every other path is local.
// All three navi tiers land on 'local', so any same-named skill across two of
// them is a same-type collision (get() throws), not a silent cross-type shadow.
function sourceTypeOf(dir: string): SourceType {
  return match(dir)
    .when((d) => d.includes("node_modules"), (): SourceType => "external")
    .when((d) => d.includes(".mastra/skills"), (): SourceType => "managed")
    .otherwise((): SourceType => "local");
}

const readText = Result.fromThrowable(
  (p: string) => readFileSync(p, "utf8"),
  () => "unreadable" as const,
);

const parseYamlSafe = Result.fromThrowable(
  (t: string) => parseYaml(t) as unknown,
  () => "invalid yaml" as const,
);

// SKILL.md carries YAML between the first two `---` fences; action.yaml is plain
// YAML. An unreadable or malformed manifest produces an empty description and
// argument list so one broken entry cannot hide the rest of the catalog.
function frontmatterBlock(text: string): string {
  return match(text.match(/^---\r?\n([\s\S]*?)\r?\n---/))
    .with(P.nullish, () => "")
    .otherwise((m) => m[1] ?? "");
}

function bodyOf(kind: Kind, text: string): string {
  return match(kind)
    .with("skill", () => frontmatterBlock(text))
    .with("workflow", () => text)
    .exhaustive();
}

function manifestOf(kind: Kind): string {
  return match(kind)
    .with("skill", () => "SKILL.md")
    .with("workflow", () => "action.yaml")
    .exhaustive();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Defensive: `doc` is unknown; absent/non-record `args` → []. Each entry is
// argName → { type?: "string"|"json"; required?: boolean; ... }; only an
// explicit `required: true` is required, and type defaults to "string".
function argsOf(doc: unknown): ArgInfo[] {
  return match(doc)
    .with({ args: P.when(isRecord) }, ({ args }) =>
      Object.entries(args).map(([name, spec]) => ({
        name,
        required: match(spec)
          .with({ required: true }, () => true)
          .otherwise(() => false),
        type: match(spec)
          .with({ type: P.string }, ({ type }) => type)
          .otherwise(() => "string"),
      })),
    )
    .otherwise(() => [] as ArgInfo[]);
}

function readManifest(
  absManifest: string,
  kind: Kind,
): { description: string; args: ArgInfo[] } {
  return readText(absManifest)
    .andThen((text) => parseYamlSafe(bodyOf(kind, text)))
    // Only an object with a string description contributes display text.
    // Arguments come from the same parsed document.
    .map((doc) => ({
      description: match(doc)
        .with({ description: P.string }, ({ description }) => description.trim())
        .otherwise(() => ""),
      args: argsOf(doc),
    }))
    .unwrapOr({ description: "", args: [] });
}

function safeDirNames(absDir: string): string[] {
  return Result.fromThrowable(
    () => readdirSync(absDir, { withFileTypes: true }),
    () => [] as never,
  )()
    // `navi install` pins navi-interop as a directory symlink. Dirent does not
    // report a symlink-to-directory as `isDirectory()`, so keep symlinks as
    // candidates and let scanTier's expected-manifest check below decide whether
    // they are valid catalog entries. Regular files never enter the candidate set.
    .map((ents) =>
      ents.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name),
    )
    .unwrapOr([]);
}

function scanTier(basePath: string, kind: Kind, tier: Tier): CatalogEntry[] {
  // Builtin tiers root at the navi install; project/pinned tiers at basePath —
  // the same per-tier anchoring as resolveWorkflowPath/createWorkspace.
  const base = match(tier.dir.startsWith("builtin/"))
    .with(true, () => INSTALL_ROOT)
    .with(false, () => basePath)
    .exhaustive();
  const absTier = join(base, tier.dir);
  const manifest = manifestOf(kind);
  return match(existsSync(absTier))
    .with(false, (): CatalogEntry[] => [])
    .with(true, () =>
      safeDirNames(absTier)
        .sort()
        .map((name) => ({ name, relPath: join(tier.dir, name, manifest) }))
        // This follows valid directory symlinks while rejecting dangling links,
        // links to files, and directories that do not contain the expected
        // SKILL.md/action.yaml manifest.
        .filter(({ relPath }) => existsSync(join(base, relPath)))
        .map(({ name, relPath }) => {
          const { description, args } = readManifest(join(base, relPath), kind);
          return {
            kind,
            name,
            tier: tier.label,
            dir: tier.dir,
            path: relPath,
            description,
            args,
            sourceType: sourceTypeOf(tier.dir),
            active: false, // decided in flagGroups once the whole name-group is known
          };
        }),
    )
    .exhaustive();
}

// A same-type duplicate is the collision case: Mastra's registry keys by name
// within a source type, so two 'local' entries with one name make get() throw.
function hasSameTypeDuplicate(group: CatalogEntry[]): boolean {
  // Fewer distinct source types than entries ⇔ at least two entries share one.
  return new Set(group.map((e) => e.sourceType)).size < group.length;
}

// Group scanned entries by name (already in tier-precedence order) and compute
// active/flag. Highest-precedence tier always resolves (skills: via the compiler's
// path-retry escape hatch on a collision; workflows: resolveWorkflowPath returns
// the first tier match). Skills flag a same-type duplicate as `collision` on ALL
// involved rows (a bare get() throws for the whole name). Cross-type or workflow
// duplicates flag the shadowed (losing) rows as `shadowed`; the winner stays clean.
function flagGroups(kind: Kind, entries: CatalogEntry[]): CatalogEntry[] {
  const byName = new Map<string, CatalogEntry[]>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);

  // flatMap preserves each group's tier-precedence order.
  return [...byName.values()].flatMap((group) =>
    match(group)
      .with([P._], ([only]): CatalogEntry[] => [{ ...only, active: true }])
      .otherwise(() => {
        const collision = match(kind)
          .with("skill", () => hasSameTypeDuplicate(group))
          .with("workflow", () => false)
          .exhaustive();
        return group.map((e, i) => ({
          ...e,
          active: i === 0,
          flag: match({ collision, winner: i === 0 })
            .with({ collision: true }, (): FlagKind | undefined => "collision")
            .with({ collision: false, winner: true }, (): FlagKind | undefined => undefined)
            .with({ collision: false, winner: false }, (): FlagKind | undefined => "shadowed")
            .exhaustive(),
        }));
      }),
  );
}

export function buildCatalog(basePath: string): Catalog {
  const collect = (kind: Kind, tiers: readonly Tier[]) =>
    flagGroups(
      kind,
      tiers.flatMap((t) => scanTier(basePath, kind, t)),
    );
  return {
    skills: collect("skill", SKILL_TIERS),
    workflows: collect("workflow", WORKFLOW_TIERS),
  };
}

// --- human rendering -------------------------------------------------------

const DESC_MAX = 96;

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return match(oneLine.length > DESC_MAX)
    .with(true, () => `${oneLine.slice(0, DESC_MAX - 1)}…`)
    .with(false, () => oneLine)
    .exhaustive();
}

// The flag annotation is computed from siblings in the flat list so entries stay
// lean (flag + active only). Names the tiers involved so the reader can act.
function annotate(entry: CatalogEntry, siblings: CatalogEntry[]): string {
  return match(entry.flag)
    .with(undefined, () => "")
    .with("collision", () => {
      const others = [...new Set(siblings.filter((s) => s.name === entry.name && s !== entry).map((s) => s.tier))];
      return `  [collision — also in ${others.join(", ")}; get() would throw]`;
    })
    .with("shadowed", () => {
      const winner = siblings.find((s) => s.name === entry.name && s.active);
      return `  [shadowed by ${winner?.tier ?? "a higher tier"}]`;
    })
    .exhaustive();
}

// Placeholder token for one arg in the run-example line:
//   json   → `--json --stdin`  (structured input and output stay machine-safe)
//   string → `"<name>"` (positional prose, quoted)
// Non-required args wrap their token in `[ ]`.
// Exported so the per-flow help screen and front door use the same invocation
// shape. JSON arguments must arrive through --stdin. They also select JSON output:
// a structured-input flow's useful result may not exist in the human summary, and
// advertising `--stdin` alone would make the caller pay before discovering that.
export function argToken(arg: { name: string; type: ArgInfo["type"]; required: boolean }): string {
  const token = match(arg.type)
    .with("json", () => "--json --stdin")
    .otherwise(() => `"<${arg.name}>"`);
  return match(arg.required)
    .with(true, () => token)
    .with(false, () => `[${token}]`)
    .exhaustive();
}

// Invocation shaped from `entry.args`, e.g.
//   navi run founder "<request>"
//   navi run edge-walk --json --stdin
//   navi run code-review ["<range>"]
//   navi run <name>                     (no args)
function runInvocation(entry: CatalogEntry, prefix: string = "navi"): string {
  const tokens = entry.args.map(argToken);
  return match(tokens)
    .with([], () => `${prefix} run ${entry.name}`)
    .otherwise((ts) => `${prefix} run ${entry.name} ${ts.join(" ")}`);
}

// Indented example line for the full catalog render.
function runExampleLine(entry: CatalogEntry, prefix: string): string {
  return `    e.g. ${runInvocation(entry, prefix)}`;
}

// `full` controls description truncation; `runExample` appends an indented
// `e.g. navi run <name> …` line with arg shape. Intent is passed from
// renderCatalog — never inferred from the heading string.
function renderGroup(
  heading: string,
  rows: CatalogEntry[],
  opts: { full: boolean; runExample: boolean; prefix: string },
): string[] {
  return match(rows)
    .with([], () => [`${heading} (0): none`])
    .otherwise(() => {
      const tierW = Math.max(...rows.map((r) => r.tier.length));
      const nameW = Math.max(...rows.map((r) => r.name.length));
      return [
        `${heading} (${rows.length}):`,
        ...rows.flatMap((r) => {
          const nameCols = `  ${r.tier.padEnd(tierW)}  ${r.name.padEnd(nameW)}`;
          const flag = annotate(r, rows);
          // Truncated: one line (tier name desc flag). Full: name row, then
          // indented full description on its own line (readable for long text).
          const body = match(opts.full)
            .with(false, () => {
              const desc = match(r.description)
                .with("", () => "")
                .otherwise((d) => `  ${truncate(d)}`);
              return [`${nameCols}${desc}${flag}`];
            })
            .with(true, () => {
              const descLine = match(r.description)
                .with("", () => [] as string[])
                .otherwise((d) => [`    ${d.replace(/\s+/g, " ").trim()}`]);
              return [`${nameCols}${flag}`, ...descLine];
            })
            .exhaustive();
          const example = match(opts.runExample)
            .with(true, () => [runExampleLine(r, opts.prefix)])
            .with(false, () => [] as string[])
            .exhaustive();
          return [...body, ...example];
        }),
      ];
    });
}

export function renderCatalog(cat: Catalog, prefix: string = "navi"): string {
  return [
    ...renderGroup("skills", cat.skills, { full: false, runExample: false, prefix }),
    "",
    ...renderGroup("flows", cat.workflows, { full: true, runExample: true, prefix }),
  ].join("\n");
}

// --- front-door flow menu --------------------------------------------------
// One aligned `navi run <name> [args…]  <when-to-use>` line per catalog
// workflow entry. Invocations come only from catalog data — never hardcoded
// flow name literals. Pure filesystem/display; callers assemble headings.

// Front-door when-to-use labels stay tight (one column of the flow menu). The
// cut itself lives in style.shortClause — ONE owner for clause-boundary excerpts
// (story parent/reason lines share it with a larger cap).
const WHEN_MAX = 64;

function shortWhen(description: string): string {
  return shortClause(description, WHEN_MAX);
}

// True when the entry has exactly one required arg and that arg is a string
// (type omitted ⇒ "string" in argsOf). Optional args may also exist; they do
// not disqualify. The COMPLETE handoff renderer uses this to ensure only flows
// that can actually bind a positional prose brief advertise a handoff command.
export function isSingleRequiredString(entry: CatalogEntry): boolean {
  const required = entry.args.filter((a) => a.required);
  return match(required)
    .with([{ type: "string" }], () => true)
    .otherwise(() => false);
}

export function flowMenu(basePath: string, prefix: string = "navi"): string[] {
  // Show only active entries; shadowed entries share their invocation name with
  // the winner and have no distinct command to advertise.
  const workflows = buildCatalog(basePath).workflows.filter((w) => w.active);
  return match(workflows)
    .with([], (): string[] => [])
    .otherwise((rows) => {
      // Pad on the full invocation (name + arg tokens) so the when-column lines up.
      const invW = Math.max(...rows.map((r) => runInvocation(r, prefix).length));
      return rows.map((r) => {
        const inv = runInvocation(r, prefix).padEnd(invW);
        const when = shortWhen(r.description);
        return match(when)
          .with("", () => `  ${inv}`)
          .otherwise((w) => `  ${inv}  ${w}`);
      });
    });
}
