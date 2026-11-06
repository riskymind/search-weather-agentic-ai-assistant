# Search + Weather Agent — Backend

FastAPI service that runs a LangChain tool-calling agent with two tools: **web search (Tavily)** and **current weather (Weatherstack)**.

> ⚠️ **Do not expose this API publicly without access protection.** Anyone who can reach
> `/api/v1/agent/*` spends your OpenAI and Tavily credits, and rate limiting is abuse protection,
> not access control.
> - Set `API_ACCESS_KEY` to require a bearer token. The Next.js frontend calls this API only
>   from its server-side proxy (`BACKEND_API_ACCESS_KEY`), so browsers never hold the key.
> - In production the server refuses to start without either `API_ACCESS_KEY` or an explicit
>   `ALLOW_PUBLIC_AGENT_API=true`.
>
> See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md#5-security) for the full setup.

## Requirements

- Python **3.11** (pinned in `.python-version`)
- [`uv`](https://docs.astral.sh/uv/)
- API keys for OpenAI, Tavily and Weatherstack. The Weatherstack plan **must support HTTPS**: the app refuses to send credentials over plain HTTP.

## Setup and run

```bash
cd backend
uv sync                      # creates .venv from uv.lock
cp .env.example .env         # then fill in the keys
uv run uvicorn --factory app.main:create_app --reload --port 8000
```

- Swagger UI: http://localhost:8000/docs
- Health: http://localhost:8000/api/v1/health

Configuration is validated at startup. If anything is missing or invalid, the process exits with a list such as:

```
[search-weather-agent] Invalid configuration:
  - OPENAI_API_KEY: is required but not set
  - WEATHER_API_BASE_URL: Value error, must be an https:// URL; ...
```

See `.env.example` for every variable and its default.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Liveness (no outbound calls) |
| POST | `/api/v1/agent/query` | `{message, session_id?}` → `{session_id, is_new_session, answer, tool_events[]}` |
| POST | `/api/v1/agent/stream` | Same body; Server-Sent Events: `session`, `status`, `tool_start`, `tool_end`, `token`, then `done` or `error` |

```bash
curl -s localhost:8000/api/v1/agent/query -H 'content-type: application/json' \
  -d '{"message": "Find the capital of Kenya and tell me its current weather"}'

curl -N localhost:8000/api/v1/agent/stream -H 'content-type: application/json' \
  -d '{"message": "What is the weather in Lagos?"}'
```

Errors always use `{"error": {"code", "message", "details"?}}`:

| Status | Code | Notes |
|---|---|---|
| 409 | `session_busy` | Another message for this session is still running |
| 413 | `request_too_large` | Body over `MAX_REQUEST_BODY_BYTES` (default 16 KiB) |
| 422 | `validation_error` | `details` lists field locations and messages (never your input) |
| 429 | `rate_limited` | `Retry-After` header (seconds), exposed to browsers via CORS |
| 502 | `llm_provider_error` | |
| 504 | `agent_timeout` | |
| 500 | `agent_execution_error` / `internal_error` | |

A failed tool call does **not** fail the request. It appears as a `tool_events[]` entry with `status: "failed"`, and the answer explains what couldn't be retrieved.

## Streaming contract (`POST /api/v1/agent/stream`)

Each frame is `event: <name>` followed by a single-line JSON `data:`. The JSON always repeats the name in its `event` field. Lines starting with `:` are keep-alive comments (sent every 15s) and should be ignored.

| Event | Payload | Meaning |
|---|---|---|
| `session` | `session_id`, `is_new_session` | Always the first event. Store `session_id` and send it with the next message |
| `status` | `stage`: `analyzing` \| `preparing_answer` | Agent progress. `preparing_answer` precedes the first `token` of each text segment |
| `tool_start` | `id`, `tool`, `input` | A tool call began |
| `tool_end` | `ToolEvent` fields (`id`, `tool`, `status`: `completed` \| `failed`, `input`, `summary`, `data`, `error`) | Matches the `tool_start` with the same `id` |
| `token` | `delta` | Text chunk of the current draft |
| `done` | `AgentQueryResponse` fields (`session_id`, `is_new_session`, `answer`, `tool_events`) | **Terminal.** `answer` is the final, authoritative answer |
| `error` | `code`, `message` | **Terminal.** The stream closes after it |

Order: `session`, `status(analyzing)`, then zero or more rounds of `[token…] tool_start tool_end`, then `status(preparing_answer)`, `token…`, and finally exactly one `done` **or** `error`.

**Partial text before tools.** The model may write text before deciding to call a tool (for example "Let me check the weather…"). Those tokens arrive *before* the `tool_start` and are **not** part of the answer, and the backend excludes them from `done.answer`. Clients should:

1. Append `token.delta` to a draft buffer.
2. On `tool_start`, discard the draft. Optionally keep showing it as transient "thinking aloud" text until then.
3. On `done`, replace whatever is displayed with `done.answer`.
4. On `error`, keep any completed tool results, show `message`, and offer a retry.
5. If the stream ends with neither `done` nor `error`, treat it as interrupted (network failure).

Errors raised **before** the stream opens (413, 422, 429) are ordinary JSON error responses, never SSE. Everything after it opens, including `session_busy`, `agent_timeout` and `llm_provider_error`, arrives as an `error` event on a 200 stream.

## Sessions

- Conversation history is kept **in process memory**. It is **lost when the server restarts** (including Render free-tier spin-downs) and isn't shared between processes, so run a single worker.
- Session IDs are server-generated UUIDs. An unknown, expired **or malformed** `session_id` starts a fresh session (`is_new_session: true`); the supplied ID is never adopted. IDs longer than 64 characters are rejected with 422.
- One message at a time per session: a concurrent request for a busy session gets `session_busy` (409 or a stream `error` event) instead of interleaving history writes.
- Storage sits behind the `SessionStore` protocol (`app/services/session_store.py`), so a Redis or PostgreSQL implementation can be added without touching the agent.

## Security and limits

| Control | Default | Variables |
|---|---|---|
| Rate limit on `/agent/query` and `/agent/stream`, per client IP, sliding window. Invalid requests count too; `/health` is exempt | 20 requests / 60s | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_MAX_CLIENTS` |
| Request body size | 16 KiB | `MAX_REQUEST_BODY_BYTES` |
| Message length | 4000 characters | (schema constant) |
| Agent bounds | 10 steps, 60s per turn | `AGENT_MAX_STEPS`, `AGENT_TIMEOUT_SECONDS` |
| CORS | exact origins from `FRONTEND_URL` | `FRONTEND_URL` |
| Agent access key (`Authorization: Bearer …`, ≥ 32 chars, constant-time check; failed attempts are rate limited; `/health` stays open) | off | `API_ACCESS_KEY`; production requires it unless `ALLOW_PUBLIC_AGENT_API=true` |
| Client IP for rate limiting: one trusted header, honoured only from trusted proxy peers; `X-Forwarded-For` is never used | socket address | `CLIENT_IP_HEADER` (Render: `CF-Connecting-IP`, unverified until checked on the deployed service), `TRUSTED_PROXY_CIDRS` |
| End-user IP from the frontend proxy (`X-Client-IP`), honoured **only** on requests with a valid `API_ACCESS_KEY` | ignored | (automatic when `API_ACCESS_KEY` is set) |
| Client-IP diagnostics, `GET /api/v1/diagnostics/client-ip`: reports what the server sees for *your* request; 404 unless enabled, and requires the access key | off | `CLIENT_IP_DIAGNOSTICS` |

**Limitations of the in-memory rate limiter and session store (v1):**

- **Per process.** Each worker or instance has its own counters and sessions, so run one worker; scaling out multiplies the effective limit and splits sessions.
- **Reset on restart.** Restarts and Render free-tier spin-downs clear both.
- **Identified by IP.** Behind a proxy, set `CLIENT_IP_HEADER` to a header that proxy *overwrites*. Otherwise every caller looks like the proxy and shares one budget.
  - On Render the intended header is `CF-Connecting-IP`, which Cloudflare sets on every plan (`True-Client-IP` is Cloudflare Enterprise-only, so a client-supplied value could pass through). Render's `X-Forwarded-For` is client-appendable, which is why uvicorn runs with `--no-proxy-headers`. Verify on the deployed service with the diagnostics endpoint ([docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md#32-client-ip-on-render)).
  - With the frontend proxy in front, the network peer is the proxy for every user. The proxy reports the user's IP in `X-Client-IP`, which counts only alongside a valid bearer key, so callers without the key cannot pick their own rate-limit identity.
  - The header is only honoured from peers in `TRUSTED_PROXY_CIDRS` (private ranges by default), so a client can't set its own identity by connecting directly.
  - Users behind one NAT share a budget.
- **Bounded memory.** Only the most recent `RATE_LIMIT_MAX_CLIENTS` clients and `SESSION_MAX_COUNT` sessions are tracked; older entries are forgotten.
- A shared store (Redis) can replace either one by implementing `RateLimiter` or `SessionStore`, without changing the agent or the routes.

## Docker

```bash
docker build -t search-weather-backend .
docker run --rm -p 8000:8000 --env-file .env search-weather-backend
```

- **Image:** `python:3.11-slim`, dependencies from `uv.lock` without dev tools, non-root user.
- **Server:** uvicorn on `0.0.0.0:$PORT` with one worker, plus a `HEALTHCHECK` on `/api/v1/health`.
- **Secrets:** never copied into the image; they are passed at runtime.
- **Full stack:** `docker compose up --build` from the repository root.
- **Render and other hosts:** see [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Layout

```
app/
  main.py                 app factory + composition root (DI)
  core/                   config (pydantic-settings), logging (JSON + secret redaction), errors
  schemas/                request/response, SSE events, tool outputs, conversation turns
  tools/                  WeatherstackClient / TavilySearchClient + LangChain tool wrappers
  agents/                 prompts, AgentRunner (create_agent, bounded, stateless)
  services/               AgentService (one turn: session, timeout, events), SessionStore
  api/v1/                 routes (thin), SSE encoder, router
tests/unit, tests/integration
```

## Quality checks

```bash
uv run pytest                 # unit + integration; all external APIs mocked, no keys needed
uv run pytest --cov=app       # with coverage
uv run pytest -m live         # optional smoke tests against the real APIs (needs .env)
uv run ruff check . && uv run ruff format --check .
uv run mypy
```
