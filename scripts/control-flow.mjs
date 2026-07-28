#!/usr/bin/env node
// Product code in src/ branches with ts-pattern and uses neverthrow at fallible
// boundaries. This check rejects raw if statements, ternaries, and switches.
// See CONTRIBUTING.md for the contributor contract.
//
// A WALL, not a ratchet. src/ reached a hard ZERO, so there is no baseline file,
// no per-file allowance, no --update and no --init: ANY raw if / ternary / switch
// anywhere in src/ fails, and there is nothing to negotiate with. The only fix is
// to express the branch as match()/Result (or fold the test into a loop condition).
//
//   node scripts/control-flow.mjs                     # check (the gate)
//   node scripts/control-flow.mjs --list src/cli.ts   # print offending lines
//   node scripts/control-flow.mjs --hook              # PostToolUse hook (payload on stdin)
//
// This checker lives outside src/, so it can use ordinary JavaScript control
// flow to report violations in product code.
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST_CAP = 20;
const KIND = {
  [ts.SyntaxKind.IfStatement]: "if",
  [ts.SyntaxKind.ConditionalExpression]: "ternary",
  [ts.SyntaxKind.SwitchStatement]: "switch",
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

// Only these three node kinds count. A conditional TYPE (`T extends U ? A : B`)
// is ts.SyntaxKind.ConditionalType, `?.` / `?.()` is an optional chain and
// `??` / `??=` is a Binary/Assignment expression — none of them are control
// flow, none of them are hits.
//
// EVERY IfStatement counts, including one sitting in an `else` position. An
// `else if` arm is a whole extra decision; walking the else-chain and counting
// each link is what keeps a chain from growing for free.
const scan = (file) => {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const hits = [];
  const visit = (node) => {
    const kind = KIND[node.kind];
    if (kind) hits.push({ kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    ts.forEachChild(node, visit); // forEachChild descends into elseStatement, so chains are walked
  };
  ts.forEachChild(sf, visit);
  return hits;
};

const mode = process.argv[2];
const hook = mode === "--hook";
// Hook mode exits 2 so editor integrations can block the write and display the
// diagnostic. A normal command exits 1.
const FAIL_EXIT = hook ? 2 : 1;

// PostToolUse hook mode parses the tool payload with Node, the one runtime this
// checker necessarily has. A missing or malformed path fails closed.
if (hook) {
  const target = (() => {
    try {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      const p = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath;
      return typeof p === "string" && p.length > 0 ? p : undefined;
    } catch {
      return undefined; // unreadable/absent payload is NOT a pass — fall through to the check
    }
  })();
  // Only a KNOWN, non-product path takes the fast exit. An unknown one always
  // runs the full check: the hook must never pass a write it did not inspect.
  if (target !== undefined && !/(^|\/)src\/.+\.ts$/.test(target)) process.exit(0);
}

if (mode === "--list") {
  const f = process.argv[3];
  scan(join(ROOT, f)).forEach((h) => console.log(`${f}:${h.line}  ${h.kind}`));
  process.exit(0);
}

const offenders = walk(join(ROOT, "src"))
  .map((f) => ({ file: relative(ROOT, f), hits: scan(f) }))
  .filter(({ hits }) => hits.length > 0)
  .sort((a, b) => a.file.localeCompare(b.file));

const total = offenders.reduce((n, o) => n + o.hits.length, 0);

if (offenders.length) {
  offenders.forEach(({ file, hits }) => {
    console.error(`\nFAIL ${file}: ${hits.length} raw ${hits.length === 1 ? "branch" : "branches"}`);
    hits.slice(0, LIST_CAP).forEach((h) => console.error(`  ${file}:${h.line}  raw ${h.kind}`));
    if (hits.length > LIST_CAP)
      console.error(`  ...${hits.length - LIST_CAP} more — node scripts/control-flow.mjs --list ${file}`);
  });
  console.error(`
CONTRIBUTING.md requires product control flow to use ts-pattern and neverthrow Result.
No raw if/else, no
ternary used as dispatch, no switch. Use match(x).with(...).exhaustive() to dispatch over a
closed union, Result/.andThen/.map/.mapErr/.match for anything fallible, and functional
predicates (.filter(v => v !== undefined)) instead of guard ifs.

A guard or cap inside a loop converts by folding the test INTO THE LOOP CONDITION, which
stays lazy — a while-loop condition is a boolean expression, not a branch, and is compliant:
  before: for (const h of hits) { if (seen.has(k)) continue; out.push(h); if (out.length >= cap) break; }
  after:  while (out.length < cap && i < hits.length) { ...; i++; }
Use .filter()/.find()/.slice() ONLY on pure in-memory collections. On a loop that does IO per
iteration (readFileSync, spawnSync, rg), an eager .filter().slice(n) reads EVERY candidate and
turns a bounded read into an unbounded one — always keep those lazy in the loop condition.

src/ is at a hard ZERO: ${total} raw ${total === 1 ? "branch" : "branches"} above is ${total === 1 ? "one" : total} too many.
There is no baseline, no allowance, and nothing to grandfather — this is not negotiable.`);
  process.exit(FAIL_EXIT);
}
if (!hook) console.log(`control-flow OK — src/ is at ZERO raw branches (no baseline, no allowances)`);
