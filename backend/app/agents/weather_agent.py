"""Tool-calling agent built on LangChain's `create_agent` (LangGraph runtime).

`AgentRunner` is stateless: it receives the conversation so far and yields
framework-neutral events (`ToolCallStarted`, `ToolCallFinished`, `AnswerToken`,
`FinalAnswer`). Sessions, timeouts and HTTP concerns live in the service and
API layers, so neither depends on LangGraph types.

To add a tool, append it to the list passed to `AgentRunner` (see `app.main`).
"""

import logging
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, cast

from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI
from langgraph.errors import GraphRecursionError

from app.agents.prompts import STEP_LIMIT_MESSAGE, build_system_prompt
from app.core.config import Settings
from app.schemas.conversation import ChatTurn
from app.schemas.tools import ToolError, ToolOutcome

logger = logging.getLogger(__name__)

_MODEL_NODE = "model"


@dataclass(frozen=True)
class ToolCallStarted:
    id: str
    tool: str
    input: dict[str, Any]


@dataclass(frozen=True)
class ToolCallFinished:
    id: str
    tool: str
    input: dict[str, Any]
    outcome: ToolOutcome


@dataclass(frozen=True)
class AnswerToken:
    delta: str


@dataclass(frozen=True)
class FinalAnswer:
    text: str
    step_limit_reached: bool = False


AgentEvent = ToolCallStarted | ToolCallFinished | AnswerToken | FinalAnswer


def build_chat_model(settings: Settings) -> ChatOpenAI:
    """Create the OpenAI chat model from configuration."""
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        temperature=0,
        timeout=settings.openai_timeout_seconds,
        max_retries=2,
        streaming=True,
    )


def _to_messages(history: Sequence[ChatTurn], message: str) -> list[AnyMessage]:
    messages: list[AnyMessage] = [SystemMessage(build_system_prompt())]
    for turn in history:
        messages.append(HumanMessage(turn.content) if turn.role == "user" else AIMessage(turn.content))
    messages.append(HumanMessage(message))
    return messages


def _outcome_from(message: ToolMessage) -> ToolOutcome:
    if isinstance(message.artifact, ToolOutcome):
        return message.artifact
    # The tool never ran (e.g. the model supplied arguments that failed schema validation).
    return ToolOutcome(
        ok=False,
        summary=f"{message.name or 'Tool'} could not be run",
        error=ToolError(code="invalid_input", message="The tool was called with invalid arguments."),
    )


class AgentRunner:
    """Runs the tool-calling agent for a single turn and yields safe execution events."""

    def __init__(self, model: BaseChatModel, tools: Sequence[BaseTool], max_steps: int) -> None:
        self._graph = create_agent(model=model, tools=list(tools))
        self._max_steps = max_steps

    async def run(self, history: Sequence[ChatTurn], message: str) -> AsyncIterator[AgentEvent]:
        """Execute one agent turn. Provider exceptions propagate to the caller."""
        pending: dict[str, ToolCallStarted] = {}
        final_text = ""
        config: RunnableConfig = {"recursion_limit": self._max_steps}
        agent_input = cast(Any, {"messages": _to_messages(history, message)})

        try:
            async for part in self._graph.astream(agent_input, config, stream_mode=["messages", "updates"]):
                # With a list of stream modes, LangGraph yields (mode, payload) tuples.
                mode, chunk = cast(tuple[str, Any], part)
                if mode == "messages":
                    msg, metadata = chunk
                    if (
                        isinstance(msg, AIMessageChunk)
                        and metadata.get("langgraph_node") == _MODEL_NODE
                        and not msg.tool_call_chunks
                        and msg.text
                    ):
                        yield AnswerToken(msg.text)
                    continue

                for node_update in chunk.values():
                    for msg in (node_update or {}).get("messages", []):
                        if isinstance(msg, AIMessage) and not msg.tool_calls:
                            final_text = msg.text
                        for event in self._events_from_message(msg, pending):
                            yield event
        except GraphRecursionError:
            logger.warning("agent_step_limit_reached", extra={"max_steps": self._max_steps})
            yield FinalAnswer(STEP_LIMIT_MESSAGE, step_limit_reached=True)
            return

        yield FinalAnswer(final_text)

    @staticmethod
    def _events_from_message(msg: object, pending: dict[str, ToolCallStarted]) -> list[AgentEvent]:
        """Translate a completed graph message into tool start/finish events."""
        if isinstance(msg, AIMessage):
            started_events: list[AgentEvent] = []
            for call in msg.tool_calls:
                started = ToolCallStarted(id=call["id"] or call["name"], tool=call["name"], input=dict(call["args"]))
                pending[started.id] = started
                started_events.append(started)
            return started_events

        if isinstance(msg, ToolMessage):
            origin = pending.pop(msg.tool_call_id, None) or ToolCallStarted(
                id=msg.tool_call_id, tool=msg.name or "unknown", input={}
            )
            outcome = _outcome_from(msg)
            logger.info(
                "tool_finished",
                extra={
                    "tool": origin.tool,
                    "ok": outcome.ok,
                    "error_code": outcome.error.code if outcome.error else None,
                },
            )
            return [ToolCallFinished(origin.id, origin.tool, origin.input, outcome)]

        return []
