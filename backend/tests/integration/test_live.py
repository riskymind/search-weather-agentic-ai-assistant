"""Optional smoke tests against the real providers.

Skipped by default. Run with real keys in `backend/.env`:

    uv run pytest -m live
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import ConfigurationError, load_settings
from app.main import create_app

pytestmark = pytest.mark.live

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


@pytest.fixture
def live_client():
    try:
        settings = load_settings(_env_file=ENV_FILE)
    except ConfigurationError as exc:
        pytest.skip(f"live credentials not configured: {exc}")
    with TestClient(create_app(settings)) as client:
        yield client


def test_live_weather(live_client):
    body = live_client.post("/api/v1/agent/query", json={"message": "What's the current weather in Lagos?"}).json()
    weather = [e for e in body["tool_events"] if e["tool"] == "weather"]
    assert weather, body
    assert weather[0]["status"] == "completed", weather[0]


def test_live_search_then_weather(live_client):
    body = live_client.post(
        "/api/v1/agent/query", json={"message": "Find the capital of Kenya and tell me its current weather."}
    ).json()
    tools = [e["tool"] for e in body["tool_events"]]
    assert "tavily_search" in tools and "weather" in tools, body
    assert "Nairobi" in body["answer"]
