import { describe, it, expect } from "vitest";
import { parseSharpen } from "../builtin/workflows/sharpen/parse-sharpen.mjs";
import { GateDecision, Directive } from "../src/contracts/whisper.ts";

// The sharpen emission step writes plain markdown; parse-sharpen.mjs turns it
// into a GateDecision (+ directives/handoff siblings) deterministically. These
// fixtures cover each of ASK/READY/HUMAN, the confidence mapping, and the
// structural violations that MUST fail honestly. A parse that succeeds must
// also validate against the real Zod GateDecision + Directive schemas — that
// ties the dependency-free parser to the whisper contracts so they cannot drift.
// The load-bearing assertion: the whole lane depends on the output parsing as a
// GateDecision so the shape-keyed whisper path activates.

const ASK_MD = `## Read
The parent wants navi onboarding to be less painful for a cold agent, but the concrete change is still fuzzy.

## Gate
ASK

## Question
What is the single smallest behavior change a cold agent would notice on their first \`navi\` run?

## Why
THE REAL ASK is still open — without a one-sentence change, founder has nothing concrete to judge.

## Bring back
- One sentence naming the user-visible change
- Who the cold agent is (role) in one phrase

## Brief
NONE

## Confidence
medium

## Grounding
semantic-only
`;

const READY_MD = `## Read
The idea is now a concrete onboarding wedge: a first-run orientation that lists flows and when to reach for each.

## Gate
READY

## Question
NONE

## Why
All five dimensions are answered enough to write a founder-ready brief.

## Bring back
NONE

## Brief
Ship a first-run orientation for cold agents: when \`navi\` is invoked with no args in a repo that has not been oriented, print the available flows and a one-line when-to-use for each (including sharpen vs founder vs founder-advice), then exit 0. Out of scope: interactive wizard, repo indexing, or rewriting existing help. Kill if agents already reach the right flow from the catalog alone within one attempt.

## Confidence
high

## Grounding
semantic-only
`;

const READY_GROUNDED_MD = READY_MD.replace(
  "## Grounding\nsemantic-only\n",
  "## Grounding\ngrounded\n",
).replace(
  "## Confidence\nhigh\n",
  "## Confidence\nlow\n",
);

const HUMAN_MD = `## Read
The parent hit a scope fork that only a human product owner can pick.

## Gate
HUMAN

## Question
Should the first-run orientation be opt-in via a flag, or the default for bare \`navi\` with no args?

## Why
BLAST RADIUS and product defaults require a human call the parent agent cannot make alone.

## Bring back
NONE

## Brief
NONE

## Confidence
medium

## Grounding
semantic-only
`;

function expectValidGate(md: string) {
  const r = parseSharpen(md);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  // Load-bearing: output must satisfy GateDecision (shape-keyed whisper path).
  const gd = GateDecision.safeParse(r.value);
  expect(gd.success).toBe(true);
  if (!gd.success) throw new Error(gd.error.message);
  // When directives are present, each must satisfy Directive (≥1 required_evidence
  // and ≥1 completion_criteria are the schema floor).
  const directives = (r.value as { directives?: unknown }).directives;
  if (Array.isArray(directives)) {
    for (const d of directives) {
      const dd = Directive.safeParse(d);
      expect(dd.success).toBe(true);
      if (!dd.success) throw new Error(dd.error.message);
    }
  }
  return r.value as Record<string, unknown>;
}

describe("sharpen parser — ASK", () => {
  it("maps ASK → DIRECT with one forcing_question directive and validates schemas", () => {
    const v = expectValidGate(ASK_MD);
    expect(v.gate).toBe("DIRECT");
    expect(v.reason).toMatch(/onboarding/);
    expect(v.blocking_directive_ids).toEqual(
      expect.arrayContaining([(v.directives as { id: string }[])[0].id]),
    );
    expect(v.human_escalation).toBeNull();
    expect(v.confidence).toBe(0.6);

    const d = (v.directives as Record<string, unknown>[])[0];
    expect(d.type).toBe("forcing_question");
    expect(d.priority).toBe(1);
    expect(d.severity).toBe("blocking");
    expect(d.status).toBe("open");
    expect(d.action).toMatch(/smallest behavior change/);
    expect(d.reason).toMatch(/REAL ASK/);
    expect(d.targets).toEqual([]);
    expect(d.required_evidence).toEqual([
      "One sentence naming the user-visible change",
      "Who the cold agent is (role) in one phrase",
    ]);
    expect(Array.isArray(d.completion_criteria)).toBe(true);
    expect((d.completion_criteria as string[]).length).toBeGreaterThanOrEqual(1);
    expect(d.stop_conditions).toEqual([]);
    expect(typeof d.issued_at).toBe("string");
    expect(d.issued_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("sharpen parser — READY", () => {
  it("maps READY → COMPLETE with handoff sibling and semantic-only risk", () => {
    const v = expectValidGate(READY_MD);
    expect(v.gate).toBe("COMPLETE");
    expect(v.reason).toMatch(/first-run orientation/);
    expect(v.blocking_directive_ids).toEqual([]);
    expect(v.directives).toEqual([]);
    expect(v.human_escalation).toBeNull();
    expect(v.confidence).toBe(0.9);
    expect(v.non_blocking_risks).toEqual([
      "semantic-only: sharpened from conversation, not from evidence in the repo — the founder is judging a claim, not a measurement.",
    ]);
    expect(v.handoff).toEqual({
      flow: "founder",
      request: v.reason,
    });
  });

  it("maps grounded READY without the semantic-only risk line", () => {
    const v = expectValidGate(READY_GROUNDED_MD);
    expect(v.gate).toBe("COMPLETE");
    expect(v.confidence).toBe(0.3); // low
    expect(v.non_blocking_risks).toEqual([]);
    expect((v.handoff as { flow: string }).flow).toBe("founder");
  });
});

describe("sharpen parser — HUMAN", () => {
  it("maps HUMAN → ESCALATE with human_escalation = Question", () => {
    const v = expectValidGate(HUMAN_MD);
    expect(v.gate).toBe("ESCALATE");
    expect(v.reason).toMatch(/scope fork/);
    expect(v.human_escalation).toMatch(/opt-in via a flag/);
    expect(v.blocking_directive_ids).toEqual([]);
    expect(v.directives).toEqual([]);
    expect(v.confidence).toBe(0.6);
  });
});

// collapse() preserves prose and bullets in Brief. Marker-only parsing belongs
// only to Bring back.
describe("sharpen parser — Brief preserves prose and bullets", () => {
  it("READY brief with paragraph then scope bullets keeps the paragraph in handoff.request", () => {
    const md = `## Read
Idea is formed enough to write a brief.

## Gate
READY

## Question
NONE

## Why
All five dimensions are answered enough.

## Bring back
NONE

## Brief
Ship a first-run orientation banner that tells a cold agent which flow to reach for. Scope:
- the front door only
- no new DSL fields

## Confidence
high

## Grounding
semantic-only
`;
    const v = expectValidGate(md);
    expect(v.gate).toBe("COMPLETE");
    const request = (v.handoff as { request: string }).request;
    // Paragraph MUST survive — not collapse to the two bullet fragments alone.
    expect(request).toMatch(/Ship a first-run orientation banner/);
    expect(request).toMatch(/the front door only/);
    expect(request).toMatch(/no new DSL fields/);
    expect(request).not.toBe("the front door only no new DSL fields");
    expect(v.reason).toBe(request);
  });
});

describe("sharpen parser — NONE is an exact sentinel", () => {
  it("brief starting 'None of the existing lanes…' is a real brief, not NONE", () => {
    const md = READY_MD.replace(
      /## Brief\n[\s\S]*?\n\n## Confidence/,
      "## Brief\nNone of the existing lanes covers first-run orientation for a cold agent; ship a banner that lists flows and when to reach for each.\n\n## Confidence",
    );
    const v = expectValidGate(md);
    expect(v.gate).toBe("COMPLETE");
    expect((v.handoff as { request: string }).request).toMatch(/^None of the existing lanes/);
    expect(v.reason).toMatch(/None of the existing lanes/);
  });
});

describe("sharpen parser — structural violations (must fail honestly)", () => {
  const failWith = (md: string) => {
    const r = parseSharpen(md);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("fails when a header is missing (non-zero path: ok:false naming the header)", () => {
    const missing = ASK_MD.replace(
      "## Why\nTHE REAL ASK is still open — without a one-sentence change, founder has nothing concrete to judge.\n\n",
      "",
    );
    expect(failWith(missing)).toMatch(/missing "## Why"/);
  });

  it("fails when ## Bring back is empty on an ASK", () => {
    const emptyBring = ASK_MD.replace(
      "## Bring back\n- One sentence naming the user-visible change\n- Who the cold agent is (role) in one phrase\n",
      "## Bring back\nNONE\n",
    );
    expect(failWith(emptyBring)).toMatch(/Bring back.*≥1|Bring back must list/);
  });

  it("fails when Gate is not one of the three", () => {
    expect(failWith(ASK_MD.replace("ASK\n", "MAYBE\n"))).toMatch(/ASK, READY, HUMAN/);
    expect(failWith(ASK_MD.replace("ASK\n", "ASK or READY\n"))).toMatch(/ASK, READY, HUMAN/);
  });

  it("fails when Confidence is not a fixed word", () => {
    expect(failWith(ASK_MD.replace("medium", "0.7"))).toMatch(/Confidence/);
  });

  it("fails when Grounding is not a fixed word", () => {
    expect(failWith(ASK_MD.replace("semantic-only", "partially"))).toMatch(/Grounding/);
  });

  it("fails when READY has no brief", () => {
    expect(failWith(READY_MD.replace(/## Brief\n[\s\S]*?\n\n## Confidence/, "## Brief\nNONE\n\n## Confidence"))).toMatch(
      /Brief/,
    );
  });

});
