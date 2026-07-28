// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

// Compound search tools collapse multi-file mapping and multi-pattern indexing
// into one tool call. Attached via toolsets on bareQuery.
//
// Filesystem and subprocess boundaries use Result.fromThrowable; path policy
// comes from path-guard, shared with the workspace vendored-code guard. Nothing
// throws across this seam.

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { match, P } from "ts-pattern";
import { Result, ok, err } from "neverthrow";
import {
  deniedRgGlobs,
  filterAllowedHits,
  formatResolveErr,
  resolveContainedPath,
} from "../mastra/path-guard.ts";
import { errStr } from "../err.ts";
import { READ_ONLY_WORKSPACE_TOOLS } from "../mastra/workspace-tools.ts";

const MAX_PATHS = 5;
const DEFAULT_MAX_LINES = 200;
const MAX_FILE_BYTES = 400_000;

export const DEEP_SEARCH_TOOL_NAMES = [
  ...READ_ONLY_WORKSPACE_TOOLS,
  "parallel_view",
  "multi_search",
] as const;

const readText = Result.fromThrowable(
  (abs: string) => readFileSync(abs, "utf8"),
  errStr,
);

const statFile = Result.fromThrowable(
  (abs: string) => statSync(abs),
  errStr,
);

// The spawn is the only throwing call and is wrapped at the boundary. Its result
// has three outcomes: spawn failure, rg success (exit 0/1), or rg failure.
const spawnRg = Result.fromThrowable(
  (pattern: string, basePath: string, maxHits: number) =>
    spawnSync(
      "rg",
      [
        "-n", "--no-heading", "--color", "never", "-S",
        "-m", String(maxHits),
        ...deniedRgGlobs(),
        "--", pattern, ".",
      ],
      { cwd: basePath, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    ),
  errStr,
);

const runRgRaw = (pattern: string, basePath: string, maxHits: number): Result<string, string> =>
  spawnRg(pattern, basePath, maxHits).andThen((r) =>
    match(r)
      .with({ error: P.nonNullable }, (failed) => err<string, string>(errStr(failed.error)))
      .with({ status: P.union(0, 1) }, (hit) => ok<string, string>((hit.stdout ?? "").trim() || "(no matches)"))
      .otherwise((bad) => err<string, string>(`rg exit ${bad.status}: ${(bad.stderr ?? "").slice(0, 200)}`)),
  );

function windowBody(content: string, around: number | undefined, maxLines: number) {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const { start, end } = match(around)
    .with(P.number.positive(), (a) => {
      const s = Math.max(1, a - Math.floor(maxLines / 3));
      return { start: s, end: Math.min(total, s + maxLines - 1) };
    })
    .otherwise(() => ({ start: 1, end: Math.min(total, maxLines) }));
  const body = lines
    .slice(start - 1, end)
    .map((ln, j) => `${start + j}|${ln}`)
    .join("\n");
  return { start, end, body, total };
}

function openFile(basePath: string, rel: string): Result<{ abs: string; content: string }, string> {
  return resolveContainedPath(basePath, rel)
    .mapErr(formatResolveErr)
    .andThen((abs) =>
      statFile(abs)
        .mapErr((m) => `unavailable: ${m}`)
        // Not-a-file takes precedence over too-large; readText remains lazy.
        .andThen((st) =>
          match({ isFile: st.isFile(), tooBig: st.size > MAX_FILE_BYTES })
            .with({ isFile: false }, () => err<{ abs: string; content: string }, string>(`unavailable: not a file: ${rel}`))
            .with({ tooBig: true }, () => err<{ abs: string; content: string }, string>(`unavailable: too large: ${rel}`))
            .otherwise(() =>
              readText(abs)
                .map((content) => ({ abs, content }))
                .mapErr((m) => `unavailable: ${m}`),
            ),
        ),
    );
}

export function makeParallelViewTool(basePath: string) {
  return createTool({
    id: "parallel_view",
    description: `Read up to ${MAX_PATHS} files in ONE call (collapses serial view steps). Prefer this over multiple view calls when you need several files. Returns numbered line windows. Paths are workspace-relative. Vendored paths (node_modules, external, .git) are refused.`,
    inputSchema: z.object({
      paths: z.array(z.string()).min(1).max(MAX_PATHS)
        .describe("Workspace-relative file paths to read in parallel"),
      maxLinesPerFile: z.number().int().positive().max(400).optional()
        .describe(`Max lines per file (default ${DEFAULT_MAX_LINES})`),
      aroundLines: z.array(z.number().int().positive()).optional(),
    }),
    execute: async (inputData: {
      paths: string[];
      maxLinesPerFile?: number | undefined;
      aroundLines?: number[] | undefined;
    }) => {
      const input = inputData ?? { paths: [] as string[] };
      const maxLines = input.maxLinesPerFile ?? DEFAULT_MAX_LINES;
      const parts = (input.paths ?? []).map((rel, i) => {
        const around = input.aroundLines?.[i];
        return openFile(basePath, rel).match(
          ({ content }) => {
            const w = windowBody(content, around, maxLines);
            return `### ${rel} (lines ${w.start}–${w.end} of ${w.total})\n\`\`\`\n${w.body}\n\`\`\`\n`;
          },
          (message) => `### ${rel}\n(${message})\n`,
        );
      });
      return parts.join("\n");
    },
  });
}

export function makeMultiSearchTool(basePath: string) {
  return createTool({
    id: "multi_search",
    description:
      "Run multiple ripgrep patterns in ONE call (collapses serial search_content steps). Prefer this for INDEX fan-out. Returns capped hits per pattern. Vendored trees are excluded.",
    inputSchema: z.object({
      patterns: z.array(z.string().min(1)).min(1).max(6),
      maxHitsPerPattern: z.number().int().positive().max(20).optional(),
    }),
    execute: async (inputData: {
      patterns: string[];
      maxHitsPerPattern?: number | undefined;
    }) => {
      const input = inputData ?? { patterns: [] as string[] };
      const maxHits = input.maxHitsPerPattern ?? 8;
      const blocks = (input.patterns ?? []).map((pattern) =>
        runRgRaw(pattern, basePath, maxHits).match(
          (out) => {
            // The pattern may name a sensitive basename so source code can audit
            // that policy. Safety belongs on the result paths: rg excludes those
            // files before capture, then this case-insensitive belt drops any hit
            // whose path still names a denied segment.
            const lines = out.split("\n").filter((ln) => ln.length > 0);
            const kept = filterAllowedHits(
              lines.map((ln) => {
                const m = ln.match(/^(.*?):\d+:/);
                return { path: m?.[1] ?? ln, line: ln };
              }),
            );
            const text = kept.map((k) => k.line).join("\n") || "(no matches)";
            return `### pattern \`${pattern}\`\n${text.slice(0, 4000)}\n`;
          },
          (message) => `### pattern \`${pattern}\`\n(rg failed: ${message})\n`,
        ),
      );
      return blocks.join("\n");
    },
  });
}
