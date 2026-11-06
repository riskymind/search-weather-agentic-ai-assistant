"""Conversation session storage.

`SessionStore` is the seam for persistence: the v1 implementation keeps sessions
in process memory, so **they disappear when the server restarts** and are not
shared between workers. A Redis or PostgreSQL implementation only needs to
satisfy this protocol; the agent itself is stateless and unaffected.

Session IDs are always generated here (UUID4). Client-supplied IDs are only
looked up, never adopted, so a client cannot create or choose a session ID.

Only one turn may run per session at a time (`lock`); a concurrent request for a busy
session is rejected with `SessionBusyError` rather than queued, so two requests can
never interleave reads and writes of the same history. The in-memory lock only
covers one process; a shared store would need a distributed lock (e.g. Redis SET NX
with an expiry).
"""

import asyncio
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from typing import Protocol

from app.core.errors import SessionBusyError
from app.schemas.conversation import ChatTurn


@dataclass
class Session:
    id: str
    turns: list[ChatTurn] = field(default_factory=list)
    last_access: float = 0.0


class SessionStore(Protocol):
    async def get_or_create(self, session_id: str | None) -> tuple[Session, bool]:
        """Return `(session, is_new)`. Unknown or expired IDs yield a brand-new session."""
        ...

    def lock(self, session_id: str) -> AbstractAsyncContextManager[None]:
        """Hold exclusive use of a session for one turn. Raises `SessionBusyError` if already held."""
        ...

    async def get_turns(self, session_id: str) -> list[ChatTurn]:
        """Return a copy of the session's history (empty if unknown)."""
        ...

    async def append_turns(self, session_id: str, turns: Sequence[ChatTurn]) -> None:
        """Append turns to a session's history (trimmed to the configured maximum)."""
        ...


class InMemorySessionStore:
    """LRU + idle-TTL session store held in process memory."""

    def __init__(
        self,
        ttl_seconds: int,
        max_sessions: int,
        max_turns: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl_seconds
        self._max_sessions = max_sessions
        self._max_turns = max_turns
        self._clock = clock
        self._sessions: OrderedDict[str, Session] = OrderedDict()
        self._busy: set[str] = set()
        self._lock = asyncio.Lock()

    def _expired(self, session: Session, now: float) -> bool:
        return now - session.last_access > self._ttl

    async def get_or_create(self, session_id: str | None) -> tuple[Session, bool]:
        async with self._lock:
            now = self._clock()
            if session_id is not None:
                session = self._sessions.get(session_id)
                if session is not None and not self._expired(session, now):
                    session.last_access = now
                    self._sessions.move_to_end(session_id)
                    return Session(session.id, list(session.turns), now), False
                self._sessions.pop(session_id, None)

            session = Session(id=str(uuid.uuid4()), last_access=now)
            self._sessions[session.id] = session
            while len(self._sessions) > self._max_sessions:
                self._sessions.popitem(last=False)
            return Session(session.id, [], now), True

    @asynccontextmanager
    async def _session_lock(self, session_id: str) -> AsyncIterator[None]:
        if session_id in self._busy:
            raise SessionBusyError()
        self._busy.add(session_id)
        try:
            yield
        finally:
            self._busy.discard(session_id)

    def lock(self, session_id: str) -> AbstractAsyncContextManager[None]:
        return self._session_lock(session_id)

    async def get_turns(self, session_id: str) -> list[ChatTurn]:
        async with self._lock:
            session = self._sessions.get(session_id)
            return list(session.turns) if session else []

    async def append_turns(self, session_id: str, turns: Sequence[ChatTurn]) -> None:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session is None:  # evicted mid-request; nothing to persist into
                return
            session.turns.extend(turns)
            del session.turns[: -self._max_turns]
            session.last_access = self._clock()
            self._sessions.move_to_end(session_id)
