/**
 * Conversation history in `localStorage`.
 *
 * History lives only in this browser: it is not synced across devices and is lost if site
 * data is cleared. The backend keeps its own short-lived, in-memory session context.
 */

import { cancelMessage, type ChatMessage, type Conversation } from "@/lib/chat";

const STORAGE_KEY = "sw-assistant:conversations";
const STORAGE_VERSION = 1;
export const MAX_STORED_CONVERSATIONS = 50;

export interface StoredState {
  conversations: Conversation[];
  activeId: string | null;
}

interface Envelope extends StoredState {
  version: number;
}

const EMPTY: StoredState = { conversations: [], activeId: null };

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<Conversation>;
  return (
    typeof c.id === "string" &&
    typeof c.title === "string" &&
    (c.sessionId === null || typeof c.sessionId === "string") &&
    Array.isArray(c.messages) &&
    typeof c.updatedAt === "number"
  );
}

/** A reply that was still streaming when the page closed can never finish: mark it cancelled. */
const settle = (message: ChatMessage): ChatMessage =>
  message.role === "assistant" && message.status === "streaming" ? cancelMessage(message) : message;

export function loadState(): StoredState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.conversations)) return EMPTY;
    const conversations = parsed.conversations
      .filter(isConversation)
      .map((c) => ({ ...c, messages: c.messages.map(settle) }));
    const activeId = conversations.some((c) => c.id === parsed.activeId) ? (parsed.activeId ?? null) : null;
    return { conversations, activeId };
  } catch {
    return EMPTY;
  }
}

export function saveState(state: StoredState): void {
  try {
    const envelope: Envelope = {
      version: STORAGE_VERSION,
      activeId: state.activeId,
      conversations: state.conversations.slice(0, MAX_STORED_CONVERSATIONS),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage full or unavailable (private mode): history simply isn't persisted.
  }
}

export function clearStoredState(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
