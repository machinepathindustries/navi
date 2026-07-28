import { z } from "zod";

// code-review's output contract.
// The top-level export is a Zod OBJECT — its keys become the step's honest
// `outputFields` (compiler resolveSchemaRef): the two shapes the inline token
// grammar can't express (an array of finding objects) plus a plain summary.
//
// The fields and enums are stable; changing either is a schema break:
//
//   severity  = z.enum(["low", "medium", "high"])
//     Three tiers is the minimal set that supports real triage — high = fix
//     before merge (correctness/security/data-loss), medium = should fix
//     (likely bug or notable smell), low = nit/style/minor. It matches the
//     schema-ref stand-in for this shape
//     (tests/fixtures/schema-ref/review.schema.ts), so the whole repo speaks one
//     severity vocabulary. Pre-PR review treats "high" as blocking.
//
//   category  = z.string()  (deliberately NOT an enum)
//     The contract fixes category as a free string. The
//     review LENS (correctness / simplification / efficiency / security /
//     test-coverage / style — see action.yaml) can evolve without a schema
//     break; only severity is a triage discriminant worth freezing.
//
//   summary   = z.string()  (top-level, distinct from the per-finding summary)
//     The review's one-line overall gloss AND the home for the honest
//     empty-diff note ("nothing to review" vs "reviewed, clean" — both give
//     findings:[], only the summary tells them apart). Named `summary` so the
//     CLI surfaces it as the envelope summary (cli.ts pickText looks for
//     `summary`/`text`), the same convention hello-two-step's final step uses.
//     Fabricating a placeholder finding for an empty diff is forbidden; the
//     honest signal is findings:[] plus this note.
//
// No logic lives here — a schema file is a shape declaration, nothing else.
export default z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      severity: z.enum(["low", "medium", "high"]),
      category: z.string(),
      summary: z.string(),
    }),
  ),
});
