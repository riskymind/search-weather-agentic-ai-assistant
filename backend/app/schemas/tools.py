"""Structured tool outputs.

These models are returned as LangChain tool *artifacts* and surfaced to clients
in `ToolEvent.data`, so the frontend can render weather and source cards without
parsing prose.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

ToolErrorCode = Literal["invalid_input", "city_not_found", "not_configured", "provider_error", "timeout"]


class ToolError(BaseModel):
    code: ToolErrorCode
    message: str


class WeatherData(BaseModel):
    kind: Literal["weather"] = "weather"
    city: str
    country: str
    region: str | None = None
    temperature_c: float
    feels_like_c: float | None = None
    description: str
    humidity: int
    wind_speed_kmh: float
    observation_time: str
    local_time: str | None = None
    icon_url: str | None = None


class SearchResult(BaseModel):
    title: str
    url: str
    content: str
    score: float | None = None


class SearchResults(BaseModel):
    kind: Literal["search"] = "search"
    query: str
    results: list[SearchResult]


ToolData = Annotated[WeatherData | SearchResults, Field(discriminator="kind")]


class ToolOutcome(BaseModel):
    """What a tool hands back to the service alongside the text the LLM sees."""

    ok: bool
    summary: str
    data: ToolData | None = None
    error: ToolError | None = None
