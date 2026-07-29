import { describe, expect, it } from "vitest";
import { GROUNDING_PASS_MESSAGE } from "../src/search/grader-instructions.ts";
import {
  renderGroundingStage,
  runGroundingStage,
} from "../src/search/grounding-stage.ts";

const DEEP_COMMAND = `navi "where is retry set?" --deep`;

describe("quick grounding stage", () => {
  it("fails closed to the deep handoff when the grader call throws", async () => {
    const result = await runGroundingStage(async () => {
      throw new Error("grader exploded");
    });
    const rendered = renderGroundingStage(result, DEEP_COMMAND, "");

    expect(rendered.stderr).toContain(
      "navi: grade stage failed (answer shown; deep handoff required):",
    );
    expect(rendered.stderr).toContain("grader exploded");
    expect(rendered.stdout).toContain(
      "Grounding grade unavailable — escalating conservatively.",
    );
    expect(rendered.stdout).toContain(DEEP_COMMAND);
    expect(rendered.stdout).not.toContain(GROUNDING_PASS_MESSAGE);
  });

  it("fails closed to the deep handoff when the structured grade is invalid", async () => {
    const result = await runGroundingStage(async () => ({
      finishReason: "stop",
      object: { verdict: "COMPLETE", weak_missing: "None", escalate: "no" },
      text: '{"verdict":"COMPLETE","weak_missing":"None","escalate":"no"}',
    }));
    const rendered = renderGroundingStage(result, DEEP_COMMAND, "");

    expect(rendered.stderr).toContain(
      "navi: grade stage failed (answer shown; deep handoff required):",
    );
    expect(rendered.stderr).toContain("failed the declared schema");
    expect(rendered.stdout).toContain(
      "Grounding grade unavailable — escalating conservatively.",
    );
    expect(rendered.stdout).toContain(DEEP_COMMAND);
    expect(rendered.stdout).not.toContain(GROUNDING_PASS_MESSAGE);
  });

  it("fails closed to the deep handoff when the grader does not stop", async () => {
    const result = await runGroundingStage(async () => ({
      finishReason: "tool-calls",
      object: { verdict: "COMPLETE", weak_missing: "None", escalate: false },
      text: '{"verdict":"COMPLETE","weak_missing":"None","escalate":false}',
    }));
    const rendered = renderGroundingStage(result, DEEP_COMMAND, "");

    expect(rendered.stderr).toContain(
      "navi: grade stage failed (answer shown; deep handoff required):",
    );
    expect(rendered.stderr).toContain(
      "grounding grade did not stop cleanly: finishReason=tool-calls",
    );
    expect(rendered.stdout).toContain(
      "Grounding grade unavailable — escalating conservatively.",
    );
    expect(rendered.stdout).toContain(DEEP_COMMAND);
    expect(rendered.stdout).not.toContain(GROUNDING_PASS_MESSAGE);
  });

  it("lets a valid complete grade stand", async () => {
    const result = await runGroundingStage(async () => ({
      finishReason: "stop",
      object: { verdict: "COMPLETE", weak_missing: "None", escalate: false },
      text: "",
    }));
    const rendered = renderGroundingStage(result, DEEP_COMMAND, "");

    expect(rendered.stderr).toBe("");
    expect(rendered.stdout).toContain("VERDICT: COMPLETE");
    expect(rendered.stdout).toContain(GROUNDING_PASS_MESSAGE);
    expect(rendered.stdout).not.toContain(DEEP_COMMAND);
  });
});
