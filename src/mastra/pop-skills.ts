// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Force-pop named skills' full bodies into agent instructions — ONE owner for
// both the workflow compiler (skills.only) and bare-query search (code-search).
// Public reads only: workspace.skills.get + formatSkillActivation.

import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { match, P } from "ts-pattern";
import { formatSkillActivation, type Workspace } from "@mastra/core/workspace";
import { SKILL_SOURCES } from "./skill-sources.ts";
import { errStr } from "../err.ts";

type WorkspaceSkills = NonNullable<Workspace["skills"]>;
type Skill = Awaited<ReturnType<WorkspaceSkills["get"]>>;

function getSkillDeterministic(
  skills: WorkspaceSkills,
  name: string,
): ResultAsync<Skill, string> {
  return ResultAsync.fromPromise(skills.get(name), errStr).orElse((collisionMsg) =>
    SKILL_SOURCES.reduce<ResultAsync<Skill, string>>(
      (acc, tier) =>
        acc.orElse(() =>
          ResultAsync.fromPromise(skills.get(`${tier}/${name}`), errStr).andThen((s) =>
            match(s)
              .with(P.nullish, () => errAsync<Skill, string>("miss"))
              .otherwise((skill) => okAsync(skill)),
          ),
        ),
      errAsync<Skill, string>(collisionMsg),
    ).mapErr(() => collisionMsg),
  );
}

// formatSkillActivation emits the SKILL.md body plus a "## References" list of
// reference FILENAMES — never their contents. That is a pointer the step agent
// cannot follow: `activeTools` is exact-match and navi's closed tool vocabulary
// can never contain Mastra's `skill_read`, so the only route left is `view` on an
// absolute path outside the workspace, which the guard refuses. Hydrating the
// reference bodies makes a force-popped skill complete in any workspace.
//
// Reads go through workspace.skills.getReference, never fs. skill.path is the
// collision-safe identifier and works for both relative and absolute skill roots.
//
// Generic over every discovered reference — no allowlist, no filename literals.
// Which files are loaded is decided by where they live: a skill that must not
// hydrate a file keeps it outside its references directory.
function hydrateReferences(
  skills: WorkspaceSkills,
  skill: NonNullable<Skill>,
): ResultAsync<string, string> {
  const body = formatSkillActivation(skill);
  return skill.references.reduce<ResultAsync<string, string>>(
    (acc, ref) =>
      acc.andThen((text) =>
        // getReference wants the path relative to the SKILL ROOT, while
        // skill.references entries are relative to references/ — hence the prefix.
        ResultAsync.fromPromise(skills.getReference(skill.path, `references/${ref}`), errStr).andThen(
          (content) =>
            match(content)
              // A failed reference read is not fatal: keep the skill body and name
              // the missing reference on stderr.
              .with(P.nullish, () => {
                console.error(`navi: skill "${skill.name}" reference ${ref} could not be read`);
                return okAsync<string, string>(text);
              })
              .otherwise((c) => okAsync<string, string>(`${text}\n\n## references/${ref}\n\n${c}`)),
        ),
      ),
    okAsync<string, string>(body),
  );
}

export function resolvePoppedSkills(
  workspace: Workspace | undefined,
  names: string[],
): ResultAsync<string, string> {
  return match(workspace?.skills)
    .with(P.nullish, () =>
      errAsync<string, string>(
        `skills.only names ${JSON.stringify(names)} but no workspace skills are configured`,
      ),
    )
    // The sequential fold preserves declaration order and stops at the first
    // failed skill resolution.
    .otherwise((skills) =>
      names
        .reduce<ResultAsync<string[], string>>(
          (acc, name) =>
            acc.andThen((bodies) =>
              getSkillDeterministic(skills, name).andThen((skill) =>
                match(skill)
                  .with(P.nullish, () => errAsync<string[], string>(`skills.only "${name}": skill not found`))
                  .otherwise((s) => hydrateReferences(skills, s).map((b) => [...bodies, b])),
              ),
            ),
          okAsync<string[], string>([]),
        )
        .map((bodies) => bodies.join("\n\n---\n\n")),
    );
}

export function loadPoppedSkill(
  workspace: Workspace | undefined,
  name: string,
): ResultAsync<string, string> {
  return match(workspace?.skills)
    .with(P.nullish, () =>
      errAsync<string, string>(`no workspace skills configured; cannot force-pop "${name}"`),
    )
    .otherwise((skills) =>
      getSkillDeterministic(skills, name).andThen((skill) =>
        match(skill)
          .with(P.nullish, () => errAsync<string, string>(`skill "${name}" not found`))
          .otherwise((s) => hydrateReferences(skills, s)),
      ),
    );
}
