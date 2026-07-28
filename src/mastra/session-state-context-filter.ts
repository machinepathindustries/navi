// Product code uses ts-pattern for dispatch and neverthrow Result at fallible
// boundaries. scripts/control-flow.mjs enforces the branch invariant; see
// CONTRIBUTING.md for the contributor contract.

import type { InputProcessor, ProcessInputArgs } from "@mastra/core/processors";
import { classifySessionStateMessage } from "../session-state.ts";

export const SESSION_STATE_CONTEXT_FILTER_ID = "navi-session-state-context-filter";

// MessageHistory runs before configured input processors, so remembered messages
// are present by the time this filter runs. Remove only navi's machine-owned state
// snapshots from the request-local MessageList: ordinary conversation remains
// available to the model, and storage is never read, written, or deleted here.
export function sessionStateContextFilter() {
  return {
    id: SESSION_STATE_CONTEXT_FILTER_ID,
    name: "Navi session-state context filter",
    processInput({ messageList }: ProcessInputArgs) {
      const stateIds = messageList.get.remembered
        .db()
        // Both valid and malformed marker-owned state stay out of model context;
        // unmarked JSON and ordinary chat classify as skip and remain.
        .filter((message) => classifySessionStateMessage(message).tag !== "skip")
        .map((message) => message.id);
      messageList.removeByIds(stateIds);
      return messageList;
    },
  } satisfies InputProcessor;
}
