"use client";

import { useEffect } from "react";

import { ChatMessage } from "@/components/ChatMessage";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import type { ChatMessage as ChatMessageModel } from "@/lib/chat";

interface MessageListProps {
  messages: ChatMessageModel[];
  onRetry: (assistantMessageId: string) => void;
  retryDisabled: boolean;
}

export function MessageList({ messages, onRetry, retryDisabled }: MessageListProps) {
  const last = messages.at(-1);
  // Re-scroll whenever the latest message grows (tokens, tool events).
  const contentKey = `${messages.length}:${last?.role === "assistant" ? `${last.content.length}:${last.tools.length}:${last.status}` : ""}`;
  const { ref, pin } = useStickToBottom<HTMLDivElement>(contentKey);

  // A newly sent message always brings the view back to the bottom.
  const userCount = messages.filter((m) => m.role === "user").length;
  useEffect(() => pin(), [userCount, pin]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto" tabIndex={-1}>
      <div className="mx-auto w-full max-w-[760px] space-y-7 px-4 py-6 sm:px-6" role="log" aria-label="Conversation">
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} onRetry={onRetry} retryDisabled={retryDisabled} />
        ))}
      </div>
    </div>
  );
}
