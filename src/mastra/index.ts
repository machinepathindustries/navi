// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { match, P } from "ts-pattern";
import { createClient } from "@libsql/client";
import { Mastra } from "@mastra/core";
import { LocalFilesystem, LocalSkillSource, Workspace } from "@mastra/core/workspace";
import { LibSQLStore } from "@mastra/libsql";
import { naviAgent } from "./agents/navi.ts";
import { WORKSPACE_TOOL_RENAMES } from "./workspace-tools.ts";
import { findGuardViolation, isContainedIn } from "./path-guard.ts";
import { resolveDbUrl } from "../db-home.ts";

// Re-export the guard surface from its single implementation in path-guard.ts.
export {
  pathHasDeniedSegment,
  isContainedIn,
  escapesWorkspace,
  findGuardViolation,
  type GuardHit,
} from "./path-guard.ts";

export { SKILL_SOURCES } from "./skill-sources.ts";
import { SKILL_SOURCES } from "./skill-sources.ts";

const root = process.cwd();

// Built-in content is rooted at the installed package, not the target workspace.
// The builtin SKILL tier resolves from here, never from basePath (the -w consumer
// workspace), so Navi's shipped skills are reachable against any external target.
const INSTALL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// SKILL_SOURCES: see skill-sources.ts (ONE owner; re-exported above for callers
// that already import from this module).

// path-guard.ts is the single owner for workspace and bare-query file policy.

// Compilation discovers named skills and places their bodies in each step's
// instructions. Runtime workspaces disable discovery so Mastra does not advertise
// package paths outside the target workspace's read boundary.
export function createWorkspace(
  basePath: string = root,
  opts: { skills?: boolean } = {},
): Workspace {
  // Consumer skills resolve from the selected workspace. Built-in skills resolve
  // from the installed package. File tools remain anchored at basePath.
  const skillTiers: { dir: string; base: string }[] = [
    { dir: ".navi/skills", base: basePath },
    { dir: ".agents/skills", base: basePath },
    { dir: "builtin/skills", base: INSTALL_ROOT },
  ];
  const skills = match(opts.skills ?? true)
    .with(false, (): string[] => [])
    .with(true, () =>
      skillTiers
        .filter((t) => existsSync(join(t.base, t.dir)))
        .map((t) =>
          match(t.base === basePath)
            .with(true, () => t.dir)
            .with(false, () => join(t.base, t.dir))
            .exhaustive(),
        ),
    )
    .exhaustive();
  return new Workspace({
    filesystem: new LocalFilesystem({ basePath, readOnly: true }),
    skillSource: new LocalSkillSource({ basePath }),
    skills,
    // Expose Mastra workspace tools under the short names accepted by workflow
    // allowlists. The compiler reads the same map when validating those names.
    // An empty allowlist means zero tools; hooks inspect arguments after remapping.
    //
    // There is deliberately no sandbox. Mastra registers execute_command and
    // process tools whenever a sandbox exists; omitting the provider makes agent
    // shell structurally absent, including tools Mastra may add later. Trusted
    // static shell remains available only as a reviewed YAML `type: command` step.
    tools: {
      ...WORKSPACE_TOOL_RENAMES,
      // LSP needs a sandbox process manager. Navi deliberately has no sandbox,
      // so advertising this always-unavailable tool only invites a failed call.
      mastra_workspace_lsp_inspect: { enabled: false },
      hooks: {
        beforeToolCall: ({ input, toolName }) =>
          match(findGuardViolation(input, basePath, toolName))
            .with(P.nullish, () => undefined)
            .otherwise((hit) => {
              // One stderr line records every refusal; the response explains why.
              console.error(`navi: blocked tool call targeting ${hit.target}`);
              const why = match(hit.kind)
                .with("escape", () => "path escapes workspace")
                .with("denied", () => "vendored/internal path")
                .exhaustive();
              // One extra sentence, and ONLY for a skill file navi itself ships.
              // A caller that reached for node_modules needs no advice about
              // skills, and the `denied` arm is shared with the bare-query speed
              // tools. Scoped this narrowly, the hint can only ever be true.
              // Keyed on whether THIS workspace force-pops skills. In the
              // skills-full lane (bare query / --deep) only code-search is popped,
              // so "already in your instructions" is deterministically FALSE for
              // every other skill — and that lane has the `skill` tool, which is
              // the right answer there. A hint that is sometimes a lie is worse
              // than no hint.
              const hint = match({
                kind: hit.kind,
                skillFile: isContainedIn(join(INSTALL_ROOT, "builtin/skills"), hit.target),
                popped: opts.skills === false,
              })
                .with({ kind: "escape", skillFile: true, popped: true }, () =>
                  " Skill bodies are already in your instructions — do not read skill files.",
                )
                .with({ kind: "escape", skillFile: true, popped: false }, () =>
                  " Load a skill with the `skill` tool, not through the filesystem.",
                )
                .otherwise(() => "");
              return {
                proceed: false,
                output: `Blocked: refusing to access "${hit.target}" (${why}).${hint}`,
              };
            }),
      },
    },
  });
}

// One LibSQL store, shared by the bare-query agent and every compiled-workflow
// run (each `run` builds its own Mastra instance around the same storage, so
// thread/session data lands in one navi.db).
// NAVI_DB points the whole runtime (threads/sessions/memory) at another sqlite file;
// tests + --ephemeral ride this seam.
//
// Resolve the URL before store construction so the default directory exists and
// unsafe local overrides are refused before libsql opens them.
const dbUrl = resolveDbUrl();
export const storage = new LibSQLStore({
  id: "navi",
  url: dbUrl,
});
// Retained companion for appendSessionState's one atomic message+cache write.
// LibSQLStore stays URL-configured so Mastra keeps its local pragma/init behavior;
// the companion uses @libsql/client's public transaction API against the same URL.
export const sessionClient = createClient({ url: dbUrl, timeout: 5_000 });

export const mastra = new Mastra({
  // Registration key is cosmetic: mastra.getAgentById("navi") resolves by the
  // Agent's own `id` field ("navi"), not by this object key (@mastra/core).
  agents: { naviAgent },
  workspace: createWorkspace(),
  storage,
});
