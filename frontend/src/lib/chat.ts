/**
 * Client-side conversation model and the pure reducer that applies stream events to an
 * assistant message. Kept free of React so it can be unit tested directly.
 */

import type { ApiError } from "@/lib/api";
import type { StreamEvent, ToolData, ToolError, ToolEvent, ToolStatus } from "@/types/agent";

export interface ToolActivity {
  id: string;
  tool: string;
  status: ToolStatus;
  input: Record<string, unknown>;
  summary: string | null;
  data: ToolData | null;
  error: ToolError | null;
}

export type AssistantStatus = "streaming" | "complete" | "error" | "cancelled";
export type AssistantStage = "analyzing" | "tools" | "preparing_answer";

export interface MessageError {
  code: string;
  message: string;
  retryAfterSeconds: number | null;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  createdAt: number;
  status: AssistantStatus;
  stage: AssistantStage;
  /** Streaming draft while `status === "streaming"`; the authoritative answer once complete. */
  content: string;
  tools: ToolActivity[];
  error: MessageError | null;
  /** The server started a fresh session (previous context expired, e.g. after a restart). */
  sessionReset: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface Conversation {
  id: string;
  title: string;
  /** Server session ID from the latest `session`/`done` event; null until the first reply. */
  sessionId: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function titleFromMessage(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

export function newUserMessage(content: string): UserMessage {
  return { id: createId(), role: "user", content, createdAt: Date.now() };
}

export function newAssistantMessage(): AssistantMessage {
  return {
    id: createId(),
    role: "assistant",
    createdAt: Date.now(),
    status: "streaming",
    stage: "analyzing",
    content: "",
    tools: [],
    error: null,
    sessionReset: false,
  };
}

const activityFrom = (event: ToolEvent): ToolActivity => ({
  id: event.id,
  tool: event.tool,
  status: event.status,
  input: event.input,
  summary: event.summary,
  data: event.data,
  error: event.error,
});

function upsertTool(tools: ToolActivity[], activity: ToolActivity): ToolActivity[] {
  const index = tools.findIndex((t) => t.id === activity.id);
  if (index === -1) return [...tools, activity];
  const next = tools.slice();
  next[index] = activity;
  return next;
}

/**
 * Apply one stream event to an assistant message.
 *
 * Draft rule (see backend README, "Streaming contract"): text tokens that arrive before a
 * `tool_start` are preamble, not the answer, so `tool_start` clears the draft; `done.answer`
 * then replaces whatever was streamed.
 */
export function applyStreamEvent(message: AssistantMessage, event: StreamEvent): AssistantMessage {
  switch (event.event) {
    case "session":
      return message;
    case "status":
      return { ...message, stage: event.stage === "analyzing" ? "analyzing" : "preparing_answer" };
    case "tool_start":
      return {
        ...message,
        stage: "tools",
        content: "",
        tools: upsertTool(message.tools, {
          id: event.id,
          tool: event.tool,
          status: "running",
          input: event.input,
          summary: null,
          data: null,
          error: null,
        }),
      };
    case "tool_end":
      return { ...message, tools: upsertTool(message.tools, activityFrom(event)) };
    case "token":
      return { ...message, stage: "preparing_answer", content: message.content + event.delta };
    case "done":
      return {
        ...message,
        status: "complete",
        content: event.answer,
        tools: event.tool_events.length > 0 ? event.tool_events.map(activityFrom) : message.tools,
      };
    case "error":
      return failMessage(message, { code: event.code, message: event.message, retryAfterSeconds: null });
  }
}

const settleRunningTools = (tools: ToolActivity[]): ToolActivity[] =>
  tools.map((t) => (t.status === "running" ? { ...t, status: "failed", summary: "Interrupted" } : t));

export function failMessage(message: AssistantMessage, error: MessageError): AssistantMessage {
  return { ...message, status: "error", error, tools: settleRunningTools(message.tools) };
}

export function cancelMessage(message: AssistantMessage): AssistantMessage {
  return { ...message, status: "cancelled", tools: settleRunningTools(message.tools) };
}

export function errorFromApi(error: ApiError): MessageError {
  return { code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds };
}
