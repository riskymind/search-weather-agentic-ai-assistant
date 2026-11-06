# spec.md — Search + Weather Agentic AI Assistant

Refactoring and deployment plan. CLAUDE.md is the requirements source; this file is the audit, the design that meets those requirements, and the progress tracker.

**Status:** All milestones complete, including the secure Next.js proxy, the access gate and the final documentation (M11, 2026-11-04). Ready for deployment, pending owner approval. **Not deployed.** The Render client-IP header is unverified until checked on the deployed service (§15).
**Audit date:** 2026-11-03 · **Audited commit:** `be395ca` (`main`)

---

## 1. Current architecture assessment

### 1.1 Repository inventory

| File | Purpose | Notes |
|---|---|---|
| `app.py` (123 lines) | The whole application: Streamlit UI, config, tools, prompt, agent, execution | Single module, everything runs at import time |
| `requirements.txt` | 9 unpinned dependencies | See 1.3 |
| `research/agent-demo.ipynb` | Exploration notebook: Tavily search + ReAct agent, **search tool only** | The file name uses a hyphen. README and CLAUDE.md both call it `agent_demo.ipynb` |
| `README.md` | Generic "LangChain Agent" readme | Several inaccuracies (see 2.6) |
| `.gitignore` | `.env`, `research/.env` | Nothing else is ignored |
| `CLAUDE.md` | Refactoring specification | Untracked |

No tests, no Docker files, no CI, no frontend code apart from Streamlit.

### 1.2 Runtime flow (`app.py`)

1. `load_dotenv()` reads `OPENAI_API_KEY`, `TAVILY_API_KEY` and `WEATHER_API_KEY` from `.env`.
2. The Streamlit page is configured (title "🤖 Search + Weather AI Agent").
3. Tools:
   - **Search:** `TavilySearchResults(max_results=2)` from `langchain_community`. It reads `TAVILY_API_KEY` from the environment itself; the `TAVILY_API_KEY` variable in `app.py` is never used. LLM-facing tool name: `tavily_search_results_json`.
   - **Weather:** `@tool get_weather_data(city: str) -> str` makes a synchronous `requests.get` call to `http://api.weatherstack.com/current?access_key=…&query={city}` and returns a free-text string with City, Temperature °C, Weather description and Humidity %. It returns `"Could not fetch weather data for {city}"` when `current` is missing from the response.
4. LLM: `ChatOpenAI(model="gpt-3.5-turbo", temperature=0)`.
5. Prompt: the classic `hwchase17/react` text template (Thought / Action / Action Input / Observation / Final Answer), written inline. The notebook shows it was copied from `hub.pull("hwchase17/react")`.
6. Agent: `create_react_agent` + `AgentExecutor(verbose=True, handle_parsing_errors=True)` from `langchain_classic`. This is a text-parsing ReAct loop with the default `max_iterations=15`.
7. UI: a text input and a "Run Agent" button. `agent_executor.invoke({"input": query})` runs, then `response["output"]` is rendered; on failure the UI shows `st.error(str(e))`.

### 1.3 Dependencies

| Package | Used for | Assessment |
|---|---|---|
| `langchain` | Meta-package | Now 1.x, which provides the modern `create_agent` API |
| `langchain-core` | `PromptTemplate`, `@tool` | Keep |
| `langchain-openai` | `ChatOpenAI` | Keep |
| `langchain-community` | `TavilySearchResults` | **Deprecated** (the notebook output shows `LangChainDeprecationWarning`, "removed in 1.0"). Drop it |
| `tavily-python` | Underlying Tavily SDK | Keep; the new search tool will call its async client directly |
| `requests` | Weatherstack call | Replace with `httpx` (async, timeouts) |
| `python-dotenv` | `.env` loading | Replaced by `pydantic-settings` |
| `langchainhub` | Not used (the `hub.pull` line is commented out) | **Deprecated package**. Drop it |
| `streamlit` | UI | Replaced by Next.js |
| *(missing)* `langchain-classic` | `app.py` imports `langchain_classic.agents` | **Not listed in requirements.txt**, so a fresh install depends on it arriving transitively. Install is not reproducible |
| *(notebook only)* `certifi` | Imported, never used | — |

### 1.4 Functionality to preserve

1. **Web search** through Tavily for current information. The default of 2 results becomes configurable.
2. **Current weather** for a city through Weatherstack, in Celsius, with description and humidity. Extended with country, wind speed and observation time.
3. **Autonomous multi-step tool selection.** The canonical case is "Find the capital of Nigeria and current weather": search → extract city → weather → combined answer.
4. **Deterministic answers** (`temperature=0`).
5. **Graceful handling of tool and parse errors.** `handle_parsing_errors=True` and the weather-failure string must become structured tool errors.
6. **The research notebook**, kept exactly as it is.
7. **Product identity:** "Search + Weather AI Agent".

---

## 2. Problems with the existing implementation

### 2.1 Security
- **S1: API key sent over plain HTTP.** The Weatherstack URL uses `http://`, so `access_key` crosses the network unencrypted. See **open question Q1**: Weatherstack has historically limited HTTPS to paid plans.
- **S2: Key embedded in the URL.** Weatherstack only accepts the key as a query parameter, so the full URL is a secret. Any logging of request URLs (for example `httpx`'s INFO logger) or exception messages that include the URL would leak it. The fix is to pass it through `params=`, silence the `httpx`/`httpcore` request loggers, and never echo URLs or raw exceptions.
- **S3: Unencoded query injection.** `city` is interpolated into the URL directly, so `"Paris&units=f"` or `"x&access_key=…"` can alter the request. The fix is to validate the input and use `params=`.
- **S4: Raw exception text shown to users.** `st.error(str(e))` can expose provider error bodies, internal paths or request details.
- **S5: `verbose=True`** prints full prompts, intermediate reasoning and tool payloads to stdout, and the "Thought:" text is the model's reasoning. CLAUDE.md forbids exposing it.
- **S6: No input bounds.** Message length is unlimited, which is a cost and abuse vector once the app is public.
- **S7: `.gitignore` is minimal.** It does not cover `venv/`, `__pycache__/`, `.ipynb_checkpoints/`, `node_modules/`, `.next/` or `*.env.local`.
- No secrets were found in git history. Searched for `sk-`, `tvly-` and literal `access_key=` values. Notebook outputs contain no keys.

### 2.2 Reliability and correctness
- **R1:** `requests.get` has **no timeout**, so a slow provider hangs the app indefinitely.
- **R2:** Weatherstack returns **HTTP 200 with `{"success": false, "error": {...}}`** on errors (invalid key, unknown city, quota). The code only checks `"current" in data`, so error types cannot be told apart, and `response.json()` throws on non-JSON responses.
- **R3:** The output reports the **user's input** as the city, not the location the provider resolved. "Abj" would be labelled "Abj".
- **R4:** **ReAct text parsing is fragile.** The model must produce exact `Action:` / `Final Answer:` text; `handle_parsing_errors` hides failures rather than preventing them. Native tool calling removes this whole failure class.
- **R5:** The loop bound is implicit (the default 15 iterations), and each failure can trigger another paid LLM call.
- **R6:** The agent is **synchronous and rebuilt on every Streamlit rerun**. It has no conversation memory, and every query is stateless.
- **R7:** **No tests.**

### 2.3 Deprecated or outdated APIs
- `langchain_community.tools.tavily_search.TavilySearchResults` is deprecated in favour of `langchain-tavily` or a direct SDK.
- `langchain_classic.agents.create_react_agent` / `AgentExecutor` are legacy. They live in the `langchain-classic` compatibility package; LangChain 1.x's supported path is `langchain.agents.create_agent` (built on LangGraph).
- `langchainhub` is deprecated.
- `gpt-3.5-turbo` is an outdated, hardcoded model.

### 2.4 Maintainability
- UI, config, tools, prompt and orchestration all live in one module, so nothing is reusable or testable in isolation.
- The prompt is inline, and duplicated between `app.py` and the notebook.
- Dependencies are unpinned and incomplete (`langchain-classic` missing).

### 2.5 UX
- One-shot input with no history, no streaming, no visibility into which tool ran, no sources and no structured weather view.

### 2.6 Documentation drift
- README calls the notebook `agent_demo.ipynb`; the file is `agent-demo.ipynb`.
- README says both "Python 3.11" and "Python 3.13.6".
- README documents `WEATHERSTACK_API_KEY`, but the code reads **`WEATHER_API_KEY`**. The new app follows CLAUDE.md and uses `WEATHER_API_KEY`, and the README will say so.
- README doesn't mention Streamlit, so `python app.py` is the wrong run command; it should be `streamlit run app.py`.

---

## 3. Proposed architecture

```
 Browser
   │  same-origin fetch: /api/agent/query (JSON), /api/agent/stream (SSE), /api/health, /api/access
   ▼
 Next.js server (Vercel / :3000): proxy.ts access gate + route handlers (validate, inject Bearer key, stream)
   │  server-to-server HTTPS, Authorization: Bearer API_ACCESS_KEY, X-Client-IP
   ▼
 FastAPI (Render Docker / :8000)
   api/v1/routes ──► services/agent_service ──► agents/weather_agent (LangChain create_agent)
                         │  session store              │ tool calls
                         │  event collection           ├─► tools/search_tool  ──► Tavily (AsyncTavilyClient)
                         ▼                             └─► tools/weather_tool ──► Weatherstack (httpx.AsyncClient)
                    Pydantic schemas                   ▼
                                                 OpenAI (ChatOpenAI, model from OPENAI_MODEL)
```

### Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **`langchain.agents.create_agent`** (LangChain 1.x, LangGraph runtime) with native OpenAI tool calling | It is the supported successor to `create_react_agent`/`AgentExecutor`, removes text parsing (R4), and provides `astream` for token and tool events |
| D2 | Tools are **our own async `@tool` functions** wrapping `httpx` and `AsyncTavilyClient`, rather than `langchain-tavily` | Full control over validation, timeouts, error mapping and structured output; one less dependency layer |
| D3 | Tools use **`response_format="content_and_artifact"`**: a compact JSON string goes to the LLM, and the full Pydantic model is the artifact | The LLM gets concise, token-efficient context. The service lifts artifacts into `tool_events[].data` so the frontend can render weather and source cards without parsing prose |
| D4 | **Tool failures are returned as structured error results, not raised.** Example: `{"ok": false, "error": "city_not_found"}` | The LLM can tell the user what failed without inventing data. The event shows `status: "failed"` |
| D5 | **Bounded execution:** LangGraph `recursion_limit` (default 10 steps, roughly 4 tool rounds) plus a per-request wall-clock timeout (`AGENT_TIMEOUT_SECONDS`, default 60) | Prevents infinite loops and runaway cost (R5) |
| D6 | **Conversation memory (revised after approval):** a `SessionStore` protocol in `services/session_store.py`, with `InMemorySessionStore` as the v1 implementation (LRU capped at `SESSION_MAX_COUNT`, idle TTL `SESSION_TTL_SECONDS`, last `SESSION_MAX_TURNS` messages kept). It stores plain user/assistant text turns, so it is JSON-serialisable and can move to Redis or PostgreSQL. The agent is **stateless**: it receives the history plus the new message, and knows nothing about sessions. The LangGraph checkpointer is *not* used, because that would couple storage to the agent runtime | No DB, per CLAUDE.md. **Limitation:** sessions are lost on restart or Render spin-down and aren't shared across workers, so the service runs **one Uvicorn worker**. Conversations are **not** permanently stored |
| D6a | **Session ID safety:** IDs are generated server-side only (UUID4, 122 random bits). A client-supplied `session_id` must be a valid UUID, otherwise 422. An unknown or expired ID is **never adopted**: the server creates a fresh session with a new ID and returns `is_new_session: true`. A client therefore can't create or choose an ID, so sessions can't collide or be pre-seeded, and a session can only be reached by whoever holds its unguessable ID | |
| D7 | **SSE with FastAPI `StreamingResponse`** (`text/event-stream`), no extra dependency. The client uses `fetch` + a stream parser rather than `EventSource`, because the endpoint is POST | Disconnects are detected through `request.is_disconnected()` and `asyncio.CancelledError`, which cancels the agent run |
| D8 | ~~The browser calls FastAPI directly (`NEXT_PUBLIC_API_URL` + CORS)~~ → **superseded in M11 by a server-side proxy (backend-for-frontend).** The browser calls same-origin Next.js route handlers; they call FastAPI with a server-only bearer key (`BACKEND_API_URL`, `BACKEND_API_ACCESS_KEY`) | **Why it changed:** a key in browser code is public, so the agent API could not be protected while the browser called it directly (security review, DEPLOYMENT.md §5). The original concern, SSE buffering, was addressed by passing the upstream body through chunk by chunk with `Cache-Control: no-transform`, and verified with per-event timings through Docker. No `NEXT_PUBLIC_*` variables remain |
| D15 | **App-level access gate** (M11): `ACCESS_CODES` (`label:code` pairs), HMAC-signed HttpOnly cookie, enforced by `proxy.ts` *and* every API route; fails closed in production without codes | Vercel Deployment Protection covers production on all plans only via Vercel Authentication, which on Hobby admits 1 external user and 1 shareable link per account; Password Protection is not on Hobby. A portfolio demo needs several individually revocable reviewers without Vercel accounts |
| D16 | **End-user IP via the proxy** (M11): the proxy sends `X-Client-IP` (from Vercel's overwritten `x-forwarded-for`); the backend honours it only on requests with a valid access key. Network-level header changed from `True-Client-IP` (Cloudflare Enterprise-only) to `CF-Connecting-IP` | Behind a proxy, every user shares the proxy's address; trusting a client IP header only alongside the key keeps it unspoofable |
| D9 | **Frontend conversation persistence:** browser `localStorage` only, clearly labelled "Stored in this browser" | Matches CLAUDE.md 3.8. Not presented as cross-device |
| D10 | **Python 3.11 everywhere** (`requires-python = ">=3.11,<3.12"`, `.python-version`, `python:3.11-slim` image), managed with **`uv`** (`pyproject.toml` + committed `uv.lock`). The Docker image installs with `uv sync --frozen` | Matches the owner's environment; no dependency requires 3.12. Reproducible and pinned |
| D11 | **Config fails fast at startup** with one readable error that lists every missing or invalid variable. Values are never echoed. The app is built by a factory (`uvicorn --factory app.main:create_app`), so importing modules in tests doesn't trigger validation | Satisfies "validate required env vars / meaningful errors". Tests inject settings, so they need no real keys |
| D13 | **HTTPS-only Weatherstack.** `WEATHER_API_BASE_URL` is configurable but must be `https://`; anything else fails startup validation. There is no HTTP fallback or override. Weatherstack error 105 (`https_access_restricted`) maps to a clear `not_configured` tool error ("subscription does not support HTTPS") | Owner decision. If the key's plan lacks HTTPS, the recommendation is to upgrade the plan or switch to an HTTPS-capable provider (e.g. Open-Meteo, which needs no key, or OpenWeatherMap). The client sits behind a small interface, so swapping providers is a local change |
| D14 | **Dependency injection:** `create_app(settings=None, agent_service=None)`. Services live on `app.state` and are resolved by FastAPI dependencies. Provider clients (`WeatherstackClient`, `TavilySearchClient`) are plain classes, testable without LangChain or FastAPI. LangChain tools are thin wrappers built by factories | Testability. Keeps LangChain out of routes |
| D12 | **Prompts live in `agents/prompts.py`**: a system prompt with tool-use guidance, a "never fabricate tool results" rule, "answer directly when no tool is needed", and the current date injected per request | Fixes "the model thinks it's 2022" (the notebook output) and keeps prompts out of logic |

---

## 4. Target folder structure

```
.
├── backend/
│   ├── app/
│   │   ├── api/v1/
│   │   │   ├── routes/{agent.py, health.py}
│   │   │   └── router.py
│   │   ├── agents/{weather_agent.py, prompts.py}
│   │   ├── tools/{search_tool.py, weather_tool.py}
│   │   ├── services/agent_service.py
│   │   ├── schemas/{agent.py, common.py}
│   │   ├── core/{config.py, logging.py, errors.py}
│   │   └── main.py
│   ├── tests/{unit/, integration/, conftest.py}
│   ├── pyproject.toml, uv.lock
│   ├── Dockerfile, .dockerignore
│   ├── .env.example
│   └── README.md
├── frontend/
│   ├── src/
│   │   ├── app/{layout.tsx, page.tsx, globals.css}
│   │   ├── components/   (see section 7)
│   │   ├── hooks/{useChat.ts, useConversations.ts}
│   │   ├── lib/{api.ts, config.ts, sse.ts, storage.ts}
│   │   └── types/agent.ts
│   ├── tests/ (or co-located *.test.tsx)
│   ├── package.json, package-lock.json, tsconfig.json, next.config.ts
│   ├── vitest.config.ts, eslint config
│   ├── Dockerfile, .dockerignore
│   ├── .env.example
│   └── README.md
├── research/
│   ├── agent-demo.ipynb        (unchanged)
│   └── requirements.txt        (legacy deps the notebook needs; see M10)
├── docker-compose.yml
├── render.yaml                 (optional Render Blueprint)
├── spec.md
├── README.md
└── .gitignore
```

`core/errors.py` is the one addition to CLAUDE.md's structure. It holds the app's exception types and the FastAPI handlers that produce the consistent error envelope.

**Legacy files:** `app.py` (Streamlit) is deleted once the Next.js UI reaches feature parity (M8). The root `requirements.txt` moves to `research/requirements.txt` so the notebook stays runnable. Both changes will be stated in the final report.

---

## 5. Backend API contracts

Base path: `/api/v1`. All bodies are JSON (`application/json`) except the SSE stream.

### 5.1 `GET /api/v1/health` → `200`
```json
{ "status": "healthy", "service": "search-weather-agent", "version": "1.0.0", "environment": "production" }
```
Liveness only: it makes no outbound calls, so Render and Docker health checks stay cheap and don't spend provider quota.

### 5.2 `POST /api/v1/agent/query`
**Request** (`AgentQueryRequest`):
```json
{ "message": "Find the capital of Nigeria and tell me its weather", "session_id": null }
```
- `message`: string, trimmed, 1–4000 chars (`MAX_MESSAGE_CHARS`).
- `session_id`: optional string; must be a UUID if provided. If null or unknown, a new session is created.

**Response `200`** (`AgentQueryResponse`):
```json
{
  "session_id": "4f1c…",
  "answer": "The capital of Nigeria is Abuja. It's currently 31°C and partly cloudy…",
  "tool_events": [
    {
      "id": "call_abc",
      "tool": "tavily_search",
      "status": "completed",
      "input": { "query": "capital of Nigeria" },
      "summary": "Found 3 results for \"capital of Nigeria\"",
      "data": { "kind": "search", "query": "capital of Nigeria", "results": [
        { "title": "Abuja - Wikipedia", "url": "https://en.wikipedia.org/wiki/Abuja", "content": "Abuja is the capital…", "score": 0.89 }
      ] },
      "error": null
    },
    {
      "id": "call_def",
      "tool": "weather",
      "status": "completed",
      "input": { "city": "Abuja" },
      "summary": "Retrieved current weather for Abuja, Nigeria",
      "data": { "kind": "weather", "city": "Abuja", "country": "Nigeria", "temperature_c": 31,
                "description": "Partly cloudy", "humidity": 54, "wind_speed_kmh": 11,
                "observation_time": "01:45 PM", "local_time": "2026-11-03 14:45", "icon_url": "https://…" },
      "error": null
    }
  ]
}
```
- `tool_events[].status`: `"running" | "completed" | "failed"`. The JSON endpoint only ever returns final states.
- `tool_events[].data`: discriminated union on `kind` (`"weather"` | `"search"`), or `null` on failure.
- `tool_events[].error`: `{ "code": "city_not_found" | "provider_error" | "timeout" | "not_configured" | "invalid_input", "message": "<safe text>" }` or `null`.
- `input` contains only the tool arguments (city or query). No prompts or reasoning.

### 5.3 `POST /api/v1/agent/stream` → `200 text/event-stream`
Same request body as `/query`. Each event is `event: <type>\ndata: <json>\n\n`:

| `event` | `data` | When |
|---|---|---|
| `session` | `{ "session_id" }` | First event, always |
| `status` | `{ "stage": "analyzing" \| "preparing_answer" }` | Run start; first answer token after tools |
| `tool_start` | `{ "id", "tool", "input" }` | The model issued a tool call |
| `tool_end` | full `ToolEvent` (as in 5.2) | Tool finished or failed |
| `token` | `{ "delta": "text" }` | Final-answer token chunks (AI message content only; tool-call chunks are never streamed) |
| `done` | full `AgentQueryResponse` | Explicit completion; the stream then closes |
| `error` | `{ "code", "message" }` | Terminal failure; the stream then closes |

Response headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`. A `: ping` comment is sent every 15 seconds so proxies (Render) don't drop idle streams. Validation errors (422) are returned as normal JSON **before** the stream opens.

### 5.4 Error envelope (all non-2xx)
```json
{ "error": { "code": "validation_error", "message": "message must not be empty", "details": [...] } }
```

| Status | `code` | Cause |
|---|---|---|
| 422 | `validation_error` | Bad payload (FastAPI/Pydantic) |
| 502 | `llm_provider_error` | OpenAI auth, rate-limit or availability failure |
| 504 | `agent_timeout` | Exceeded `AGENT_TIMEOUT_SECONDS` |
| 500 | `agent_execution_error` / `internal_error` | Anything else; generic message, details only in server logs |

Tool failures **do not** produce non-2xx responses. They appear as `status: "failed"` events, and the answer explains what couldn't be retrieved.

### 5.5 Docs
Swagger at `/docs`, ReDoc at `/redoc`, OpenAPI at `/openapi.json`, enabled in all environments.

---

## 6. Agent execution workflow

1. **Route** validates the request with Pydantic and calls `AgentService.run(message, session_id)` or `AgentService.stream(...)`.
2. **Service** resolves or creates `session_id` and builds the run config: `{"configurable": {"thread_id": session_id}, "recursion_limit": AGENT_MAX_STEPS}`.
3. **Agent** (`weather_agent.build_agent(settings)`, created once at startup and reused) is `create_agent(model=ChatOpenAI(model=OPENAI_MODEL, temperature=0, timeout, max_retries=2), tools=[tavily_search, weather], system_prompt=..., checkpointer=InMemorySaver())`. New tools only need appending to the `TOOLS` list.
4. **Loop** (handled by LangGraph): the model either answers directly (no tool, e.g. "What is 2+2?") or emits tool calls. Tools run and return `ToolMessage`s with content and artifacts, and the loop repeats until a final answer or the recursion limit.
   - "Weather in Lagos" → `weather(city="Lagos")`.
   - "President of Nigeria" → `tavily_search(...)` → summarised answer.
   - "Capital of Kenya + weather" → `tavily_search` → model extracts "Nairobi" → `weather(city="Nairobi")` → combined answer.
5. **Event collection:** the service iterates `agent.astream(..., stream_mode=["messages", "updates"])`:
   - `AIMessage.tool_calls` → `tool_start`
   - `ToolMessage` (+ artifact) → `tool_end` with summary/data/error
   - AI content chunks after the last tool round → `token`
6. **Finalize:** assemble `AgentQueryResponse`. `/query` consumes the same stream internally, so there is one code path and the two endpoints cannot drift.
7. **Failure handling:**
   - Tool error → structured result → model explains.
   - `GraphRecursionError` → graceful answer: "I couldn't finish within the step limit", with partial tool events.
   - OpenAI errors → 502 / `error` event.
   - Timeout → 504 / `error` event.
   - Client disconnect → task cancelled.
8. **Safety:** only tool names, arguments, status, summaries and structured results are emitted. Reasoning content, system prompts and raw provider payloads are never emitted. Logs record tool name, duration and status, never keys or full URLs.

### Tool specs

**`weather(city: str)`**
- Validation: 1–100 chars, trimmed, letters, spaces and `.,'-` (Unicode letters allowed, e.g. "São Paulo").
- Call: `GET {WEATHER_API_BASE_URL}/current` with `params={access_key, query, units: "m"}` and `httpx` timeouts (connect 5s, read 10s).
- Error mapping:
  - Weatherstack `success:false` code 615 → `city_not_found`
  - codes 101/102 → `not_configured`, logged as "invalid weather credentials"
  - other codes, or HTTP 5xx → `provider_error`
  - timeout → `timeout`
  - non-JSON or missing fields → `provider_error` ("malformed response")
- Returns `WeatherData`: `city`, `country`, `region`, `temperature_c`, `feels_like_c`, `description`, `humidity`, `wind_speed_kmh`, `observation_time`, `local_time`, `icon_url`. The city is the **resolved** location name (fixes R3).

**`tavily_search(query: str)`**
- Validation: 1–400 chars.
- Call: `AsyncTavilyClient.search(query, max_results=TAVILY_MAX_RESULTS, search_depth="basic")`, wrapped in `asyncio.wait_for`.
- Returns `SearchResults{query, results[{title, url, content (≤500 chars), score}]}`.
- An empty result is still `ok: true`, with the summary "No results found".
- API, auth and timeout failures are returned as structured errors.
- Result URLs are filtered to `http(s)` schemes only.

---

## 7. Frontend component architecture

Next.js App Router, TypeScript (strict), Tailwind CSS v4, `lucide-react`, Vitest + React Testing Library. npm is the package manager (Vercel default). Exact versions pinned in M6.

```
app/layout.tsx         fonts (next/font), theme script, metadata
app/page.tsx           <ChatLayout/>
components/
  ChatLayout           composes Sidebar + header + messages + input; owns responsive drawer state
  Sidebar              logo/name, New conversation, ConversationList, Clear conversation, Settings (theme toggle, "stored in this browser" note, API status)
  ChatHeader           conversation title, mobile menu button, theme toggle
  WelcomeScreen        intro + <SuggestedPrompts/>
  SuggestedPrompts     the 4 prompts from CLAUDE.md 3.2; click → submit
  ChatMessage          user/assistant bubbles; assistant: markdown answer + tool activity + cards
  ToolExecutionCard    one row per tool event; animated spinner/check/error icon; friendly label ("Searching the web", "Retrieving weather information")
  WeatherCard          location, temperature, description, humidity, wind, observation time; lucide weather icon mapped from description
  SearchResultCard     title, domain, snippet; <a target="_blank" rel="noopener noreferrer">, http(s) URLs only
  LoadingIndicator     typing dots / "Analyzing your request…"
  ErrorMessage         inline error with Retry
  ChatInput            auto-growing textarea; Enter = send, Shift+Enter = newline; disabled while streaming; Stop button aborts
hooks/
  useChat              sends via streamAgent(), reduces SSE events into the message state, AbortController
  useConversations     localStorage-backed list of conversations {id, session_id, title, messages, updatedAt}
lib/
  config.ts            reads/validates NEXT_PUBLIC_API_URL (default http://localhost:8000)
  api.ts               getHealth(), queryAgent(), streamAgent(); one request() helper; typed ApiError for HTTP, network and abort errors
  sse.ts               spec-compliant SSE parser over ReadableStream (handles chunk splits, multi-line data, comments)
  storage.ts           safe localStorage wrapper (try/catch, schema version)
types/agent.ts         mirrors backend Pydantic schemas exactly (ToolEvent, WeatherData, SearchResults, StreamEvent union…)
```

- **Activity timeline per assistant message:** "Analyzing your request" (`status: analyzing`) → one row per `tool_start`/`tool_end` → "Preparing your answer" (`preparing_answer`) → "Completed" (`done`).
- **Answer rendering:** the answer is rendered as Markdown with `react-markdown`, which is the one extra dependency and skips raw HTML by default, so it's safe.
- **Contract drift guard:** `types/agent.ts` is maintained by hand against the Pydantic schemas. *(The planned OpenAPI snapshot test was not implemented; a test only checks that the documented paths exist. See the engineering report, §10.)* Generated types are an option, but would add tooling.

---

## 8. Environment variables

### Backend (`backend/.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | — | Secret |
| `TAVILY_API_KEY` | yes | — | Secret |
| `WEATHER_API_KEY` | yes | — | Secret (Weatherstack access key) |
| `OPENAI_MODEL` | no | `gpt-4o-mini` (**see Q3**) | Any tool-calling chat model |
| `APP_ENV` | no | `development` | `development` \| `production`. Production: JSON logs |
| `FRONTEND_URL` | yes in prod | `http://localhost:3000` | CORS allowlist; comma-separated for multiple exact origins (e.g. production + a fixed preview domain). No wildcards |
| `LOG_LEVEL` | no | `INFO` | |
| `WEATHER_API_BASE_URL` | no | `https://api.weatherstack.com` | **Must be `https://`** (D13). The Weatherstack plan must support HTTPS |
| `SESSION_TTL_SECONDS` | no | `3600` | Idle session expiry |
| `SESSION_MAX_COUNT` | no | `500` | LRU cap on in-memory sessions |
| `SESSION_MAX_TURNS` | no | `20` | Messages of history sent to the model |
| `TAVILY_MAX_RESULTS` | no | `3` | 1–10 |
| `AGENT_MAX_STEPS` | no | `10` | LangGraph recursion limit |
| `AGENT_TIMEOUT_SECONDS` | no | `60` | |
| `PORT` | no | `8000` | Set by Render |

Secrets use `SecretStr`, so they are never printed in `repr` or logs.

### Frontend (`frontend/.env.example`): all server-only (M11)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BACKEND_API_URL` | yes in prod | `http://localhost:8000` outside production | FastAPI URL as reached from the Next.js server (Compose: `http://backend:8000`) |
| `BACKEND_API_ACCESS_KEY` | when the backend has a key | — | Equals the backend `API_ACCESS_KEY`; injected server-side |
| `ACCESS_CODES` | yes in prod (or `ALLOW_PUBLIC_ACCESS=true`) | — | `label:code,…`; codes ≥ 16 chars |
| `ACCESS_SESSION_SECRET` | with `ACCESS_CODES` | — | ≥ 32 chars; signs session cookies |
| `ACCESS_SESSION_TTL_HOURS` | no | `168` | |
| `ALLOW_PUBLIC_ACCESS` | no | `false` | Explicit opt-out of the gate in production |

`NEXT_PUBLIC_API_URL` was removed. The backend also gained `CLIENT_IP_DIAGNOSTICS` (default off). The root `.env` (Compose) holds `BACKEND_API_ACCESS_KEY` and optional gate settings.

---

## 9. Testing strategy

### Backend (pytest, pytest-asyncio, `respx` for httpx mocks, ruff, mypy)
Unit tests:
- Config: missing or invalid variables raise a readable error that doesn't include values.
- Weather tool: success, invalid city (615), invalid input, timeout, 5xx, malformed JSON, missing key. Also asserts the key never appears in logs or error output (`caplog`).
- Search tool: success, empty results, API error, timeout (`AsyncTavilyClient` mocked).
- Summaries and event mapping.

Agent and service tests use a **fake tool-calling chat model** (scripted `AIMessage`s with `tool_calls`):
- Direct answer with no tools.
- Weather-only selection.
- Search-only selection.
- Multi-tool search → weather.
- Tool failure handled gracefully.
- Recursion-limit stop.
- LLM error mapping.

Integration tests (`httpx.AsyncClient` + `ASGITransport`, agent service overridden through FastAPI dependencies):
- Health endpoint.
- `/query` happy path.
- 422 on invalid payloads (empty message, too long, bad session_id).
- 502/504 envelopes.
- SSE: event order `session → … → done`, every frame parseable JSON, an `error` event on failure, cancellation on disconnect.
- CORS: allowed origin vs disallowed origin.

None of these need real credentials. One opt-in `@pytest.mark.live` smoke test runs against real APIs only when keys are present; it is skipped by default.

### Frontend (Vitest, React Testing Library, jsdom, `tsc --noEmit`, ESLint, `next build`)
- Welcome screen render.
- Suggested prompt click submits.
- Message submission (Enter vs Shift+Enter).
- Loading state.
- Assistant answer render.
- Tool activity transitions.
- Weather card fields.
- Search result links (`rel`, domain, non-http URL rejected).
- Error state + retry.
- SSE parser edge cases (split chunks, multi-line data, comments).
- API client HTTP and network errors.

### End-to-end verification
Before marking complete: `docker compose up --build`, curl health, `/query` and `/stream`, and manually run the three CLAUDE.md scenarios through the UI. This needs real keys in `backend/.env`; if they aren't available, the final report will say so explicitly.

---

## 10. Deployment strategy

### Backend → Render (Docker)
- `backend/Dockerfile`, multi-stage:
  - Builder: `python:3.12-slim` + `uv sync --frozen --no-dev`.
  - Runtime: `python:3.12-slim`, copy `.venv` + `app/`, non-root user, `HEALTHCHECK` via Python urllib.
  - `CMD sh -c "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers"`.
- Render setup: Web Service → connect GitHub repo → Root Directory `backend` → Runtime Docker → set the environment variables (secrets + `APP_ENV=production` + `FRONTEND_URL=https://<app>.vercel.app`) → Health Check Path `/api/v1/health`.
- An optional `render.yaml` Blueprint documents the same settings.
- Free-tier caveats: cold starts (~50s) and in-memory sessions lost on spin-down. The UI shows a friendly "backend waking up / unreachable" error.
- Alternative: the same image on any container host (`docker build -t sw-agent-backend backend && docker run -p 8000:8000 --env-file backend/.env sw-agent-backend`), e.g. Fly.io, Railway, Cloud Run or a VM.

### Frontend → Vercel
- Import the repo → Root Directory `frontend` → framework Next.js (auto) → set `NEXT_PUBLIC_API_URL=https://<backend>.onrender.com` → deploy.
- Then set the backend's `FRONTEND_URL` to the Vercel domain and redeploy the backend.
- `next.config.ts` uses `output: "standalone"`, which is used by the Docker image and harmless on Vercel.

### Local Docker Compose
- `backend` service on port 8000 (`env_file: backend/.env`, at runtime only; never copied into the image) with a healthcheck.
- `frontend` service on port 3000, `depends_on: backend: condition: service_healthy`, with its own healthcheck.
- **Networking:** the browser runs on the host, so the frontend is built with `NEXT_PUBLIC_API_URL=http://localhost:8000` (build arg), not `http://backend:8000`. The backend's `FRONTEND_URL=http://localhost:3000`. The same values work for host-only development (`uvicorn` + `npm run dev`).
- `.dockerignore` files exclude `.env*`, `.venv`, `node_modules` and `.next`.

Deployment will **not** be performed or claimed without explicit authorization. Docs will describe the exact steps.

---

## 11. Implementation milestones

| # | Milestone | Exit criteria | Status |
|---|---|---|---|
| 1 | Repository audit + `spec.md` | This document; approved by owner | ✅ Approved 2026-11-03 |
| 2 | Backend skeleton + config | `uv` project, Settings with validation, structured logging, error envelope, health route, `.env.example`, ruff + mypy clean, health/config tests pass | ✅ 2026-11-03 |
| 3 | Weather + search tools | Async tools with Pydantic outputs and full error mapping; unit tests pass | ✅ 2026-11-03 |
| 4 | Agent + endpoints | `create_agent` orchestration, prompts, AgentService, `/query`, `/stream` SSE, CORS | ✅ 2026-11-03 (verified with mocked providers; **not yet verified against real OpenAI/Tavily/Weatherstack**, since no keys are available here) |
| 5 | Backend tests | Unit and integration suites from section 9 green; coverage report | ✅ 2026-11-03: 131 passed, 99% coverage; ruff + mypy --strict clean |
| 5a | Backend hardening (owner review) | Rate limiting, per-session lock, body-size limit, aggregated config errors, SSE contract docs | ✅ 2026-11-04: 157 passed, 99% coverage |
| 6 | Next.js init + UI | App scaffold, all components in section 7, theming, responsive | ✅ 2026-11-04 |
| 7 | API integration + SSE | `lib/api.ts`, SSE parser, `useChat`, localStorage conversations | ✅ 2026-11-04: verified in headless Chrome against the real backend (scripted LLM, mocked providers) |
| 8 | Frontend tests + build | Vitest green, `tsc`/ESLint clean, `next build` passes; legacy-file removal **deferred** until the owner confirms parity | ✅ 2026-11-04: 60 passed; lint/tsc clean; build OK. `app.py` and `requirements.txt` are still present by instruction |
| 9 | Docker + Compose | Both Dockerfiles; `docker compose up --build` healthy; curl checks pass | ✅ 2026-11-04: both images build; `docker compose up --build` reaches healthy/healthy; health, docs, CORS, headers and hardening verified; **real OpenAI, Tavily and Weatherstack (HTTPS) calls succeeded through the containers**, including multi-tool SSE and a headless-Chrome run |
| 10 | Deployment config + docs | `render.yaml`, README rewrite, backend/frontend READMEs, `.gitignore` hardening, final engineering report | ✅ 2026-11-04: root README rewritten (with screenshots), DEPLOYMENT.md rewritten, final report in `docs/ENGINEERING_REPORT.md` |
| 11 | Secure proxy + access gate + client-IP review | Same-origin route handlers with server-side bearer key, unbuffered SSE proxy, access gate, `CF-Connecting-IP` + keyed `X-Client-IP`, diagnostics endpoint; tests; Docker and browser verification | ✅ 2026-11-04: backend 179 passed (99%); frontend 132 passed; lint/tsc/build clean; Docker E2E and 13/13 headless-Chrome checks with real providers. Render client IP **unverified** (needs deployment) |

After each milestone: run tests, lint and type checks, review the diff, and update this table. No commits, pushes or deploys without explicit authorization.

---

## 12. Owner decisions (approved 2026-11-03)

- **Q1 → HTTPS required** (D13). No insecure override. If the current Weatherstack plan lacks HTTPS, report it and recommend an HTTPS-capable provider.
- **Q2 → Keep `app.py` and the root `requirements.txt` until M8.** Remove them only after verifying that Next.js fully replaces Streamlit. Keep the notebook usable on its own.
  - **Notebook dependency audit:** it imports `os`, `certifi` (unused), `python-dotenv`, `langchain-openai`, `langchain-community` (`TavilySearchResults`, deprecated), `langchain-classic` (`hub`, `create_react_agent`, `AgentExecutor`) and `langchain-core`, and runs on a Jupyter kernel (`ipykernel`). It reads `OPENAI_API_KEY` and `TAVILY_API_KEY` from `.env`. These legacy packages are incompatible in spirit with the new backend, which drops `langchain-community` and `langchain-classic`, so the notebook keeps **its own** requirements file (`research/requirements.txt`, created at M8) rather than sharing the backend's environment.
- **Q3 → `OPENAI_MODEL=gpt-4o-mini`** as the configurable default. It is never hardcoded in agent logic.
- **Q4 → In-memory sessions + localStorage are acceptable** for v1, with the separation and validation in D6/D6a.

### Original open questions (for the record)

- **Q1: Weatherstack HTTPS.** CLAUDE.md requires HTTPS. Weatherstack has historically served HTTPS **only on paid plans**; free keys get an `https_access_restricted` error. Proposal: default to `https://`, map that error to a clear `not_configured` message ("your Weatherstack plan doesn't support HTTPS"), and allow `WEATHER_API_BASE_URL=http://api.weatherstack.com` as a **documented, explicitly insecure** override for free-tier keys. Which plan is your key on?
- **Q2: Legacy files.** OK to delete `app.py` and move `requirements.txt` → `research/requirements.txt` once the Next.js UI reaches parity (M8)? The notebook itself stays untouched.
- **Q3: Default `OPENAI_MODEL`.** Proposed default is `gpt-4o-mini` (cheap, reliable tool calling). It's configurable, so tell me if you'd like a different default.
- **Q4: Session memory.** In-memory, single-worker server-side memory (D6) plus `localStorage` history in the browser. Acceptable for v1?

## 13. Implementation notes (Phase 2)

Deviations from the plan above, with reasons:

- **Extra modules:**
  - `core/errors.py`: error types and envelope handlers.
  - `schemas/tools.py`: tool output models.
  - `schemas/conversation.py`: `ChatTurn`, shared by the store and the agent without coupling them.
  - `services/session_store.py`: D6.
  - `tools/common.py`: `ToolFailure`.
  - `api/dependencies.py`: DI accessors.
  - `api/v1/sse.py`: SSE encoder with keep-alive and disconnect handling.
- **SSE contract refinements:**
  - Every `data:` JSON object repeats its `event` name, which simplifies TypeScript discriminated unions.
  - `session` also carries `is_new_session`.
  - `tool_end` and `done` are flat (`ToolEvent` / `AgentQueryResponse` fields at the top level).
  - `token` deltas after the most recent `tool_start` form the answer draft, and `done.answer` is authoritative.
- **`/query` response** gained `is_new_session` (D6a).
- **Message length** is a schema constant (`MAX_MESSAGE_CHARS = 4000`), not an environment variable.
- **Separate `httpx.AsyncClient` per provider (security).** The Tavily SDK writes `Authorization: Bearer <key>` into the default headers of any client it is given, so a shared client would leak the Tavily key to Weatherstack.
- **Log redaction** happens in the formatter, on the final output including tracebacks. `httpx`, `httpx2` (used by the OpenAI SDK), `httpcore` and `openai` loggers are raised to WARNING because they log request URLs, and Weatherstack URLs contain the key.
- **The Tavily SDK maps a missing `results` key to `[]`**, so it is treated as "no results". `results` of the wrong type is a `provider_error`.
- **Additional environment variables:** `OPENAI_TIMEOUT_SECONDS`, `WEATHER_TIMEOUT_SECONDS`, `TAVILY_TIMEOUT_SECONDS`.
- **Run command:** `uvicorn --factory app.main:create_app`.
- **Backend Dockerfile** is deferred to M9, per milestone order.

### Hardening (after Phase 2 review)

- **Rate limiting** (`core/rate_limit.py`): in-memory sliding window per client IP on `/agent/query` and `/agent/stream`, default 20 requests per 60 seconds.
  - Over the limit: 429 `rate_limited` with a `Retry-After` header, which CORS exposes to the browser.
  - Invalid requests count towards the limit; `/health` is exempt.
  - The limiter sits behind a `RateLimiter` protocol.
- **Concurrency** (`SessionStore.lock`): one turn per session at a time. A second, concurrent request gets `session_busy` (409, or an SSE `error` event) instead of being queued. History is read *after* the lock is taken.
  - This exposed and fixed a bug: `AgentService.run()` returned without closing the stream generator, which left the lock held. It now uses `contextlib.aclosing`.
- **Request size** (`core/middleware.py`): 413 when `Content-Length` exceeds `MAX_REQUEST_BODY_BYTES` (16 KiB). Chunked or mislabelled bodies are counted as they are read, then replayed to the app.
  - The first approach (raising while the route read the body) was turned into a 400 by FastAPI, so the middleware now buffers and checks the body itself.
- **Config:** the production `FRONTEND_URL` requirement is now a field validator, so every missing or invalid setting is reported in one error.
- **Contract change, documented:** a *malformed* `session_id` (any string up to 64 characters) now starts a new server-generated session (`is_new_session: true`) instead of returning 422.
  - Why: the owner asked that invalid or expired IDs both return a new server ID, so corrupted client state self-heals.
  - Strings over 64 characters and non-strings are still 422.
- **SSE contract:** no wire changes. The client algorithm is now documented in the backend README ("Streaming contract") and in the OpenAPI description:
  - discard the draft at `tool_start`;
  - replace it with `done.answer`;
  - `done` and `error` are the only terminal events;
  - errors before the stream opens are JSON, errors after it opens are `error` events.
  - Tests now cover preamble text before tool calls; the scripted test LLM streams content before tool-call chunks, as OpenAI does.
- **Exposure warning:** the API has no authentication. The backend README states that it must not be exposed publicly without access protection.

### Frontend (Phase 3)

- **Stack:** Next.js 16.4.4, React 19.3, TypeScript 5.9 (strict), Tailwind 4, lucide-react, react-markdown (answers only; raw HTML is never rendered), Vitest 5 + React Testing Library + jsdom 29.
- **Compatibility choices:**
  - ESLint 9: `eslint-plugin-react`, which `eslint-config-next` uses, does not support ESLint 10 yet.
  - jsdom 29: jsdom 30 needs Node ≥ 24.15, and the dev machine has 24.8.
  - TypeScript 5.9 rather than 7.
- **Scaffold changes:** switched off the scaffold's default `cacheComponents` and `partialPrefetching`, which a client-only chat app doesn't need. Fixed the scaffold `.gitignore`, which ignored `.env.example`.
- **Client-only app:** the chat app reads localStorage on first render, so it is loaded with `next/dynamic` and `ssr: false`; the page shell is still prerendered. A pre-paint script applies the saved theme to avoid a flash.
- **API client:** `lib/api.ts` is the only module that calls the backend. It returns `ApiError` with backend codes, plus the client codes `network_error`, `aborted`, `stream_interrupted`, `invalid_response` and `http_error`. After the terminal event the client cancels the reader, which Chrome logs as `ERR_ABORTED` on `/agent/stream`; this is expected.
- **Persistence:** conversations are stored per browser in a versioned localStorage store (maximum 50). The UI says they are stored in this browser only.
- **Design:** fog and ink-navy palette, teal signal colour, amber reserved for weather. Bricolage Grotesque for headings, IBM Plex Sans for body text. The weather card is styled as a station readout, with isobar lines whose hue follows the temperature.

### Docker and deployment preparation

- **Images:**
  - Backend: `python:3.11-slim`, uv `--frozen --no-dev` venv in a build stage, non-root, read-only code, one uvicorn worker on `$PORT`, `--no-proxy-headers`, `HEALTHCHECK`.
  - Frontend: `node:24-bookworm-slim` build with `npm ci`, then the `standalone` server on `node:24-alpine` as `node`, `HEALTHCHECK`.
  - The `# syntax=` directive was dropped: it adds an extra image pull, and that pull hung on this network.
- **Compose:** `backend/.env` is passed via `env_file` at runtime. The frontend is built with a browser-reachable `NEXT_PUBLIC_API_URL` (`http://localhost:8000`, never `http://backend:8000`) and `depends_on` the healthy backend. Both services run with read-only root filesystems, `tmpfs` `/tmp`, `cap_drop: ALL` and `no-new-privileges`.
- **Fonts:** switched from `next/font/google` to `next/font/local` with vendored Latin WOFF2 files (Fontsource 5.3.0, SIL OFL, 136 KB), so builds no longer download from Google Fonts. The scaffold `favicon.ico` was replaced by `app/icon.svg`.
- **Client IP (new `core/client_ip.py`).** Render's `X-Forwarded-For` is client-appendable (sources in DEPLOYMENT.md), so uvicorn's proxy-header handling is off. A single `CLIENT_IP_HEADER` (Render: `True-Client-IP`) is honoured only from peers in `TRUSTED_PROXY_CIDRS`.
- **Access control:** optional `API_ACCESS_KEY` bearer auth on `/agent/*` (`401 unauthorized`; rate limiting runs first). **Production fail-safe:** startup is refused unless `API_ACCESS_KEY` is set or `ALLOW_PUBLIC_AGENT_API=true`. The recommended BFF proxy (DEPLOYMENT.md §5, option A) is proposed and not implemented.
- **Verified:**
  - Images: backend 365 MB, frontend 326 MB as reported by Docker Desktop's store; `node:24-alpine` alone reports 244 MB there.
  - Real-provider runs: the Lagos weather query (Weatherstack HTTPS works with the owner's key), "capital of Kenya + weather" via SSE (`tavily_search` → `weather(Nairobi)` → answer), and a browser run through the containers.
  - In a CPU-loaded Docker VM, Python imports took 17–22 s, so the backend health check's start period is 60 s in the image and 90 s in Compose.
- **Test isolation:** tests no longer read `backend/.env` (`Settings.model_config["env_file"]` is patched to `None`); the live tests load it explicitly.

### Secure proxy, access gate and final readiness (M11)

- **Proxy (`frontend/src/server/backend.ts`, `src/app/api/*`).**
  - Validates requests before forwarding: JSON content type (415); 16 KiB limit by `Content-Length` and while reading (413); JSON (400); the backend schema, with message length in code points like Python (422).
  - Forwards only `message` and `session_id`, never browser headers or cookies.
  - Error handling:
    - backend 409, 413, 422, 429 (+`Retry-After`), 500, 502 and 504 keep their status, code and message;
    - backend 401/403, 404 and non-envelope responses become a generic 502, logged server-side;
    - network failure → 502, timeout (110 s) → 504, client abort → 499.
- **SSE (`src/server/sseProxy.ts`).**
  - Chunk-by-chunk pass-through with `highWaterMark: 0`, so the proxy never reads ahead.
  - The `SSEParser` already used by the browser watches for the terminal event; a stream that fails or ends without `done`/`error` gets a synthesized `stream_interrupted` error frame, prefixed by blank lines so a truncated event cannot merge with it.
  - Browser disconnect cancels the upstream body and aborts the fetch (`request.signal`). Verified in Docker: the backend logged `stream_client_disconnected` and the agent turn did not complete.
- **Access gate (`src/proxy.ts`, `src/server/access.ts`).**
  - Cookie `v1.<label>.<exp>.<HMAC(secret, label, exp, sha256(code))>`. Removing or changing a code revokes its sessions; rotating the secret revokes all.
  - Codes are compared in constant time over all entries.
  - Login is a plain form with a 303 redirect.
  - Failed attempts: 5 per client and 50 globally per 15 minutes, in memory.
  - Route handlers re-check access, so the matcher is not the only line of defence (the Next.js docs recommend this).
- **Bug found during Docker verification and fixed:** redirects built from `request.url` pointed at `http://0.0.0.0:3000/` behind the standalone server. Redirects now use relative `Location` headers.
- **Test stabilisation.** The ChatApp end-to-end test raced on a transient "Searching the web" label: under load, React rendered `tool_start` and `tool_end` in one batch, so the label never appeared. The test now holds the stream at `tool_start` deterministically. Whole-app jsdom tests got a 15 s budget; the machine's load average was about 100 on 8 cores during verification.
- **Compose.** The backend now requires `API_ACCESS_KEY` locally too, read from the root `.env`. Ports are bound to `127.0.0.1`. `BACKEND_API_URL=http://backend:8000` is correct now that calls are server-side. The frontend image contains no configuration, and its health check uses `/access`.
- **Observed provider behaviour:** Weatherstack intermittently failed (a ConnectError, a timeout and an HTTP error in about 12 calls; immediate retries succeeded). The tool mapped each to a structured failure and the agent reported it honestly. A single retry on transient errors is a possible improvement and is not implemented.

## 14. Change log
- 2026-11-03: Initial audit and plan (Milestone 1).
- 2026-11-03: Owner decisions recorded (§12, D6/D6a/D10/D13/D14). Backend milestones 2–5 implemented and verified with mocked providers.
- 2026-11-04: Backend hardening (rate limiting, session lock, body limit, config aggregation, SSE contract docs). Next.js frontend implemented, tested and verified in headless Chrome.
- 2026-11-04: Docker images, Compose, Render Blueprint, deployment guide and security review; client-IP resolution and an optional access key with a production fail-safe.
- 2026-11-04: M11, secure Next.js proxy (same-origin routes, server-side bearer key, unbuffered SSE pass-through), app-level access gate, `CF-Connecting-IP` + keyed `X-Client-IP`, client-IP diagnostics endpoint, root README and DEPLOYMENT.md rewritten, final engineering report. D8 superseded; D15, D16 added.

## 15. Final verification (2026-11-04)

| Check | Result |
|---|---|
| Backend pytest | **179 passed**, 2 live tests deselected (opt-in), coverage **99%** |
| Backend Ruff check / format | clean / 51 files formatted |
| Backend mypy `--strict` (configured for `app`) | no issues in 34 source files |
| Frontend Vitest | **132 passed** (8 files): UI (jsdom) plus 40 proxy/SSE and 30 access-gate tests (node). 6/6 consecutive full runs green under heavy machine load |
| Frontend ESLint / `tsc --noEmit` | 0 problems / 0 errors |
| `next build` | success; `/`, `/access` and the 5 API routes are dynamic; Proxy registered |
| Secret scan of the build | build run with sentinel values for all 4 secrets: none found anywhere in `.next/` |
| Docker images | backend and frontend built |
| `docker compose up` | both services healthy; ports on 127.0.0.1 |
| Backend direct, no key | `POST /api/v1/agent/query` → 401; health and docs → 200 |
| Proxy validation via Docker | 422, 415, 400, 413, 403 (cross-site) as specified |
| Real providers via proxy | JSON: Lagos → `weather` → answer. SSE: Kenya → `tavily_search` → `weather(Nairobi)` → answer; events arrived progressively (tools at 1.5 s and 5.8 s, `done` at 11.4 s, 89 token events), no compression |
| Disconnect | aborting curl mid-stream → backend `stream_client_disconnected`, no `agent_turn_completed` |
| Access gate via Docker | anonymous page → 307 `/access`; API → 401; forged cookie → 401; login → 303 + `HttpOnly; SameSite=Lax` cookie; logout clears it; changing a code revokes its live session (200 → 401); 5 failures → `locked` with `Retry-After: 900`, even for the correct code; logs contain no codes |
| Headless Chrome (real providers) | 13/13 checks: redirect to gate, wrong code rejected, cookie not readable by JS, sign-in, streaming, weather card, 3 sources with `noopener noreferrer`, mobile dark weather card, **no request off-origin, none with `Authorization`, none to :8000** |
| Spoofed client-IP headers (tests) | `CF-Connecting-IP`, `True-Client-IP`, `X-Forwarded-For` from untrusted peers and `X-Client-IP` without the key do not change the rate-limit identity |
| Render client-IP behaviour | **Not verified**: needs a deployed service (procedure in DEPLOYMENT.md §3.2) |
| Deployment | **Not performed** (not authorised) |
