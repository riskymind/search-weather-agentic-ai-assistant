"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import { ToolExecutionCard } from "@/components/ToolExecutionCard";
import { buildActivitySteps, summarizeActivity } from "@/lib/activity";
import type { AssistantMessage } from "@/lib/chat";

/** Live activity timeline; collapses to a one-line summary once the turn has finished. */
export function AgentActivity({ message }: { message: AssistantMessage }) {
  const streaming = message.status === "streaming";
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? streaming;
  const listId = useId();
  const steps = buildActivitySteps(message);

  return (
    <div className="rounded-xl border border-line bg-surface/60 px-3.5 py-2.5">
      <button
        type="button"
        className="focus-ring -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm text-muted hover:text-ink"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setUserExpanded(!expanded)}
      >
        <span className="flex-1">{streaming ? "Working on your request" : summarizeActivity(message)}</span>
        <ChevronDown
          className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <ol id={listId} aria-label="Assistant activity" aria-live="polite" className="mt-1.5">
          {steps.map((step) => (
            <ToolExecutionCard key={step.key} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}
