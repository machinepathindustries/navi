// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { z } from "zod";
import { match } from "ts-pattern";

// Grader instructions — the second stage of the staged one-shot pipeline. After
// the one-shot ANSWER (oneshot-instructions.ts), a terse evidence-check re-reads
// the SAME deterministic evidence (preflight INDEX + prefetch MAP windows) plus the
// answer, and reports whether the answer is actually grounded. This stage is the
// PRINCIPLED HOME for thinking:disabled: a mechanical support-check, not open-ended
// synthesis — so cutting reasoning here is safe where cutting it on the answer is
// not. It catches fluent but unsupported answers, not merely terse ones; grounding
// of substantive claims (not just citations) is the first axis. Mastra validates
// the model's small structured result; Navi renders the familiar three-line human
// form. Semantic judgment stays in the model while transport stays deterministic.
export const GROUNDING_PASS_MESSAGE = "✓ Grounding grade passed — the answer stands.";

export const GroundingGradeSchema = z.object({
  verdict: z.enum(["COMPLETE", "PARTIAL", "MISSING"]),
  weak_missing: z.string().min(1),
  escalate: z.boolean(),
});

export type GroundingGrade = z.infer<typeof GroundingGradeSchema>;

export function renderGroundingGrade(grade: GroundingGrade): string {
  const escalate = match(grade.escalate)
    .with(true, () => "yes")
    .with(false, () => "no")
    .exhaustive();
  return [
    `VERDICT: ${grade.verdict}`,
    `WEAK/MISSING: ${grade.weak_missing}`,
    `ESCALATE: ${escalate}`,
  ].join("\n");
}

export function buildGraderInstructions(): string {
  return [
    "You are a strict GRADING stage in a one-shot code-search pipeline. Return only the structured grade required by the supplied schema. Reason silently: no preamble, narration, or step-by-step explanation.",
    "You see the SAME evidence the answerer saw — a deterministic ripgrep digest (the INDEX) and pre-read file windows (the FOCUSED CONTEXT) — plus the QUESTION and the ANSWER it produced (appended below). You have NO tools; judge ONLY from the provided evidence.",
    "Judge on three axes (reason SILENTLY, report only the verdict):",
    "- GROUNDING: is every substantive claim (the claim itself, not just its `path:line`) supported by a window? A fluent, confident claim the evidence does NOT support, or CONTRADICTS, is the WORST failure — flag it even when a citation is attached.",
    "- RETRIEVAL-BOUNDED: is the DEFINITIVE source for the core claim actually PRESENT in the windows, or only a PROXY? A DEFAULTS / constants-table / module-constant entry (`DEFAULTS['X']=…`, `const X=…`), a doc/README line, an instruction-template or prose line, or an adjacent symbol is a PROXY — NOT the definitive source. The definitive source of an EFFECTIVE / RUNTIME / RESOLVED value or behavior is its assignment/override/call site (`self.X = …` in a constructor, a settings resolver, the actual call site). If the question asks for an effective/runtime/resolved value (or \"what X does at runtime\") and that site is ABSENT from the windows, the answer is retrieval-bounded → VERDICT PARTIAL + ESCALATE: yes, EVEN IF the answer asserts High confidence from the proxy.",
    "- OVER-CONFIDENCE: did the answer assert High or Medium confidence while a key point rests on an absent source or an unsupported claim?",
    "ESCALATE rule (this is where a tool-backed deep read is worth spending): set escalate=true whenever such a read would likely CHANGE or COMPLETE the answer. That INCLUDES the case where the answer itself abstains, says the evidence is insufficient, reports Low confidence, or says a deeper read is needed — an honest \"I don't know\" is a reason to escalate, NOT a reason to stop. A MISSING verdict always escalates; a PARTIAL verdict escalates unless the gap is trivial; a KEY claim unsupported/contradicted escalates. Only COMPLETE + fully grounded may set escalate=false.",
    "For weak_missing, name the specific unsupported or absent claim and the file a deeper read needs. Use \"None\" only for a COMPLETE, fully grounded answer.",
  ].join("\n");
}
