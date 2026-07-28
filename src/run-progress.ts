// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import { match, P } from "ts-pattern";

// Live progress writes only to stderr. Stdout stays reserved for answer tokens
// and the --json envelope.

export type ProgressMode = "off" | "live" | "jsonl";
export const PROGRESS_MODES = ["off", "live", "jsonl"] as const;

// Resolve the effective mode. A known flag value wins; undefined (and any value
// not yet validated at the CLI layer) defaults to live on a TTY, off otherwise.
export function resolveProgressMode(flag: string | undefined, isTTY: boolean): ProgressMode {
  return match(flag)
    .with(P.union(...PROGRESS_MODES), (m) => m)
    .otherwise(() =>
      match(isTTY)
        .with(true, (): ProgressMode => "live")
        .with(false, (): ProgressMode => "off")
        .exhaustive(),
    );
}

type AgentChunk = { type: string; payload: Record<string, unknown> };

const toolNameOf = (payload: Record<string, unknown>): string =>
  match(payload.toolName)
    .with(P.string, (n) => n)
    .otherwise(() => "");

// Render ONE agent fullStream chunk to STDERR. text-delta is intentionally silent
// here — the answer path writes those tokens to STDOUT in the collect() loop.
export function agentChunkProgress(mode: ProgressMode, chunk: AgentChunk): void {
  match(mode)
    .with("off", () => undefined)
    .with("live", () =>
      match(chunk.type)
        .with("tool-call", () => {
          process.stderr.write(`navi: · ${toolNameOf(chunk.payload)}\n`);
        })
        .with("tool-result", () => {
          process.stderr.write(`navi: ✓ ${toolNameOf(chunk.payload)}\n`);
        })
        .with("tool-error", () => {
          process.stderr.write(`navi: ✗ ${toolNameOf(chunk.payload)}\n`);
        })
        .otherwise(() => undefined),
    )
    .with("jsonl", () =>
      match(chunk.type)
        .with("tool-call", "tool-result", "tool-error", () => {
          const line = match(chunk.payload.toolName)
            .with(P.string, (toolName) => JSON.stringify({ type: chunk.type, toolName }))
            .otherwise(() => JSON.stringify({ type: chunk.type }));
          process.stderr.write(`${line}\n`);
        })
        .otherwise(() => undefined),
    )
    .exhaustive();
}

type WorkflowEvent = { type: string; payload: Record<string, unknown> };

const stepIdOf = (payload: Record<string, unknown>): string => String(payload.id ?? "");
const stepStatusOf = (payload: Record<string, unknown>): string => String(payload.status ?? "");

// Render ONE workflow fullStream event to STDERR. Per-step progress for `navi run`;
// workflow-start/finish/canceled/paused and other types are silent. stdout stays
// reserved for the --json envelope.
export function workflowEventProgress(mode: ProgressMode, event: WorkflowEvent): void {
  match(mode)
    .with("off", () => undefined)
    .with("live", () =>
      match(event.type)
        .with("workflow-step-start", () => {
          process.stderr.write(`navi: ▸ ${stepIdOf(event.payload)}\n`);
        })
        .with("workflow-step-result", () => {
          const id = stepIdOf(event.payload);
          const glyph = match(stepStatusOf(event.payload))
            .with("success", () => "✓")
            .with("failed", () => "✗")
            .otherwise(() => "·");
          process.stderr.write(`navi: ${glyph} ${id}\n`);
        })
        .otherwise(() => undefined),
    )
    .with("jsonl", () =>
      match(event.type)
        .with("workflow-step-start", "workflow-step-result", () => {
          const id = stepIdOf(event.payload);
          const status = stepStatusOf(event.payload);
          const line = match(status)
            .with("", () => JSON.stringify({ type: event.type, id }))
            .otherwise((s) => JSON.stringify({ type: event.type, id, status: s }));
          process.stderr.write(`${line}\n`);
        })
        .otherwise(() => undefined),
    )
    .exhaustive();
}
