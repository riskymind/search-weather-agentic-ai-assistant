import json
import logging

from app.core.logging import JsonFormatter, RedactingFormatter, SecretRedactor, TextFormatter

SECRET = "wx-very-secret-key"


def record(msg: str, exc_info=None, **extra) -> logging.LogRecord:
    rec = logging.LogRecord("test", logging.INFO, __file__, 1, msg, None, exc_info)
    for key, value in extra.items():
        setattr(rec, key, value)
    return rec


def test_secrets_redacted_in_message_extras_and_tracebacks():
    formatter = RedactingFormatter(JsonFormatter(), SecretRedactor([SECRET]))
    try:
        raise ValueError(f"https://api.weatherstack.com/current?access_key={SECRET}")
    except ValueError:
        import sys

        output = formatter.format(record(f"calling with {SECRET}", exc_info=sys.exc_info(), url=f"x?k={SECRET}"))
    assert SECRET not in output
    payload = json.loads(output)
    assert payload["message"] == "calling with ***"
    assert payload["url"] == "x?k=***"
    assert payload["exc_type"] == "ValueError"


def test_text_formatter_includes_extras():
    output = TextFormatter().format(record("tool_finished", tool="weather", ok=True))
    assert "tool_finished" in output and "tool=weather" in output and "ok=True" in output


def test_url_logging_http_clients_are_quiet():
    from app.core.logging import configure_logging

    configure_logging("DEBUG", json_output=False, secrets=[SECRET])
    for name in ("httpx", "httpx2", "httpcore", "openai"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING
