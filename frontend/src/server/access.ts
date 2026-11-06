/**
 * Application-level access gate (server-only).
 *
 * Visitors exchange an access code for a signed, HttpOnly session cookie. The cookie holds
 * `v1.<label>.<expiry>.<signature>`, where the HMAC-SHA256 signature (keyed by
 * ACCESS_SESSION_SECRET) also covers a hash of the code it was issued for. A session is
 * therefore valid only while its label still exists *with the same code*: removing or
 * changing a code revokes its sessions, and rotating the secret revokes all of them.
 * The cookie never contains the code or the secret.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getGateConfig, type AccessCode, type GateConfig } from "@/server/config";
import { errorResponse } from "@/server/http";

export const ACCESS_COOKIE = "sw_access";
const TOKEN_VERSION = "v1";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

function signature(secret: string, label: string, expires: number, code: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${TOKEN_VERSION}.${label}.${expires}.`)
    .update(sha256(code))
    .digest();
}

/** Return the label of the matching code, comparing against every code in constant time. */
export function matchAccessCode(input: string, codes: AccessCode[]): string | null {
  const candidate = sha256(input);
  let match: string | null = null;
  for (const { label, code } of codes) {
    if (timingSafeEqual(candidate, sha256(code)) && match === null) match = label;
  }
  return match;
}

export function createSessionToken(
  config: Extract<GateConfig, { mode: "enabled" }>,
  label: string,
  now = Date.now(),
): string {
  const code = config.codes.find((c) => c.label === label);
  if (!code) throw new Error("unknown access label");
  const expires = Math.floor(now / 1000) + config.ttlSeconds;
  return `${TOKEN_VERSION}.${label}.${expires}.${signature(config.secret, label, expires, code.code).toString("base64url")}`;
}

/** The label of a valid, unexpired, unrevoked session token, otherwise null. */
export function verifySessionToken(
  config: Extract<GateConfig, { mode: "enabled" }>,
  token: string | undefined,
  now = Date.now(),
): string | null {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  const [, label, expiresRaw, sig] = parts as [string, string, string, string];
  const expires = Number(expiresRaw);
  if (!/^\d{1,12}$/.test(expiresRaw) || expires <= Math.floor(now / 1000)) return null;
  const code = config.codes.find((c) => c.label === label);
  if (!code) return null;
  const expected = signature(config.secret, label, expires, code.code);
  const actual = Buffer.from(sig, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? label : null;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

const isHttps = (request: Request) =>
  new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";

export function sessionCookie(request: Request, token: string, maxAgeSeconds: number): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${ACCESS_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

export const clearedSessionCookie = (request: Request) => sessionCookie(request, "", 0);

let loggedProblems = "";

function logMisconfiguration(problems: string[]): void {
  const text = problems.join("; ");
  if (text === loggedProblems) return;
  loggedProblems = text;
  console.error(`[access-gate] Access gate is misconfigured, refusing all requests: ${text}`);
}

export type AccessState =
  | { status: "open" }
  | { status: "granted"; label: string }
  | { status: "denied" }
  | { status: "misconfigured" };

export function accessState(request: Request, config: GateConfig = getGateConfig()): AccessState {
  if (config.mode === "disabled") return { status: "open" };
  if (config.mode === "misconfigured") {
    logMisconfiguration(config.problems);
    return { status: "misconfigured" };
  }
  const label = verifySessionToken(config, readCookie(request, ACCESS_COOKIE));
  return label ? { status: "granted", label } : { status: "denied" };
}

/**
 * Route-handler guard: null when the request may proceed, otherwise the error response.
 * Used in every API route as well as in `proxy.ts`, so a matcher change cannot open a route.
 */
export function requireAccess(request: Request): Response | null {
  const state = accessState(request);
  if (state.status === "open" || state.status === "granted") return null;
  if (state.status === "misconfigured") {
    return errorResponse(503, "access_not_configured", "Access to this demo is not configured yet.");
  }
  return errorResponse(401, "access_required", "Enter an access code to use this demo.");
}

/** Only same-site relative paths, so `next` cannot redirect to another origin. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/access") || value.startsWith("/api/")) return "/";
  return value;
}
