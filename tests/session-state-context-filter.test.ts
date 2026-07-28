import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageList, type MastraDBMessage } from "@mastra/core/agent";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { buildShape } from "../src/compiler/shape.ts";
import { compile } from "../src/compiler/compile.ts";
import { parseSpecText } from "../src/compiler/parse.ts";
import { naviAgent } from "../src/mastra/agents/navi.ts";
import {
  SESSION_STATE_CONTEXT_FILTER_ID,
  sessionStateContextFilter,
} from "../src/mastra/session-state-context-filter.ts";
import type { SessionState } from "../src/contracts/whisper.ts";
import { SESSION_STATE_KIND } from "../src/session-state.ts";

const RESOURCE_ID = "cli";
let dir: string;
let storage: LibSQLStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "navi-context-filter-"));
  storage = new LibSQLStore({ id: "context-filter-test", url: `file:${join(dir, "memory.db")}` });
  await storage.init();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function message(
  id: string,
  threadId: string,
  text: string,
  metadata?: Record<string, unknown>,
  role: "assistant" | "user" = "assistant",
): MastraDBMessage {
  return {
    id,
    threadId,
    resourceId: RESOURCE_ID,
    role,
    type: "text",
    createdAt: new Date(),
    content: {
      format: 2,
      parts: [{ type: "text", text }],
      metadata,
    },
  };
}

function stateSnapshot(sessionId: string): SessionState {
  return {
    schema_version: "navi.session.v2",
    session_id: sessionId,
    task: "unmarked assistant JSON",
    parent_events: [],
    surface_map: null,
    directives: [],
    findings: [],
    evidence: [],
    turn_history: [],
    status: "active",
  };
}

describe("session-state context filter", () => {
  it("removes only marked assistant state from model context without deleting storage", async () => {
    const threadId = randomUUID();
    const markedState = message(
      "remembered-marked-state",
      threadId,
      "machine-only state snapshot",
      { kind: SESSION_STATE_KIND },
    );
    const unmarkedValidState = message(
      "remembered-unmarked-valid-state",
      threadId,
      JSON.stringify(stateSnapshot(threadId)),
    );
    const unmarkedMalformedState = message(
      "remembered-unmarked-malformed-state",
      threadId,
      JSON.stringify({
        schema_version: "navi.session.v2",
        session_id: threadId,
        task: "unmarked malformed-looking assistant JSON",
      }),
    );
    const ordinaryJson = message(
      "remembered-ordinary-json",
      threadId,
      JSON.stringify({ event: "ordinary JSON stays" }),
    );
    const rememberedUserCollision = message(
      "remembered-user-session-json",
      threadId,
      JSON.stringify({
        schema_version: "navi.session.v2",
        session_id: threadId,
        task: "user text, not machine state",
      }),
      undefined,
      "user",
    );
    const rememberedRunEnvelope = message(
      "remembered-run-envelope",
      threadId,
      JSON.stringify({
        schema_version: "navi.run.v2",
        session_id: threadId,
        status: "active",
      }),
    );
    const conversation = message("remembered-conversation", threadId, "ordinary remembered conversation");
    const raw = await storage.getStore("memory");
    if (!raw) throw new Error("memory store unavailable");
    const now = new Date();
    await raw.saveThread({
      thread: {
        id: threadId,
        resourceId: RESOURCE_ID,
        title: "context filter",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    });
    await raw.saveMessages({
      messages: [
        markedState,
        unmarkedValidState,
        unmarkedMalformedState,
        ordinaryJson,
        rememberedUserCollision,
        rememberedRunEnvelope,
        conversation,
      ],
    });

    const memory = new Memory();
    memory.setStorage(storage);
    const before = await memory.recall({ threadId, perPage: false });
    const currentInput = {
      ...message(
        "current-marked-input",
        threadId,
        "current input happens to carry the marker",
        { kind: SESSION_STATE_KIND },
      ),
      role: "user" as const,
    };
    const messageList = new MessageList({ threadId, resourceId: RESOURCE_ID })
      .add(before.messages, "memory")
      .add(currentInput, "input");

    const processor = sessionStateContextFilter();
    const result = processor.processInput({
      messageList,
      messages: messageList.get.all.db(),
      systemMessages: [],
      state: {},
      retryCount: 0,
      abort: (reason?: string) => {
        throw new Error(reason ?? "aborted");
      },
    });

    expect(result).toBe(messageList);
    expect(messageList.get.remembered.db().map(({ id }) => id).sort()).toEqual(
      [
        "remembered-conversation",
        "remembered-ordinary-json",
        "remembered-run-envelope",
        "remembered-unmarked-malformed-state",
        "remembered-unmarked-valid-state",
        "remembered-user-session-json",
      ].sort(),
    );
    expect(messageList.get.input.db().map(({ id }) => id)).toEqual(["current-marked-input"]);
    const prompt = JSON.stringify(messageList.get.all.prompt());
    expect(prompt).not.toContain("machine-only state snapshot");
    expect(prompt).toContain("unmarked assistant JSON");
    expect(prompt).toContain("unmarked malformed-looking assistant JSON");
    expect(prompt).toContain("ordinary remembered conversation");
    expect(prompt).toContain("ordinary JSON stays");
    expect(prompt).toContain("current input happens to carry the marker");

    const after = await memory.recall({ threadId, perPage: false });
    expect(after.messages.map(({ id }) => id).sort()).toEqual(
      [
        "remembered-conversation",
        "remembered-marked-state",
        "remembered-ordinary-json",
        "remembered-run-envelope",
        "remembered-unmarked-malformed-state",
        "remembered-unmarked-valid-state",
        "remembered-user-session-json",
      ].sort(),
    );
    expect(
      after.messages.find(({ id }) => id === "remembered-marked-state")?.content.metadata?.kind,
    ).toBe(SESSION_STATE_KIND);
  });

  it("wires distinct filter instances into the base and compiled agents", async () => {
    const shape = await buildShape(
      parseSpecText(`
name: context-filter-wiring
steps:
  - name: inspect
    type: agent
    prompt: inspect
`)._unsafeUnwrap(),
    );
    const compiled = (await compile(shape, { thread: "filter-wiring", resource: RESOURCE_ID }))._unsafeUnwrap();
    const stepAgent = compiled.agents["context-filter-wiring.inspect"]!;
    const baseProcessors = await naviAgent.listConfiguredInputProcessors();
    const stepProcessors = await stepAgent.listConfiguredInputProcessors();
    const baseFilter = baseProcessors.find(({ id }) => id === SESSION_STATE_CONTEXT_FILTER_ID);
    const stepFilter = stepProcessors.find(({ id }) => id === SESSION_STATE_CONTEXT_FILTER_ID);

    expect(baseFilter?.id).toBe(SESSION_STATE_CONTEXT_FILTER_ID);
    expect(stepFilter?.id).toBe(SESSION_STATE_CONTEXT_FILTER_ID);
    expect(stepFilter).not.toBe(baseFilter);
  });
});
