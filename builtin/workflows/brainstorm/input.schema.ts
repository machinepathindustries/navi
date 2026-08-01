import { z } from "zod";

const NonEmptyText = z.string().trim().min(1);
const JsonObject = z.record(z.string(), z.json());

const CandidateIdea = z.union([
  NonEmptyText,
  JsonObject.refine((idea) => Object.keys(idea).length > 0, "idea object must not be empty"),
]);

const DirectiveReturn = z
  .object({
    requirement: NonEmptyText,
    value: z.json(),
  })
  .strict();

const ResponseTo = z
  .object({
    directive_id: NonEmptyText,
    returns: z.array(DirectiveReturn).min(1),
  })
  .strict();

const BrainstormEvent = z
  .object({
    task: NonEmptyText,
    ideas: z.array(CandidateIdea).min(1),
    context: z.array(z.json()).optional(),
    constraints: z.array(z.json()).optional(),
    response_to: ResponseTo.optional(),
  })
  .strict();

export default z
  .object({
    event: BrainstormEvent,
  })
  .strict();
