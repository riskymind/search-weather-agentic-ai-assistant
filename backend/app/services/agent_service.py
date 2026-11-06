"""Coordinates one agent turn: session handling, bounded execution, event collection,
error mapping and the final structured response.

Independent of FastAPI. `stream()` is the single execution path; `run()` simply
consumes it, so the JSON and SSE endpoints cannot drift apart.
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Protocol
from uuid import UUID

import openai

from app.agents.weather_agent import AgentEvent, AnswerToken, FinalAnswer, ToolCallFinished, ToolCallStarted
from app.core.errors import AgentExecutionError, AgentTimeoutError, AppError, LLMProviderError
from app.schemas.agent import (
    AgentQueryResponse,
    DoneEvent,
    SessionEvent,
    StatusEvent,
    StreamEvent,
    TokenEvent,
    ToolEndEvent,
    ToolEvent,
    ToolStartEvent,
)
from app.schemas.conversation import ChatTurn
from app.services.session_store import SessionStore

logger = logging.getLogger(__name__)

EMPTY_ANSWER_MESSAGE = "I couldn't produce an answer for that request. Please try rephrasing it."


def _parse_session_id(value: str | None) -> str | None:
    """Canonicalise a client-supplied session ID. Malformed IDs are treated like unknown ones
    (a new server-generated session is created), so stale or corrupted client state self-heals."""
    if value is None:
        return None
    try:
        return str(UUID(value))
    except ValueError:
        logger.info("invalid_session_id_ignored")
        return None


class AgentRunnerProtocol(Protocol):
    def run(self, history: list[ChatTurn], message: str) -> AsyncIterator[AgentEvent]: ...


class AgentService:
    """Executes agent turns against a session store."""

    def __init__(self, runner: AgentRunnerProtocol, sessions: SessionStore, timeout_seconds: float) -> None:
        self._runner = runner
        self._sessions = sessions
        self._timeout = timeout_seconds

    async def stream(self, message: str, session_id: str | None = None) -> AsyncGenerator[StreamEvent, None]:
        """Yield safe execution events for one turn, ending with a `DoneEvent`.

        Raises `AppError` subclasses on failure (after any events already yielded),
        including `SessionBusyError` if another turn is running for the same session.
        """
        session, is_new = await self._sessions.get_or_create(_parse_session_id(session_id))
        async with self._sessions.lock(session.id):
            history = await self._sessions.get_turns(session.id)
            yield SessionEvent(session_id=session.id, is_new_session=is_new)
            yield StatusEvent(stage="analyzing")

            started_at = time.perf_counter()
            tool_events: list[ToolEvent] = []
            draft: list[str] = []
            final: FinalAnswer | None = None
            preparing_announced = False

            try:
                async with asyncio.timeout(self._timeout):
                    async for event in self._runner.run(history, message):
                        if isinstance(event, ToolCallStarted):
                            # Any text streamed so far was preamble to this tool call, not the answer.
                            draft.clear()
                            preparing_announced = False
                            yield ToolStartEvent(id=event.id, tool=event.tool, input=event.input)
                        elif isinstance(event, ToolCallFinished):
                            outcome = event.outcome
                            tool_event = ToolEvent(
                                id=event.id,
                                tool=event.tool,
                                status="completed" if outcome.ok else "failed",
                                input=event.input,
                                summary=outcome.summary,
                                data=outcome.data,
                                error=outcome.error,
                            )
                            tool_events.append(tool_event)
                            yield ToolEndEvent(**tool_event.model_dump())
                        elif isinstance(event, AnswerToken):
                            if not preparing_announced:
                                preparing_announced = True
                                yield StatusEvent(stage="preparing_answer")
                            draft.append(event.delta)
                            yield TokenEvent(delta=event.delta)
                        elif isinstance(event, FinalAnswer):
                            final = event
            except TimeoutError:
                logger.warning("agent_timeout", extra={"session_id": session.id, "timeout_seconds": self._timeout})
                raise AgentTimeoutError() from None
            except openai.APIError as exc:
                logger.error("llm_provider_error", extra={"session_id": session.id, "error_type": type(exc).__name__})
                raise LLMProviderError() from None
            except AppError:
                raise
            except Exception as exc:
                logger.exception(
                    "agent_execution_failed", extra={"session_id": session.id, "error_type": type(exc).__name__}
                )
                raise AgentExecutionError() from None

            answer = ((final.text if final else "") or "".join(draft)).strip() or EMPTY_ANSWER_MESSAGE
            await self._sessions.append_turns(
                session.id, [ChatTurn(role="user", content=message), ChatTurn(role="assistant", content=answer)]
            )
            logger.info(
                "agent_turn_completed",
                extra={
                    "session_id": session.id,
                    "tools": [e.tool for e in tool_events],
                    "step_limit_reached": bool(final and final.step_limit_reached),
                    "duration_ms": round((time.perf_counter() - started_at) * 1000),
                },
            )
            yield DoneEvent(session_id=session.id, is_new_session=is_new, answer=answer, tool_events=tool_events)

    async def run(self, message: str, session_id: str | None = None) -> AgentQueryResponse:
        """Execute one turn and return the complete structured response."""
        # aclosing: returning early must still close the generator so the session lock is released.
        async with contextlib.aclosing(self.stream(message, session_id)) as events:
            async for event in events:
                if isinstance(event, DoneEvent):
                    return AgentQueryResponse.model_validate(event.model_dump(exclude={"event"}))
        raise AgentExecutionError()  # pragma: no cover - stream always ends with DoneEvent or raises
