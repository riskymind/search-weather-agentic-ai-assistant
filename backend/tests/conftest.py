"""Shared fixtures. No test requires real OpenAI, Tavily or Weatherstack credentials."""

import asyncio
import json
from collections.abc import Iterator
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import PrivateAttr

from app.core.config import Settings, get_settings, load_settings

FAKE_OPENAI_KEY = "sk-test-openai-key-0000"
FAKE_TAVILY_KEY = "tvly-test-tavily-key-0000"
FAKE_WEATHER_KEY = "wx-test-weather-key-0000"

WEATHERSTACK_URL = "https://api.weatherstack.com/current"
TAVILY_SEARCH_URL = "https://api.tavily.com/search"

_ENV_VARS = (
    "OPENAI_API_KEY",
    "TAVILY_API_KEY",
    "WEATHER_API_KEY",
    "OPENAI_MODEL",
    "APP_ENV",
    "FRONTEND_URL",
    "LOG_LEVEL",
    "WEATHER_API_BASE_URL",
    "API_ACCESS_KEY",
    "ALLOW_PUBLIC_AGENT_API",
    "CLIENT_IP_HEADER",
    "TRUSTED_PROXY_CIDRS",
    "CLIENT_IP_DIAGNOSTICS",
)


@pytest.fixture(autouse=True)
def _isolate_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure no real credentials or local configuration leak into tests.

    Clears relevant environment variables and stops Settings from reading `backend/.env`
    (which may hold real keys). Live tests opt back in explicitly.
    """
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "openai_api_key": FAKE_OPENAI_KEY,
        "tavily_api_key": FAKE_TAVILY_KEY,
        "weather_api_key": FAKE_WEATHER_KEY,
        "_env_file": None,
    }
    values.update(overrides)
    return load_settings(**values)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


def tool_call(name: str, args: dict[str, Any], call_id: str, preamble: str = "") -> AIMessage:
    return AIMessage(content=preamble, tool_calls=[{"name": name, "args": args, "id": call_id}])


class ScriptedChatModel(BaseChatModel):
    """Deterministic tool-calling chat model.

    Returns `responses` in order (one per model call). An `Exception` entry is raised.
    Text answers are streamed word by word; tool calls are streamed as a single chunk.
    Every list of messages the agent sent is recorded in `calls`.
    """

    responses: list[Any]  # AIMessage | Exception (Any avoids pydantic coercion)
    _calls: list[list[BaseMessage]] = PrivateAttr(default_factory=list)

    @property
    def calls(self) -> list[list[BaseMessage]]:
        return self._calls

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":  # type: ignore[override]
        return self

    def _next(self, messages: list[BaseMessage]) -> AIMessage:
        self._calls.append(list(messages))
        index = len(self._calls) - 1
        if index >= len(self.responses):
            # Keep requesting tools forever (used to exercise the step limit).
            last = self.responses[-1]
            assert isinstance(last, AIMessage)
            return last
        response = self.responses[index]
        if isinstance(response, Exception):
            raise response
        return response

    def _generate(
        self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kw: Any
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._next(messages))])

    def _stream(
        self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kw: Any
    ) -> Iterator[ChatGenerationChunk]:
        message = self._next(messages)
        # Like OpenAI: any text content streams first, then the tool-call chunks.
        text = str(message.content)
        if text:
            for i, word in enumerate(text.split(" ")):
                yield ChatGenerationChunk(message=AIMessageChunk(content=(" " if i else "") + word))
        if message.tool_calls:
            chunks = [
                {"name": tc["name"], "args": json.dumps(tc["args"]), "id": tc["id"], "index": i}
                for i, tc in enumerate(message.tool_calls)
            ]
            yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_call_chunks=chunks))  # type: ignore[arg-type]


def weatherstack_payload(city: str = "Lagos", country: str = "Nigeria", **current: Any) -> dict[str, Any]:
    return {
        "request": {"type": "City", "query": f"{city}, {country}", "language": "en", "unit": "m"},
        "location": {
            "name": city,
            "country": country,
            "region": "Lagos",
            "localtime": "2026-11-03 14:45",
        },
        "current": {
            "observation_time": "01:45 PM",
            "temperature": 31,
            "feelslike": 35,
            "weather_descriptions": ["Partly cloudy"],
            "weather_icons": ["https://cdn.worldweatheronline.com/images/wsymbols01_png_64/wsymbol_0002.png"],
            "humidity": 70,
            "wind_speed": 13,
            **current,
        },
    }


def tavily_payload(*results: dict[str, Any], query: str = "capital of Kenya") -> dict[str, Any]:
    return {"query": query, "results": list(results), "response_time": 0.5}


def tavily_result(title: str, url: str, content: str, score: float = 0.9) -> dict[str, Any]:
    return {"title": title, "url": url, "content": content, "score": score}


class FakeRunner:
    """Replays a fixed list of agent events (or raises an exception)."""

    def __init__(self, events=(), error: Exception | None = None, delay: float = 0) -> None:
        self.events = list(events)
        self.error = error
        self.delay = delay
        self.histories: list[list] = []

    async def run(self, history, message):
        self.histories.append(list(history))
        for event in self.events:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield event
        if self.error:
            raise self.error
