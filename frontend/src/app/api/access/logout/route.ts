/** POST /api/access/logout: clear the session cookie and return to the access page. */

import { clearedSessionCookie } from "@/server/access";
import { crossOriginResponse, isCrossOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Response {
  if (isCrossOrigin(request)) return crossOriginResponse();
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/access?signed_out=1", // relative: see app/api/access/route.ts
      "Set-Cookie": clearedSessionCookie(request),
      "Cache-Control": "no-store",
    },
  });
}
