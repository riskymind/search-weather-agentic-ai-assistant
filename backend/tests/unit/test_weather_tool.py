import json
import logging

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.schemas.tools import ToolOutcome
from app.tools.common import ToolFailure
from app.tools.weather_tool import WeatherstackClient, build_weather_tool, validate_city
from tests.conftest import FAKE_WEATHER_KEY, WEATHERSTACK_URL, weatherstack_payload


@pytest.fixture
async def client():
    async with httpx.AsyncClient(timeout=2) as http:
        yield WeatherstackClient(http, SecretStr(FAKE_WEATHER_KEY), "https://api.weatherstack.com")


@respx.mock
async def test_success_returns_structured_weather(client):
    route = respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    data = await client.get_current("  Lagos ")

    assert data.city == "Lagos"
    assert data.country == "Nigeria"
    assert data.temperature_c == 31
    assert data.description == "Partly cloudy"
    assert data.humidity == 70
    assert data.wind_speed_kmh == 13
    assert data.observation_time == "01:45 PM"
    assert data.icon_url and data.icon_url.startswith("https://")

    request = route.calls.last.request
    assert request.url.scheme == "https"
    assert request.url.params["query"] == "Lagos"
    assert request.url.params["units"] == "m"
    assert request.url.params["access_key"] == FAKE_WEATHER_KEY


@respx.mock
async def test_city_is_sent_encoded_not_interpolated(client):
    route = respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload("São Paulo", "Brazil"))
    await client.get_current("São Paulo")
    params = route.calls.last.request.url.params
    assert params["query"] == "São Paulo"
    assert list(params.keys()) == ["access_key", "query", "units"]


@respx.mock
async def test_reports_resolved_location_not_user_input(client):
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload("Abuja", "Nigeria"))
    data = await client.get_current("abuja")
    assert data.city == "Abuja"


@pytest.mark.parametrize("city", ["", "   ", "Paris&units=f", "x" * 101, "123", "<script>", "Lagos; DROP"])
def test_invalid_city_rejected(city):
    with pytest.raises(ToolFailure) as exc_info:
        validate_city(city)
    assert exc_info.value.code == "invalid_input"


@pytest.mark.parametrize("city", ["Lagos", "São Paulo", "St. John's", "Washington, D.C.", "Port-au-Prince", "東京"])
def test_valid_city_accepted(city):
    assert validate_city(city) == city


@respx.mock
async def test_invalid_input_never_calls_provider(client):
    route = respx.get(WEATHERSTACK_URL)
    with pytest.raises(ToolFailure):
        await client.get_current("Paris&access_key=stolen")
    assert not route.called


@pytest.mark.parametrize(
    ("provider_code", "expected"),
    [
        (615, "city_not_found"),
        (101, "not_configured"),
        (102, "not_configured"),
        (105, "not_configured"),
        (104, "provider_error"),
        (999, "provider_error"),
    ],
)
@respx.mock
async def test_provider_error_codes_are_mapped(client, provider_code, expected):
    respx.get(WEATHERSTACK_URL).respond(
        json={"success": False, "error": {"code": provider_code, "type": "x", "info": "details"}}
    )
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Atlantis")
    assert exc_info.value.code == expected


@respx.mock
async def test_https_restricted_message_is_explicit(client):
    respx.get(WEATHERSTACK_URL).respond(json={"success": False, "error": {"code": 105}})
    with pytest.raises(ToolFailure, match="does not support HTTPS"):
        await client.get_current("Lagos")


@respx.mock
async def test_timeout(client):
    respx.get(WEATHERSTACK_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Lagos")
    assert exc_info.value.code == "timeout"


@respx.mock
async def test_connection_error(client):
    respx.get(WEATHERSTACK_URL).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Lagos")
    assert exc_info.value.code == "provider_error"


@respx.mock
async def test_http_5xx(client):
    respx.get(WEATHERSTACK_URL).respond(status_code=503, text="unavailable")
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Lagos")
    assert exc_info.value.code == "provider_error"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json=["unexpected"]),
        httpx.Response(200, json={"location": {"name": "Lagos"}}),
        httpx.Response(200, json=weatherstack_payload(weather_descriptions=[])),
        httpx.Response(200, json=weatherstack_payload(temperature="hot")),
    ],
)
@respx.mock
async def test_malformed_response(client, response):
    respx.get(WEATHERSTACK_URL).mock(return_value=response)
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Lagos")
    assert exc_info.value.code == "provider_error"


@respx.mock
async def test_api_key_never_in_errors_or_logs(client, caplog):
    caplog.set_level(logging.DEBUG)
    respx.get(WEATHERSTACK_URL).mock(
        side_effect=httpx.ConnectError(f"failed {WEATHERSTACK_URL}?access_key={FAKE_WEATHER_KEY}")
    )
    with pytest.raises(ToolFailure) as exc_info:
        await client.get_current("Lagos")
    assert FAKE_WEATHER_KEY not in str(exc_info.value)
    assert exc_info.value.__cause__ is None and exc_info.value.__suppress_context__
    assert FAKE_WEATHER_KEY not in caplog.text


# --- LangChain tool wrapper -------------------------------------------------------


@respx.mock
async def test_tool_returns_content_and_artifact(client):
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    tool = build_weather_tool(client)
    message = await tool.ainvoke({"type": "tool_call", "name": "weather", "args": {"city": "Lagos"}, "id": "c1"})

    content = json.loads(message.content)
    assert content["ok"] is True
    assert content["weather"]["temperature_c"] == 31
    outcome = message.artifact
    assert isinstance(outcome, ToolOutcome)
    assert outcome.ok and outcome.data is not None and outcome.data.kind == "weather"
    assert outcome.summary == "Retrieved current weather for Lagos, Nigeria"


@respx.mock
async def test_tool_failure_is_structured_not_fabricated(client):
    respx.get(WEATHERSTACK_URL).respond(json={"success": False, "error": {"code": 615}})
    tool = build_weather_tool(client)
    message = await tool.ainvoke({"type": "tool_call", "name": "weather", "args": {"city": "Atlantis"}, "id": "c1"})

    content = json.loads(message.content)
    assert content == {
        "ok": False,
        "error": {"code": "city_not_found", "message": "No weather data was found for 'Atlantis'."},
    }
    assert message.artifact.ok is False
    assert message.artifact.data is None
    assert message.artifact.error.code == "city_not_found"
