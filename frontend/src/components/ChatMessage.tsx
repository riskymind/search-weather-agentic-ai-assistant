"use client";

import { Check, Copy, Info, RotateCcw } from "lucide-react";
import { useState } from "react";

import { AgentActivity } from "@/components/AgentActivity";
import { BrandMark } from "@/components/BrandMark";
import { ErrorMessage } from "@/components/ErrorMessage";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { MarkdownContent } from "@/components/MarkdownContent";
import { SearchResultCard } from "@/components/SearchResultCard";
import { WeatherCard } from "@/components/WeatherCard";
import type { AssistantMessage, ChatMessage as ChatMessageModel } from "@/lib/chat";
import type { SearchResult, WeatherData } from "@/types/agent";

interface ChatMessageProps {
  message: ChatMessageModel;
  onRetry?: (assistantMessageId: string) => void;
  retryDisabled?: boolean;
}

export function ChatMessage({ message, onRetry, retryDisabled }: ChatMessageProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[0.95rem] leading-relaxed whitespace-pre-wrap break-words">
          <span className="sr-only">You said: </span>
          {message.content}
        </div>
      </div>
    );
  }
  return <AssistantReply message={message} onRetry={onRetry} retryDisabled={retryDisabled} />;
}

function collectResults(message: AssistantMessage) {
  const weather: WeatherData[] = [];
  const sources: SearchResult[] = [];
  const seen = new Set<string>();
  for (const tool of message.tools) {
    if (tool.status !== "completed" || !tool.data) continue;
    if (tool.data.kind === "weather") weather.push(tool.data);
    else
      for (const result of tool.data.results) {
        if (seen.has(result.url)) continue;
        seen.add(result.url);
        sources.push(result);
      }
  }
  return { weather, sources };
}

function AssistantReply({ message, onRetry, retryDisabled }: ChatMessageProps & { message: AssistantMessage }) {
  const streaming = message.status === "streaming";
  const { weather, sources } = collectResults(message);
  const showActivity = message.tools.length > 0 || streaming;
  const waitingForText = streaming && !message.content;

  return (
    <article className="flex gap-3" aria-busy={streaming}>
      <BrandMark className="mt-0.5 hidden size-7 shrink-0 sm:block" />
      <div className="min-w-0 flex-1 space-y-3">
        <h2 className="sr-only">Assistant reply</h2>
        {message.sessionReset && (
          <p className="flex items-start gap-2 text-xs text-muted">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            The assistant started a new session, so it no longer remembers earlier messages in this conversation.
          </p>
        )}

        {showActivity && <AgentActivity message={message} />}

        {weather.map((data, i) => (
          <WeatherCard key={`${data.city}-${i}`} data={data} />
        ))}

        {waitingForText && message.stage !== "tools" && (
          <LoadingIndicator label={message.stage === "analyzing" ? "Analyzing your request" : "Preparing your answer"} />
        )}

        {message.content && (
          <div className={streaming ? "streaming-caret" : undefined}>
            <MarkdownContent content={message.content} />
          </div>
        )}

        {message.status === "error" && message.error && (
          <ErrorMessage
            error={message.error}
            onRetry={onRetry ? () => onRetry(message.id) : undefined}
            retryDisabled={retryDisabled}
          />
        )}

        {message.status === "cancelled" && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>Stopped before the answer finished.</span>
            {onRetry && (
              <button
                type="button"
                onClick={() => onRetry(message.id)}
                disabled={retryDisabled}
                className="focus-ring inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-accent hover:underline disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                Ask again
              </button>
            )}
          </div>
        )}

        {sources.length > 0 && (
          <section aria-label="Sources" className="pt-1">
            <h3 className="mb-2 text-sm font-medium text-muted">Sources</h3>
            <ul className="grid gap-2 sm:grid-cols-2">
              {sources.map((result) => (
                <li key={result.url}>
                  <SearchResultCard result={result} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {message.status === "complete" && message.content && <CopyButton text={message.content} />}
      </div>
    </article>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context or denied): nothing to do.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="focus-ring inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-ink"
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      {copied ? "Copied" : "Copy answer"}
    </button>
  );
}
