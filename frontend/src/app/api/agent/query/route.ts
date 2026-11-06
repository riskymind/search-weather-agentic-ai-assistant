/** POST /api/agent/query → FastAPI POST /api/v1/agent/query (complete JSON answer). */

import { callBackend, guardRequest, invalidUpstream, readAgentRequest, upstreamError } from "@/server/backend";
import { jsonResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PATH = "/api/v1/agent/query";

export async function POST(request: Request): Promise<Response> {
  const denied = guardRequest(request, { mutating: true });
  if (denied) return denied;

  const body = await readAgentRequest(request);
  if (!body.ok) return body.response;

  const upstream = await callBackend(request, PATH, { method: "POST", body: body.value, accept: "application/json" });
  if (!upstream.ok) return upstream.response;
  if (!upstream.value.ok) return upstreamError(upstream.value, PATH);

  try {
    return jsonResponse(await upstream.value.json());
  } catch {
    return invalidUpstream(PATH);
  }
}
