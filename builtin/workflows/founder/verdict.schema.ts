// Workflow-side re-export of the src-owned VerdictSchema (src/contracts/verdict.ts).
// Founder declares this file as its native structured output; the RUN seam
// (envelope/cli) imports from src/ so product code never depends on builtin/.
export { VerdictSchema, type Verdict } from "../../../src/contracts/verdict.ts";
export { default } from "../../../src/contracts/verdict.ts";
