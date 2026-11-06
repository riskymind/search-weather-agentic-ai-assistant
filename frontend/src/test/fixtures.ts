import type { AgentQueryResponse, SearchResults, StreamEvent, ToolEvent, WeatherData } from "@/types/agent";

const encoder = new TextEncoder();

/** Encode a typed event exactly as the backend does: `event:` line + one-line JSON `data:`. */
export function frame(event: StreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A ReadableStream that yields the given chunks (strings or raw bytes), optionally with delays. */
export function streamOf(chunks: Array<string | Uint8Array>, delayMs = 0): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  });
}

export function sseResponse(chunks: Array<string | Uint8Array>, delayMs = 0): Response {
  return new Response(streamOf(chunks, delayMs), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export const WEATHER: WeatherData = {
  kind: "weather",
  city: "Nairobi",
  country: "Kenya",
  region: "Nairobi Area",
  temperature_c: 22,
  feels_like_c: 23,
  description: "Partly cloudy",
  humidity: 64,
  wind_speed_kmh: 13,
  observation_time: "01:45 PM",
  local_time: "2026-11-03 16:45",
  icon_url: null,
};

export const SEARCH: SearchResults = {
  kind: "search",
  query: "capital of Kenya",
  results: [
    {
      title: "Nairobi - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Nairobi",
      content: "Nairobi is the capital and largest city of Kenya.",
      score: 0.92,
    },
  ],
};

export const SEARCH_EVENT: ToolEvent = {
  id: "s1",
  tool: "tavily_search",
  status: "completed",
  input: { query: "capital of Kenya" },
  summary: 'Found 1 result for "capital of Kenya"',
  data: SEARCH,
  error: null,
};

export const WEATHER_EVENT: ToolEvent = {
  id: "w1",
  tool: "weather",
  status: "completed",
  input: { city: "Nairobi" },
  summary: "Retrieved current weather for Nairobi, Kenya",
  data: WEATHER,
  error: null,
};

export const SESSION_ID = "4f1c2b9e-0d7a-4a63-9b51-2f0a7c1d9e88";

/** The full event sequence of a multi-tool turn, including preamble text before the first tool. */
export function multiToolTurn(answer = "The capital of Kenya is Nairobi. It is 22°C and partly cloudy."): StreamEvent[] {
  const done: AgentQueryResponse = {
    session_id: SESSION_ID,
    is_new_session: true,
    answer,
    tool_events: [SEARCH_EVENT, WEATHER_EVENT],
  };
  return [
    { event: "session", session_id: SESSION_ID, is_new_session: true },
    { event: "status", stage: "analyzing" },
    { event: "status", stage: "preparing_answer" },
    { event: "token", delta: "Let me look that up." },
    { event: "tool_start", id: "s1", tool: "tavily_search", input: { query: "capital of Kenya" } },
    { ...SEARCH_EVENT, event: "tool_end" },
    { event: "tool_start", id: "w1", tool: "weather", input: { city: "Nairobi" } },
    { ...WEATHER_EVENT, event: "tool_end" },
    { event: "status", stage: "preparing_answer" },
    { event: "token", delta: "The capital of Kenya is Nairobi. " },
    { event: "token", delta: "It is 22°C and partly cloudy." },
    { event: "done", ...done },
  ];
}
