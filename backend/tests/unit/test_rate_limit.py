from app.core.rate_limit import InMemoryRateLimiter


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


async def test_allows_up_to_limit_then_denies():
    limiter = InMemoryRateLimiter(limit=3, window_seconds=60, clock=Clock())
    decisions = [await limiter.hit("1.2.3.4") for _ in range(4)]
    assert [d.allowed for d in decisions] == [True, True, True, False]
    assert [d.remaining for d in decisions] == [2, 1, 0, 0]
    assert decisions[-1].retry_after_seconds == 60


async def test_window_slides():
    clock = Clock()
    limiter = InMemoryRateLimiter(limit=2, window_seconds=10, clock=clock)
    await limiter.hit("a")
    clock.now += 5
    await limiter.hit("a")
    denied = await limiter.hit("a")
    assert not denied.allowed and denied.retry_after_seconds == 5
    clock.now += 5  # first hit leaves the window
    assert (await limiter.hit("a")).allowed
    assert not (await limiter.hit("a")).allowed


async def test_denied_requests_do_not_consume_budget():
    clock = Clock()
    limiter = InMemoryRateLimiter(limit=1, window_seconds=10, clock=clock)
    await limiter.hit("a")
    for _ in range(5):
        await limiter.hit("a")
    clock.now += 10
    assert (await limiter.hit("a")).allowed


async def test_clients_are_isolated():
    limiter = InMemoryRateLimiter(limit=1, window_seconds=60, clock=Clock())
    assert (await limiter.hit("a")).allowed
    assert not (await limiter.hit("a")).allowed
    assert (await limiter.hit("b")).allowed


async def test_tracked_clients_are_bounded():
    limiter = InMemoryRateLimiter(limit=1, window_seconds=60, max_clients=2, clock=Clock())
    await limiter.hit("a")
    await limiter.hit("b")
    await limiter.hit("c")  # evicts "a" (least recently seen)
    assert len(limiter._hits) == 2
    assert (await limiter.hit("a")).allowed  # forgotten client starts fresh (documented limitation)
