import { z } from "zod";
import { match, P } from "ts-pattern";
import { Directive, GateDecision } from "../../../src/contracts/whisper.ts";

export const BrainstormCandidate = z.object({
  id: z.string().min(1),
  origin: z.enum(["caller", "generated", "synthesis"]),
  proposal: z.string().min(1),
  distinct_bet: z.string().min(1),
  strongest_case: z.string().min(1),
  strongest_objection: z.string().min(1),
  disconfirming_signal: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
});

export const BrainstormChallenge = z.object({
  candidate_ids: z.array(z.string().min(1)).min(1),
  seam: z.string().min(1),
  pressure: z.string().min(1),
  hardening: z.string().min(1),
  residual_unknown: z.string().min(1).nullable(),
});

export const HardenedConcept = z.object({
  title: z.string().min(1),
  brief: z.string().min(1),
  actor: z.string().min(1),
  desired_change: z.string().min(1),
  smallest_wedge: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  non_goals: z.array(z.string().min(1)).min(1),
  kill_conditions: z.array(z.string().min(1)).min(1),
  settled: z.array(z.string().min(1)).min(1),
  reopen_if: z.array(z.string().min(1)).min(1),
  controller_next_action: z.object({
    instruction: z.string().min(1),
    carry_forward: z.array(z.string().min(1)).min(1),
  }),
});

export const BrainstormArc = z.object({
  framing: z.string().min(1),
  grounding_points: z.array(z.string().min(1)),
  candidates: z.array(BrainstormCandidate).min(2).max(5),
  challenges: z.array(BrainstormChallenge).min(1),
  deliberation: z.array(
    z.object({
      candidate_id: z.string().min(1),
      disposition: z.enum(["lead", "merge", "retain", "discard"]),
      reason: z.string().min(1),
      reconsider_if: z.string().min(1).nullable(),
    }),
  ).min(2).max(5),
  convergence: z.object({
    source_candidate_ids: z.array(z.string().min(1)).min(1),
    synthesis: z.string().min(1),
    why_it_wins: z.string().min(1),
  }).nullable(),
  hardened: HardenedConcept.nullable(),
});

const BrainstormResult = GateDecision.extend({
  gate: z.enum(["DIRECT", "REPAIR", "BLOCKED", "ESCALATE", "COMPLETE"]),
  arc: BrainstormArc,
  directives: z.array(Directive).max(1),
}).superRefine((result, ctx) => {
  const issue = (path: PropertyKey[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // Candidate ids are the local foreign keys for the rest of the arc. Reject
  // ambiguity and dangling references at this boundary rather than asking the
  // calling agent to infer which candidate the model meant.
  const candidateIds = result.arc.candidates.map(({ id }) => id);
  const knownCandidateIds = new Set(candidateIds);
  result.arc.candidates
    .map(({ id }, index) => ({ id, index }))
    .filter(({ id, index }) => candidateIds.indexOf(id) !== index)
    .forEach(({ id, index }) =>
      issue(["arc", "candidates", index, "id"], `duplicate candidate id "${id}"`),
    );
  result.arc.challenges.forEach((challenge, challengeIndex) =>
    challenge.candidate_ids
      .map((id, idIndex) => ({ id, idIndex }))
      .filter(({ id }) => !knownCandidateIds.has(id))
      .forEach(({ id, idIndex }) =>
        issue(
          ["arc", "challenges", challengeIndex, "candidate_ids", idIndex],
          `unknown candidate id "${id}"`,
        ),
      ),
  );
  result.arc.deliberation
    .map(({ candidate_id }, index) => ({ candidate_id, index }))
    .filter(({ candidate_id }) => !knownCandidateIds.has(candidate_id))
    .forEach(({ candidate_id, index }) =>
      issue(
        ["arc", "deliberation", index, "candidate_id"],
        `unknown candidate id "${candidate_id}"`,
      ),
    );
  result.arc.convergence?.source_candidate_ids
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => !knownCandidateIds.has(id))
    .forEach(({ id, index }) =>
      issue(
        ["arc", "convergence", "source_candidate_ids", index],
        `unknown candidate id "${id}"`,
      ),
    );

  const requireNoHumanEscalation = () =>
    match(result.human_escalation)
      .with(null, () => undefined)
      .otherwise(() =>
        issue(
          ["human_escalation"],
          `${result.gate} must set human_escalation to null`,
        ),
      );
  const requireNoDirectives = () => {
    match(result.directives.length)
      .with(0, () => undefined)
      .otherwise(() =>
        issue(["directives"], `${result.gate} must return no directives`),
      );
    match(result.blocking_directive_ids.length)
      .with(0, () => undefined)
      .otherwise(() =>
        issue(
          ["blocking_directive_ids"],
          `${result.gate} must return no blocking directive ids`,
        ),
      );
  };

  match(result.gate)
    .with("COMPLETE", () => {
      match(result.arc.convergence)
        .with(null, () =>
          issue(["arc", "convergence"], "COMPLETE requires a convergence"),
        )
        .otherwise(() => undefined);
      match(result.arc.hardened)
        .with(null, () =>
          issue(["arc", "hardened"], "COMPLETE requires a hardened concept"),
        )
        .otherwise(() => undefined);
      requireNoDirectives();
      requireNoHumanEscalation();
    })
    .with(P.union("DIRECT", "REPAIR", "BLOCKED"), () => {
      match(result.directives)
        .with([P._], ([directive]) => {
          match(directive.id.trim().length)
            .with(0, () =>
              issue(
                ["directives", 0, "id"],
                `${result.gate} requires a nonblank directive id`,
              ),
            )
            .otherwise(() => undefined);
          match(directive.status)
            .with("open", () => undefined)
            .otherwise(() =>
              issue(
                ["directives", 0, "status"],
                `${result.gate} requires one open directive`,
              ),
            );
          match(directive.severity)
            .with("blocking", () => undefined)
            .otherwise(() =>
              issue(
                ["directives", 0, "severity"],
                `${result.gate} requires one blocking directive`,
              ),
            );
          match(result.blocking_directive_ids)
            .with([directive.id], () => undefined)
            .otherwise(() =>
              issue(
                ["blocking_directive_ids"],
                `${result.gate} must name its one directive id`,
              ),
            );
        })
        .otherwise(() =>
          issue(["directives"], `${result.gate} requires exactly one directive`),
        );
      requireNoHumanEscalation();
    })
    .with("ESCALATE", () => {
      match(result.human_escalation)
        .with(
          P.when(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          ),
          () => undefined,
        )
        .otherwise(() =>
          issue(
            ["human_escalation"],
            "ESCALATE requires a nonblank human escalation",
          ),
        );
      requireNoDirectives();
    })
    .exhaustive();
});

export default BrainstormResult;
