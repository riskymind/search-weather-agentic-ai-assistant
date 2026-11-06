"""FastAPI dependencies resolving services built at startup (overridable in tests)."""

import hmac
import logging

from fastapi import Request

from app.core.client_ip import FORWARDED_CLIENT_IP_HEADER, parse_ip, resolve_client_ip
from app.core.config import Settings
from app.core.errors import RateLimitedError, UnauthorizedError
from app.core.rate_limit import RateLimiter
from app.services.agent_service import AgentService

logger = logging.getLogger(__name__)


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_agent_service(request: Request) -> AgentService:
    service: AgentService = request.app.state.agent_service
    return service


def has_valid_access_key(request: Request) -> bool:
    """True when API_ACCESS_KEY is configured and the request carries it as a bearer token."""
    settings: Settings = request.app.state.settings
    if settings.api_access_key is None:
        return False
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    expected = settings.api_access_key.get_secret_value().encode()
    return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), expected)


def network_client_ip(request: Request) -> str:
    """The caller's IP as seen at the network boundary (see `app.core.client_ip`)."""
    settings: Settings = request.app.state.settings
    return resolve_client_ip(
        request.client.host if request.client else None,
        request.headers,
        settings.client_ip_header,
        settings.trusted_proxy_networks,
    )


def client_key(request: Request) -> str:
    """Identify the caller for rate limiting.

    The frontend's server-side proxy calls this API for every browser user, so the network
    address is the proxy's. The proxy reports the end user's IP in `X-Client-IP`, which is
    honoured **only** together with a valid access key: anyone without the key cannot choose
    their own rate-limit identity, and their failed attempts are limited by network address.
    """
    if has_valid_access_key(request):
        forwarded = parse_ip(request.headers.get(FORWARDED_CLIENT_IP_HEADER))
        if forwarded:
            return forwarded
    return network_client_ip(request)


async def require_api_access(request: Request) -> None:
    """When API_ACCESS_KEY is configured, require `Authorization: Bearer <key>`."""
    settings: Settings = request.app.state.settings
    if settings.api_access_key is not None and not has_valid_access_key(request):
        raise UnauthorizedError()


async def enforce_rate_limit(request: Request) -> None:
    """Reject the request with 429 when the caller has exceeded its budget."""
    limiter: RateLimiter | None = request.app.state.rate_limiter
    if limiter is None:
        return
    decision = await limiter.hit(client_key(request))
    if not decision.allowed:
        logger.warning("rate_limited", extra={"path": request.url.path, "retry_after": decision.retry_after_seconds})
        raise RateLimitedError(decision.retry_after_seconds)
