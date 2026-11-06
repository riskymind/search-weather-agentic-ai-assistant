/** GET /api/health → FastAPI GET /api/v1/health (only the documented fields are returned). */

import { callBackend, guardRequest, invalidUpstream, upstreamError } from "@/server/backend";
import { jsonResponse } from "@/server/http";
import type { HealthResponse } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/v1/health";

export async function GET(request: Request): Promise<Response> {
  const denied = guardRequest(request, { mutating: false });
  if (denied) return denied;

  const upstream = await callBackend(request, PATH, { method: "GET", accept: "application/json" });
  if (!upstream.ok) return upstream.response;
  if (!upstream.value.ok) return upstreamError(upstream.value, PATH);

  try {
    const body = (await upstream.value.json()) as Partial<HealthResponse>;
    if (body.status !== "healthy") return invalidUpstream(PATH);
    const health: HealthResponse = {
      status: "healthy",
      service: String(body.service ?? ""),
      version: String(body.version ?? ""),
      environment: String(body.environment ?? ""),
    };
    return jsonResponse(health);
  } catch {
    return invalidUpstream(PATH);
  }
}
