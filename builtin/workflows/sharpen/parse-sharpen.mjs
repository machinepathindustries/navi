import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deterministic parse of the sharpen emission step's eight-header markdown into
// a GateDecision (+ directives/handoff siblings). This is the sharpen workflow's
// FINAL step: a `type: command` step that runs `node parse-sharpen.mjs` with the
// emission text fed on stdin via a single-quoted heredoc — the robust way to
// hand arbitrary text to a program without the shell touching it.
//
// The MODEL emits seven simple judgment headers (plus Confidence/Grounding as
// fixed words); the PARSER owns ALL GateDecision mechanics — gate enum, directive
// assembly, confidence number mapping, and handoff sibling. A malformed
// composite must not enter the next turn; a bad header is a loud failure.
//
// A parse failure is an HONEST failure, never a guessed gate: main() writes a
// diagnostic to stderr and exits 1, so the command step fails → the workflow
// fails and the CLI maps it to exit 1.
//
// Pure JS with only a node built-in imported: the command subprocess guarantees
// `node`, not a TypeScript loader or resolvable deps. The unit tests re-validate
// this parser's output against the real Zod GateDecision + Directive schemas.

const HEADERS = [
  "Read",
  "Gate",
  "Question",
  "Why",
  "Bring back",
  "Brief",
  "Confidence",
  "Grounding",
];

// Word → GateDecision.confidence (parser-owned; the model never emits a number).
const CONFIDENCE_MAP = { high: 0.9, medium: 0.6, low: 0.3 };

// Locate a "## <Title>" marker ANYWHERE, not anchored to line start: the RLM
// glues the header onto its own trailing narration with no newline
// ("…to be thorough.## Read"). Inter-word whitespace is flexible and the match
// is case-insensitive. This tolerance can only accept more
// valid-intent output, never invent a gate (the gate token is validated
// separately). Preamble before the first header is dropped for free, because
// section bodies are only ever sliced BETWEEN header positions.
function headerRegex(title) {
  const body = title
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[ \\t]+");
  return new RegExp(`##[ \\t]*${body}`, "gi");
}

function fail(error) {
  return { ok: false, error };
}

// Literal NONE token: surrounding whitespace + trailing punctuation only.
// Do NOT loosen to `^none\b` — a real brief opening "None of the existing
// lanes…" must still parse as prose, not as the NONE sentinel.
function isNoneLiteral(s) {
  return /^\s*none[.!?,;:]*\s*$/i.test(String(s ?? ""));
}

// A section body → its list items. If any line carries a list marker, use only
// the marker lines (dropping any intro prose); otherwise fall back to every
// non-empty line. Code-fence lines are always dropped.
// Used for genuine LIST sections only (`## Bring back`) — prose sections use
// collapse(), which must keep every non-fence line.
function bullets(body) {
  const marker = /^\s*(?:[-*•–+]|\d+[.)])\s+/;
  const lines = body.split(/\r?\n/).filter((l) => !/^\s*```/.test(l));
  const src = lines.some((l) => marker.test(l)) ? lines.filter((l) => marker.test(l)) : lines;
  return src.map((l) => l.replace(marker, "").trim()).filter(Boolean);
}

// Collapse a PROSE section (Read / Why / Brief / Question / …) into one trimmed
// string. Preserves ALL non-fence lines — a paragraph followed by scope bullets
// keeps the paragraph. Still strips a leading list marker per line and collapses
// whitespace. Distinct from bullets(): that extractor drops non-marker lines as
// soon as any marker appears, which is correct for Bring back and wrong here.
function collapse(body) {
  const marker = /^\s*(?:[-*•–+]|\d+[.)])\s+/;
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => l.replace(marker, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractGate(body) {
  const m = collapse(body).match(/\b(ASK|READY|HUMAN)\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

function extractConfidence(body) {
  const m = collapse(body).match(/\b(high|medium|low)\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

function extractGrounding(body) {
  const m = collapse(body).match(/\b(grounded|semantic-only)\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

// Stable directive id for this round's forcing question. Pure function of the
// question text so re-parsing the same emission yields the same id; not a
// content-hash of the whole session (the CLI owns session continuity via -t).
function directiveId(question) {
  const slug = String(question)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `sharpen-${slug || "question"}`;
}

// Completion criteria for a forcing_question directive — deterministic, never
// model-emitted. The parent closes the directive by answering the question with
// the required evidence named in required_evidence.
function completionCriteria(question, bringBack) {
  return [
    `Parent answers the forcing question with concrete content covering: ${bringBack.join("; ")}`,
    `The answer addresses: ${question}`,
  ];
}

export function parseSharpen(input) {
  const text = String(input ?? "");

  // Each header must appear exactly once. Zero = missing; >1 = duplicate.
  const positions = [];
  for (const h of HEADERS) {
    const matches = [...text.matchAll(headerRegex(h))];
    if (matches.length === 0) return fail(`missing "## ${h}" header`);
    if (matches.length > 1)
      return fail(`"## ${h}" header appears ${matches.length}× (must be exactly once)`);
    const m = matches[0];
    positions.push({ header: h, start: m.index, end: m.index + m[0].length });
  }

  // The eight headers must appear in contract order.
  const byPos = [...positions].sort((a, b) => a.start - b.start);
  const order = byPos.map((p) => p.header);
  if (order.join("|") !== HEADERS.join("|"))
    return fail(`headers out of order: got [${order.join(", ")}], expected [${HEADERS.join(", ")}]`);

  // Each body runs from the end of its header to the start of the next.
  const section = {};
  for (let i = 0; i < byPos.length; i++)
    section[byPos[i].header] = text.slice(byPos[i].end, i + 1 < byPos.length ? byPos[i + 1].start : text.length);

  const read = collapse(section["Read"]);
  if (!read) return fail(`## Read is empty`);

  const gateWord = extractGate(section["Gate"]);
  if (!gateWord) return fail(`## Gate must contain exactly one of ASK, READY, HUMAN`);

  const questionRaw = collapse(section["Question"]);
  if (!questionRaw) return fail(`## Question is empty`);

  const why = collapse(section["Why"]);
  if (!why) return fail(`## Why is empty`);

  const bringBackRaw = bullets(section["Bring back"]);
  // NONE (literal, optional trailing punctuation) or empty bullets → no list.
  const bringBackNone =
    bringBackRaw.length === 0 ||
    (bringBackRaw.length === 1 && isNoneLiteral(bringBackRaw[0]));
  const bringBack = bringBackNone ? [] : bringBackRaw;

  const briefRaw = collapse(section["Brief"]);
  if (!briefRaw) return fail(`## Brief is empty (use the literal NONE when Gate is not READY)`);
  const briefNone = isNoneLiteral(briefRaw);
  const brief = briefNone ? null : briefRaw;

  const confidenceWord = extractConfidence(section["Confidence"]);
  if (!confidenceWord) return fail(`## Confidence must be exactly one of: high | medium | low`);

  const groundingWord = extractGrounding(section["Grounding"]);
  if (!groundingWord) return fail(`## Grounding must be exactly one of: grounded | semantic-only`);

  const confidence = CONFIDENCE_MAP[confidenceWord];
  const issuedAt = new Date().toISOString();

  // Gate-specific assembly. Cross-field rules fail honestly rather than guessing.
  if (gateWord === "ASK") {
    if (isNoneLiteral(questionRaw))
      return fail(`## Question must be a real question when Gate is ASK (got NONE)`);
    if (bringBack.length === 0)
      return fail(
        `## Bring back must list ≥1 required evidence bullets when Gate is ASK (got none — fail honestly rather than invent)`,
      );
    if (brief !== null)
      return fail(`## Brief must be the literal NONE when Gate is ASK`);

    const id = directiveId(questionRaw);
    const directive = {
      id,
      type: "forcing_question",
      priority: 1,
      severity: "blocking",
      status: "open",
      reason: why,
      action: questionRaw,
      targets: [],
      required_evidence: bringBack,
      completion_criteria: completionCriteria(questionRaw, bringBack),
      stop_conditions: [],
      issued_at: issuedAt,
    };

    return {
      ok: true,
      value: {
        gate: "DIRECT",
        reason: read,
        blocking_directive_ids: [id],
        non_blocking_risks: [],
        human_escalation: null,
        confidence,
        directives: [directive],
      },
    };
  }

  if (gateWord === "READY") {
    if (!isNoneLiteral(questionRaw))
      return fail(`## Question must be the literal NONE when Gate is READY`);
    if (brief === null) return fail(`## Brief must be the one-paragraph brief when Gate is READY (got NONE)`);

    const non_blocking_risks = [];
    if (groundingWord === "semantic-only") {
      non_blocking_risks.push(
        "semantic-only: sharpened from conversation, not from evidence in the repo — the founder is judging a claim, not a measurement.",
      );
    }

    return {
      ok: true,
      value: {
        gate: "COMPLETE",
        reason: brief,
        blocking_directive_ids: [],
        non_blocking_risks,
        human_escalation: null,
        confidence,
        directives: [],
        // Unknown handoff targets are ignored by the envelope renderer.
        handoff: { flow: "founder", request: brief },
      },
    };
  }

  // HUMAN
  if (isNoneLiteral(questionRaw))
    return fail(`## Question must name what the human must decide when Gate is HUMAN (got NONE)`);
  if (brief !== null) return fail(`## Brief must be the literal NONE when Gate is HUMAN`);

  return {
    ok: true,
    value: {
      gate: "ESCALATE",
      reason: read,
      blocking_directive_ids: [],
      non_blocking_risks: [],
      human_escalation: questionRaw,
      confidence,
      directives: [],
    },
  };
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const r = parseSharpen(await readStdin());
  if (!r.ok) {
    process.stderr.write(`sharpen parse failed: ${r.error}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(r.value));
}

// Run only when executed directly. Realpath comparison supports package and
// workspace symlinks while keeping imports inert.
const entryArg = process.argv[1];
const invokedDirectly =
  Boolean(entryArg) && realpathSync(entryArg) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
