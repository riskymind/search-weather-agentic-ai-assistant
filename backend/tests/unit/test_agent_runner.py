"""Agent tool selection and execution, using a scripted LLM and respx-mocked providers."""

from datetime import date

import httpx
import pytest
import respx
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import SecretStr
from tavily import AsyncTavilyClient

from app.agents.prompts import STEP_LIMIT_MESSAGE, build_system_prompt
from app.agents.weather_agent import AgentRunner, AnswerToken, FinalAnswer, ToolCallFinished, ToolCallStarted
from app.schemas.conversation import ChatTurn
from app.tools.search_tool import TavilySearchClient, build_search_tool
from app.tools.weather_tool import WeatherstackClient, build_weather_tool
from tests.conftest import (
    FAKE_TAVILY_KEY,
    FAKE_WEATHER_KEY,
    TAVILY_SEARCH_URL,
    WEATHERSTACK_URL,
    ScriptedChatModel,
    tavily_payload,
    tavily_result,
    tool_call,
    weatherstack_payload,
)


@pytest.fixture
async def tools():
    async with httpx.AsyncClient() as weather_http, httpx.AsyncClient() as tavily_http:
        weather = WeatherstackClient(weather_http, SecretStr(FAKE_WEATHER_KEY), "https://api.weatherstack.com")
        search = TavilySearchClient(AsyncTavilyClient(api_key=FAKE_TAVILY_KEY, client=tavily_http), 3, 2)
        yield [build_search_tool(search), build_weather_tool(weather)]


async def collect(runner, message, history=()):
    return [event async for event in runner.run(list(history), message)]


def of_type(events, cls):
    return [e for e in events if isinstance(e, cls)]


async def test_direct_answer_without_tools(tools):
    model = ScriptedChatModel(responses=[AIMessage(content="Two plus two is four.")])
    events = await collect(AgentRunner(model, tools, max_steps=10), "What is 2+2?")

    assert not of_type(events, ToolCallStarted)
    assert "".join(e.delta for e in of_type(events, AnswerToken)) == "Two plus two is four."
    assert events[-1] == FinalAnswer("Two plus two is four.")


@respx.mock
async def test_weather_question_selects_weather_tool(tools):
    weather_route = respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    search_route = respx.post(TAVILY_SEARCH_URL)
    model = ScriptedChatModel(
        responses=[
            tool_call("weather", {"city": "Lagos"}, "w1"),
            AIMessage(content="It is 31°C and partly cloudy in Lagos."),
        ]
    )
    events = await collect(AgentRunner(model, tools, max_steps=10), "What is the weather in Lagos?")

    assert of_type(events, ToolCallStarted) == [ToolCallStarted("w1", "weather", {"city": "Lagos"})]
    finished = of_type(events, ToolCallFinished)
    assert len(finished) == 1 and finished[0].outcome.ok
    assert finished[0].outcome.data.city == "Lagos"
    assert weather_route.call_count == 1 and not search_route.called
    assert events[-1].text == "It is 31°C and partly cloudy in Lagos."

    # The tool result was fed back to the model as a ToolMessage.
    second_call = model.calls[1]
    assert isinstance(second_call[-1], ToolMessage) and '"ok": true' in second_call[-1].content


@respx.mock
async def test_information_question_selects_search_tool(tools):
    respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(tavily_result("President of Nigeria", "https://example.com/ng", "The president is ..."))
    )
    weather_route = respx.get(WEATHERSTACK_URL)
    model = ScriptedChatModel(
        responses=[
            tool_call("tavily_search", {"query": "current president of Nigeria"}, "s1"),
            AIMessage(content="According to [example.com](https://example.com/ng), the president is ..."),
        ]
    )
    events = await collect(AgentRunner(model, tools, max_steps=10), "Who is the president of Nigeria?")

    finished = of_type(events, ToolCallFinished)
    assert [f.tool for f in finished] == ["tavily_search"]
    assert finished[0].outcome.data.kind == "search"
    assert not weather_route.called


@respx.mock
async def test_multi_tool_search_then_weather(tools):
    respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(
            tavily_result("Nairobi", "https://en.wikipedia.org/wiki/Nairobi", "Nairobi is the capital.")
        )
    )
    weather_route = respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload("Nairobi", "Kenya", temperature=22))
    model = ScriptedChatModel(
        responses=[
            tool_call("tavily_search", {"query": "capital of Kenya"}, "s1"),
            tool_call("weather", {"city": "Nairobi"}, "w1"),
            AIMessage(content="The capital of Kenya is Nairobi, where it is currently 22°C."),
        ]
    )
    events = await collect(AgentRunner(model, tools, max_steps=10), "Find the capital of Kenya and its weather")

    assert [type(e).__name__ for e in events if not isinstance(e, AnswerToken)] == [
        "ToolCallStarted",
        "ToolCallFinished",
        "ToolCallStarted",
        "ToolCallFinished",
        "FinalAnswer",
    ]
    finished = of_type(events, ToolCallFinished)
    assert [f.tool for f in finished] == ["tavily_search", "weather"]
    assert finished[1].outcome.data.city == "Nairobi"
    assert weather_route.calls.last.request.url.params["query"] == "Nairobi"
    assert "Nairobi" in events[-1].text


@respx.mock
async def test_tool_failure_is_reported_to_model(tools):
    respx.get(WEATHERSTACK_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
    model = ScriptedChatModel(
        responses=[
            tool_call("weather", {"city": "Lagos"}, "w1"),
            AIMessage(content="Sorry, I couldn't retrieve the weather right now."),
        ]
    )
    events = await collect(AgentRunner(model, tools, max_steps=10), "Weather in Lagos?")

    finished = of_type(events, ToolCallFinished)[0]
    assert finished.outcome.ok is False and finished.outcome.error.code == "timeout"
    tool_message = model.calls[1][-1]
    assert isinstance(tool_message, ToolMessage) and '"ok": false' in tool_message.content
    assert events[-1].text.startswith("Sorry")


async def test_invalid_tool_arguments_become_failed_event(tools):
    model = ScriptedChatModel(
        responses=[
            tool_call("weather", {"town": "Lagos"}, "w1"),  # wrong argument name
            AIMessage(content="I could not get the weather."),
        ]
    )
    events = await collect(AgentRunner(model, tools, max_steps=10), "Weather?")
    finished = of_type(events, ToolCallFinished)[0]
    assert finished.outcome.ok is False
    assert finished.outcome.error.code == "invalid_input"


@respx.mock
async def test_execution_is_bounded_by_step_limit(tools):
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    model = ScriptedChatModel(responses=[tool_call("weather", {"city": "Lagos"}, "loop")])  # never stops
    events = await collect(AgentRunner(model, tools, max_steps=6), "Loop forever")

    assert events[-1] == FinalAnswer(STEP_LIMIT_MESSAGE, step_limit_reached=True)
    assert len(model.calls) <= 3


async def test_history_and_system_prompt_are_sent(tools):
    model = ScriptedChatModel(responses=[AIMessage(content="You asked about Lagos.")])
    history = [ChatTurn(role="user", content="Weather in Lagos?"), ChatTurn(role="assistant", content="31°C.")]
    await collect(AgentRunner(model, tools, max_steps=10), "What did I ask?", history)

    sent = model.calls[0]
    assert isinstance(sent[0], SystemMessage) and date.today().isoformat() in sent[0].content
    assert [type(m) for m in sent[1:]] == [HumanMessage, AIMessage, HumanMessage]
    assert sent[-1].content == "What did I ask?"


async def test_provider_exceptions_propagate(tools):
    model = ScriptedChatModel(responses=[RuntimeError("boom")])
    with pytest.raises(RuntimeError):
        await collect(AgentRunner(model, tools, max_steps=10), "hi")


def test_system_prompt_rules():
    prompt = build_system_prompt(date(2026, 1, 2))
    assert "2026-01-02" in prompt
    assert "Never invent or guess tool results" in prompt
    assert "tavily_search" in prompt and "weather" in prompt
