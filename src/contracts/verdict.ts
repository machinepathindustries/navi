// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";

export const VerdictCode = z.enum(["GO", "REFINE", "REJECT"]);
export type VerdictCode = z.infer<typeof VerdictCode>;

// src-side owner of the RUN-seam schema (src/ must not import builtin/). The
// workflow-side file at builtin/workflows/founder/verdict.schema.ts re-exports
// from here so Founder's structured output and the CLI/envelope RUN path share
// one definition. Callers fall back to the not-a-verdict path when the object is
// malformed (do not steer `next` off an invalid object).
const VerdictText = z.string().trim().min(1);

export const VerdictSchema = z.object({
  verdict: VerdictCode,
  take: VerdictText,
  grounding_points: z.array(VerdictText),
  decision_rules: z.array(VerdictText),
  what_not_to_do: z.array(VerdictText),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export default VerdictSchema;
