/** POST /api/agent/stream → FastAPI POST /api/v1/agent/stream (Server-Sent Events, unbuffered). */

import { callBackend, guardRequest, invalidUpstream, readAgentRequest, upstreamError } from "@/server/backend";
import { proxySseStream, SSE_RESPONSE_HEADERS } from "@/server/sseProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PATH = "/api/v1/agent/stream";

export async function POST(request: Request): Promise<Response> {
  const denied = guardRequest(request, { mutating: true });
  if (denied) return denied;

  const body = await readAgentRequest(request);
  if (!body.ok) return body.response;

  const upstream = await callBackend(request, PATH, { method: "POST", body: body.value, accept: "text/event-stream" });
  if (!upstream.ok) return upstream.response;
  const response = upstream.value;
  if (!response.ok) return upstreamError(response, PATH);

  if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined);
    return invalidUpstream(PATH);
  }

  const stream = proxySseStream(response.body, (outcome) => {
    if (outcome === "interrupted") console.error(JSON.stringify({ level: "error", event: "stream_interrupted", path: PATH }));
  });
  return new Response(stream, { status: 200, headers: SSE_RESPONSE_HEADERS });
}
