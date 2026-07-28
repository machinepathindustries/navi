// SurfaceMap output for the `expand` step. The contract is the canonical
// SurfaceMap already defined in src/contracts/whisper.ts, re-exported here
// output so there is a single source of truth, never a forked copy. Its keys
// (surfaces, seams, unknowns, revision_hash) become the step's honest
// outputFields. A schema file declares shape only; a re-export is the leanest
// possible declaration.
export { SurfaceMap as default } from "../../../src/contracts/whisper.ts";
