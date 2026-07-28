// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// The workspace tool vocabulary — the ONE owner for BOTH the `createWorkspace()`
// tool-name remap (src/mastra/index.ts) and the compile-time `tools:` allowlist
// lint (src/compiler/shape.ts), so the names a step may list can never drift from
// the names the workspace actually registers. Pure data, zero import side effects:
// safe to pull into the model-free `--shape`/compile path without booting the
// runtime (a store/Mastra instance) the way importing mastra/index.ts would.

// Mastra Code's ecosystem-convention short names, remapped from the raw
// `mastra_workspace_*` defaults. The key is the original constant Mastra
// registers; `.name` is the exposed short name
// (WorkspaceToolConfig.name). Spread into the Workspace `tools:` config.
export const WORKSPACE_TOOL_RENAMES = {
  mastra_workspace_read_file: { name: "view" },
  mastra_workspace_grep: { name: "search_content" },
  mastra_workspace_list_files: { name: "find_files" },
} as const;

// The default read-only `mastra_workspace_*` tool keys left unrenamed remain
// referenceable by raw name from a step's `tools:` allowlist.
const UNRENAMED_TOOL_NAMES = [
  "mastra_workspace_file_stat",
] as const;

// Closed vocabulary a step's `tools:` allowlist may legally reference — the remapped
// short names plus the untouched raw names. Mastra's per-call `activeTools` filter
// is EXACT string match, so a `tools:` entry OUTSIDE this set matches ZERO tools
// and silently ships a toolless/under-tooled agent; the compiler rejects such an
// entry as a lint error that names the bad entry and this vocabulary.
export type WorkspaceToolName =
  | (typeof WORKSPACE_TOOL_RENAMES)[keyof typeof WORKSPACE_TOOL_RENAMES]["name"]
  | (typeof UNRENAMED_TOOL_NAMES)[number];

export const WORKSPACE_TOOL_NAMES = [
  ...Object.values(WORKSPACE_TOOL_RENAMES).map((r) => r.name),
  ...UNRENAMED_TOOL_NAMES,
] as const satisfies readonly WorkspaceToolName[];

// Shared read-only preset for agent steps that need repo evidence. YAML cannot
// import this const; authors paste the same list into action.yaml `tools:` and
// tests pin both sides equal. Not a DSL token — the closed .strict() schema stays
// closed (spec.ts tools: z.array(z.string())).
export const READ_ONLY_WORKSPACE_TOOLS = [
  "view",
  "search_content",
  "find_files",
  "mastra_workspace_file_stat",
] as const satisfies readonly WorkspaceToolName[];

// The ONE membership test for the closed tool vocabulary — a type guard, so callers
// NARROW instead of assert. shape.ts uses it both to LINT an unknown `tools:` entry
// and to FILTER the resolved plan down to the honest WorkspaceToolName[] set (no cast).
export const isWorkspaceToolName = (t: string): t is WorkspaceToolName =>
  (WORKSPACE_TOOL_NAMES as readonly string[]).includes(t);
