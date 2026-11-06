/**
 * Centralised API client. All network access goes through here, to the same-origin
 * `/api/*` route handlers that proxy to the FastAPI backend on the server.
 */

import { API_PATHS } from "@/lib/config";
import { readSSE, type SSEMessage } from "@/lib/sse";
import {
  STREAM_EVENT_NAMES,
  type AgentQueryRequest,
  type AgentQueryResponse,
  type DoneEvent,
  type ErrorResponse,
  type HealthResponse,
  type StreamEvent,
  type StreamEventName,
} from "@/types/agent";

/** Client-side error codes, in addition to the backend's `error.code` values. */
export type ClientErrorCode = "network_error" | "aborted" | "invalid_response" | "stream_interrupted" | "http_error";

export class ApiError extends Error {
  readonly code: string;
  /** HTTP status, or null for network failures and in-stream `error` events. */
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(options: { code: string; message: string; status?: number | null; retryAfterSeconds?: number | null }) {
    super(options.message);
    this.name = "ApiError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export const isAbortError = (error: unknown): boolean =>
  (error instanceof ApiError && error.code === "aborted") ||
  (error instanceof DOMException && error.name === "AbortError");

const abortedError = () => new ApiError({ code: "aborted", message: "The request was cancelled." });

const networkError = () =>
  new ApiError({
    code: "network_error",
    message: "Can't reach the assistant. Check your internet connection and try again.",
  });

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
  try {
    const body = (await response.json()) as Partial<ErrorResponse>;
    if (body?.error?.code && body.error.message) {
      return new ApiError({ ...body.error, status: response.status, retryAfterSeconds });
    }
  } catch {
    // Not the standard envelope (e.g. a proxy error page).
  }
  return new ApiError({
    code: "http_error",
    message: `The assistant service responded with HTTP ${response.status}.`,
    status: response.status,
    retryAfterSeconds,
  });
}

async function send(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) throw abortedError();
    throw networkError();
  }
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, { ...init, headers: { Accept: "application/json", ...init.headers } });
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError({ code: "invalid_response", message: "The assistant service returned an invalid response." });
  }
}

const jsonPost = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>(API_PATHS.health, { signal });
}

export function queryAgent(body: AgentQueryRequest, signal?: AbortSignal): Promise<AgentQueryResponse> {
  return requestJson<AgentQueryResponse>(API_PATHS.query, jsonPost(body, signal));
}

/** Convert a raw SSE message into a typed event; unknown or malformed events are ignored. */
export function parseStreamEvent(message: SSEMessage): StreamEvent | null {
  if (!STREAM_EVENT_NAMES.has(message.event as StreamEventName)) return null;
  try {
    const data: unknown = JSON.parse(message.data);
    if (typeof data !== "object" || data === null) return null;
    return { ...(data as object), event: message.event } as StreamEvent;
  } catch {
    return null;
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

/**
 * Run an agent turn over SSE, forwarding every event to `onEvent`.
 *
 * Resolves with the terminal `done` event. Rejects with `ApiError` for HTTP errors (before
 * the stream opens), an in-stream `error` event (its backend code is preserved), network
 * failures, a stream that ends without a terminal event (`stream_interrupted`) and
 * cancellation (`aborted`).
 */
export async function streamAgent(body: AgentQueryRequest, { signal, onEvent }: StreamOptions): Promise<DoneEvent> {
  const init = jsonPost(body, signal);
  const response = await send(API_PATHS.stream, {
    ...init,
    headers: { ...init.headers, Accept: "text/event-stream" },
  });

  if (!response.body || !(response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    throw new ApiError({ code: "invalid_response", message: "The assistant service did not return a stream." });
  }

  try {
    for await (const message of readSSE(response.body)) {
      const event = parseStreamEvent(message);
      if (!event) continue;
      onEvent(event);
      if (event.event === "done") return event;
      if (event.event === "error") throw new ApiError({ code: event.code, message: event.message });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted || isAbortError(error)) throw abortedError();
    throw new ApiError({ code: "stream_interrupted", message: "The connection was lost before the answer finished." });
  }

  if (signal?.aborted) throw abortedError();
  throw new ApiError({ code: "stream_interrupted", message: "The connection was lost before the answer finished." });
}
