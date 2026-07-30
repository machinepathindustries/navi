import { createRubricScorer } from "@mastra/evals/scorers/prebuilt";
import { describe, expect, it } from "vitest";

describe("Mastra compatibility", () => {
  it("exposes the rubric scorer added to the current evals package", () => {
    expect(createRubricScorer).toBeTypeOf("function");
  });
});
