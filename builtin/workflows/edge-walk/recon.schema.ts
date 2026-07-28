import { z } from "zod";

// ReconOutput contains the wiring facts established by `recon`. It stays flat:
// scalars, string arrays, and flat {uri,line,note} records are reliable across
// supported models. There is no verdict field on
// purpose: recon reports what is and is not wired, as file:line facts, and the
// judge decides the disposition (repository-recon "render no verdict" rule).
// Everything the agent could not confirm goes in `not_found` as an explicit
// marker — an honest absence, never a silently dropped one.
//
// A schema file is a shape declaration and nothing else. `Cite` is shared by
// the three cited arrays.
const Cite = z.object({
  uri: z.string(), // file path as read, relative to the workspace root
  line: z.number().int(), // a real line the agent actually read
  note: z.string(), // one terse phrase: what sits at that location
});

export default z.object({
  // One line restating what was traced: the task's subject and the parent's claim.
  subject: z.string(),
  // Real production triggers/entry points that reach the subject at RUNTIME —
  // the command, route, handler, or job, not just the subject's own module.
  entry_points: z.array(Cite),
  // Direct callers/consumers of the subject symbol found in the tree (a
  // test-only caller is a caller worth naming as such in its `note`).
  callers: z.array(Cite),
  // The parent's claimed locations (its plan citations, or the evidence uris on a
  // continuation), each re-read so the note reflects what the location shows.
  claimed_locations: z.array(Cite),
  // Whether a trace from a real trigger FORWARD actually reaches the claimed
  // work. `false` is the orphaned/partial-wiring signal: the code exists but no
  // runtime path arrives at it (repository-recon "sits on that path" check).
  claimed_on_traced_path: z.boolean(),
  // Second paths that reach the same externally visible effect WITHOUT passing
  // through the subject — the partial-wiring shape (repository-recon bypass check).
  bypasses: z.array(Cite),
  // Explicit "searched for X, absent" markers: a suspected caller/trigger looked
  // for and not found. Naming the absence is a fact; omitting it is not.
  not_found: z.array(z.string()),
});
