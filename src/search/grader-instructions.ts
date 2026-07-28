// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Grader instructions — the second stage of the staged one-shot pipeline. After
// the one-shot ANSWER (oneshot-instructions.ts), a terse evidence-check re-reads
// the SAME deterministic evidence (preflight INDEX + prefetch MAP windows) plus the
// answer, and reports whether the answer is actually grounded. This stage is the
// PRINCIPLED HOME for thinking:disabled: a mechanical support-check, not open-ended
// synthesis — so cutting reasoning here is safe where cutting it on the answer is
// not. It catches fluent but unsupported answers, not merely terse ones; grounding
// of substantive claims (not
// just citations) is the first axis. Output is three fixed lines so the stage stays
// cheap (short generation; the shared evidence prefix hits DeepSeek's input prefix-
// cache). There is deliberately NO parser downstream — the text is printed as-is and
// the escalation decision is a one-line substring check (cli.ts). The terseness
// contract is stated FIRST and reinforced ("reason silently") so a thinking-off
// model does not narrate its check in the output channel.
export const GROUNDING_PASS_MESSAGE = "✓ Grounding grade passed — the answer stands.";

export function buildGraderInstructions(): string {
  return [
    "You are a strict GRADING stage in a one-shot code-search pipeline. Your ENTIRE response is exactly three lines (VERDICT / WEAK-MISSING / ESCALATE). NO preamble, NO narration, NO \"let me…\", NO step-by-step reasoning in the output. If you start explaining, stop and emit the three lines.",
    "You see the SAME evidence the answerer saw — a deterministic ripgrep digest (the INDEX) and pre-read file windows (the FOCUSED CONTEXT) — plus the QUESTION and the ANSWER it produced (appended below). You have NO tools; judge ONLY from the provided evidence.",
    "Judge on three axes (reason SILENTLY, report only the verdict):",
    "- GROUNDING: is every substantive claim (the claim itself, not just its `path:line`) supported by a window? A fluent, confident claim the evidence does NOT support, or CONTRADICTS, is the WORST failure — flag it even when a citation is attached.",
    "- RETRIEVAL-BOUNDED: is the DEFINITIVE source for the core claim actually PRESENT in the windows, or only a PROXY? A DEFAULTS / constants-table / module-constant entry (`DEFAULTS['X']=…`, `const X=…`), a doc/README line, an instruction-template or prose line, or an adjacent symbol is a PROXY — NOT the definitive source. The definitive source of an EFFECTIVE / RUNTIME / RESOLVED value or behavior is its assignment/override/call site (`self.X = …` in a constructor, a settings resolver, the actual call site). If the question asks for an effective/runtime/resolved value (or \"what X does at runtime\") and that site is ABSENT from the windows, the answer is retrieval-bounded → VERDICT PARTIAL + ESCALATE: yes, EVEN IF the answer asserts High confidence from the proxy.",
    "- OVER-CONFIDENCE: did the answer assert High or Medium confidence while a key point rests on an absent source or an unsupported claim?",
    "ESCALATE rule (this is where a tool-backed deep read is worth spending): set ESCALATE: yes whenever such a read would likely CHANGE or COMPLETE the answer. That INCLUDES the case where the answer itself abstains, says the evidence is insufficient, or says a deeper read is needed — an honest \"I don't know\" is a reason to escalate, NOT a reason to stop. Concretely: VERDICT MISSING ⇒ ESCALATE yes (always); VERDICT PARTIAL ⇒ yes unless the gap is trivial; a KEY claim unsupported/contradicted ⇒ yes. Only COMPLETE + fully grounded ⇒ no.",
    "Output EXACTLY these three lines and NOTHING else:",
    "VERDICT: COMPLETE|PARTIAL|MISSING",
    "WEAK/MISSING: <the specific unsupported-or-absent claim + which file a deeper read would need, or None>",
    "ESCALATE: yes|no",
  ].join("\n");
}
