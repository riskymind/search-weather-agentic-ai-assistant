import json
import logging

import httpx
import pytest
import respx
from tavily import AsyncTavilyClient

from app.schemas.tools import ToolOutcome
from app.tools.common import ToolFailure
from app.tools.search_tool import MAX_SNIPPET_CHARS, TavilySearchClient, build_search_tool
from tests.conftest import FAKE_TAVILY_KEY, TAVILY_SEARCH_URL, tavily_payload, tavily_result


@pytest.fixture
async def client():
    async with httpx.AsyncClient(timeout=2) as http:
        yield TavilySearchClient(
            AsyncTavilyClient(api_key=FAKE_TAVILY_KEY, client=http), max_results=3, timeout_seconds=2
        )


@respx.mock
async def test_success_returns_structured_results(client):
    route = respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(
            tavily_result(
                "Nairobi - Wikipedia", "https://en.wikipedia.org/wiki/Nairobi", "Nairobi is the capital of Kenya."
            ),
            tavily_result("Kenya", "https://www.britannica.com/place/Kenya", "Kenya's capital is Nairobi.", 0.7),
        )
    )
    data = await client.search("capital of Kenya")

    assert data.query == "capital of Kenya"
    assert [r.title for r in data.results] == ["Nairobi - Wikipedia", "Kenya"]
    assert data.results[0].url == "https://en.wikipedia.org/wiki/Nairobi"
    assert data.results[0].content == "Nairobi is the capital of Kenya."

    request = route.calls.last.request
    body = json.loads(request.content)
    assert body["query"] == "capital of Kenya"
    assert body["max_results"] == 3
    assert request.headers["authorization"] == f"Bearer {FAKE_TAVILY_KEY}"


@respx.mock
async def test_empty_results(client):
    respx.post(TAVILY_SEARCH_URL).respond(json=tavily_payload())
    data = await client.search("asdkjhasdkjh")
    assert data.results == []


@respx.mock
async def test_filters_unsafe_urls_and_truncates_snippets(client):
    respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(
            tavily_result("Bad", "javascript:alert(1)", "x"),
            tavily_result("Long", "https://example.com", "word " * 400),
        )
    )
    data = await client.search("anything")
    assert [r.title for r in data.results] == ["Long"]
    assert len(data.results[0].content) <= MAX_SNIPPET_CHARS


@pytest.mark.parametrize("query", ["", "   ", "x" * 401])
async def test_invalid_query(client, query):
    with pytest.raises(ToolFailure) as exc_info:
        await client.search(query)
    assert exc_info.value.code == "invalid_input"


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "not_configured"),
        (403, "not_configured"),
        (429, "provider_error"),
        (400, "invalid_input"),
        (500, "provider_error"),
    ],
)
@respx.mock
async def test_api_failures_are_mapped(client, status_code, expected):
    respx.post(TAVILY_SEARCH_URL).respond(status_code=status_code, json={"detail": {"error": "nope"}})
    with pytest.raises(ToolFailure) as exc_info:
        await client.search("news")
    assert exc_info.value.code == expected


@respx.mock
async def test_timeout(client):
    respx.post(TAVILY_SEARCH_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(ToolFailure) as exc_info:
        await client.search("news")
    assert exc_info.value.code == "timeout"


@respx.mock
async def test_network_failure(client):
    respx.post(TAVILY_SEARCH_URL).mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(ToolFailure) as exc_info:
        await client.search("news")
    assert exc_info.value.code == "provider_error"


@respx.mock
async def test_malformed_response(client):
    # (The SDK itself normalises a *missing* "results" key to [], i.e. "no results".)
    respx.post(TAVILY_SEARCH_URL).respond(json={"results": "not-a-list"})
    with pytest.raises(ToolFailure) as exc_info:
        await client.search("news")
    assert exc_info.value.code == "provider_error"


@respx.mock
async def test_credentials_not_leaked(client, caplog):
    caplog.set_level(logging.DEBUG)
    respx.post(TAVILY_SEARCH_URL).respond(status_code=401, json={"detail": {"error": f"bad key {FAKE_TAVILY_KEY}"}})
    with pytest.raises(ToolFailure) as exc_info:
        await client.search("news")
    assert FAKE_TAVILY_KEY not in str(exc_info.value)
    assert FAKE_TAVILY_KEY not in caplog.text


# --- LangChain tool wrapper -------------------------------------------------------


async def _invoke(client, query):
    tool = build_search_tool(client)
    return await tool.ainvoke({"type": "tool_call", "name": "tavily_search", "args": {"query": query}, "id": "s1"})


@respx.mock
async def test_tool_success(client):
    respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(tavily_result("Abuja", "https://en.wikipedia.org/wiki/Abuja", "Abuja is the capital."))
    )
    message = await _invoke(client, "capital of Nigeria")
    content = json.loads(message.content)
    assert content["ok"] is True
    assert content["results"][0]["url"] == "https://en.wikipedia.org/wiki/Abuja"
    assert isinstance(message.artifact, ToolOutcome)
    assert message.artifact.summary == 'Found 1 result for "capital of Nigeria"'
    assert message.artifact.data.kind == "search"


@respx.mock
async def test_tool_empty_results(client):
    respx.post(TAVILY_SEARCH_URL).respond(json=tavily_payload())
    message = await _invoke(client, "nothing")
    assert json.loads(message.content) == {"ok": True, "results": []}
    assert message.artifact.ok is True
    assert message.artifact.summary.startswith("No results found")


@respx.mock
async def test_tool_failure(client):
    respx.post(TAVILY_SEARCH_URL).respond(status_code=500)
    message = await _invoke(client, "news")
    content = json.loads(message.content)
    assert content["ok"] is False
    assert content["error"]["code"] == "provider_error"
    assert message.artifact.ok is False
    assert message.artifact.summary == "Web search failed"
