// Workflow-side re-export of the src-owned VerdictSchema (src/contracts/verdict.ts).
// The founder parse path and unit tests keep importing from this path; the RUN
// seam (envelope/cli) imports from src/ so product code never depends on builtin/.
export { VerdictSchema, type Verdict } from "../../../src/contracts/verdict.ts";
export { default } from "../../../src/contracts/verdict.ts";
