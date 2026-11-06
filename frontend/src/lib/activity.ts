/**
 * Turns an assistant message's safe execution events into user-facing activity steps.
 * Only tool names, arguments, status and summaries are shown: never model reasoning.
 */

import type { AssistantMessage, ToolActivity } from "@/lib/chat";

export type StepStatus = "running" | "done" | "failed";

export interface ActivityStep {
  key: string;
  label: string;
  detail?: string;
  status: StepStatus;
}

const LABELS: Record<string, { running: string; done: string; failed: string }> = {
  tavily_search: { running: "Searching the web", done: "Searched the web", failed: "Web search failed" },
  weather: {
    running: "Retrieving weather information",
    done: "Retrieved weather information",
    failed: "Weather information unavailable",
  },
};

function toolLabel(tool: ToolActivity): string {
  const labels = LABELS[tool.tool];
  if (!labels) return tool.status === "running" ? `Running ${tool.tool}` : `Ran ${tool.tool}`;
  return tool.status === "running" ? labels.running : tool.status === "completed" ? labels.done : labels.failed;
}

function toolInput(tool: ToolActivity): string | undefined {
  const value = tool.input.query ?? tool.input.city;
  return typeof value === "string" && value ? value : undefined;
}

function toolDetail(tool: ToolActivity): string | undefined {
  if (tool.status === "running") return toolInput(tool);
  if (tool.status === "failed") return tool.error?.message ?? tool.summary ?? undefined;
  return tool.summary ?? undefined;
}

export function buildActivitySteps(message: AssistantMessage): ActivityStep[] {
  const streaming = message.status === "streaming";
  const steps: ActivityStep[] = [
    {
      key: "analyze",
      label: "Analyzing your request",
      status: streaming && message.stage === "analyzing" && message.tools.length === 0 ? "running" : "done",
    },
  ];

  for (const tool of message.tools) {
    steps.push({
      key: tool.id,
      label: toolLabel(tool),
      detail: toolDetail(tool),
      status: tool.status === "running" ? "running" : tool.status === "completed" ? "done" : "failed",
    });
  }

  if (message.status === "complete" || (streaming && message.stage === "preparing_answer")) {
    steps.push({ key: "prepare", label: "Preparing your answer", status: streaming ? "running" : "done" });
  }
  if (message.status === "complete") steps.push({ key: "complete", label: "Completed", status: "done" });
  if (message.status === "error") steps.push({ key: "error", label: "Stopped by an error", status: "failed" });
  if (message.status === "cancelled") steps.push({ key: "cancelled", label: "Stopped", status: "failed" });
  return steps;
}

/** One-line description of what the agent did, for the collapsed activity header. */
export function summarizeActivity(message: AssistantMessage): string {
  const used = new Set(message.tools.map((t) => t.tool));
  const parts: string[] = [];
  if (used.has("tavily_search")) parts.push("searched the web");
  if (used.has("weather")) parts.push("checked the weather");
  for (const name of used) if (!LABELS[name]) parts.push(`used ${name}`);
  if (parts.length === 0) return "Answered directly";
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
