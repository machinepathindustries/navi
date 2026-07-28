// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";

export const VerdictCode = z.enum(["GO", "REFINE", "REJECT"]);
export type VerdictCode = z.infer<typeof VerdictCode>;

// The verdict object is the machine shape parsed from five Markdown headers.
// One field per header, in header order:
//   verdict          ← ## Verdict          (GO | REFINE | REJECT)
//   take             ← ## Take
//   grounding_points ← ## Grounding points
//   decision_rules   ← ## Decision rules
//   what_not_to_do   ← ## What not to do
//
// src-side owner of the RUN-seam schema (src/ must not import builtin/). The
// workflow-side file at builtin/workflows/founder/verdict.schema.ts re-exports
// from here so the parser unit tests and the CLI/envelope RUN path share one
// definition. On a parse failure at the RUN seam, callers fall back to the
// not-a-verdict path (do not steer `next` off a malformed object).
export const VerdictSchema = z.object({
  verdict: VerdictCode,
  take: z.string(),
  grounding_points: z.array(z.string()),
  decision_rules: z.array(z.string()),
  what_not_to_do: z.array(z.string()),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export default VerdictSchema;
