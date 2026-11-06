import uuid

from app.schemas.conversation import ChatTurn
from app.services.session_store import InMemorySessionStore


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def turns(n: int) -> list[ChatTurn]:
    return [ChatTurn(role="user" if i % 2 == 0 else "assistant", content=str(i)) for i in range(n)]


async def test_new_session_gets_server_generated_uuid():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    session, is_new = await store.get_or_create(None)
    assert is_new
    assert uuid.UUID(session.id).version == 4
    assert session.turns == []


async def test_existing_session_is_resumed_with_history():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    session, _ = await store.get_or_create(None)
    await store.append_turns(session.id, turns(2))

    resumed, is_new = await store.get_or_create(session.id)
    assert not is_new
    assert resumed.id == session.id
    assert [t.content for t in resumed.turns] == ["0", "1"]


async def test_unknown_client_id_is_never_adopted():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    chosen = str(uuid.uuid4())
    session, is_new = await store.get_or_create(chosen)
    assert is_new
    assert session.id != chosen
    # The chosen ID still doesn't exist afterwards.
    again, is_new_again = await store.get_or_create(chosen)
    assert is_new_again and again.id not in (chosen, session.id)


async def test_sessions_are_isolated():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    a, _ = await store.get_or_create(None)
    b, _ = await store.get_or_create(None)
    await store.append_turns(a.id, [ChatTurn(role="user", content="secret for A")])
    resumed_b, _ = await store.get_or_create(b.id)
    assert resumed_b.turns == []


async def test_returned_history_is_a_copy():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    session, _ = await store.get_or_create(None)
    session.turns.append(ChatTurn(role="user", content="mutated"))
    resumed, _ = await store.get_or_create(session.id)
    assert resumed.turns == []


async def test_idle_sessions_expire():
    clock = Clock()
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10, clock=clock)
    session, _ = await store.get_or_create(None)
    clock.now += 61
    resumed, is_new = await store.get_or_create(session.id)
    assert is_new and resumed.id != session.id


async def test_lru_eviction():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=2, max_turns=10)
    first, _ = await store.get_or_create(None)
    second, _ = await store.get_or_create(None)
    await store.get_or_create(first.id)  # touch first, so second is least recently used
    await store.get_or_create(None)
    assert (await store.get_or_create(first.id))[1] is False
    assert (await store.get_or_create(second.id))[1] is True


async def test_history_is_trimmed():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=4)
    session, _ = await store.get_or_create(None)
    await store.append_turns(session.id, turns(6))
    resumed, _ = await store.get_or_create(session.id)
    assert [t.content for t in resumed.turns] == ["2", "3", "4", "5"]


async def test_append_to_evicted_session_is_ignored():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=4)
    await store.append_turns(str(uuid.uuid4()), turns(2))  # no error


async def test_lock_rejects_concurrent_turns_for_same_session():
    import pytest

    from app.core.errors import SessionBusyError

    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    a, _ = await store.get_or_create(None)
    b, _ = await store.get_or_create(None)
    async with store.lock(a.id):
        with pytest.raises(SessionBusyError):
            async with store.lock(a.id):
                pass  # pragma: no cover
        async with store.lock(b.id):  # other sessions are unaffected
            pass
    async with store.lock(a.id):  # released afterwards
        pass


async def test_lock_released_after_error():
    import contextlib

    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    session, _ = await store.get_or_create(None)
    with contextlib.suppress(RuntimeError):
        async with store.lock(session.id):
            raise RuntimeError
    async with store.lock(session.id):
        pass


async def test_get_turns_returns_copy():
    store = InMemorySessionStore(ttl_seconds=60, max_sessions=10, max_turns=10)
    session, _ = await store.get_or_create(None)
    await store.append_turns(session.id, turns(2))
    history = await store.get_turns(session.id)
    history.clear()
    assert len(await store.get_turns(session.id)) == 2
    assert await store.get_turns("missing") == []
