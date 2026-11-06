import asyncio

import httpx
import openai
import pytest

from app.agents.weather_agent import AnswerToken, FinalAnswer, ToolCallFinished, ToolCallStarted
from app.core.errors import AgentExecutionError, AgentTimeoutError, LLMProviderError
from app.schemas.tools import ToolError, ToolOutcome, WeatherData
from app.services.agent_service import EMPTY_ANSWER_MESSAGE, AgentService
from app.services.session_store import InMemorySessionStore
from tests.conftest import FakeRunner

WEATHER = WeatherData(
    city="Lagos",
    country="Nigeria",
    temperature_c=31,
    description="Sunny",
    humidity=60,
    wind_speed_kmh=10,
    observation_time="01:00 PM",
)


def make_service(runner, timeout: float = 5) -> AgentService:
    return AgentService(runner, InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), timeout)


WEATHER_TURN = [
    ToolCallStarted("w1", "weather", {"city": "Lagos"}),
    ToolCallFinished(
        "w1", "weather", {"city": "Lagos"}, ToolOutcome(ok=True, summary="Retrieved weather", data=WEATHER)
    ),
    AnswerToken("It is"),
    AnswerToken(" sunny."),
    FinalAnswer("It is sunny."),
]


async def test_stream_event_sequence():
    events = [e async for e in make_service(FakeRunner(WEATHER_TURN)).stream("Weather in Lagos?")]
    assert [e.event for e in events] == [
        "session",
        "status",
        "tool_start",
        "tool_end",
        "status",
        "token",
        "token",
        "done",
    ]
    assert events[1].stage == "analyzing" and events[4].stage == "preparing_answer"
    assert events[3].status == "completed" and events[3].data.city == "Lagos"
    done = events[-1]
    assert done.answer == "It is sunny."
    assert done.session_id == events[0].session_id and done.is_new_session


async def test_run_returns_structured_response():
    response = await make_service(FakeRunner(WEATHER_TURN)).run("Weather in Lagos?")
    assert response.answer == "It is sunny."
    assert [(t.tool, t.status, t.summary) for t in response.tool_events] == [
        ("weather", "completed", "Retrieved weather")
    ]


async def test_failed_tool_event_status():
    runner = FakeRunner(
        [
            ToolCallStarted("w1", "weather", {"city": "X"}),
            ToolCallFinished(
                "w1",
                "weather",
                {"city": "X"},
                ToolOutcome(ok=False, summary="Could not", error=ToolError(code="city_not_found", message="none")),
            ),
            FinalAnswer("I couldn't find that city."),
        ]
    )
    response = await make_service(runner).run("Weather in X?")
    event = response.tool_events[0]
    assert event.status == "failed" and event.error.code == "city_not_found" and event.data is None


async def test_conversation_context_is_kept_per_session():
    runner = FakeRunner([FinalAnswer("Hello!")])
    service = make_service(runner)
    first = await service.run("Hi")
    second = await service.run("Again", first.session_id)

    assert not second.is_new_session and second.session_id == first.session_id
    assert [(t.role, t.content) for t in runner.histories[1]] == [("user", "Hi"), ("assistant", "Hello!")]


async def test_unknown_session_starts_new_one():
    import uuid

    response = await make_service(FakeRunner([FinalAnswer("ok")])).run("Hi", str(uuid.uuid4()))
    assert response.is_new_session


async def test_empty_answer_falls_back_to_message():
    response = await make_service(FakeRunner([FinalAnswer("")])).run("Hi")
    assert response.answer == EMPTY_ANSWER_MESSAGE


async def test_timeout_maps_to_agent_timeout():
    service = make_service(FakeRunner(WEATHER_TURN, delay=0.2), timeout=0.05)
    with pytest.raises(AgentTimeoutError):
        await service.run("slow")


async def test_openai_error_maps_to_llm_provider_error():
    error = openai.APIConnectionError(request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions"))
    with pytest.raises(LLMProviderError):
        await make_service(FakeRunner(error=error)).run("Hi")


async def test_unexpected_error_maps_to_execution_error_without_details():
    with pytest.raises(AgentExecutionError) as exc_info:
        await make_service(FakeRunner(error=ValueError("internal prompt text"))).run("Hi")
    assert "internal prompt text" not in str(exc_info.value)
    assert exc_info.value.__cause__ is None


async def test_failed_turn_is_not_saved():
    runner = FakeRunner(error=ValueError("x"))
    service = make_service(runner)
    with pytest.raises(AgentExecutionError):
        await service.run("Hi")
    runner.error = None
    runner.events = [FinalAnswer("ok")]
    await service.run("Again")
    assert runner.histories[-1] == []


async def test_concurrent_turn_on_same_session_is_rejected_and_history_consistent():
    from app.core.errors import SessionBusyError

    service = make_service(FakeRunner([AnswerToken("a"), FinalAnswer("first")], delay=0.05))
    first = await service.run("one")

    async def turn(text):
        return await service.run(text, first.session_id)

    results = await asyncio.gather(turn("two"), turn("three"), return_exceptions=True)
    assert sum(isinstance(r, SessionBusyError) for r in results) == 1
    assert sum(not isinstance(r, Exception) for r in results) == 1

    # History has exactly one complete user/assistant pair per successful turn.
    history = await service._sessions.get_turns(first.session_id)
    assert [t.role for t in history] == ["user", "assistant", "user", "assistant"]


async def test_session_lock_released_after_failure_and_cancellation():
    runner = FakeRunner(error=ValueError("x"))
    service = make_service(runner)
    with pytest.raises(AgentExecutionError):
        await service.run("fail")
    sessions = service._sessions
    session, _ = await sessions.get_or_create(None)
    # cancellation mid-stream
    runner.error = None
    runner.events = [AnswerToken("x"), FinalAnswer("x")]
    runner.delay = 1
    stream = service.stream("slow", session.id)
    await anext(stream)  # session event (lock held)
    await stream.aclose()
    async with sessions.lock(session.id):  # lock was released
        pass


async def test_malformed_session_id_starts_new_session():
    response = await make_service(FakeRunner([FinalAnswer("ok")])).run("Hi", "not-a-uuid")
    assert response.is_new_session
    assert response.session_id != "not-a-uuid"


async def test_text_before_tool_call_is_not_part_of_answer():
    runner = FakeRunner(
        [
            AnswerToken("Let me check"),
            ToolCallStarted("w1", "weather", {"city": "Lagos"}),
            ToolCallFinished("w1", "weather", {"city": "Lagos"}, ToolOutcome(ok=True, summary="ok", data=WEATHER)),
            AnswerToken("Sunny."),
            FinalAnswer(""),  # no final text: answer falls back to the post-tool draft only
        ]
    )
    events = [e async for e in make_service(runner).stream("Weather?")]
    names = [e.event for e in events]
    assert names == ["session", "status", "status", "token", "tool_start", "tool_end", "status", "token", "done"]
    assert events[-1].answer == "Sunny."
