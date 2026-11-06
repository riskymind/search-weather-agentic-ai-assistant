/** Small HTTP helpers shared by the route handlers and the proxy (server-only). */

import { isIP } from "node:net";

const NO_STORE = { "Cache-Control": "no-store" };

/** The standard error envelope, identical in shape to the FastAPI backend's. */
export function errorResponse(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  merged.set("Cache-Control", "no-store");
  return Response.json({ error: { code, message } }, { status, headers: merged });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * The end user's IP, when a trusted platform provides it. On Vercel, `x-forwarded-for`
 * (and its alias `x-vercel-forwarded-for`) is overwritten by the platform, so it cannot be
 * spoofed. Elsewhere there is no trustworthy source in a route handler, so null.
 */
export function clientIp(request: Request): string | null {
  if (process.env.VERCEL !== "1") return null;
  const raw = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "";
  const first = raw.split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : null;
}

/**
 * True for requests a browser marks as coming from another site. Cookies are SameSite=Lax,
 * so cross-site POSTs carry no session anyway; this check is defence in depth against CSRF.
 * Requests without an Origin header (curl, server-to-server) are not browser CSRF.
 */
export function isCrossOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true; // includes the opaque origin "null"
  }
}

export const crossOriginResponse = () =>
  errorResponse(403, "forbidden_origin", "Cross-site requests are not allowed.");
