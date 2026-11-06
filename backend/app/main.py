"""Application factory and composition root.

Run with:  uvicorn --factory app.main:create_app
Configuration is validated when the factory runs, so a misconfigured deployment
fails at startup with a readable list of problems.
"""

import logging
import sys
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.language_models import BaseChatModel
from tavily import AsyncTavilyClient

from app.agents.weather_agent import AgentRunner, build_chat_model
from app.api.v1.router import api_router
from app.core.config import SERVICE_NAME, SERVICE_VERSION, ConfigurationError, Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.middleware import BodySizeLimitMiddleware
from app.core.rate_limit import InMemoryRateLimiter, RateLimiter
from app.services.agent_service import AgentService
from app.services.session_store import InMemorySessionStore
from app.tools.search_tool import TavilySearchClient, build_search_tool
from app.tools.weather_tool import WeatherstackClient, build_weather_tool

logger = logging.getLogger(__name__)


async def build_agent_service(
    settings: Settings, stack: AsyncExitStack, model: BaseChatModel | None = None
) -> AgentService:
    """Wire providers, tools, agent and session store. HTTP clients close with `stack`.

    `model` overrides the configured OpenAI chat model (used by tests).
    """
    # Separate clients per provider: the Tavily SDK writes its bearer token into the
    # client's default headers, which must never be sent to another provider.
    weather_http = await stack.enter_async_context(
        httpx.AsyncClient(timeout=httpx.Timeout(settings.weather_timeout_seconds, connect=5.0))
    )
    tavily_http = await stack.enter_async_context(
        httpx.AsyncClient(timeout=httpx.Timeout(settings.tavily_timeout_seconds, connect=5.0))
    )

    weather_client = WeatherstackClient(weather_http, settings.weather_api_key, settings.weather_api_base_url)
    search_client = TavilySearchClient(
        AsyncTavilyClient(api_key=settings.tavily_api_key.get_secret_value(), client=tavily_http),
        max_results=settings.tavily_max_results,
        timeout_seconds=settings.tavily_timeout_seconds,
    )
    tools = [build_search_tool(search_client), build_weather_tool(weather_client)]

    runner = AgentRunner(model or build_chat_model(settings), tools, max_steps=settings.agent_max_steps)
    sessions = InMemorySessionStore(
        ttl_seconds=settings.session_ttl_seconds,
        max_sessions=settings.session_max_count,
        max_turns=settings.session_max_turns,
    )
    return AgentService(runner, sessions, timeout_seconds=settings.agent_timeout_seconds)


def create_app(
    settings: Settings | None = None,
    agent_service: AgentService | None = None,
    chat_model: BaseChatModel | None = None,
    rate_limiter: RateLimiter | None = None,
) -> FastAPI:
    """Build the FastAPI application.

    `settings`, `agent_service`, `chat_model` and `rate_limiter` allow injecting test
    doubles; in production all are built from the environment.
    """
    if settings is None:
        try:
            settings = get_settings()
        except ConfigurationError as exc:
            # Readable startup failure without a traceback (which could include env details).
            print(f"[{SERVICE_NAME}] {exc}", file=sys.stderr)
            raise SystemExit(1) from None

    configure_logging(
        settings.log_level,
        json_output=settings.is_production,
        secrets=[
            settings.openai_api_key.get_secret_value(),
            settings.tavily_api_key.get_secret_value(),
            settings.weather_api_key.get_secret_value(),
            settings.api_access_key.get_secret_value() if settings.api_access_key else "",
        ],
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            app.state.agent_service = agent_service or await build_agent_service(settings, stack, chat_model)
            logger.info(
                "startup_complete",
                extra={
                    "rate_limit": (
                        f"{settings.rate_limit_requests}/{settings.rate_limit_window_seconds}s"
                        if settings.rate_limit_enabled
                        else "disabled"
                    ),
                    "environment": settings.app_env,
                    "model": settings.openai_model,
                    "cors_origins": settings.cors_origins,
                    "agent_auth": "api_key" if settings.api_access_key else "none",
                    "client_ip_header": settings.client_ip_header or "(socket peer)",
                },
            )
            if settings.api_access_key is None:
                logger.warning(
                    "agent_endpoints_unauthenticated",
                    extra={"detail": "Anyone who can reach /api/v1/agent/* can spend provider credits."},
                )
            yield
        logger.info("shutdown_complete")

    app = FastAPI(
        title="Search + Weather Agent API",
        version=SERVICE_VERSION,
        description="Agentic AI assistant backend: web search (Tavily) and current weather (Weatherstack).",
        lifespan=lifespan,
    )
    app.state.settings = settings
    if rate_limiter is None and settings.rate_limit_enabled:
        rate_limiter = InMemoryRateLimiter(
            limit=settings.rate_limit_requests,
            window_seconds=settings.rate_limit_window_seconds,
            max_clients=settings.rate_limit_max_clients,
        )
    app.state.rate_limiter = rate_limiter

    # Added first = innermost; CORS is outermost so error responses also carry CORS headers.
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_body_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept", "Authorization"],
        expose_headers=["Retry-After"],
    )
    register_exception_handlers(app)
    app.include_router(api_router)
    return app
