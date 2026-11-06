/**
 * POST /api/access: exchange an access code for a session cookie.
 *
 * A plain HTML form posts here (works without JavaScript) and is answered with a 303
 * redirect: to the requested page on success, back to /access with an error otherwise.
 */

import {
  createSessionToken,
  matchAccessCode,
  safeNextPath,
  sessionCookie,
} from "@/server/access";
import { getGateConfig } from "@/server/config";
import { clientIp, isCrossOrigin } from "@/server/http";
import { loginLimiter } from "@/server/loginLimiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 2048;

/**
 * Relative Location (RFC 9110): the browser resolves it against the URL it used. `request.url`
 * cannot be used here because behind a proxy or in Docker it reflects the server's bind address
 * (e.g. http://0.0.0.0:3000), not the public origin.
 */
function redirect(path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store", ...headers } });
}

const backToForm = (error: string, next: string, headers?: Record<string, string>) =>
  redirect(`/access?error=${error}${next === "/" ? "" : `&next=${encodeURIComponent(next)}`}`, headers);

export async function POST(request: Request): Promise<Response> {
  if (isCrossOrigin(request)) return backToForm("origin", "/");

  const config = getGateConfig();
  if (config.mode === "disabled") return redirect("/");
  if (config.mode === "misconfigured") return backToForm("unavailable", "/");

  const declared = Number(request.headers.get("content-length") ?? "");
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if ((Number.isFinite(declared) && declared > MAX_FORM_BYTES) || !type.includes("application/x-www-form-urlencoded")) {
    return backToForm("invalid", "/");
  }
  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return backToForm("invalid", "/");
  const form = new URLSearchParams(text);
  const next = safeNextPath(form.get("next"));

  const key = clientIp(request) ?? "unknown";
  const wait = loginLimiter.retryAfterSeconds(key);
  if (wait > 0) {
    console.warn(JSON.stringify({ level: "warning", event: "access_locked", retry_after: wait }));
    return backToForm("locked", next, { "Retry-After": String(wait) });
  }

  const label = matchAccessCode(form.get("code") ?? "", config.codes);
  if (!label) {
    loginLimiter.recordFailure(key);
    console.warn(JSON.stringify({ level: "warning", event: "access_denied" }));
    return backToForm("invalid", next);
  }

  loginLimiter.recordSuccess(key);
  console.info(JSON.stringify({ level: "info", event: "access_granted", label }));
  return redirect(next, {
    "Set-Cookie": sessionCookie(request, createSessionToken(config, label), config.ttlSeconds),
  });
}
