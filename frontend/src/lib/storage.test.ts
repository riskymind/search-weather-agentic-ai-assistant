import { describe, expect, it } from "vitest";

import { newAssistantMessage, newUserMessage, type Conversation } from "@/lib/chat";
import { loadState, MAX_STORED_CONVERSATIONS, saveState } from "@/lib/storage";

const conversation = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id,
  title: `Chat ${id}`,
  sessionId: null,
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("storage", () => {
  it("round-trips conversations and the active id", () => {
    saveState({ conversations: [conversation("a", { sessionId: "s-1" })], activeId: "a" });
    expect(loadState()).toEqual({ conversations: [conversation("a", { sessionId: "s-1" })], activeId: "a" });
  });

  it("returns empty state for missing, corrupt or old-version data", () => {
    expect(loadState()).toEqual({ conversations: [], activeId: null });
    window.localStorage.setItem("sw-assistant:conversations", "{not json");
    expect(loadState().conversations).toEqual([]);
    window.localStorage.setItem("sw-assistant:conversations", JSON.stringify({ version: 0, conversations: [] }));
    expect(loadState().conversations).toEqual([]);
  });

  it("drops malformed conversations and unknown active ids", () => {
    window.localStorage.setItem(
      "sw-assistant:conversations",
      JSON.stringify({ version: 1, activeId: "missing", conversations: [conversation("ok"), { id: 5 }] }),
    );
    const state = loadState();
    expect(state.conversations.map((c) => c.id)).toEqual(["ok"]);
    expect(state.activeId).toBeNull();
  });

  it("marks replies that were streaming when the page closed as cancelled", () => {
    saveState({ conversations: [conversation("a", { messages: [newUserMessage("Hi"), newAssistantMessage()] })], activeId: "a" });
    const reply = loadState().conversations[0]?.messages[1];
    expect(reply).toMatchObject({ role: "assistant", status: "cancelled" });
  });

  it("caps the number of stored conversations", () => {
    const many = Array.from({ length: MAX_STORED_CONVERSATIONS + 5 }, (_, i) => conversation(String(i)));
    saveState({ conversations: many, activeId: null });
    expect(loadState().conversations).toHaveLength(MAX_STORED_CONVERSATIONS);
  });
});
