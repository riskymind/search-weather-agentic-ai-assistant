"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { MAX_MESSAGE_CHARS } from "@/types/agent";

const MAX_HEIGHT_PX = 200;
const COUNTER_THRESHOLD = MAX_MESSAGE_CHARS - 500;

interface ChatInputProps {
  onSubmit: (message: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  /** Disabled for a reason other than this conversation streaming (e.g. another one is). */
  disabled?: boolean;
}

export function ChatInput({ onSubmit, onStop, isStreaming, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = value.trim();
  const tooLong = value.length > MAX_MESSAGE_CHARS;
  const canSend = trimmed.length > 0 && !tooLong && !isStreaming && !disabled;

  // Grow with content up to a limit, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSubmit(trimmed);
    setValue("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline; ignore Enter while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line bg-bg/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
      <form onSubmit={submit} className="mx-auto w-full max-w-[760px]">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_1px_2px_rgb(23_32_51/0.06)] focus-within:border-accent/60">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={disabled ? "Waiting for the other conversation to finish…" : "Ask anything, or check the weather"}
            aria-describedby="chat-input-hint"
            aria-invalid={tooLong || undefined}
            className="max-h-[200px] min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-2 text-[0.95rem] leading-relaxed outline-none placeholder:text-muted disabled:cursor-not-allowed"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="focus-ring grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-bg hover:opacity-90"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              className="focus-ring grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div id="chat-input-hint" className="mt-2 flex items-center justify-between gap-4 px-1 text-xs text-muted">
          <span className="hidden sm:inline">Enter to send, Shift + Enter for a new line.</span>
          <span className="sm:hidden">Answers can be wrong; check the sources.</span>
          {value.length > COUNTER_THRESHOLD && (
            <span className={tooLong ? "font-medium text-danger" : undefined} aria-live="polite">
              {value.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
