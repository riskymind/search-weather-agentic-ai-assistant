"""ASGI middleware."""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import RequestTooLargeError, error_payload

_BODY_METHODS = {"POST", "PUT", "PATCH"}


class BodySizeLimitMiddleware:
    """Reject request bodies larger than `max_bytes` with 413.

    `Content-Length` is checked up front. The body is then read (and counted) here, so a
    chunked request or a false `Content-Length` cannot bypass the limit, and replayed to
    the application as a single message. Later `receive` calls go to the server as usual,
    so disconnect detection for streaming responses keeps working. Bodies are small (the
    limit defaults to 16 KiB), so buffering them is cheap.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=RequestTooLargeError.status_code,
            content=error_payload(RequestTooLargeError.code, RequestTooLargeError.message),
            headers={"Connection": "close"},
        )
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return

        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = self.max_bytes + 1
                if declared > self.max_bytes:
                    await self._reject(scope, receive, send)
                    return
                break

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":  # client disconnected while sending
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await self._reject(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)
