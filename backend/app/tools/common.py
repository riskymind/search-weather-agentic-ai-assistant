"""Helpers shared by tool implementations."""

import json

from app.schemas.tools import ToolErrorCode


class ToolFailure(Exception):
    """A provider call failed in a way the agent should be told about (never fabricate data)."""

    def __init__(self, code: ToolErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ToolErrorCode = code
        self.message = message


def llm_content(payload: dict[str, object]) -> str:
    """Serialise the compact view of a tool result that is sent back to the LLM."""
    return json.dumps(payload, ensure_ascii=False, default=str)
