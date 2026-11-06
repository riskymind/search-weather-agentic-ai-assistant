"""Current-weather tool backed by Weatherstack.

`WeatherstackClient` is a plain async client (testable without LangChain);
`build_weather_tool` wraps it as a LangChain tool that returns a compact JSON
string for the LLM plus a structured `ToolOutcome` artifact for the UI.

Weatherstack only accepts the API key as an `access_key` query parameter, so
request URLs are secrets: they are never logged or included in error messages.
"""

import logging
import re

import httpx
from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field, SecretStr, ValidationError

from app.schemas.tools import ToolError, ToolOutcome, WeatherData
from app.tools.common import ToolFailure, llm_content

logger = logging.getLogger(__name__)

WEATHER_TOOL_NAME = "weather"
MAX_CITY_LENGTH = 100

# Letters (any script) separated by spaces or . , ' (straight or curly) - ; e.g. "São Paulo", "St. John's".
_CITY_PATTERN = re.compile(r"[^\W\d_]+(?:[ .,'\u2019\-]+[^\W\d_]+)*\.?")

# https://weatherstack.com/documentation#api_error_codes
_NOT_FOUND_CODES = {615}
_CREDENTIAL_CODES = {101, 102}
_HTTPS_RESTRICTED_CODE = 105


def validate_city(city: str) -> str:
    """Normalise and validate a city name, raising `ToolFailure(invalid_input)`."""
    cleaned = " ".join(city.split())
    if not cleaned:
        raise ToolFailure("invalid_input", "A city name is required.")
    if len(cleaned) > MAX_CITY_LENGTH:
        raise ToolFailure("invalid_input", f"City names must be at most {MAX_CITY_LENGTH} characters.")
    if not _CITY_PATTERN.fullmatch(cleaned):
        raise ToolFailure("invalid_input", f"'{cleaned}' is not a valid city name.")
    return cleaned


class _Location(BaseModel):
    name: str
    country: str
    region: str | None = None
    localtime: str | None = None


class _Current(BaseModel):
    observation_time: str
    temperature: float
    feelslike: float | None = None
    weather_descriptions: list[str] = Field(min_length=1)
    weather_icons: list[str] = Field(default_factory=list)
    humidity: int
    wind_speed: float


class _WeatherstackResponse(BaseModel):
    location: _Location
    current: _Current


class WeatherstackClient:
    """Async client for Weatherstack's `/current` endpoint (metric units)."""

    def __init__(self, http: httpx.AsyncClient, api_key: SecretStr, base_url: str) -> None:
        self._http = http
        self._api_key = api_key
        self._url = f"{base_url.rstrip('/')}/current"

    async def get_current(self, city: str) -> WeatherData:
        """Return current weather for `city`, or raise `ToolFailure`."""
        city = validate_city(city)
        params = {"access_key": self._api_key.get_secret_value(), "query": city, "units": "m"}
        try:
            response = await self._http.get(self._url, params=params)
        except httpx.TimeoutException:
            logger.warning("weather_provider_timeout", extra={"city": city})
            raise ToolFailure("timeout", "The weather service timed out.") from None
        except httpx.HTTPError as exc:
            logger.warning("weather_provider_unreachable", extra={"city": city, "error_type": type(exc).__name__})
            raise ToolFailure("provider_error", "The weather service is unreachable.") from None

        if response.status_code != 200:
            logger.warning("weather_provider_http_error", extra={"city": city, "status_code": response.status_code})
            raise ToolFailure("provider_error", "The weather service returned an error.")

        try:
            body = response.json()
        except ValueError:
            logger.warning("weather_provider_malformed", extra={"city": city, "reason": "non_json"})
            raise ToolFailure("provider_error", "The weather service returned a malformed response.") from None

        if not isinstance(body, dict):
            raise ToolFailure("provider_error", "The weather service returned a malformed response.")
        if body.get("success") is False or "error" in body:
            raise self._map_provider_error(body.get("error"), city)

        try:
            parsed = _WeatherstackResponse.model_validate(body)
        except ValidationError:
            logger.warning("weather_provider_malformed", extra={"city": city, "reason": "schema"})
            raise ToolFailure("provider_error", "The weather service returned a malformed response.") from None

        loc, cur = parsed.location, parsed.current
        return WeatherData(
            city=loc.name,
            country=loc.country,
            region=loc.region or None,
            temperature_c=cur.temperature,
            feels_like_c=cur.feelslike,
            description=cur.weather_descriptions[0],
            humidity=cur.humidity,
            wind_speed_kmh=cur.wind_speed,
            observation_time=cur.observation_time,
            local_time=loc.localtime,
            icon_url=next((u for u in cur.weather_icons if u.startswith("https://")), None),
        )

    @staticmethod
    def _map_provider_error(error: object, city: str) -> ToolFailure:
        code = error.get("code") if isinstance(error, dict) else None
        logger.warning("weather_provider_error", extra={"city": city, "provider_code": code})
        if code in _NOT_FOUND_CODES:
            return ToolFailure("city_not_found", f"No weather data was found for '{city}'.")
        if code in _CREDENTIAL_CODES:
            return ToolFailure("not_configured", "The weather service credentials are invalid or inactive.")
        if code == _HTTPS_RESTRICTED_CODE:
            return ToolFailure(
                "not_configured",
                "The weather service subscription does not support HTTPS, which this application requires.",
            )
        return ToolFailure("provider_error", "The weather service could not process the request.")


class WeatherInput(BaseModel):
    city: str = Field(
        description="City name only, e.g. 'Lagos' or 'Nairobi'. Optionally add the country: 'Paris, France'."
    )


def build_weather_tool(client: WeatherstackClient) -> BaseTool:
    """Wrap a `WeatherstackClient` as the agent's `weather` tool."""

    @tool(WEATHER_TOOL_NAME, args_schema=WeatherInput, response_format="content_and_artifact")
    async def weather(city: str) -> tuple[str, ToolOutcome]:
        """Get the CURRENT weather (temperature in °C, conditions, humidity, wind) for a city.
        Use this for any question about current weather. If you only know a country or a
        description (e.g. "the capital of Kenya"), find the city name first."""
        try:
            data = await client.get_current(city)
        except ToolFailure as failure:
            error = ToolError(code=failure.code, message=failure.message)
            outcome = ToolOutcome(
                ok=False,
                summary=f"Could not retrieve weather for {city.strip() or 'the requested city'}",
                error=error,
            )
            return llm_content({"ok": False, "error": error.model_dump()}), outcome

        place = f"{data.city}, {data.country}" if data.country else data.city
        outcome = ToolOutcome(ok=True, summary=f"Retrieved current weather for {place}", data=data)
        return llm_content({"ok": True, "weather": data.model_dump(exclude={"kind", "icon_url"})}), outcome

    return weather
