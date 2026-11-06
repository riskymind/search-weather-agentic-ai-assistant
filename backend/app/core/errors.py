"""Application error types and the FastAPI handlers that render the error envelope.

Every non-2xx response has the shape `{"error": {"code", "message", "details"?}}`.
Messages are always safe, fixed strings: no stack traces, provider payloads,
prompts or credentials.
"""

import logging

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas.common import ErrorBody, ErrorResponse

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Base class for errors that map to a well-defined API response."""

    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    code: str = "internal_error"
    message: str = "An unexpected error occurred. Please try again."

    def __init__(self, message: str | None = None, headers: dict[str, str] | None = None) -> None:
        super().__init__(message or self.message)
        if message:
            self.message = message
        self.headers = headers or {}


class LLMProviderError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = "llm_provider_error"
    message = "The language model provider is unavailable or rejected the request. Please try again later."


class AgentTimeoutError(AppError):
    status_code = status.HTTP_504_GATEWAY_TIMEOUT
    code = "agent_timeout"
    message = "The assistant took too long to respond. Please try again."


class AgentExecutionError(AppError):
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    code = "agent_execution_error"
    message = "The assistant could not complete your request. Please try again."


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"
    message = "A valid API access key is required."

    def __init__(self) -> None:
        super().__init__(headers={"WWW-Authenticate": "Bearer"})


class SessionBusyError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "session_busy"
    message = "This conversation is already processing a message. Wait for it to finish and try again."


class RateLimitedError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"
    message = "Too many requests. Please wait a moment and try again."

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__(headers={"Retry-After": str(retry_after_seconds)})
        self.retry_after_seconds = retry_after_seconds


class RequestTooLargeError(AppError):
    status_code = status.HTTP_413_CONTENT_TOO_LARGE
    code = "request_too_large"
    message = "The request body is too large."


def error_payload(code: str, message: str, details: list[dict[str, object]] | None = None) -> dict[str, object]:
    return ErrorResponse(error=ErrorBody(code=code, message=message, details=details)).model_dump(exclude_none=True)


def _safe_validation_details(exc: RequestValidationError) -> list[dict[str, object]]:
    # Only location, message and type; the raw input is omitted.
    return [
        {"loc": list(err.get("loc", ())), "msg": err.get("msg", ""), "type": err.get("type", "")}
        for err in exc.errors()
    ]


def register_exception_handlers(app: FastAPI) -> None:
    """Attach handlers that render all errors as the standard envelope."""

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content=error_payload(exc.code, exc.message), headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=jsonable_encoder(
                error_payload("validation_error", "The request payload is invalid.", _safe_validation_details(exc))
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return JSONResponse(status_code=exc.status_code, content=error_payload(code, message))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled_error", extra={"path": request.url.path, "error_type": type(exc).__name__})
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=error_payload("internal_error", AppError.message),
        )
