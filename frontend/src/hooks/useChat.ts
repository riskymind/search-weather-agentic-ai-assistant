"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, isAbortError, streamAgent } from "@/lib/api";
import {
  applyStreamEvent,
  cancelMessage,
  errorFromApi,
  failMessage,
  newAssistantMessage,
  newUserMessage,
  type AssistantMessage,
  type Conversation,
} from "@/lib/chat";
import { MAX_MESSAGE_CHARS } from "@/types/agent";

interface UseChatOptions {
  conversation: Conversation | null;
  createConversation: (firstMessage: string) => string;
  updateConversation: (id: string, update: (conversation: Conversation) => Conversation) => void;
}

export interface ChatApi {
  send: (text: string) => Promise<void>;
  stop: () => void;
  retry: (assistantMessageId: string) => void;
  isStreaming: boolean;
  streamingConversationId: string | null;
}

/** Sends messages over SSE and folds stream events into the conversation. One turn at a time. */
export function useChat({ conversation, createConversation, updateConversation }: UseChatOptions): ChatApi {
  const controllerRef = useRef<AbortController | null>(null);
  const [streamingConversationId, setStreamingConversationId] = useState<string | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const updateAssistant = useCallback(
    (conversationId: string, messageId: string, update: (message: AssistantMessage) => AssistantMessage) => {
      updateConversation(conversationId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === messageId && m.role === "assistant" ? update(m) : m)),
      }));
    },
    [updateConversation],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || message.length > MAX_MESSAGE_CHARS || controllerRef.current) return;

      const conversationId = conversation?.id ?? createConversation(message);
      const previousSessionId = conversation?.sessionId ?? null;
      const userMessage = newUserMessage(message);
      const assistant = newAssistantMessage();
      updateConversation(conversationId, (c) => ({ ...c, messages: [...c.messages, userMessage, assistant] }));

      const controller = new AbortController();
      controllerRef.current = controller;
      setStreamingConversationId(conversationId);

      try {
        await streamAgent(
          { message, session_id: previousSessionId },
          {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.event === "session") {
                // Always adopt the server's session ID (it may differ if the old one expired).
                updateConversation(conversationId, (c) => ({ ...c, sessionId: event.session_id }));
                if (previousSessionId && event.is_new_session) {
                  updateAssistant(conversationId, assistant.id, (m) => ({ ...m, sessionReset: true }));
                }
                return;
              }
              updateAssistant(conversationId, assistant.id, (m) => applyStreamEvent(m, event));
            },
          },
        );
      } catch (error) {
        if (isAbortError(error)) {
          updateAssistant(conversationId, assistant.id, cancelMessage);
        } else {
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({ code: "internal_error", message: "Something went wrong while sending your message." });
          updateAssistant(conversationId, assistant.id, (m) => failMessage(m, errorFromApi(apiError)));
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        setStreamingConversationId(null);
      }
    },
    [conversation, createConversation, updateConversation, updateAssistant],
  );

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  const retry = useCallback(
    (assistantMessageId: string) => {
      if (!conversation || controllerRef.current) return;
      const index = conversation.messages.findIndex((m) => m.id === assistantMessageId);
      const userMessage = conversation.messages[index - 1];
      if (index < 1 || userMessage?.role !== "user") return;
      // Drop the failed exchange, then resend the same question.
      updateConversation(conversation.id, (c) => ({
        ...c,
        messages: c.messages.filter((m) => m.id !== assistantMessageId && m.id !== userMessage.id),
      }));
      void send(userMessage.content);
    },
    [conversation, send, updateConversation],
  );

  return { send, stop, retry, isStreaming: streamingConversationId !== null, streamingConversationId };
}
