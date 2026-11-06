"""Application configuration loaded from environment variables (and an optional `.env`).

Configuration is validated once at startup. Any missing or invalid value raises
`ConfigurationError` with a readable list of problems; secret values are never
included in the message.
"""

import re
from functools import lru_cache
from ipaddress import IPv4Network, IPv6Network, ip_network
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_NAME = "search-weather-agent"
SERVICE_VERSION = "1.0.0"

DEV_FRONTEND_URL = "http://localhost:3000"


class ConfigurationError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


def _validate_origin(origin: str) -> str:
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"'{origin}' is not a valid http(s) origin")
    if "*" in origin:
        raise ValueError("wildcard origins are not allowed")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError(f"'{origin}' must be an origin only (scheme://host[:port]), without a path")
    return f"{parts.scheme}://{parts.netloc}"


class Settings(BaseSettings):
    """Typed application settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Secrets (required)
    openai_api_key: SecretStr
    tavily_api_key: SecretStr
    weather_api_key: SecretStr

    # LLM
    openai_model: str = Field(default="gpt-4o-mini", min_length=1)
    openai_timeout_seconds: float = Field(default=30.0, gt=0, le=120)

    # Application
    app_env: Literal["development", "production"] = "development"
    # Comma-separated list of exact origins allowed by CORS. Required in production.
    frontend_url: str | None = Field(default=None, validate_default=True)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    # Providers
    weather_api_base_url: str = "https://api.weatherstack.com"
    weather_timeout_seconds: float = Field(default=10.0, gt=0, le=60)
    tavily_max_results: int = Field(default=3, ge=1, le=10)
    tavily_timeout_seconds: float = Field(default=15.0, gt=0, le=60)

    # Agent bounds
    agent_max_steps: int = Field(default=10, ge=2, le=50)
    agent_timeout_seconds: float = Field(default=60.0, gt=0, le=300)

    # Abuse protection (in-memory, per process)
    rate_limit_enabled: bool = True
    rate_limit_requests: int = Field(default=20, ge=1, le=10_000)
    rate_limit_window_seconds: int = Field(default=60, ge=1, le=86_400)
    rate_limit_max_clients: int = Field(default=10_000, ge=1)
    max_request_body_bytes: int = Field(default=16_384, ge=1_024, le=1_048_576)

    # Access control for the agent endpoints (see "Security and limits" in README.md).
    # When set, /agent/* requires `Authorization: Bearer <API_ACCESS_KEY>`.
    api_access_key: SecretStr | None = None
    # Production refuses to start with unauthenticated agent endpoints unless this is set explicitly.
    allow_public_agent_api: bool = Field(default=False, validate_default=True)

    # Client identification behind a reverse proxy (used for rate limiting).
    # CLIENT_IP_HEADER is honoured only when the direct peer is in TRUSTED_PROXY_CIDRS.
    client_ip_header: str | None = None
    trusted_proxy_cidrs: str = "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7"
    # Enables GET /api/v1/diagnostics/client-ip (requires API_ACCESS_KEY) to verify the
    # platform's forwarding headers after a deployment. Keep it off otherwise.
    client_ip_diagnostics: bool = False

    # Sessions (in-memory)
    session_ttl_seconds: int = Field(default=3600, ge=60)
    session_max_count: int = Field(default=500, ge=1)
    session_max_turns: int = Field(default=20, ge=2, le=200)

    @field_validator("openai_api_key", "tavily_api_key", "weather_api_key")
    @classmethod
    def _secret_not_blank(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("must not be empty")
        return value

    @field_validator("log_level", mode="before")
    @classmethod
    def _upper_log_level(cls, value: object) -> object:
        return value.upper() if isinstance(value, str) else value

    @field_validator("weather_api_base_url")
    @classmethod
    def _require_https(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme != "https" or not parts.netloc:
            raise ValueError(
                "must be an https:// URL; API credentials are never sent over plain HTTP "
                "(the Weatherstack subscription must support HTTPS)"
            )
        return value.rstrip("/")

    @field_validator("frontend_url")
    @classmethod
    def _validate_frontend_url(cls, value: str | None, info: ValidationInfo) -> str | None:
        # A field validator (not a model validator) so this is reported together with every
        # other configuration error. `app_env` is declared earlier, so it is already in `info.data`.
        if value is None or not value.strip():
            if info.data.get("app_env") == "production":
                raise ValueError("is required when APP_ENV=production")
            return None
        origins = [_validate_origin(o.strip()) for o in value.split(",") if o.strip()]
        return ",".join(origins)

    @field_validator("api_access_key")
    @classmethod
    def _strong_access_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None or not value.get_secret_value():
            return None
        if len(value.get_secret_value()) < 32:
            raise ValueError("must be at least 32 characters (e.g. `openssl rand -hex 32`)")
        return value

    @field_validator("allow_public_agent_api")
    @classmethod
    def _no_accidental_public_api(cls, value: bool, info: ValidationInfo) -> bool:
        if info.data.get("app_env") == "production" and not info.data.get("api_access_key") and not value:
            raise ValueError(
                "the agent endpoints would be publicly accessible without authentication in production; "
                "set API_ACCESS_KEY, or set ALLOW_PUBLIC_AGENT_API=true to accept that risk explicitly"
            )
        return value

    @field_validator("client_ip_header")
    @classmethod
    def _valid_header_name(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        if not re.fullmatch(r"[A-Za-z0-9-]+", value.strip()):
            raise ValueError("must be an HTTP header name, e.g. CF-Connecting-IP")
        return value.strip().lower()

    @field_validator("trusted_proxy_cidrs")
    @classmethod
    def _valid_networks(cls, value: str) -> str:
        try:
            networks = [ip_network(part.strip(), strict=False) for part in value.split(",") if part.strip()]
        except ValueError as exc:
            raise ValueError(f"must be a comma-separated list of IP networks ({exc})") from None
        return ",".join(str(n) for n in networks)

    @property
    def trusted_proxy_networks(self) -> list[IPv4Network | IPv6Network]:
        return [ip_network(part) for part in self.trusted_proxy_cidrs.split(",") if part]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origins(self) -> list[str]:
        """Exact origins allowed by CORS."""
        return (self.frontend_url or DEV_FRONTEND_URL).split(",")


def _format_validation_error(exc: ValidationError) -> str:
    lines = []
    for error in exc.errors(include_input=False, include_url=False):
        field = ".".join(str(part) for part in error["loc"]).upper() or "SETTINGS"
        message = "is required but not set" if error["type"] == "missing" else error["msg"]
        lines.append(f"  - {field}: {message}")
    return "Invalid configuration:\n" + "\n".join(lines)


def load_settings(**overrides: object) -> Settings:
    """Build and validate settings, converting validation failures into `ConfigurationError`."""
    try:
        return Settings(**overrides)  # type: ignore[arg-type]
    except ValidationError as exc:
        raise ConfigurationError(_format_validation_error(exc)) from None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, validated on first use."""
    return load_settings()
