// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { ResultAsync, err } from "neverthrow";
import { match, P } from "ts-pattern";
import { resolveStructuredObject } from "../compiler/index.ts";
import { errStr } from "../err.ts";
import { rule } from "../style.ts";
import {
  GROUNDING_PASS_MESSAGE,
  GroundingGradeSchema,
  renderGroundingGrade,
  type GroundingGrade,
} from "./grader-instructions.ts";

export type GroundingGeneration = {
  finishReason: string | undefined;
  object: unknown;
  text: string;
};

export type GroundingStageResult = {
  gradeText: string;
  escalate: boolean;
  diagnostic: string | null;
};

export async function runGroundingStage(
  generate: () => Promise<GroundingGeneration>,
): Promise<GroundingStageResult> {
  const grade = await ResultAsync.fromPromise(generate(), errStr).andThen((result) =>
    match(result.finishReason)
      .with("stop", () =>
        resolveStructuredObject(
          "grounding-grade",
          result.object,
          result.text,
          GroundingGradeSchema,
        ).map((value) => value as GroundingGrade),
      )
      .otherwise((reason) =>
        err(`grounding grade did not stop cleanly: finishReason=${reason}`),
      ),
  );

  return grade.match(
    (value) => ({
      gradeText: renderGroundingGrade(value),
      escalate: value.verdict !== "COMPLETE" || value.escalate,
      diagnostic: null,
    }),
    (message) => ({
      gradeText: "Grounding grade unavailable — escalating conservatively.",
      escalate: true,
      diagnostic: message,
    }),
  );
}

export function renderGroundingStage(
  result: GroundingStageResult,
  deepCommand: string,
  movesBlock: string,
): { stdout: string; stderr: string } {
  const stderr = match(result.diagnostic)
    .with(
      P.string,
      (message) =>
        `\nnavi: grade stage failed (answer shown; deep handoff required): ${message}\n`,
    )
    .with(null, () => "")
    .exhaustive();
  const next = match(result.escalate)
    .with(
      true,
      () =>
        `\n${rule("next")}\n⚠ This quick answer needs a deeper, tool-backed repository read. Run:\n  ${deepCommand}\n${movesBlock}\n`,
    )
    .with(
      false,
      () => `\n${rule("next")}\n${GROUNDING_PASS_MESSAGE}${movesBlock}\n`,
    )
    .exhaustive();

  return {
    stdout: `\n\n${rule("grounding check")}\n${result.gradeText}\n${next}`,
    stderr,
  };
}
