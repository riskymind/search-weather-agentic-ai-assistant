"""HTTP-level tests: the real app (lifespan, wiring, tools) with a scripted LLM and mocked providers."""

import json
import uuid

import httpx
import openai
import pytest
import respx
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from app.agents.weather_agent import FinalAnswer
from app.main import create_app
from app.services.agent_service import AgentService
from app.services.session_store import InMemorySessionStore
from tests.conftest import (
    FAKE_OPENAI_KEY,
    FAKE_TAVILY_KEY,
    FAKE_WEATHER_KEY,
    TAVILY_SEARCH_URL,
    WEATHERSTACK_URL,
    FakeRunner,
    ScriptedChatModel,
    make_settings,
    tavily_payload,
    tavily_result,
    tool_call,
    weatherstack_payload,
)

QUERY_URL = "/api/v1/agent/query"
STREAM_URL = "/api/v1/agent/stream"
SECRETS = (FAKE_OPENAI_KEY, FAKE_TAVILY_KEY, FAKE_WEATHER_KEY)


def client_for(*responses, **settings_overrides) -> TestClient:
    app = create_app(make_settings(**settings_overrides), chat_model=ScriptedChatModel(responses=list(responses)))
    return TestClient(app, raise_server_exceptions=False)


def client_with_runner(runner, timeout: float = 5) -> TestClient:
    service = AgentService(runner, InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), timeout)
    return TestClient(create_app(make_settings(), agent_service=service), raise_server_exceptions=False)


def assert_no_secrets(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text


# --- Health & docs ------------------------------------------------------------


def test_health():
    with client_for() as client:
        response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "service": "search-weather-agent",
        "version": "1.0.0",
        "environment": "development",
    }


def test_openapi_docs_available():
    with client_for() as client:
        assert client.get("/docs").status_code == 200
        paths = client.get("/openapi.json").json()["paths"]
    assert {"/api/v1/health", QUERY_URL, STREAM_URL} <= set(paths)


def test_unknown_route_uses_error_envelope():
    with client_for() as client:
        response = client.get("/api/v1/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_startup_fails_fast_without_configuration(capsys):
    with pytest.raises(SystemExit) as exc_info:
        create_app()
    assert exc_info.value.code == 1
    assert "OPENAI_API_KEY: is required but not set" in capsys.readouterr().err


# --- Query endpoint -------------------------------------------------------------


@respx.mock
def test_query_multi_tool_end_to_end():
    respx.post(TAVILY_SEARCH_URL).respond(
        json=tavily_payload(
            tavily_result(
                "Abuja - Wikipedia", "https://en.wikipedia.org/wiki/Abuja", "Abuja is the capital of Nigeria."
            )
        )
    )
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload("Abuja", "Nigeria"))
    responses = [
        tool_call("tavily_search", {"query": "capital of Nigeria"}, "s1"),
        tool_call("weather", {"city": "Abuja"}, "w1"),
        AIMessage(content="The capital of Nigeria is Abuja. It is currently 31°C and partly cloudy."),
    ]
    with client_for(*responses) as client:
        response = client.post(QUERY_URL, json={"message": "Find the capital of Nigeria and tell me its weather"})

    assert response.status_code == 200
    body = response.json()
    uuid.UUID(body["session_id"])
    assert body["is_new_session"] is True
    assert body["answer"].startswith("The capital of Nigeria is Abuja")

    search_event, weather_event = body["tool_events"]
    assert search_event["tool"] == "tavily_search" and search_event["status"] == "completed"
    assert search_event["input"] == {"query": "capital of Nigeria"}
    assert search_event["data"]["kind"] == "search"
    assert search_event["data"]["results"][0]["url"] == "https://en.wikipedia.org/wiki/Abuja"
    assert weather_event["tool"] == "weather" and weather_event["status"] == "completed"
    assert weather_event["summary"] == "Retrieved current weather for Abuja, Nigeria"
    assert {"city", "country", "temperature_c", "description", "humidity", "wind_speed_kmh", "observation_time"} <= set(
        weather_event["data"]
    )
    assert_no_secrets(response.text)


def test_query_direct_answer_has_no_tool_events():
    with client_for(AIMessage(content="Hello! How can I help?")) as client:
        body = client.post(QUERY_URL, json={"message": "Hi"}).json()
    assert body["answer"] == "Hello! How can I help?"
    assert body["tool_events"] == []


@respx.mock
def test_query_tool_failure_is_graceful():
    respx.get(WEATHERSTACK_URL).respond(json={"success": False, "error": {"code": 615}})
    responses = [
        tool_call("weather", {"city": "Atlantis"}, "w1"),
        AIMessage(content="I couldn't find weather data for Atlantis."),
    ]
    with client_for(*responses) as client:
        response = client.post(QUERY_URL, json={"message": "Weather in Atlantis"})
    assert response.status_code == 200
    event = response.json()["tool_events"][0]
    assert event["status"] == "failed"
    assert event["error"]["code"] == "city_not_found"
    assert event["data"] is None


def test_session_continuity():
    runner = FakeRunner([FinalAnswer("ok")])
    with client_with_runner(runner) as client:
        first = client.post(QUERY_URL, json={"message": "Hi"}).json()
        second = client.post(QUERY_URL, json={"message": "Again", "session_id": first["session_id"]}).json()
        unknown = client.post(QUERY_URL, json={"message": "Hi", "session_id": str(uuid.uuid4())}).json()

    assert second["session_id"] == first["session_id"] and second["is_new_session"] is False
    assert [t.content for t in runner.histories[1]] == ["Hi", "ok"]
    assert unknown["is_new_session"] is True and unknown["session_id"] != first["session_id"]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"message": ""},
        {"message": "   "},
        {"message": "x" * 4001},
        {"message": 123},
        {"message": "hi", "session_id": "x" * 65},
        {"message": "hi", "session_id": 42},
    ],
)
def test_invalid_payloads(payload):
    with client_for() as client:
        response = client.post(QUERY_URL, json=payload)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"]
    assert all("input" not in detail for detail in error["details"])


def test_malformed_json_body():
    with client_for() as client:
        response = client.post(QUERY_URL, content=b"{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422


def test_llm_provider_error_returns_502():
    error = openai.AuthenticationError(
        f"Incorrect API key provided: {FAKE_OPENAI_KEY}",
        response=httpx.Response(401, request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions")),
        body=None,
    )
    with client_for(error) as client:
        response = client.post(QUERY_URL, json={"message": "Hi"})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "llm_provider_error"
    assert_no_secrets(response.text)


def test_agent_execution_error_returns_500_without_internals():
    with client_for(RuntimeError("Traceback: system prompt says ...")) as client:
        response = client.post(QUERY_URL, json={"message": "Hi"})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "agent_execution_error"
    assert "system prompt" not in response.text and "Traceback" not in response.text


def test_agent_timeout_returns_504():
    with client_with_runner(FakeRunner([FinalAnswer("late")], delay=0.3), timeout=0.05) as client:
        response = client.post(QUERY_URL, json={"message": "Hi"})
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "agent_timeout"


# --- CORS ---------------------------------------------------------------------------


def _preflight(client: TestClient, origin: str) -> httpx.Response:
    return client.options(QUERY_URL, headers={"Origin": origin, "Access-Control-Request-Method": "POST"})


def test_cors_allows_configured_origin_only():
    with client_for(app_env="production", frontend_url="https://app.vercel.app", allow_public_agent_api=True) as client:
        allowed = _preflight(client, "https://app.vercel.app")
        denied = _preflight(client, "https://evil.example")
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://app.vercel.app"
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


# --- SSE stream ----------------------------------------------------------------------


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for frame in text.strip().split("\n\n"):
        if frame.startswith(":"):
            continue
        fields = dict(line.split(": ", 1) for line in frame.split("\n"))
        events.append((fields["event"], json.loads(fields["data"])))
    return events


@respx.mock
def test_stream_event_structure():
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    responses = [tool_call("weather", {"city": "Lagos"}, "w1"), AIMessage(content="It is 31°C in Lagos.")]
    with (
        client_for(*responses) as client,
        client.stream("POST", STREAM_URL, json={"message": "Weather in Lagos?"}) as r,
    ):
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache"
        text = r.read().decode()

    events = parse_sse(text)
    names = [name for name, _ in events]
    assert names[0] == "session" and names[-1] == "done"
    assert names[:4] == ["session", "status", "tool_start", "tool_end"]
    assert "token" in names
    for name, data in events:
        assert data["event"] == name

    tool_start = events[2][1]
    assert tool_start == {"event": "tool_start", "id": "w1", "tool": "weather", "input": {"city": "Lagos"}}
    tool_end = events[3][1]
    assert tool_end["status"] == "completed" and tool_end["data"]["kind"] == "weather"

    tokens = "".join(data["delta"] for name, data in events if name == "token")
    done = events[-1][1]
    assert tokens == done["answer"] == "It is 31°C in Lagos."
    assert done["session_id"] == events[0][1]["session_id"]
    assert len(done["tool_events"]) == 1
    assert_no_secrets(text)


def test_stream_error_event():
    with (
        client_for(RuntimeError("internal details")) as client,
        client.stream("POST", STREAM_URL, json={"message": "Hi"}) as r,
    ):
        text = r.read().decode()
    events = parse_sse(text)
    assert [name for name, _ in events] == ["session", "status", "error"]
    assert events[-1][1] == {
        "event": "error",
        "code": "agent_execution_error",
        "message": "The assistant could not complete your request. Please try again.",
    }
    assert "internal details" not in text


def test_stream_validation_error_is_json_before_stream():
    with client_for() as client:
        response = client.post(STREAM_URL, json={"message": ""})
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")


# --- Hardening: sessions, rate limits, request size ----------------------------------


@pytest.mark.parametrize("bad_id", ["not-a-uuid", "../../etc/passwd", ""])
def test_malformed_session_id_gets_new_server_session(bad_id):
    with client_for(AIMessage(content="ok")) as client:
        response = client.post(QUERY_URL, json={"message": "Hi", "session_id": bad_id})
    assert response.status_code == 200
    body = response.json()
    assert body["is_new_session"] is True
    assert str(uuid.UUID(body["session_id"])) == body["session_id"] != bad_id


def test_expired_session_gets_new_server_session():
    runner = FakeRunner([FinalAnswer("ok")])
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    service = AgentService(runner, store, 5)
    with TestClient(create_app(make_settings(), agent_service=service)) as client:
        first = client.post(QUERY_URL, json={"message": "Hi"}).json()
        store._sessions[first["session_id"]].last_access -= 3600  # force expiry
        second = client.post(QUERY_URL, json={"message": "Hi", "session_id": first["session_id"]}).json()
    assert second["is_new_session"] is True and second["session_id"] != first["session_id"]


@pytest.mark.parametrize("url", [QUERY_URL, STREAM_URL])
def test_rate_limit_enforced(url):
    runner = FakeRunner([FinalAnswer("ok")])
    service = AgentService(runner, InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), 5)
    app = create_app(
        make_settings(rate_limit_requests=2, rate_limit_window_seconds=30, frontend_url="http://localhost:3000"),
        agent_service=service,
    )
    with TestClient(app) as client:
        statuses = [client.post(url, json={"message": "Hi"}).status_code for _ in range(2)]
        limited = client.post(url, json={"message": "Hi"}, headers={"Origin": "http://localhost:3000"})
        health = client.get("/api/v1/health")

    assert statuses == [200, 200]
    assert limited.status_code == 429
    assert limited.headers["content-type"].startswith("application/json")  # never an SSE stream
    assert limited.json()["error"]["code"] == "rate_limited"
    assert 1 <= int(limited.headers["retry-after"]) <= 30
    assert "retry-after" in limited.headers["access-control-expose-headers"].lower()
    assert health.status_code == 200  # health checks are never rate limited


def test_rate_limit_counts_invalid_requests_too():
    with TestClient(
        create_app(
            make_settings(rate_limit_requests=1),
            agent_service=AgentService(
                FakeRunner(), InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), 5
            ),
        )
    ) as client:
        assert client.post(QUERY_URL, json={}).status_code == 422
        assert client.post(QUERY_URL, json={}).status_code == 429


def test_rate_limit_can_be_disabled():
    with TestClient(
        create_app(
            make_settings(rate_limit_enabled=False, rate_limit_requests=1),
            agent_service=AgentService(
                FakeRunner([FinalAnswer("ok")]), InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), 5
            ),
        )
    ) as client:
        assert [client.post(QUERY_URL, json={"message": "Hi"}).status_code for _ in range(3)] == [200, 200, 200]


def test_request_body_too_large_by_content_length():
    with client_for() as client:
        response = client.post(
            QUERY_URL, content=b'{"message": "' + b"x" * 20_000 + b'"}', headers={"content-type": "application/json"}
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"


def test_request_body_too_large_when_streamed_without_content_length():
    def chunks():
        yield b'{"message": "'
        for _ in range(40):
            yield b"x" * 1_000
        yield b'"}'

    with client_for() as client:
        response = client.post(QUERY_URL, content=chunks(), headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"


def test_request_within_limit_accepted():
    with client_for(AIMessage(content="ok"), max_request_body_bytes=8_192) as client:
        assert client.post(QUERY_URL, json={"message": "x" * 4000}).status_code == 200


@respx.mock
def test_stream_preamble_text_precedes_tool_start_and_is_not_the_answer():
    respx.get(WEATHERSTACK_URL).respond(json=weatherstack_payload())
    responses = [
        tool_call("weather", {"city": "Lagos"}, "w1", preamble="Let me check the weather."),
        AIMessage(content="It is 31°C in Lagos."),
    ]
    with client_for(*responses) as client, client.stream("POST", STREAM_URL, json={"message": "Weather?"}) as r:
        events = parse_sse(r.read().decode())

    names = [name for name, _ in events]
    first_tool = names.index("tool_start")
    preamble = "".join(d["delta"] for n, d in events[:first_tool] if n == "token")
    answer_draft = "".join(d["delta"] for n, d in events[first_tool:] if n == "token")
    assert preamble == "Let me check the weather."
    assert answer_draft == "It is 31°C in Lagos."
    assert events[-1][1]["answer"] == "It is 31°C in Lagos."


def test_session_busy_arrives_as_stream_error_event():
    from app.core.errors import SessionBusyError

    class BusyService:
        async def stream(self, message, session_id):
            raise SessionBusyError()
            yield  # pragma: no cover

    app = create_app(make_settings(), agent_service=BusyService())  # type: ignore[arg-type]
    with TestClient(app) as client, client.stream("POST", STREAM_URL, json={"message": "Hi"}) as r:
        events = parse_sse(r.read().decode())
    assert events == [("error", {"event": "error", "code": "session_busy", "message": SessionBusyError.message})]


# --- Access control and client IP ----------------------------------------------------

ACCESS_KEY = "a" * 40


def test_access_key_required_when_configured():
    with client_for(AIMessage(content="ok"), AIMessage(content="ok"), api_access_key=ACCESS_KEY) as client:
        missing = client.post(QUERY_URL, json={"message": "Hi"})
        wrong = client.post(QUERY_URL, json={"message": "Hi"}, headers={"Authorization": "Bearer " + "b" * 40})
        ok = client.post(QUERY_URL, json={"message": "Hi"}, headers={"Authorization": f"Bearer {ACCESS_KEY}"})
        stream_missing = client.post(STREAM_URL, json={"message": "Hi"})
        health = client.get("/api/v1/health")
    assert missing.status_code == 401 and wrong.status_code == 401 and stream_missing.status_code == 401
    assert missing.json()["error"]["code"] == "unauthorized"
    assert missing.headers["www-authenticate"] == "Bearer"
    assert ok.status_code == 200
    assert health.status_code == 200  # platform health checks need no key
    assert ACCESS_KEY not in missing.text


def test_failed_auth_attempts_are_rate_limited():
    with client_for(api_access_key=ACCESS_KEY, rate_limit_requests=2) as client:
        codes = [client.post(QUERY_URL, json={"message": "Hi"}).status_code for _ in range(3)]
    assert codes == [401, 401, 429]


def test_rate_limit_uses_trusted_client_ip_header():
    # TestClient's peer is "testclient" (not an IP), so trust is exercised via a peer override.
    runner = FakeRunner([FinalAnswer("ok")])
    service = AgentService(runner, InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), 5)
    app = create_app(
        make_settings(rate_limit_requests=1, client_ip_header="True-Client-IP", trusted_proxy_cidrs="10.0.0.0/8"),
        agent_service=service,
    )
    with TestClient(app, client=("10.0.0.5", 1234)) as client:
        a1 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"True-Client-IP": "203.0.113.1"})
        b1 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"True-Client-IP": "203.0.113.2"})
        a2 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"True-Client-IP": "203.0.113.1"})
        spoof = client.post(
            QUERY_URL, json={"message": "Hi"}, headers={"True-Client-IP": "203.0.113.1", "X-Forwarded-For": "9.9.9.9"}
        )
    assert (a1.status_code, b1.status_code, a2.status_code, spoof.status_code) == (200, 200, 429, 429)


def _proxy_app(**overrides):
    runner = FakeRunner([FinalAnswer("ok")] * 10)
    service = AgentService(runner, InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10), 5)
    settings = {"rate_limit_requests": 1, "api_access_key": ACCESS_KEY, **overrides}
    return create_app(make_settings(**settings), agent_service=service)


AUTH = {"Authorization": f"Bearer {ACCESS_KEY}"}


def test_forwarded_end_user_ip_is_trusted_only_with_a_valid_key():
    # Every request comes from the same network peer (the frontend proxy).
    with TestClient(_proxy_app(), client=("198.51.100.10", 1234)) as client:
        user_a = client.post(QUERY_URL, json={"message": "Hi"}, headers={**AUTH, "X-Client-IP": "203.0.113.1"})
        user_b = client.post(QUERY_URL, json={"message": "Hi"}, headers={**AUTH, "X-Client-IP": "203.0.113.2"})
        user_a_again = client.post(QUERY_URL, json={"message": "Hi"}, headers={**AUTH, "X-Client-IP": "203.0.113.1"})
        # Without the key, X-Client-IP is ignored: the attacker is limited by network address.
        spoof_1 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"X-Client-IP": "203.0.113.50"})
        spoof_2 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"X-Client-IP": "203.0.113.51"})
    assert (user_a.status_code, user_b.status_code, user_a_again.status_code) == (200, 200, 429)
    assert (spoof_1.status_code, spoof_2.status_code) == (401, 429)


def test_spoofed_forwarding_headers_do_not_change_identity():
    # Direct internet peer (untrusted): CF-Connecting-IP, True-Client-IP and X-Forwarded-For are ignored.
    app = _proxy_app(client_ip_header="CF-Connecting-IP", trusted_proxy_cidrs="10.0.0.0/8")
    with TestClient(app, client=("198.51.100.4", 1234)) as client:
        codes = [
            client.post(QUERY_URL, json={"message": "Hi"}, headers={header: f"203.0.113.{i}"}).status_code
            for i, header in enumerate(("CF-Connecting-IP", "True-Client-IP", "X-Forwarded-For"))
        ]
    assert codes == [401, 429, 429]


def test_cf_connecting_ip_from_trusted_proxy_identifies_clients():
    app = _proxy_app(client_ip_header="CF-Connecting-IP", trusted_proxy_cidrs="10.0.0.0/8", api_access_key=None)
    with TestClient(app, client=("10.0.0.5", 1234)) as client:
        a1 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"CF-Connecting-IP": "203.0.113.1"})
        b1 = client.post(QUERY_URL, json={"message": "Hi"}, headers={"CF-Connecting-IP": "203.0.113.2"})
        # A different header does not change the identity of a client already limited.
        a2 = client.post(
            QUERY_URL,
            json={"message": "Hi"},
            headers={"CF-Connecting-IP": "203.0.113.1", "True-Client-IP": "9.9.9.9", "X-Forwarded-For": "9.9.9.9"},
        )
    assert (a1.status_code, b1.status_code, a2.status_code) == (200, 200, 429)


DIAG_URL = "/api/v1/diagnostics/client-ip"


def test_client_ip_diagnostics_hidden_unless_enabled_with_a_key():
    with TestClient(_proxy_app(rate_limit_requests=10)) as client:
        assert client.get(DIAG_URL, headers=AUTH).status_code == 404
    with TestClient(_proxy_app(client_ip_diagnostics=True, api_access_key=None, rate_limit_requests=10)) as client:
        assert client.get(DIAG_URL).status_code == 404
    assert DIAG_URL not in create_app(make_settings()).openapi()["paths"]


def test_client_ip_diagnostics_reports_the_callers_request():
    app = _proxy_app(
        client_ip_diagnostics=True,
        client_ip_header="CF-Connecting-IP",
        trusted_proxy_cidrs="10.0.0.0/8",
        rate_limit_requests=10,
    )
    headers = {**AUTH, "CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "6.6.6.6, 203.0.113.9"}
    with TestClient(app, client=("10.0.0.5", 1234)) as client:
        assert client.get(DIAG_URL).status_code == 401
        body = client.get(DIAG_URL, headers=headers).json()
    assert body["peer"] == "10.0.0.5" and body["peer_trusted"] is True
    assert body["configured_header"] == "cf-connecting-ip"
    assert body["headers"]["x-forwarded-for"] == "6.6.6.6, 203.0.113.9"
    assert body["network_client_ip"] == "203.0.113.9"
    assert body["rate_limit_key"] == "203.0.113.9"
    assert ACCESS_KEY not in json.dumps(body)
