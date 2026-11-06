"""Request, response and streaming-event schemas for the agent endpoints."""

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.tools import ToolData, ToolError

ToolStatus = Literal["running", "completed", "failed"]

MAX_MESSAGE_CHARS = 4000


class AgentQueryRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS, description="The user's message.")
    session_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Session ID returned by a previous response. Omit or null to start a new session. "
            "Unknown, expired or malformed IDs start a new server-generated session "
            "(the response then has is_new_session=true); a client-chosen ID is never adopted."
        ),
    )

    @field_validator("message")
    @classmethod
    def _strip_message(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message must not be blank")
        return value


class ToolEvent(BaseModel):
    id: str
    tool: str
    status: ToolStatus
    input: dict[str, Any] = Field(default_factory=dict)
    summary: str
    data: ToolData | None = None
    error: ToolError | None = None


class AgentQueryResponse(BaseModel):
    session_id: str
    is_new_session: bool
    answer: str
    tool_events: list[ToolEvent]


# --- Server-Sent Event payloads -------------------------------------------------


class SessionEvent(BaseModel):
    event: Literal["session"] = "session"
    session_id: str
    is_new_session: bool


class StatusEvent(BaseModel):
    event: Literal["status"] = "status"
    stage: Literal["analyzing", "preparing_answer"]


class ToolStartEvent(BaseModel):
    event: Literal["tool_start"] = "tool_start"
    id: str
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)


class ToolEndEvent(ToolEvent):
    event: Literal["tool_end"] = "tool_end"


class TokenEvent(BaseModel):
    event: Literal["token"] = "token"
    delta: str


class DoneEvent(AgentQueryResponse):
    event: Literal["done"] = "done"


class ErrorEvent(BaseModel):
    event: Literal["error"] = "error"
    code: str
    message: str


StreamEvent = SessionEvent | StatusEvent | ToolStartEvent | ToolEndEvent | TokenEvent | DoneEvent | ErrorEvent
