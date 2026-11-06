"""Conversation history model shared by the session store and the agent."""

from typing import Literal

from pydantic import BaseModel


class ChatTurn(BaseModel):
    """One message of conversation history (plain text, JSON-serialisable for any store)."""

    role: Literal["user", "assistant"]
    content: str
