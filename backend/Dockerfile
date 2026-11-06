# Production image for the FastAPI backend.
#   docker build -t search-weather-backend ./backend
#   docker run --env-file backend/.env -p 8000:8000 search-weather-backend
#
# Secrets are supplied at runtime (env vars); no .env file is ever copied into the image.

ARG PYTHON_VERSION=3.11
ARG UV_VERSION=0.12.17

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# --- Build: resolve the locked, production-only virtualenv --------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /build
COPY pyproject.toml uv.lock .python-version ./
# --frozen: install exactly what uv.lock pins (fails if the lock is out of date).
# --no-dev: no pytest/ruff/mypy in the image.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# --- Runtime --------------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    APP_ENV=production \
    PORT=8000

RUN groupadd --system app && useradd --system --gid app --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
# Code stays root-owned and read-only for the runtime user.
COPY app ./app

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT', '8000'), timeout=4)"]

# - Binds 0.0.0.0 on $PORT (Render injects PORT).
# - One worker: sessions and rate limits are in-process memory.
# - --no-proxy-headers: X-Forwarded-For on Render is client-appendable, so uvicorn must not
#   rewrite the client address from it. The network client IP comes from CLIENT_IP_HEADER
#   (e.g. CF-Connecting-IP), honoured only for peers in TRUSTED_PROXY_CIDRS; the end-user IP
#   from the frontend proxy (X-Client-IP) only with a valid API key (app/core/client_ip.py).
CMD ["sh", "-c", "exec uvicorn --factory app.main:create_app --host 0.0.0.0 --port \"${PORT}\" --workers 1 --no-proxy-headers --no-server-header --timeout-graceful-shutdown 30"]
