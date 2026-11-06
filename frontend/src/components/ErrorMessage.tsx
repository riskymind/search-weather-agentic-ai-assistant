import { RotateCcw, TriangleAlert } from "lucide-react";

import type { MessageError } from "@/lib/chat";

const TITLES: Record<string, string> = {
  network_error: "Can't reach the assistant",
  stream_interrupted: "The connection dropped",
  rate_limited: "Too many requests",
  session_busy: "Still answering your previous message",
  agent_timeout: "The answer took too long",
  llm_provider_error: "The language model is unavailable",
  validation_error: "That message couldn't be sent",
  request_too_large: "That message is too long",
  access_required: "Your access has expired",
  access_not_configured: "This demo isn't available yet",
  backend_unreachable: "Can't reach the assistant",
  backend_unavailable: "The assistant is unavailable",
  backend_not_configured: "The assistant is unavailable",
  upstream_timeout: "The answer took too long",
};

export function errorTitle(code: string): string {
  return TITLES[code] ?? "Something went wrong";
}

function detail(error: MessageError): string {
  if (error.code === "rate_limited" && error.retryAfterSeconds) {
    return `You've sent a lot of messages in a short time. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  return error.message;
}

interface ErrorMessageProps {
  error: MessageError;
  onRetry?: () => void;
  retryDisabled?: boolean;
}

export function ErrorMessage({ error, onRetry, retryDisabled }: ErrorMessageProps) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{errorTitle(error.code)}</p>
        <p className="mt-0.5 text-sm text-muted">{detail(error)}</p>
      </div>
      {error.code === "access_required" ? (
        <a
          href="/access"
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-medium hover:bg-surface-2"
        >
          Sign in again
        </a>
      ) : onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}
