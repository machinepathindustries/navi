// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { P, match } from "ts-pattern";

// The shared unknown→string normalizer for fallible boundaries keeps error
// wording consistent.
//
// A LEAF module on purpose: it imports nothing from this codebase, so any file
// — contracts, compiler, cli, mastra wiring — can import it with no risk of a
// cycle. Callers that want a prefix interpolate it (`cannot read ${errStr(e)}`);
// callers that want the bare message pass `errStr` itself as the mapper.
export const errStr = (e: unknown): string =>
  match(e)
    .with(P.instanceOf(Error), (caught) => caught.message)
    .otherwise(() => String(e));
