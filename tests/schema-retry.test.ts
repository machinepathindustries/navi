import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { schemaRetryProcessor } from "../src/mastra/schema-retry.ts";
import { Evidence } from "../src/contracts/whisper.ts";
import judgeComposite from "../builtin/workflows/edge-walk/judge.schema.ts";

// Pure processor unit tests with no model or stream. The generic
// self-correcting output processor is exercised by handing its `processOutputStep`
// a fabricated ProcessOutputStepArgs (only the fields it reads: `text`,
// `retryCount`, `abort`, `messageList`) and asserting the abort/re-ask contract.
// abort() is a `=> never` in production (Mastra unwinds the loop); here it is a
// spy that records-and-throws a sentinel so control flow matches production.

const ABORT_SENTINEL = Symbol("abort");

type AbortCall = { reason?: string; options?: { retry?: boolean } };

// Build a minimal args stand-in. Cast through unknown: the real type has many
// runtime-only fields (usage, steps, systemMessages …) the processor never reads.
// `finishReason` defaults to "stop" — the terminal text emission the processor
// validates; pass "tool-calls" (etc.) to exercise the intermediate-step skip.
function fakeArgs(text: string, retryCount = 0, finishReason = "stop") {
  const calls: AbortCall[] = [];
  const messageList = { __sentinel: "messageList" };
  const abort = vi.fn((reason?: string, options?: { retry?: boolean }) => {
    calls.push({ reason, options });
    throw ABORT_SENTINEL; // mirror production: abort never returns
  });
  const args = { text, retryCount, finishReason, abort, messageList } as unknown as Parameters<
    NonNullable<ReturnType<typeof schemaRetryProcessor>["processOutputStep"]>
  >[0];
  return { args, calls, abort, messageList };
}

// Run processOutputStep, swallowing only the abort sentinel so a real error still
// surfaces the test failure.
function run(proc: ReturnType<typeof schemaRetryProcessor>, args: unknown) {
  try {
    return proc.processOutputStep!(args as never);
  } catch (e) {
    if (e === ABORT_SENTINEL) return undefined;
    throw e;
  }
}

const validEvidence = JSON.stringify({
  kind: "command_result",
  command: "npm test",
  exit_code: 0,
  claim_supported: true,
});

describe("schemaRetryProcessor — invalid emission re-asks with the field paths", () => {
  it("aborts WITH retry:true and a message naming the failing field path", () => {
    // exit_code: "" is the live species-6 failure — a string where a number is
    // required; `modelOptional(z.number().int())` rejects it one layer up.
    const bad = JSON.stringify({ kind: "command_result", exit_code: "", claim_supported: true });
    const { args, calls, abort } = fakeArgs(bad);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(calls[0]!.options).toEqual({ retry: true });
    // The re-ask carries the model's own error, keyed by the field path.
    expect(calls[0]!.reason).toContain("exit_code");
    expect(calls[0]!.reason).toContain('step "judge"');
  });

  it("aborts WITH retry:true when the emission is not valid JSON", () => {
    const { args, calls, abort } = fakeArgs("not json at all {");
    const proc = schemaRetryProcessor({ stepName: "recon", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(calls[0]!.options).toEqual({ retry: true });
    expect(calls[0]!.reason).toContain("not valid JSON");
  });

  it("names every failing path when several fields are wrong", () => {
    const bad = JSON.stringify({ kind: "not_a_kind", exit_code: "", claim_supported: "yes" });
    const { args, calls } = fakeArgs(bad);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(calls[0]!.reason).toContain("kind");
    expect(calls[0]!.reason).toContain("exit_code");
    expect(calls[0]!.reason).toContain("claim_supported");
  });

  it("an empty-string judgment field on the real judge composite re-asks", () => {
    // The production wiring: the judge step validates against judgeComposite, which
    // requires non-empty judgment strings. An emission with reason:"" triggers a
    // retry that names `reason`.
    const bad = JSON.stringify({
      gate: "CLEAR",
      reason: "",
      blocking_directive_ids: [],
      non_blocking_risks: [],
      human_escalation: null,
      confidence: 0.9,
      directives: [],
      findings: [],
    });
    const { args, calls, abort } = fakeArgs(bad);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: judgeComposite, maxRetries: 2 });
    run(proc, args);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(calls[0]!.options).toEqual({ retry: true });
    expect(calls[0]!.reason).toContain("reason");
  });
});

describe("schemaRetryProcessor — valid emission is untouched", () => {
  it("does NOT abort and returns the messageList unchanged", () => {
    const { args, abort, messageList } = fakeArgs(validEvidence);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    const ret = run(proc, args);
    expect(abort).not.toHaveBeenCalled();
    expect(ret).toBe(messageList);
  });

  it("tolerates surrounding whitespace around a valid emission", () => {
    const { args, abort } = fakeArgs(`\n  ${validEvidence}\n`);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(abort).not.toHaveBeenCalled();
  });

  it("accepts exactly one schema-valid payload with a mechanical prose wrapper", () => {
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    const fenced = fakeArgs(`\`\`\`json\n${validEvidence}\n\`\`\``);
    run(proc, fenced.args);
    expect(fenced.abort).not.toHaveBeenCalled();

    const narratedFence = fakeArgs(`Here is the result:\n\`\`\`json\n${validEvidence}\n\`\`\`\nDone.`);
    run(proc, narratedFence.args);
    expect(narratedFence.abort).not.toHaveBeenCalled();

    const narratedObject = fakeArgs(`I have now finished the check.\n${validEvidence}\nThat is the result.`);
    run(proc, narratedObject.args);
    expect(narratedObject.abort).not.toHaveBeenCalled();

    const ambiguous = fakeArgs(`First: ${validEvidence}\nSecond: ${validEvidence}`);
    run(proc, ambiguous.args);
    expect(ambiguous.abort).toHaveBeenCalledTimes(1);
    expect(ambiguous.calls[0]!.reason).toContain("not valid JSON");
  });
});

describe("schemaRetryProcessor — no declared schema is a no-op", () => {
  it("never aborts even on garbage text when schema is undefined (text-only step)", () => {
    const { args, abort, messageList } = fakeArgs("literally anything, not even json");
    const proc = schemaRetryProcessor({ stepName: "summarize", schema: undefined, maxRetries: 2 });
    const ret = run(proc, args);
    expect(abort).not.toHaveBeenCalled();
    expect(ret).toBe(messageList); // pass-through, no validation performed
  });
});

describe("schemaRetryProcessor — only the final emission is validated", () => {
  it("skips an intermediate tool-call step (finishReason != stop, empty text) — never aborts", () => {
    // The judge is a tool-using agent: intermediate steps finish "tool-calls" with
    // NO answer text. Validating those (empty → 'Unexpected end of JSON input')
    // would abort the grounding loop before an answer exists. Must pass through.
    const { args, abort, messageList } = fakeArgs("", 0, "tool-calls");
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    const ret = run(proc, args);
    expect(abort).not.toHaveBeenCalled();
    expect(ret).toBe(messageList);
  });

  it("skips a non-empty intermediate step that is not the terminal stop step", () => {
    // Even if an intermediate step carries partial/reasoning text, it is not the
    // structured answer — only finishReason "stop" is validated.
    const partial = '{"kind":"command_result"'; // truncated on a tool-calls step
    const { args, abort } = fakeArgs(partial, 0, "tool-calls");
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(abort).not.toHaveBeenCalled();
  });

  it("validates the terminal stop step that follows tool calls", () => {
    // After tools, the final "stop" step carries the real JSON — validate it.
    const { args, abort } = fakeArgs(validEvidence, 0, "stop");
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2 });
    run(proc, args);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("schemaRetryProcessor — the stderr retry notice is precise", () => {
  it("fires notify(retryCount+1) while under the cap", () => {
    const notify = vi.fn();
    const bad = JSON.stringify({ kind: "command_result", exit_code: "", claim_supported: true });
    // retryCount 0 → this is the first failure → notice "retry 1"
    const first = fakeArgs(bad, 0);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2, notify });
    run(proc, first.args);
    expect(notify).toHaveBeenLastCalledWith(1);
    // retryCount 1 → "retry 2" (still under the cap of 2)
    const second = fakeArgs(bad, 1);
    run(proc, second.args);
    expect(notify).toHaveBeenLastCalledWith(2);
  });

  it("does NOT fire notify on the exhausting attempt (retryCount == maxRetries)", () => {
    const notify = vi.fn();
    const bad = JSON.stringify({ kind: "command_result", exit_code: "", claim_supported: true });
    // retryCount already at the cap: this abort becomes a tripwire, no phantom notice.
    const { args, abort } = fakeArgs(bad, 2);
    const proc = schemaRetryProcessor({ stepName: "judge", schema: Evidence, maxRetries: 2, notify });
    run(proc, args);
    expect(abort).toHaveBeenCalledTimes(1); // still aborts (→ tripwire)
    expect(abort.mock.calls[0]![1]).toEqual({ retry: true });
    expect(notify).not.toHaveBeenCalled(); // but no misleading "retry 3"
  });
});

describe("schemaRetryProcessor — identity", () => {
  it("carries a stable, step-scoped processor id", () => {
    const proc = schemaRetryProcessor({ stepName: "judge", schema: z.object({}), maxRetries: 2 });
    expect(proc.id).toBe("navi.schema-retry.judge");
  });
});
