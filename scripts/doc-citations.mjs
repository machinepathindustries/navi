#!/usr/bin/env node
// Validate every repo-relative path:line citation in Navi's public docs.
//
// The scan covers README.md, CONTRIBUTING.md, docs/README.md, and every
// Mintlify page. Literal `text` fences may show output from another repository,
// so citations inside those fences are ignored.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// resolve() strips a trailing slash so under-root checks stay reliable.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const isUnderRoot = (abs) => {
  const rel = relative(ROOT, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// Path (slashes + name chars) ending in an allowed extension, then :N or :N-M.
// Extension list is deliberate: without it, "05:12" or "navi.run.v1"
// look citation-shaped.
const CITATION_RE =
  /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.(?:ts|tsx|mjs|js|json|yaml|yml|md)):(\d+)(?:-(\d+))?/g;

const walkMarkdown = (dir, extensions) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkMarkdown(p, extensions);
    return extensions.some((extension) => e.name.endsWith(extension)) ? [p] : [];
  });
};

const scanTargets = () => {
  const files = [
    ...walkMarkdown(join(ROOT, "docs", "mintlify"), [".mdx"]),
    join(ROOT, "README.md"),
    join(ROOT, "CONTRIBUTING.md"),
    join(ROOT, "docs", "README.md"),
  ];
  return files.filter((f) => existsSync(f) && statSync(f).isFile()).sort();
};

// Editor-style line count: trailing newline does not invent an extra line.
const lineCountOf = (text) => {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, "").split("\n").length;
};

// relPath -> { lines: number } on hit, or { reason: string } on permanent miss.
const lineCountCache = new Map();

const resolveFile = (rawPath) => {
  // Strip leading ./ and normalize to forward-slash repo-relative form.
  const cleaned = rawPath.replace(/^\.\//, "").replace(/\\/g, "/");
  if (cleaned.startsWith("/") || /^[A-Za-z]:\//.test(cleaned)) {
    return { rel: cleaned, lines: null, reason: "not repo-relative" };
  }
  if (cleaned.includes("..")) {
    return { rel: cleaned, lines: null, reason: "path escapes repo root" };
  }

  if (lineCountCache.has(cleaned)) {
    const cached = lineCountCache.get(cleaned);
    return cached.lines !== undefined
      ? { rel: cleaned, lines: cached.lines, reason: null }
      : { rel: cleaned, lines: null, reason: cached.reason };
  }

  const abs = resolve(ROOT, cleaned);
  // Belt-and-braces: resolved path must stay under ROOT.
  if (!isUnderRoot(abs)) {
    lineCountCache.set(cleaned, { reason: "path escapes repo root" });
    return { rel: cleaned, lines: null, reason: "path escapes repo root" };
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    lineCountCache.set(cleaned, { reason: "file missing" });
    return { rel: cleaned, lines: null, reason: "file missing" };
  }
  const lines = lineCountOf(readFileSync(abs, "utf8"));
  lineCountCache.set(cleaned, { lines });
  return { rel: cleaned, lines, reason: null };
};

const literalOutputRanges = (text) =>
  [...text.matchAll(/^```text[^\n]*\n[\s\S]*?^```[ \t]*$/gm)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

const extractCitations = (text) => {
  const hits = [];
  const ignored = literalOutputRanges(text);
  // Reset lastIndex defensively (global regex).
  CITATION_RE.lastIndex = 0;
  let m;
  while ((m = CITATION_RE.exec(text)) !== null) {
    if (ignored.some((range) => m.index >= range.start && m.index < range.end)) {
      continue;
    }
    const path = m[1];
    const start = Number(m[2]);
    const end = m[3] !== undefined ? Number(m[3]) : start;
    // m[0] may include a leading delimiter char; the path itself starts at
    // the capture. Locate the citation start for line-in-doc reporting.
    const citeStart = m.index + (m[0].startsWith(path) ? 0 : 1);
    const citation = end === start ? `${path}:${start}` : `${path}:${start}-${end}`;
    hits.push({ path, start, end, citation, index: citeStart });
  }
  return hits;
};

const lineAtIndex = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
};

const checkCitation = ({ path, start, end }) => {
  const { rel, lines, reason } = resolveFile(path);
  if (reason) return { ok: false, reason, citation: end === start ? `${rel}:${start}` : `${rel}:${start}-${end}` };
  if (!Number.isFinite(start) || start < 1) {
    return { ok: false, reason: `line ${start} invalid`, citation: `${rel}:${start}${end !== start ? `-${end}` : ""}` };
  }
  if (end !== start && (!Number.isFinite(end) || end < 1)) {
    return { ok: false, reason: `line ${end} invalid`, citation: `${rel}:${start}-${end}` };
  }
  if (start > lines) {
    return {
      ok: false,
      reason: `line ${start} past EOF (${lines} lines)`,
      citation: end === start ? `${rel}:${start}` : `${rel}:${start}-${end}`,
    };
  }
  if (end > lines) {
    return {
      ok: false,
      reason: `line ${end} past EOF (${lines} lines)`,
      citation: `${rel}:${start}-${end}`,
    };
  }
  return {
    ok: true,
    citation: end === start ? `${rel}:${start}` : `${rel}:${start}-${end}`,
  };
};

const files = scanTargets();
const stale = [];
let totalCitations = 0;
const filesWithCitations = new Set();

for (const abs of files) {
  const relDoc = relative(ROOT, abs).replace(/\\/g, "/");
  const text = readFileSync(abs, "utf8");
  const cites = extractCitations(text);
  if (cites.length === 0) continue;
  filesWithCitations.add(relDoc);
  for (const c of cites) {
    totalCitations++;
    const result = checkCitation(c);
    if (!result.ok) {
      const docLine = lineAtIndex(text, c.index);
      stale.push({
        doc: relDoc,
        docLine,
        citation: result.citation,
        reason: result.reason,
      });
    }
  }
}

const fileCount = filesWithCitations.size;

if (stale.length > 0) {
  for (const s of stale) {
    console.error(`${s.doc}:${s.docLine}  ->  ${s.citation}  (${s.reason})`);
  }
  console.error(
    `doc-citations FAIL — ${stale.length} stale of ${totalCitations} citations across ${fileCount} files`,
  );
  process.exit(1);
}

console.log(
  `doc-citations OK — ${totalCitations} citations across ${fileCount} files resolve, 0 stale`,
);
