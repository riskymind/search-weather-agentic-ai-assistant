import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, getHealth, parseStreamEvent, queryAgent, streamAgent } from "@/lib/api";
import { frame, jsonResponse, multiToolTurn, sseResponse } from "@/test/fixtures";
import type { StreamEvent } from "@/types/agent";

const fetchMock = vi.fn<typeof fetch>();

function useFetch(response: Response | (() => Promise<Response>)) {
  fetchMock.mockImplementation(typeof response === "function" ? response : async () => response);
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected rejection");
}

describe("JSON requests", () => {
  it("calls the same-origin proxy route", async () => {
    useFetch(jsonResponse({ status: "healthy", service: "s", version: "1", environment: "test" }));
    await expect(getHealth()).resolves.toMatchObject({ status: "healthy" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/health");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("posts JSON to the query endpoint", async () => {
    useFetch(jsonResponse({ session_id: "s", is_new_session: true, answer: "hi", tool_events: [] }));
    await queryAgent({ message: "Hi", session_id: null });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/agent/query");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "Hi", session_id: null });
  });

  it("maps the backend error envelope, including Retry-After", async () => {
    useFetch(jsonResponse({ error: { code: "rate_limited", message: "Too many requests." } }, 429, { "Retry-After": "12" }));
    const error = await rejection(queryAgent({ message: "Hi" }));
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 12, message: "Too many requests." });
  });

  it("handles non-envelope HTTP errors", async () => {
    useFetch(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await rejection(getHealth())).toMatchObject({ code: "http_error", status: 502 });
  });

  it("reports network failures", async () => {
    useFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await rejection(getHealth());
    expect(error.code).toBe("network_error");
    expect(error.message).toContain("Can't reach the assistant");
  });

  it("reports aborts distinctly", async () => {
    const controller = new AbortController();
    controller.abort();
    useFetch(() => Promise.reject(new DOMException("Aborted", "AbortError")));
    expect((await rejection(getHealth(controller.signal))).code).toBe("aborted");
  });
});

describe("streamAgent", () => {
  it("dispatches every event in order and resolves with done", async () => {
    const events = multiToolTurn();
    useFetch(sseResponse([events.map(frame).join("")]));
    const received: StreamEvent[] = [];
    const done = await streamAgent({ message: "Q" }, { onEvent: (e) => received.push(e) });

    expect(received.map((e) => e.event)).toEqual(events.map((e) => e.event));
    expect(done.answer).toBe(events.at(-1)?.event === "done" ? (events.at(-1) as { answer: string }).answer : "");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/agent/stream");
    expect(new Headers(init?.headers).get("Accept")).toBe("text/event-stream");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("works when frames are split across arbitrary network chunks", async () => {
    const text = multiToolTurn().map(frame).join("");
    const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
    useFetch(sseResponse(chunks));
    const received: StreamEvent[] = [];
    await streamAgent({ message: "Q" }, { onEvent: (e) => received.push(e) });
    expect(received).toHaveLength(multiToolTurn().length);
  });

  it("rejects with the backend code from an error event", async () => {
    useFetch(
      sseResponse([
        frame({ event: "session", session_id: "s", is_new_session: true }),
        frame({ event: "error", code: "agent_timeout", message: "The assistant took too long to respond." }),
      ]),
    );
    const onEvent = vi.fn();
    const error = await rejection(streamAgent({ message: "Q" }, { onEvent }));
    expect(error).toMatchObject({ code: "agent_timeout", status: null });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects HTTP errors before the stream opens", async () => {
    useFetch(jsonResponse({ error: { code: "validation_error", message: "The request payload is invalid." } }, 422));
    expect((await rejection(streamAgent({ message: "" }, { onEvent: vi.fn() }))).code).toBe("validation_error");
  });

  it("detects a stream that ends without a terminal event", async () => {
    useFetch(sseResponse([frame({ event: "token", delta: "partial" })]));
    expect((await rejection(streamAgent({ message: "Q" }, { onEvent: vi.fn() }))).code).toBe("stream_interrupted");
  });

  it("detects a connection error mid-stream", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(frame({ event: "token", delta: "x" })));
        } else controller.error(new TypeError("network error"));
      },
    });
    useFetch(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    expect((await rejection(streamAgent({ message: "Q" }, { onEvent: vi.fn() }))).code).toBe("stream_interrupted");
  });

  it("rejects a non-SSE success response", async () => {
    useFetch(jsonResponse({ unexpected: true }));
    expect((await rejection(streamAgent({ message: "Q" }, { onEvent: vi.fn() }))).code).toBe("invalid_response");
  });

  it("cancels when aborted mid-stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame({ event: "session", session_id: "s", is_new_session: true })));
        controller.signal.addEventListener("abort", () => c.error(new DOMException("Aborted", "AbortError")));
      },
    });
    useFetch(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const promise = streamAgent({ message: "Q" }, { signal: controller.signal, onEvent: () => controller.abort() });
    expect((await rejection(promise)).code).toBe("aborted");
  });
});

describe("parseStreamEvent", () => {
  it("ignores unknown event names and malformed JSON", () => {
    expect(parseStreamEvent({ event: "future_event", data: "{}" })).toBeNull();
    expect(parseStreamEvent({ event: "token", data: "{not json" })).toBeNull();
    expect(parseStreamEvent({ event: "token", data: '"string"' })).toBeNull();
  });

  it("uses the SSE event name as the discriminator", () => {
    expect(parseStreamEvent({ event: "token", data: '{"delta":"a"}' })).toEqual({ event: "token", delta: "a" });
  });
});
