/**
 * Server-side proxy to the FastAPI backend (server-only).
 *
 * The browser only talks to this app's same-origin `/api/*` routes. These helpers validate
 * the request, inject the backend bearer token on the server, forward the call and turn
 * every upstream failure into a sanitized error envelope. Backend URLs, credentials, stack
 * traces and raw upstream bodies never reach the browser.
 */

import { requireAccess } from "@/server/access";
import { ConfigError, getBackendConfig } from "@/server/config";
import { clientIp, crossOriginResponse, errorResponse, isCrossOrigin } from "@/server/http";
import { MAX_MESSAGE_CHARS, type AgentQueryRequest } from "@/types/agent";

/** Same as the backend's MAX_REQUEST_BODY_BYTES default. */
export const MAX_BODY_BYTES = 16 * 1024;
/** Slightly under the route's `maxDuration` (backend agent timeout is 60 s, plus cold starts). */
export const UPSTREAM_TIMEOUT_MS = 110_000;
const MAX_SESSION_ID_CHARS = 64;

/** Backend statuses that are meaningful to the browser and are passed through unchanged. */
const PASSTHROUGH_STATUSES = new Set([409, 413, 422, 429, 500, 502, 503, 504]);

type Result<T> = { ok: true; value: T } | { ok: false; response: Response };

const fail = (response: Response): { ok: false; response: Response } => ({ ok: false, response });

/** Origin check plus access gate, for every proxied route. */
export function guardRequest(request: Request, { mutating }: { mutating: boolean }): Response | null {
  if (mutating && isCrossOrigin(request)) return crossOriginResponse();
  return requireAccess(request);
}

const tooLarge = () => errorResponse(413, "request_too_large", "The request body is too large.");

/** Read a JSON body of at most `maxBytes`, without buffering more than that. */
export async function readJsonBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Result<unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return fail(errorResponse(415, "unsupported_media_type", "Send the request as application/json."));
  }
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return fail(tooLarge());

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return fail(tooLarge());
      }
      chunks.push(value);
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return fail(errorResponse(400, "invalid_json", "The request body is not valid JSON."));
  }
}

const invalid = (message: string) => fail(errorResponse(422, "validation_error", message));

/** Mirror of the backend's `AgentQueryRequest` validation. Only known fields are forwarded. */
export function validateAgentRequest(value: unknown): Result<AgentQueryRequest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("The request body must be a JSON object.");
  }
  const { message, session_id: sessionId } = value as Record<string, unknown>;
  if (typeof message !== "string" || message.trim() === "") return invalid("message must be a non-empty string.");
  // Count code points, as Python's len() does on the backend.
  if ([...message].length > MAX_MESSAGE_CHARS) {
    return invalid(`message must be at most ${MAX_MESSAGE_CHARS} characters.`);
  }
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== "string" || sessionId.length > MAX_SESSION_ID_CHARS) {
      return invalid(`session_id must be null or a string of at most ${MAX_SESSION_ID_CHARS} characters.`);
    }
  }
  return { ok: true, value: { message, session_id: typeof sessionId === "string" ? sessionId : null } };
}

export async function readAgentRequest(request: Request): Promise<Result<AgentQueryRequest>> {
  const body = await readJsonBody(request);
  return body.ok ? validateAgentRequest(body.value) : body;
}

function log(event: string, details: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...details }));
}

const unavailable = () =>
  errorResponse(502, "backend_unavailable", "The assistant service is not available right now. Please try again later.");

interface BackendCall {
  method: "GET" | "POST";
  body?: AgentQueryRequest;
  accept: string;
}

/**
 * Call the backend with the server-side credentials. The upstream request is aborted when
 * the browser disconnects (`request.signal`) or after UPSTREAM_TIMEOUT_MS.
 */
export async function callBackend(request: Request, path: string, call: BackendCall): Promise<Result<Response>> {
  let config;
  try {
    config = getBackendConfig();
  } catch (error) {
    log("proxy_misconfigured", { reason: error instanceof ConfigError ? error.message : "invalid configuration" });
    return fail(errorResponse(503, "backend_not_configured", "The assistant service is not configured."));
  }

  const headers = new Headers({ Accept: call.accept });
  if (call.body) headers.set("Content-Type", "application/json");
  if (config.accessKey) headers.set("Authorization", `Bearer ${config.accessKey}`);
  const ip = clientIp(request);
  if (ip) headers.set("X-Client-IP", ip);

  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: call.method,
      headers,
      body: call.body ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.any([request.signal, timeout]),
      cache: "no-store",
      redirect: "manual",
    });
    return { ok: true, value: response };
  } catch (error) {
    if (request.signal.aborted) {
      return fail(errorResponse(499, "client_closed_request", "The request was cancelled."));
    }
    if (timeout.aborted) {
      log("backend_timeout", { path });
      return fail(errorResponse(504, "upstream_timeout", "The assistant service took too long to respond."));
    }
    log("backend_unreachable", { path, error: error instanceof Error ? error.name : "unknown" });
    return fail(
      errorResponse(
        502,
        "backend_unreachable",
        "The assistant service can't be reached right now. It may be starting up; try again in a minute.",
      ),
    );
  }
}

function isEnvelope(body: unknown): body is { error: { code: string; message: string } } {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return typeof error?.code === "string" && typeof error.message === "string";
}

/**
 * Translate a non-2xx backend response. Meaningful statuses (409, 413, 422, 429 and the
 * backend's own 5xx) keep their status, error code and fixed message, plus `Retry-After`.
 * Authentication failures (the proxy's key is wrong), unknown routes and anything without
 * the standard envelope become a generic 502, logged on the server.
 */
export async function upstreamError(upstream: Response, path: string): Promise<Response> {
  let body: unknown = null;
  try {
    body = await upstream.json();
  } catch {
    // Not JSON: an HTML error page from a platform proxy, for example.
  }
  if (!PASSTHROUGH_STATUSES.has(upstream.status) || !isEnvelope(body)) {
    log("backend_error_response", { path, status: upstream.status });
    if (upstream.status === 401 || upstream.status === 403) {
      log("backend_rejected_proxy_credentials", { hint: "BACKEND_API_ACCESS_KEY must equal the backend's API_ACCESS_KEY" });
    }
    if (upstream.status === 503 || upstream.status === 504) {
      return errorResponse(
        upstream.status,
        "backend_unavailable",
        "The assistant service is starting up or temporarily unavailable. Please try again in a minute.",
      );
    }
    return unavailable();
  }
  const headers: Record<string, string> = {};
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter && /^\d{1,6}$/.test(retryAfter)) headers["Retry-After"] = retryAfter;
  return errorResponse(upstream.status, body.error.code, body.error.message, headers);
}

export const invalidUpstream = (path: string) => {
  log("backend_invalid_response", { path });
  return unavailable();
};
