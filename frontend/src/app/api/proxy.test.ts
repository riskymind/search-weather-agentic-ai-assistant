// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { POST as query } from "@/app/api/agent/query/route";
import { POST as stream } from "@/app/api/agent/stream/route";
import { readSSE } from "@/lib/sse";
import { INTERRUPTED_FRAME } from "@/server/sseProxy";
import { frame, jsonResponse, multiToolTurn, sseResponse, streamOf } from "@/test/fixtures";
import {
  agentRequest,
  apiRequest,
  BACKEND_KEY,
  BACKEND_URL,
  mockFetch,
  ORIGIN,
  readAll,
  sessionCookieHeader,
  stubServerEnv,
} from "@/test/server";

const ANSWER = { session_id: "s1", is_new_session: true, answer: "Hi", tool_events: [] };

beforeEach(() => stubServerEnv());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectSanitized(text: string) {
  expect(text).not.toContain(BACKEND_KEY);
  expect(text).not.toContain(BACKEND_URL);
  expect(text).not.toContain("backend.internal");
}

describe("POST /api/agent/query", () => {
  it("forwards a validated body with the server-side bearer token", async () => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(
      agentRequest("/api/agent/query", { message: "Hi", session_id: null, injected: "dropped" }, { authorization: "Bearer from-browser" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ANSWER);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BACKEND_URL}/api/v1/agent/query`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${BACKEND_KEY}`);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-client-ip")).toBeNull(); // not on Vercel: no trustworthy client IP
    expect(JSON.parse(String(init?.body))).toEqual({ message: "Hi", session_id: null });
  });

  it("forwards the platform-provided client IP on Vercel", async () => {
    stubServerEnv({ VERCEL: "1" });
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    await query(agentRequest("/api/agent/query", { message: "Hi" }, { "x-forwarded-for": "203.0.113.7" }));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-client-ip")).toBe("203.0.113.7");
  });

  it.each([
    ["not JSON content type", { "content-type": "text/plain" }, "Hi", 415, "unsupported_media_type"],
    ["malformed JSON", {}, "{not json", 400, "invalid_json"],
  ])("rejects %s without calling the backend", async (_name, headers, body, status, code) => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const request = apiRequest("/api/agent/query", {
      body,
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: sessionCookieHeader(), ...headers },
    });
    const response = await query(request);
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ message: "" }],
    [{ message: "   " }],
    [{ message: 42 }],
    [{ message: "x".repeat(4001) }],
    [{ message: "Hi", session_id: 7 }],
    [{ message: "Hi", session_id: "x".repeat(65) }],
    [["Hi"]],
    [null],
  ])("rejects an invalid payload %j with 422", async (body) => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(agentRequest("/api/agent/query", body));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts message length in code points, like the backend", async () => {
    mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(agentRequest("/api/agent/query", { message: "🌤".repeat(4000) }));
    expect(response.status).toBe(200);
  });

  it("enforces the body size limit by Content-Length and while streaming", async () => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const big = JSON.stringify({ message: "x".repeat(20_000) });
    const declared = await query(agentRequest("/api/agent/query", JSON.parse(big)));
    expect(declared.status).toBe(413);

    const chunked = apiRequest("/api/agent/query", {
      body: streamOf([big.slice(0, 9000), big.slice(9000)]),
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: sessionCookieHeader() },
    });
    const streamed = await query(chunked);
    expect(streamed.status).toBe(413);
    expect((await streamed.json()).error.code).toBe("request_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, "session_busy", "This conversation is already processing a message."],
    [422, "validation_error", "The request payload is invalid."],
    [429, "rate_limited", "Too many requests. Please wait a moment and try again."],
    [500, "agent_execution_error", "The assistant could not complete your request. Please try again."],
    [504, "agent_timeout", "The assistant took too long to respond. Please try again."],
  ])("preserves backend status %i and its error code", async (status, code, message) => {
    mockFetch(async () => jsonResponse({ error: { code, message } }, status, { "Retry-After": "17" }));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message } });
    expect(response.headers.get("retry-after")).toBe("17");
  });

  it("hides backend authentication failures behind a generic 502", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => jsonResponse({ error: { code: "unauthorized", message: "A valid API access key is required." } }, 401));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("backend_unavailable");
    expect(text).not.toContain("API access key");
    expect(errors.mock.calls.join(" ")).not.toContain(BACKEND_KEY);
  });

  it("sanitizes non-envelope upstream errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => new Response("<html>Traceback (most recent call last) at backend.internal</html>", { status: 502 }));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("Traceback");
    expectSanitized(text);
  });

  it("maps network failures and timeouts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${BACKEND_URL}`);
    });
    const unreachable = await query(agentRequest("/api/agent/query", { message: "Hi" }));
    expect(unreachable.status).toBe(502);
    const text = await unreachable.text();
    expect(JSON.parse(text).error.code).toBe("backend_unreachable");
    expectSanitized(text);
  });

  it("aborts the backend request when the browser disconnects", async () => {
    const browser = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          upstreamSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const pending = query(agentRequest("/api/agent/query", { message: "Hi" }, {}, browser.signal));
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    browser.abort();
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
  });

  it("requires an access session", async () => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }, { cookie: "sw_access=v1.reviewer.9999999999.forged" }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("access_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the gate is not configured in production", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServerEnv({ ACCESS_CODES: "" });
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }, { cookie: "" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("access_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    const fetchMock = mockFetch(async () => jsonResponse(ANSWER));
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden_origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing backend URL in production without details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServerEnv({ BACKEND_API_URL: "" });
    const response = await query(agentRequest("/api/agent/query", { message: "Hi" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("backend_not_configured");
  });
});

describe("POST /api/agent/stream", () => {
  const events = multiToolTurn();
  const wire = events.map(frame).join("");

  async function events_of(response: Response) {
    const received = [];
    for await (const message of readSSE(response.body as ReadableStream<Uint8Array>)) received.push(message);
    return received;
  }

  it("streams the backend's events byte-for-byte with SSE headers", async () => {
    const fetchMock = mockFetch(async () => sseResponse([wire]));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await readAll(response.body as ReadableStream<Uint8Array>)).toBe(wire);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("authorization")).toBe(`Bearer ${BACKEND_KEY}`);
  });

  it("preserves event boundaries when frames are split across arbitrary chunks", async () => {
    const encoded = new TextEncoder().encode(wire);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < encoded.length; i += 5) chunks.push(encoded.slice(i, i + 5)); // splits UTF-8 too
    mockFetch(async () => sseResponse(chunks));
    const received = await events_of(await stream(agentRequest("/api/agent/stream", { message: "Q" })));
    expect(received.map((m) => m.event)).toEqual(events.map((e) => e.event));
    expect(received.map((m) => JSON.parse(m.data))).toEqual(events);
  });

  it("forwards each chunk as soon as it arrives (no buffering)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(events[0]!)));
        await gate;
        controller.enqueue(new TextEncoder().encode(events.slice(1).map(frame).join("")));
        controller.close();
      },
    });
    mockFetch(async () => new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(frame(events[0]!)); // before the rest exists
    release();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe(events.slice(1).map(frame).join(""));
  });

  it("delivers the backend's terminal error event unchanged", async () => {
    const error = frame({ event: "error", code: "agent_timeout", message: "The assistant took too long to respond." });
    mockFetch(async () => sseResponse([frame(events[0]!), error]));
    const text = await readAll((await stream(agentRequest("/api/agent/stream", { message: "Q" }))).body!);
    expect(text).toBe(frame(events[0]!) + error);
  });

  it("appends a sanitized error event when the upstream ends without a terminal event", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => sseResponse([frame(events[0]!), "event: token\ndata: {\"event\":\"tok"]));
    const received = await events_of(await stream(agentRequest("/api/agent/stream", { message: "Q" })));
    const last = received.at(-1)!;
    expect(last.event).toBe("error");
    expect(JSON.parse(last.data)).toMatchObject({ code: "stream_interrupted" });
  });

  it("appends a sanitized error event when the upstream connection fails mid-stream", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let sent = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error(`socket hang up ${BACKEND_URL}`));
        sent = true;
        controller.enqueue(new TextEncoder().encode(frame(events[0]!)));
      },
    });
    mockFetch(async () => new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }));
    const text = await readAll((await stream(agentRequest("/api/agent/stream", { message: "Q" }))).body!);
    expect(text).toBe(frame(events[0]!) + INTERRUPTED_FRAME);
    expectSanitized(text);
  });

  it("cancels the upstream stream when the browser disconnects", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(events[0]!)));
      },
      cancel() {
        cancelled = true;
      },
    });
    mockFetch(async () => new Response(upstream, { headers: { "Content-Type": "text/event-stream" } }));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("returns errors before the stream opens as JSON with the backend status", async () => {
    mockFetch(async () => jsonResponse({ error: { code: "rate_limited", message: "Too many requests." } }, 429, { "Retry-After": "5" }));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect((await response.json()).error.code).toBe("rate_limited");
  });

  it("rejects a non-SSE success response from the backend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => jsonResponse({ unexpected: true }));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }));
    expect(response.status).toBe(502);
  });

  it("requires an access session", async () => {
    const fetchMock = mockFetch(async () => sseResponse([wire]));
    const response = await stream(agentRequest("/api/agent/stream", { message: "Q" }, { cookie: "" }));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("returns only the documented health fields", async () => {
    mockFetch(async () =>
      jsonResponse({ status: "healthy", service: "search-weather-agent", version: "1.0.0", environment: "production", extra: "x" }),
    );
    const response = await health(apiRequest("/api/health", { method: "GET", headers: { cookie: sessionCookieHeader() } }));
    expect(await response.json()).toEqual({
      status: "healthy",
      service: "search-weather-agent",
      version: "1.0.0",
      environment: "production",
    });
  });

  it("is protected by the access gate", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ status: "healthy" }));
    expect((await health(apiRequest("/api/health", { method: "GET" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a sleeping or unavailable backend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockFetch(async () => new Response("Service Unavailable", { status: 503 }));
    const response = await health(apiRequest("/api/health", { method: "GET", headers: { cookie: sessionCookieHeader() } }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("backend_unavailable");
  });
});
