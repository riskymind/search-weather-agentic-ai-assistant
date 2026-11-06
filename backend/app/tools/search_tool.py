"""Web search tool backed by Tavily.

`TavilySearchClient` adapts Tavily's async SDK into structured `SearchResults`
(testable without LangChain); `build_search_tool` wraps it as the agent's
`tavily_search` tool.
"""

import asyncio
import logging

import httpx
from langchain_core.tools import BaseTool, tool
from pydantic import BaseModel, Field
from tavily import AsyncTavilyClient
from tavily.errors import (
    BadRequestError,
    ForbiddenError,
    InvalidAPIKeyError,
    MissingAPIKeyError,
    UsageLimitExceededError,
)
from tavily.errors import TimeoutError as TavilyTimeoutError

from app.schemas.tools import SearchResult, SearchResults, ToolError, ToolOutcome
from app.tools.common import ToolFailure, llm_content

logger = logging.getLogger(__name__)

SEARCH_TOOL_NAME = "tavily_search"
MAX_QUERY_LENGTH = 400
MAX_SNIPPET_CHARS = 500


def _snippet(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= MAX_SNIPPET_CHARS else text[: MAX_SNIPPET_CHARS - 1].rstrip() + "…"


class TavilySearchClient:
    """Structured wrapper around `AsyncTavilyClient.search`."""

    def __init__(self, client: AsyncTavilyClient, max_results: int, timeout_seconds: float) -> None:
        self._client = client
        self._max_results = max_results
        self._timeout = timeout_seconds

    async def search(self, query: str) -> SearchResults:
        """Search the web for `query`, or raise `ToolFailure`."""
        query = " ".join(query.split())
        if not query:
            raise ToolFailure("invalid_input", "A search query is required.")
        if len(query) > MAX_QUERY_LENGTH:
            raise ToolFailure("invalid_input", f"Search queries must be at most {MAX_QUERY_LENGTH} characters.")

        try:
            raw = await asyncio.wait_for(
                self._client.search(
                    query,
                    max_results=self._max_results,
                    search_depth="basic",
                    timeout=self._timeout,
                ),
                timeout=self._timeout + 1,
            )
        except (TavilyTimeoutError, TimeoutError, httpx.TimeoutException):
            logger.warning("search_provider_timeout")
            raise ToolFailure("timeout", "The web search service timed out.") from None
        except (InvalidAPIKeyError, MissingAPIKeyError, ForbiddenError):
            logger.error("search_provider_credentials_rejected")
            raise ToolFailure("not_configured", "The web search service credentials were rejected.") from None
        except UsageLimitExceededError:
            logger.warning("search_provider_usage_limit")
            raise ToolFailure("provider_error", "The web search service usage limit was reached.") from None
        except BadRequestError:
            raise ToolFailure("invalid_input", "The web search service rejected the query.") from None
        except Exception as exc:  # SDK may raise httpx errors or others; never leak details
            logger.warning("search_provider_error", extra={"error_type": type(exc).__name__})
            raise ToolFailure("provider_error", "The web search service is unavailable.") from None

        items = raw.get("results") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            logger.warning("search_provider_malformed")
            raise ToolFailure("provider_error", "The web search service returned a malformed response.")

        results: list[SearchResult] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "")
            if not url.startswith(("https://", "http://")):
                continue
            score = item.get("score")
            results.append(
                SearchResult(
                    title=_snippet(str(item.get("title") or url))[:200],
                    url=url,
                    content=_snippet(str(item.get("content") or "")),
                    score=float(score) if isinstance(score, int | float) else None,
                )
            )
        return SearchResults(query=query, results=results)


class SearchInput(BaseModel):
    query: str = Field(description="A focused natural-language web search query.")


def build_search_tool(client: TavilySearchClient) -> BaseTool:
    """Wrap a `TavilySearchClient` as the agent's `tavily_search` tool."""

    @tool(SEARCH_TOOL_NAME, args_schema=SearchInput, response_format="content_and_artifact")
    async def tavily_search(query: str) -> tuple[str, ToolOutcome]:
        """Search the web for current or factual information (news, people, places, events,
        recent developments). Returns titles, URLs and content snippets."""
        try:
            data = await client.search(query)
        except ToolFailure as failure:
            error = ToolError(code=failure.code, message=failure.message)
            outcome = ToolOutcome(
                ok=False,
                summary="Web search failed",
                error=error,
            )
            return llm_content({"ok": False, "error": error.model_dump()}), outcome

        if not data.results:
            outcome = ToolOutcome(ok=True, summary=f'No results found for "{data.query}"', data=data)
            return llm_content({"ok": True, "results": []}), outcome

        count = len(data.results)
        outcome = ToolOutcome(
            ok=True,
            summary=f'Found {count} result{"s" if count != 1 else ""} for "{data.query}"',
            data=data,
        )
        results = [r.model_dump(exclude={"score"}) for r in data.results]
        return llm_content({"ok": True, "results": results}), outcome

    return tavily_search
