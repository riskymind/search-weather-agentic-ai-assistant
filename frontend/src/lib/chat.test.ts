import { describe, expect, it } from "vitest";

import { buildActivitySteps, summarizeActivity } from "@/lib/activity";
import { applyStreamEvent, cancelMessage, newAssistantMessage, titleFromMessage, type AssistantMessage } from "@/lib/chat";
import { multiToolTurn } from "@/test/fixtures";
import type { StreamEvent } from "@/types/agent";

const fold = (events: StreamEvent[], start: AssistantMessage = newAssistantMessage()) =>
  events.reduce(applyStreamEvent, start);

describe("applyStreamEvent", () => {
  it("discards preamble text at tool_start and ends with the authoritative answer", () => {
    const events = multiToolTurn("Final answer.");
    const preambleIndex = events.findIndex((e) => e.event === "tool_start");
    const beforeTools = fold(events.slice(0, preambleIndex));
    expect(beforeTools.content).toBe("Let me look that up.");

    const atToolStart = fold(events.slice(0, preambleIndex + 1));
    expect(atToolStart.content).toBe("");
    expect(atToolStart.stage).toBe("tools");
    expect(atToolStart.tools).toEqual([expect.objectContaining({ id: "s1", status: "running" })]);

    const final = fold(events);
    expect(final.status).toBe("complete");
    expect(final.content).toBe("Final answer.");
    expect(final.tools.map((t) => [t.tool, t.status])).toEqual([
      ["tavily_search", "completed"],
      ["weather", "completed"],
    ]);
  });

  it("streams tokens into the draft after tools", () => {
    const events = multiToolTurn();
    const draft = fold(events.slice(0, -1));
    expect(draft.status).toBe("streaming");
    expect(draft.content).toBe("The capital of Kenya is Nairobi. It is 22°C and partly cloudy.");
  });

  it("marks running tools as interrupted on error", () => {
    const message = fold([
      { event: "tool_start", id: "w1", tool: "weather", input: { city: "Lagos" } },
      { event: "error", code: "agent_timeout", message: "Too slow." },
    ]);
    expect(message.status).toBe("error");
    expect(message.error).toEqual({ code: "agent_timeout", message: "Too slow.", retryAfterSeconds: null });
    expect(message.tools[0]).toMatchObject({ status: "failed", summary: "Interrupted" });
  });

  it("cancels cleanly", () => {
    const message = cancelMessage(fold([{ event: "tool_start", id: "s1", tool: "tavily_search", input: {} }]));
    expect(message.status).toBe("cancelled");
    expect(message.tools[0]?.status).toBe("failed");
  });
});

describe("activity steps", () => {
  it("shows live steps for a multi-tool turn", () => {
    const events = multiToolTurn();
    const searching = fold(events.slice(0, 5));
    expect(buildActivitySteps(searching)).toEqual([
      { key: "analyze", label: "Analyzing your request", status: "done" },
      { key: "s1", label: "Searching the web", detail: "capital of Kenya", status: "running" },
    ]);

    const done = fold(events);
    expect(buildActivitySteps(done).map((s) => s.label)).toEqual([
      "Analyzing your request",
      "Searched the web",
      "Retrieved weather information",
      "Preparing your answer",
      "Completed",
    ]);
    expect(summarizeActivity(done)).toBe("Searched the web and checked the weather");
  });

  it("explains failed tools with the tool error", () => {
    const message = fold([
      { event: "tool_start", id: "w1", tool: "weather", input: { city: "Atlantis" } },
      {
        event: "tool_end",
        id: "w1",
        tool: "weather",
        status: "failed",
        input: { city: "Atlantis" },
        summary: "Could not retrieve weather for Atlantis",
        data: null,
        error: { code: "city_not_found", message: "No weather data was found for 'Atlantis'." },
      },
    ]);
    expect(buildActivitySteps(message)[1]).toEqual({
      key: "w1",
      label: "Weather information unavailable",
      detail: "No weather data was found for 'Atlantis'.",
      status: "failed",
    });
  });

  it("summarizes a direct answer", () => {
    expect(summarizeActivity(newAssistantMessage())).toBe("Answered directly");
  });
});

describe("titleFromMessage", () => {
  it("collapses whitespace and truncates", () => {
    expect(titleFromMessage("  What is\n the weather?  ")).toBe("What is the weather?");
    expect(titleFromMessage("x".repeat(80))).toHaveLength(60);
  });
});
