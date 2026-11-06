import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatApp from "@/components/ChatApp";
import { frame, jsonResponse, multiToolTurn, SESSION_ID, sseResponse } from "@/test/fixtures";
import type { StreamEvent } from "@/types/agent";

type StreamHandler = (body: { message: string; session_id: string | null }, init: RequestInit) => Response | Promise<Response>;

let streamHandler: StreamHandler;
const streamBodies: Array<{ message: string; session_id: string | null }> = [];

beforeEach(() => {
  streamBodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return jsonResponse({ status: "healthy", service: "search-weather-agent", version: "1.0.0", environment: "test" });
      }
      if (url.endsWith("/api/agent/stream")) {
        const body = JSON.parse(String(init.body));
        streamBodies.push(body);
        return streamHandler(body, init);
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const reply = (events: StreamEvent[], delayMs = 0) => () => sseResponse(events.map(frame), delayMs);

// Whole-app flows (jsdom render + streamed turns) are slower than unit tests on a busy machine.
describe("ChatApp", { timeout: 15_000 }, () => {
  it("runs a full multi-tool conversation from a suggested prompt", async () => {
    // Hold the stream right after the first tool_start, so the transient "Searching the web"
    // state is observable regardless of timing; then release the rest of the turn.
    const events = multiToolTurn();
    const firstToolEnd = events.findIndex((e) => e.event === "tool_end");
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    streamHandler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encode = (list: StreamEvent[]) => new TextEncoder().encode(list.map(frame).join(""));
            controller.enqueue(encode(events.slice(0, firstToolEnd)));
            await released;
            controller.enqueue(encode(events.slice(firstToolEnd)));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const user = userEvent.setup();
    render(<ChatApp />);

    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeInTheDocument();
    expect(screen.getByText("Your conversations will appear here.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Find the capital of Kenya and its current weather." }));

    // The question is shown immediately and the assistant reports progress.
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).getByText("Find the capital of Kenya and its current weather.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Stop generating" })).toBeInTheDocument();
    expect(await screen.findByText("Searching the web")).toBeInTheDocument();
    release();

    // Final state: authoritative answer, weather card, clickable sources, no preamble.
    expect(await screen.findByText("The capital of Kenya is Nairobi. It is 22°C and partly cloudy.")).toBeInTheDocument();
    expect(screen.queryByText("Let me look that up.")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Current weather in Nairobi" })).toHaveTextContent("22°C");
    const sources = screen.getByRole("region", { name: "Sources" });
    expect(within(sources).getByRole("link", { name: /Nairobi - Wikipedia/ })).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Nairobi",
    );
    expect(screen.getByRole("button", { name: /Searched the web and checked the weather/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();

    // The conversation is listed and the request started a new server session.
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(nav).getByRole("button", { name: /^Find the capital of Kenya/ })).toHaveAttribute("aria-current", "page");
    expect(streamBodies[0]).toEqual({ message: "Find the capital of Kenya and its current weather.", session_id: null });
  });

  it("sends the server-issued session ID with follow-up messages and persists history", async () => {
    streamHandler = reply(multiToolTurn());
    const user = userEvent.setup();
    const { unmount } = render(<ChatApp />);

    const input = screen.getByRole("textbox", { name: "Message" });
    await user.type(input, "Capital of Kenya and weather?{Enter}");
    await screen.findByText(/The capital of Kenya is Nairobi/);

    streamHandler = reply([
      { event: "session", session_id: SESSION_ID, is_new_session: false },
      { event: "token", delta: "Nairobi is at 1,795 m." },
      { event: "done", session_id: SESSION_ID, is_new_session: false, answer: "Nairobi is at 1,795 m.", tool_events: [] },
    ]);
    await user.type(input, "How high is it?{Enter}");
    await screen.findByText("Nairobi is at 1,795 m.");
    expect(streamBodies[1]).toEqual({ message: "How high is it?", session_id: SESSION_ID });

    // Reload: history comes back from localStorage.
    await act(() => new Promise((r) => setTimeout(r, 300))); // debounced save
    unmount();
    render(<ChatApp />);
    expect(await screen.findByText("Nairobi is at 1,795 m.")).toBeInTheDocument();
    expect(screen.getByText("How high is it?")).toBeInTheDocument();
  });

  it("shows an error with a working retry", async () => {
    streamHandler = () =>
      jsonResponse({ error: { code: "rate_limited", message: "Too many requests." } }, 429, { "Retry-After": "20" });
    const user = userEvent.setup();
    render(<ChatApp />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "Weather in Lagos?{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many requests");
    expect(alert).toHaveTextContent("Try again in 20 seconds");

    streamHandler = reply([
      { event: "session", session_id: SESSION_ID, is_new_session: true },
      { event: "done", session_id: SESSION_ID, is_new_session: true, answer: "It is sunny in Lagos.", tool_events: [] },
    ]);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("It is sunny in Lagos.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByRole("log")).getAllByText("Weather in Lagos?")).toHaveLength(1);
  });

  it("explains in-stream errors and unreachable backends", async () => {
    streamHandler = reply([
      { event: "session", session_id: SESSION_ID, is_new_session: true },
      { event: "status", stage: "analyzing" },
      { event: "error", code: "llm_provider_error", message: "The language model provider is unavailable." },
    ]);
    const user = userEvent.setup();
    render(<ChatApp />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("The language model is unavailable");

    streamHandler = () => Promise.reject(new TypeError("Failed to fetch"));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Hello?{Enter}");
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent("Can't reach the assistant");
  });

  it("stops a reply in progress", async () => {
    streamHandler = (_body, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(frame({ event: "session", session_id: SESSION_ID, is_new_session: true })),
            );
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const user = userEvent.setup();
    render(<ChatApp />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Long question{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop generating" }));
    expect(await screen.findByText("Stopped before the answer finished.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("tells the user when the server started a new session", async () => {
    window.localStorage.setItem(
      "sw-assistant:conversations",
      JSON.stringify({
        version: 1,
        activeId: "c1",
        conversations: [
          {
            id: "c1",
            title: "Earlier chat",
            sessionId: "expired-session",
            messages: [{ id: "u1", role: "user", content: "Earlier question", createdAt: 1 }],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    streamHandler = reply([
      { event: "session", session_id: SESSION_ID, is_new_session: true },
      { event: "done", session_id: SESSION_ID, is_new_session: true, answer: "Fresh answer.", tool_events: [] },
    ]);
    const user = userEvent.setup();
    render(<ChatApp />);
    expect(screen.getByText("Earlier question")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Follow-up{Enter}");
    expect(await screen.findByText("Fresh answer.")).toBeInTheDocument();
    expect(streamBodies[0]?.session_id).toBe("expired-session");
    expect(screen.getByText(/started a new session/)).toBeInTheDocument();
  });

  it("starts, switches and deletes conversations", async () => {
    streamHandler = reply([
      { event: "session", session_id: SESSION_ID, is_new_session: true },
      { event: "done", session_id: SESSION_ID, is_new_session: true, answer: "First answer.", tool_events: [] },
    ]);
    const user = userEvent.setup();
    render(<ChatApp />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "First chat{Enter}");
    await screen.findByText("First answer.");

    await user.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);
    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Conversations" });
    await user.click(within(nav).getByRole("button", { name: /^First chat/ }));
    expect(screen.getByText("First answer.")).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Delete conversation: First chat" }));
    expect(screen.getByText("Your conversations will appear here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What would you like to know?" })).toBeInTheDocument();
  });
});
