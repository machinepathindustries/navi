// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// The single owner of additive search-result scoring.
//
// Retrieval scoring (preflight.scoreHit/termWeight, prefetch.pathPrefetchScore)
// is a pile of independent signals whose weights SUM — several predicates fire on
// the same input. match() is the WRONG primitive for that: it selects exactly ONE
// arm, so converting an additive score to match() silently changes ranking. The
// correct form is a declarative table plus this fold—no raw
// `if` per signal, and the whole weight schedule readable in one place.
//
// A LEAF module on purpose (same reasoning as err.ts): imports nothing from this
// codebase, so any scorer can use it with no risk of a cycle.
export type Weighted<T> = readonly (readonly [(x: T) => boolean, number])[];

export const foldWeights = <T,>(table: Weighted<T>, x: T): number =>
  table.filter(([hits]) => hits(x)).reduce((sum, [, w]) => sum + w, 0);
