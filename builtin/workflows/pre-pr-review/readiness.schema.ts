import { z } from "zod";
import { ReviewFindingSchema } from "../code-review/findings.schema.ts";

// pre-pr-review's output contract — the branch-level "is this ready for a PR"
// verdict the calling agent acts on. The top-level export is a Zod OBJECT, so
// its keys become the review step's honest `outputFields` (compiler
// resolveSchemaRef); the `findings` array and the `readiness` enum are the two
// shapes the inline `output:` token grammar can't express, which is why this is
// a `.ts` schema ref, the same escape hatch code-review uses.
//
// `recommendation` is deliberately absent: its imperative prose would duplicate
// `summary` without adding machine actionability beyond the `readiness` enum.
//
//   summary    = z.string()
//     The one-line gloss AND the caller's next-action directive in one line —
//     e.g. "Ready to open the PR" or "Fix 2 high-severity findings before the
//     PR". Named `summary` so the CLI surfaces it as the envelope summary /
//     human headline (cli.ts pickText looks for `summary`/`text`), the same
//     convention code-review and hello-two-step use. This is where the whisper
//     — tell the caller what to do next — is spoken in prose.
//
//   readiness  = z.enum(["ready", "not_ready"])   (frozen discriminant)
//     THE reason this workflow exists apart from code-review: one machine flag a
//     CI-style caller branches on without re-deriving severity logic in every
//     consumer. Binary is the minimal PR-gate discriminant — "ready" = no
//     blocking (high-severity) findings and coverage sufficient to judge;
//     "not_ready" = blocking findings, nothing to PR, or coverage too incomplete
//     to certify. A larger enum ("needs_review"/"blocked") would need its own
//     proven consumer.
//
//   coverage   = z.string()   (deliberately NOT a structured object)
//     The large-diff honesty note. A big branch diff is bounded by the collector
//     (a byte budget over whole-file chunks), so the reviewer states plainly what
//     it actually read — "Complete: all 12 files reviewed in full" or "Bounded:
//     21 of 40 files read in full; 19 stat-only, not read line-by-line: …". A
//     A plain string preserves both complete and bounded coverage descriptions
//     without imposing another nested schema.
//
//   findings   = the SAME finding shape as code-review
//     (builtin/workflows/code-review/findings.schema.ts) — {file, line,
//     severity∈low|medium|high, category, summary}. Importing the canonical
//     sub-schema makes that shared vocabulary structural rather than something
//     a parity test has to police. An empty findings list plus an honest
//     `summary`/`coverage` is legal (the no-changes and clean-branch paths);
//     fabricating a finding to fill the list is forbidden.
//
// No logic lives here — a schema file is a shape declaration, nothing else.
export default z.object({
  summary: z.string(),
  readiness: z.enum(["ready", "not_ready"]),
  coverage: z.string(),
  findings: z.array(ReviewFindingSchema),
});
