"""Per-client rate limiting for the agent endpoints.

v1 uses an in-memory sliding-window log, which means:

- limits are **per process** (each worker or instance counts separately) and reset on restart;
- clients are identified by IP address. Behind a reverse proxy (Render, Vercel, nginx) uvicorn
  must run with `--proxy-headers` and `FORWARDED_ALLOW_IPS` set to the proxy, otherwise every
  request appears to come from the proxy and shares one budget;
- users behind the same NAT share a budget;
- at most `max_clients` clients are tracked (least recently seen are forgotten first).

This is abuse protection, not access control. A shared store (e.g. Redis) can replace it by
implementing `RateLimiter`.
"""

import math
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    limit: int
    remaining: int
    retry_after_seconds: int = 0


class RateLimiter(Protocol):
    async def hit(self, key: str) -> RateLimitDecision:
        """Record one request for `key` and say whether it is allowed."""
        ...


class InMemoryRateLimiter:
    """Allow `limit` requests per `window_seconds` per key (sliding window)."""

    def __init__(
        self,
        limit: int,
        window_seconds: float,
        max_clients: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._max_clients = max_clients
        self._clock = clock
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()

    async def hit(self, key: str) -> RateLimitDecision:
        # No awaits inside: atomic with respect to the event loop, so no lock is needed.
        now = self._clock()
        hits = self._hits.get(key)
        if hits is None:
            hits = self._hits[key] = deque()
            while len(self._hits) > self._max_clients:
                self._hits.popitem(last=False)
        self._hits.move_to_end(key)

        while hits and hits[0] <= now - self._window:
            hits.popleft()

        if len(hits) >= self._limit:
            retry_after = max(1, math.ceil(hits[0] + self._window - now))
            return RateLimitDecision(allowed=False, limit=self._limit, remaining=0, retry_after_seconds=retry_after)

        hits.append(now)
        return RateLimitDecision(allowed=True, limit=self._limit, remaining=self._limit - len(hits))
