// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Skill tier paths, highest precedence first — ONE owner for createWorkspace,
// catalog, and force-pop collision escape hatch (compile + bare-query).
export const SKILL_SOURCES = [".navi/skills", ".agents/skills", "builtin/skills"] as const;
