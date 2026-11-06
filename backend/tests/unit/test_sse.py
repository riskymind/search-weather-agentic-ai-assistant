import asyncio
import json

from app.api.v1.sse import format_sse, sse_stream
from app.core.errors import AgentTimeoutError
from app.schemas.agent import SessionEvent, TokenEvent


def parse(frame: str) -> tuple[str, dict]:
    lines = dict(line.split(": ", 1) for line in frame.strip().split("\n"))
    return lines["event"], json.loads(lines["data"])


def test_format_sse():
    event, data = parse(format_sse(TokenEvent(delta="hi\nthere")))
    assert event == "token"
    assert data == {"event": "token", "delta": "hi\nthere"}  # newlines stay inside the JSON string


async def test_events_are_forwarded_in_order():
    async def source():
        yield SessionEvent(session_id="s", is_new_session=True)
        yield TokenEvent(delta="a")

    frames = [f async for f in sse_stream(source())]
    assert [parse(f)[0] for f in frames] == ["session", "token"]


async def test_app_error_becomes_terminal_error_event():
    async def source():
        yield TokenEvent(delta="a")
        raise AgentTimeoutError()

    frames = [f async for f in sse_stream(source())]
    event, data = parse(frames[-1])
    assert event == "error"
    assert data["code"] == "agent_timeout"


async def test_unexpected_error_is_generic():
    async def source():
        raise RuntimeError("secret internals")
        yield  # pragma: no cover

    frames = [f async for f in sse_stream(source())]
    event, data = parse(frames[-1])
    assert event == "error" and data["code"] == "internal_error"
    assert "secret internals" not in frames[-1]


async def test_keepalive_ping_while_idle():
    async def source():
        await asyncio.sleep(0.15)
        yield TokenEvent(delta="late")

    frames = [f async for f in sse_stream(source(), ping_interval=0.05)]
    assert frames[0] == ": ping\n\n"
    assert parse(frames[-1])[0] == "token"


async def test_client_disconnect_cancels_agent():
    cancelled = asyncio.Event()

    async def source():
        yield TokenEvent(delta="first")
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        yield TokenEvent(delta="never")  # pragma: no cover

    stream = sse_stream(source())
    assert parse(await anext(stream))[1]["delta"] == "first"
    await stream.aclose()  # what Starlette does when the client goes away
    await asyncio.wait_for(cancelled.wait(), timeout=1)
