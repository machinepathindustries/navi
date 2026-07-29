import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Deterministic parse of the founder emission step's five-header markdown into
// the verdict object (see verdict.schema.ts). This is the founder workflow's
// FINAL step: a `type: command` step that runs `node parse-verdict.mjs` with the
// emission text written directly to child stdin by Navi's command-step runtime,
// so arbitrary model text never enters the shell command string.
//
// A parse failure is an HONEST failure, never a guessed verdict: main() writes a
// diagnostic to stderr and exits 1, so the command step fails → the workflow
// fails and the CLI maps it to exit 1.
//
// Pure JS with only a node built-in imported: the command subprocess guarantees
// `node`, not a TypeScript loader or resolvable deps, so building with the grain
// (the dependency-grain rubric) means no zod/no .ts import at runtime. The unit
// tests re-validate this parser's output against the real Zod schema, keeping
// the two honest.

const HEADERS = ["Verdict", "Take", "Grounding points", "Decision rules", "What not to do"];

// Locate a "## <Title>" marker ANYWHERE, not anchored to line start: the RLM
// glues the header onto its own trailing narration with no newline
// ("…to be thorough.## Verdict"). Inter-word whitespace is flexible and the match
// is case-insensitive. This tolerance can only accept more
// valid-intent output, never invent a verdict (the verdict token is validated
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

// A section body → its list items. If any line carries a list marker, use only
// the marker lines (dropping any intro prose); otherwise fall back to every
// non-empty line. Code-fence lines are always dropped.
function bullets(body) {
  const marker = /^\s*(?:[-*•–+]|\d+[.)])\s+/;
  const lines = body.split(/\r?\n/).filter((l) => !/^\s*```/.test(l));
  const src = lines.some((l) => marker.test(l)) ? lines.filter((l) => marker.test(l)) : lines;
  return src.map((l) => l.replace(marker, "").trim()).filter(Boolean);
}

// The Take section is one sentence; collapse whatever shape it arrived in
// (a bullet, a bare line, wrapped lines) into a single trimmed string.
function collapse(body) {
  return bullets(body).join(" ").trim();
}

// The Verdict section is short and verdict-only, so a case-insensitive token
// match there is safe (prose false positives are not a real risk in a
// header-bounded slice). Normalized to the uppercase enum.
function extractVerdict(body) {
  const m = body.match(/\b(GO|REFINE|REJECT)\b/i);
  return m ? m[1].toUpperCase() : undefined;
}

export function parseVerdict(input) {
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

  // The five headers must appear in contract order.
  const byPos = [...positions].sort((a, b) => a.start - b.start);
  const order = byPos.map((p) => p.header);
  if (order.join("|") !== HEADERS.join("|"))
    return fail(`headers out of order: got [${order.join(", ")}], expected [${HEADERS.join(", ")}]`);

  // Each body runs from the end of its header to the start of the next.
  const section = {};
  for (let i = 0; i < byPos.length; i++)
    section[byPos[i].header] = text.slice(byPos[i].end, i + 1 < byPos.length ? byPos[i + 1].start : text.length);

  const verdict = extractVerdict(section["Verdict"]);
  if (!verdict) return fail(`## Verdict must contain exactly one of GO, REFINE, REJECT`);
  const take = collapse(section["Take"]);
  if (!take) return fail(`## Take is empty`);

  return {
    ok: true,
    value: {
      verdict,
      take,
      grounding_points: bullets(section["Grounding points"]),
      decision_rules: bullets(section["Decision rules"]),
      what_not_to_do: bullets(section["What not to do"]),
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
  const r = parseVerdict(await readStdin());
  if (!r.ok) {
    process.stderr.write(`founder parse failed: ${r.error}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(r.value));
}

// Run only when executed directly. Realpath comparison supports package and
// workspace symlinks while keeping imports inert.
const entryArg = process.argv[1];
const invokedDirectly =
  Boolean(entryArg) && existsSync(entryArg) && realpathSync(entryArg) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
