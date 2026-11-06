"""Server-Sent Events encoding for agent streams.

Runs the event source in a background task and forwards events through a queue,
so a keep-alive comment can be sent while the agent is busy (some proxies drop
idle connections). If the client disconnects, Starlette cancels this generator
and the agent task is cancelled with it.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

from app.core.errors import AppError
from app.schemas.agent import ErrorEvent, StreamEvent

logger = logging.getLogger(__name__)

PING_INTERVAL_SECONDS = 15.0
SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}


class _EndOfStream:
    """Queue sentinel marking the end of the event source."""


_END = _EndOfStream()


def format_sse(event: StreamEvent) -> str:
    """Encode an event as an SSE frame (`event:` type + single-line JSON `data:`)."""
    return f"event: {event.event}\ndata: {event.model_dump_json()}\n\n"


async def sse_stream(
    events: AsyncIterator[StreamEvent], ping_interval: float = PING_INTERVAL_SECONDS
) -> AsyncIterator[str]:
    """Encode `events` as SSE, converting failures into a terminal `error` event."""
    queue: asyncio.Queue[StreamEvent | _EndOfStream] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for event in events:
                await queue.put(event)
        except AppError as exc:
            await queue.put(ErrorEvent(code=exc.code, message=exc.message))
        except Exception as exc:
            logger.exception("stream_failed", extra={"error_type": type(exc).__name__})
            await queue.put(ErrorEvent(code="internal_error", message=AppError.message))
        finally:
            await queue.put(_END)

    task = asyncio.create_task(produce())
    completed = False
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=ping_interval)
            except TimeoutError:
                yield ": ping\n\n"
                continue
            if isinstance(item, _EndOfStream):
                completed = True
                return
            yield format_sse(item)
    finally:
        if not completed:
            logger.info("stream_client_disconnected")
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
