"""Agent endpoints. Thin adapters: all orchestration lives in `AgentService`."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.dependencies import enforce_rate_limit, get_agent_service, require_api_access
from app.api.v1.sse import SSE_HEADERS, sse_stream
from app.schemas.agent import AgentQueryRequest, AgentQueryResponse
from app.schemas.common import ErrorResponse
from app.services.agent_service import AgentService

# Rate limiting runs first so that failed authentication attempts are also limited.
router = APIRouter(
    prefix="/agent",
    tags=["agent"],
    dependencies=[Depends(enforce_rate_limit), Depends(require_api_access)],
)

_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Missing or invalid API access key (only when API_ACCESS_KEY is set)"},
    409: {"model": ErrorResponse, "description": "Session is already processing a message (`session_busy`)"},
    413: {"model": ErrorResponse, "description": "Request body too large"},
    422: {"model": ErrorResponse, "description": "Invalid request payload"},
    429: {"model": ErrorResponse, "description": "Rate limit exceeded (see `Retry-After` header)"},
    500: {"model": ErrorResponse, "description": "Agent execution error"},
    502: {"model": ErrorResponse, "description": "LLM provider error"},
    504: {"model": ErrorResponse, "description": "Agent timed out"},
}

ServiceDep = Annotated[AgentService, Depends(get_agent_service)]


@router.post(
    "/query",
    response_model=AgentQueryResponse,
    responses=_ERROR_RESPONSES,
    summary="Ask the agent and receive the complete answer",
)
async def query_agent(body: AgentQueryRequest, service: ServiceDep) -> AgentQueryResponse:
    return await service.run(body.message, body.session_id)


@router.post(
    "/stream",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {"text/event-stream": {}},
            "description": (
                "SSE stream. Each frame is `event: <name>` + one-line JSON `data:` whose `event` field repeats "
                "the name. Order: session, status(analyzing), then any number of "
                "[token* -> tool_start -> tool_end] rounds, status(preparing_answer), token*, and exactly one "
                "terminal `done` or `error`. Clients must DISCARD any token text received before a "
                "`tool_start` (it is preamble, not the answer) and must REPLACE the streamed draft with "
                "`done.answer`, which is authoritative. Errors after the stream opens (including "
                "`session_busy`, `agent_timeout`, `llm_provider_error`) arrive as an `error` event; errors "
                "before it opens (413, 422, 429) are normal JSON responses."
            ),
        },
        401: _ERROR_RESPONSES[401],
        413: _ERROR_RESPONSES[413],
        422: _ERROR_RESPONSES[422],
        429: _ERROR_RESPONSES[429],
    },
    summary="Ask the agent and stream execution events (Server-Sent Events)",
)
async def stream_agent(body: AgentQueryRequest, service: ServiceDep) -> StreamingResponse:
    return StreamingResponse(
        sse_stream(service.stream(body.message, body.session_id)),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
