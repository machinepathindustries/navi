import { z } from "zod";
import { GateDecision, Directive, Finding, SurfaceMap, modelOptional } from "../../../src/contracts/whisper.ts";

// The `judge` step returns one structured disposition and its artifacts. It is
// the canonical GateDecision extended with the sibling
// arrays the CLI lifts into the run envelope + the persisted SessionState:
//
//   - GateDecision fields (gate/reason/blocking_directive_ids/non_blocking_risks/
//     human_escalation/confidence) → GateDecision.safeParse on the final output is
//     the shape check that activates the whisper run path (cli.ts runGatePath).
//   - directives[]  → each a full, valid Directive (the CLI re-validates the
//     sibling and exits 1 LOUDLY on a present-but-invalid one — never weaken it).
//   - findings[]    → each a full, valid Finding snapshot ([] when none).
//   - surface_map   → OPTIONAL: omit it and the CLI carries the freshest SurfaceMap
//     the run produced (expand's output), else prior's — which is exactly what a
//     continuation-skip run wants (revision unchanged ⇒ keep the prior map's hash).
//
// Composed from the canonical schemas by re-export/extend — no forked shapes, no
// logic. Extra keys are fine: the CLI's GateDecision.safeParse
// strips them; the sibling extraction reads directives/findings/surface_map by name.
export default GateDecision.extend({
  directives: z.array(Directive),
  findings: z.array(Finding),
  // The composite's own optional field gets the same one-rule null-normalization as
  // the family's other optionals (Finding/Evidence): the judge is told to OMIT it,
  // but a model that serializes "no value" as `null` is normalized to absent at the
  // parse boundary rather than hard-failing the judge (see modelOptional in
  // src/contracts/whisper.ts).
  surface_map: modelOptional(SurfaceMap),
});
