/** Helpers for testing server route handlers and the proxy (node environment). */

import { vi } from "vitest";

import { createSessionToken } from "@/server/access";
import { getGateConfig } from "@/server/config";

export const BACKEND_URL = "http://backend.internal:8000";
export const BACKEND_KEY = "k".repeat(48);
export const SESSION_SECRET = "s".repeat(40);
export const REVIEWER_CODE = "reviewer-code-1234567890";
export const ORIGIN = "http://app.test";

/** Production-like environment with the gate on and the proxy configured. */
export function stubServerEnv(overrides: Record<string, string> = {}): void {
  const values: Record<string, string> = {
    NODE_ENV: "production",
    BACKEND_API_URL: BACKEND_URL,
    BACKEND_API_ACCESS_KEY: BACKEND_KEY,
    ACCESS_CODES: `reviewer:${REVIEWER_CODE},owner:owner-code-abcdefghijklmnop`,
    ACCESS_SESSION_SECRET: SESSION_SECRET,
    ACCESS_SESSION_TTL_HOURS: "",
    ALLOW_PUBLIC_ACCESS: "",
    VERCEL: "",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

/** A valid session cookie for the current environment's gate configuration. */
export function sessionCookieHeader(label = "reviewer"): string {
  const config = getGateConfig();
  if (config.mode !== "enabled") throw new Error("gate not enabled");
  return `sw_access=${createSessionToken(config, label)}`;
}

export function apiRequest(
  path: string,
  init: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    body: init.body,
    signal: init.signal,
    headers: { host: "app.test", ...init.headers },
    // Required by undici for streamed request bodies.
    ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** An authorised same-origin JSON POST. */
export function agentRequest(path: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return apiRequest(path, {
    body: JSON.stringify(body),
    signal,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...("cookie" in headers ? {} : { cookie: sessionCookieHeader() }),
      ...headers,
    },
  });
}

export function mockFetch(implementation: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => implementation(String(input), init ?? {}));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}
