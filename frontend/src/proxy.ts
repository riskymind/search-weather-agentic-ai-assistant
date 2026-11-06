/**
 * Access gate for every page and API route (Next.js 16 "proxy", formerly middleware).
 *
 * Signed-in visitors pass through; others are redirected to /access (pages) or receive a
 * 401 envelope (API). API route handlers re-check access themselves, so a matcher mistake
 * here cannot expose a route.
 */

import { NextResponse, type NextRequest } from "next/server";

import { accessState } from "@/server/access";
import { errorResponse } from "@/server/http";

const PUBLIC_PATHS = ["/access", "/api/access"];

export function proxy(request: NextRequest): Response {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const state = accessState(request);
  if (state.status === "open" || state.status === "granted") return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return state.status === "misconfigured"
      ? errorResponse(503, "access_not_configured", "Access to this demo is not configured yet.")
      : errorResponse(401, "access_required", "Enter an access code to use this demo.");
  }
  const target = new URL("/access", request.url);
  if (pathname !== "/") target.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(target, 307);
}

export const config = {
  // Everything except build assets and the icon. /access is allowed inside the function.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
