"""Structured logging.

Production emits one JSON object per line; development emits readable text.
A redacting formatter masks configured secret values in every line (tracebacks included) as a last line
of defence, and noisy HTTP client loggers (which log full request URLs, including
Weatherstack's `access_key` query parameter) are silenced.
"""

import json
import logging
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime", "color_message"}

# Loggers that would otherwise print request URLs containing credentials.
_QUIET_LOGGERS = ("httpx", "httpx2", "httpcore", "openai", "urllib3")


class SecretRedactor:
    """Replace any known secret value in formatted log output with `***`."""

    def __init__(self, secrets: Iterable[str]) -> None:
        self._secrets = [s for s in secrets if s and len(s) >= 4]

    def __call__(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "***")
        return text


class RedactingFormatter(logging.Formatter):
    """Wraps another formatter and redacts secrets from its complete output (including tracebacks)."""

    def __init__(self, inner: logging.Formatter, redactor: SecretRedactor) -> None:
        super().__init__()
        self._inner = inner
        self._redact = redactor

    def format(self, record: logging.LogRecord) -> str:
        return self._redact(self._inner.format(record))


class JsonFormatter(logging.Formatter):
    """Format records as single-line JSON, including any `extra={...}` fields."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        payload.update({k: v for k, v in record.__dict__.items() if k not in _RESERVED})
        if record.exc_info:
            payload["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
            payload["traceback"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class TextFormatter(logging.Formatter):
    """Readable formatter that appends `extra` fields as key=value pairs."""

    def __init__(self) -> None:
        super().__init__("%(asctime)s %(levelname)-8s %(name)s: %(message)s")

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extras = {k: v for k, v in record.__dict__.items() if k not in _RESERVED}
        if extras:
            base += " " + " ".join(f"{k}={v}" for k, v in extras.items())
        return base


def configure_logging(level: str, json_output: bool, secrets: Iterable[str] = ()) -> None:
    """Configure the root logger. Safe to call more than once."""
    handler = logging.StreamHandler(sys.stdout)
    inner = JsonFormatter() if json_output else TextFormatter()
    handler.setFormatter(RedactingFormatter(inner, SecretRedactor(secrets)))

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # Route uvicorn's loggers through the same handler/format.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers = []
        uv_logger.propagate = True
