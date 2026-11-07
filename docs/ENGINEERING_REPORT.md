# Engineering report: Search + Weather Agentic AI Assistant

**Date:** 2026-11-04, deployment addendum 2026-11-07 · **Base commit:** `be395ca` (`main`) · **State:** all milestones implemented and verified locally (2026-11-04), merged as PR #1 (`2c28726`), and **deployed to Render and Vercel on 2026-11-07** (§12).

## 1. Original architecture

- A single Streamlit script, `app.py` (123 lines), held UI, configuration, tools, prompt and agent execution, all run at import time.
- A deprecated LangChain ReAct agent (`create_react_agent` + `AgentExecutor`, prompt pulled from LangChain Hub at runtime, text-parsed actions).
- `TavilySearchResults` from `langchain_community` for search, and a synchronous `requests` call to Weatherstack over **plain HTTP** with the key in the URL.
- `requirements.txt` had 9 unpinned dependencies. There were no tests, no Docker files, no API and no streaming.
- An exploration notebook (`research/agent-demo.ipynb`, search tool only).

Full audit: `spec.md` §1–2.

## 2. New architecture

```
Browser ─ same-origin /api/* + HttpOnly access cookie ─▶ Next.js server (Vercel)
          proxy.ts gate · route handlers validate, inject Bearer key, stream SSE unbuffered
        ─ HTTPS + Authorization: Bearer + X-Client-IP ─▶ FastAPI (Render, Docker)
          auth · rate limit · body limit · AgentService (sessions, events, timeout)
          LangChain create_agent (OpenAI tool calling, ≤10 steps, 60 s)
            ├─ tavily_search (AsyncTavilyClient)
            └─ weather (HTTPX → Weatherstack, HTTPS only)
```

- **Backend:** FastAPI app factory, Pydantic Settings with aggregated validation errors, structured and redacted logging, a uniform error envelope, async tools with structured (Pydantic) outputs and structured failures, an in-memory session store and rate limiter behind protocols, and SSE with keep-alive and disconnect cancellation.
- **Frontend:** Next.js 16 App Router, a strict-TypeScript chat UI (streaming, tool activity, weather and source cards, localStorage history, light and dark themes), a same-origin server-side proxy, and an access gate.
- **Ops:**
  - multi-stage, non-root, read-only Docker images;
  - Compose with health checks and loopback-only ports;
  - a Render Blueprint;
  - Vercel instructions.

Decisions D1–D16 and their rationale are in `spec.md` §3.

## 3. Files created

All of these are new and currently untracked; about 143 files, plus the vendored fonts.

- **Backend (`backend/`):**
  - `app/{main.py, api/, agents/, tools/, services/, schemas/, core/}`;
  - tests in `tests/unit` (11 modules) and `tests/integration` (API + opt-in live);
  - `pyproject.toml`, `uv.lock`, `Dockerfile`, `.dockerignore`, `.env.example`, `.python-version`, `README.md`.
- **Frontend (`frontend/`):**
  - `src/app` (layout, page, access page, API route handlers), `src/proxy.ts`, `src/server/*`, `src/components/*` (the 12 required components plus helpers);
  - `src/hooks/*`, `src/lib/*`, `src/types/agent.ts`, tests;
  - `Dockerfile`, `.env.example`, configuration files, `README.md`.
- **Root:** `docker-compose.yml`, `render.yaml`, `.env.example`, `spec.md`, `docs/DEPLOYMENT.md`, `docs/ENGINEERING_REPORT.md`, `docs/screenshots/*.png`.

**Added in this milestone (M11):**

| Area | Files |
|---|---|
| Proxy | `frontend/src/app/api/{health,agent/query,agent/stream}/route.ts`, `frontend/src/server/{backend,sseProxy,http,config}.ts` |
| Access gate | `frontend/src/proxy.ts`, `frontend/src/server/{access,loginLimiter}.ts`, `frontend/src/app/access/page.tsx`, `frontend/src/app/api/access/{route.ts,logout/route.ts}` |
| Backend | `backend/app/api/v1/routes/diagnostics.py`, `backend/app/schemas/diagnostics.py` |
| Tests | `frontend/src/app/api/proxy.test.ts` (40), `frontend/src/server/access.test.ts` (30), `frontend/src/test/server.ts`; new backend tests in `tests/unit/test_client_ip.py` and `tests/integration/test_api.py` |
| Docs | `.env.example` (root), `docs/ENGINEERING_REPORT.md`, `docs/screenshots/` |

## 4. Files modified

- **Tracked files:** `README.md` (rewritten for the new application) and `.gitignore` (environment, Python, Node and editor patterns).
- **Earlier-milestone files changed in M11:**
  - Backend: `app/api/dependencies.py`, `app/core/{client_ip,config}.py`, `app/api/v1/router.py`, `tests/conftest.py`, `Dockerfile` (comment), `.env.example`, `README.md`.
  - Frontend: `src/lib/{api,config}.ts`, `src/app/page.tsx`, `src/components/{ClientApp,ChatApp,SettingsPanel,ErrorMessage}.tsx`, `src/hooks/useBackendHealth.ts`, tests (`api.test.ts`, `ChatApp.test.tsx`, `components.test.tsx`, `test/setup.ts`), `vitest.config.mts`, `Dockerfile`, `.env.example`, `README.md`.
  - Root: `docker-compose.yml`, `render.yaml`, `docs/DEPLOYMENT.md`, `spec.md`.
- **Not modified:** `app.py`, `requirements.txt` and `research/agent-demo.ipynb`, as instructed.

## 5. Features preserved

- Web search with Tavily.
- Current weather by city with Weatherstack.
- Multi-step reasoning and tool selection, including chaining (search → weather).
- The chat-style interaction (Streamlit's single question box became a full chat).
- The research notebook, unchanged.

## 6. Features improved

| Area | Change |
|---|---|
| Agent | Native tool calling (no text parsing) via LangChain 1.x `create_agent`. Prompts live in code with the current date. Direct answers are allowed. Bounded steps and time. Structured tool failures, and no fabricated results |
| Tools | Async I/O with timeouts. HTTPS-only Weatherstack (the key is never sent over HTTP). City validation. Full error mapping (invalid or unknown city, plan, timeout, malformed). Keys redacted from logs. Separate HTTP clients so the Tavily token cannot leak to Weatherstack |
| API | Typed REST + SSE contracts, a uniform error envelope, health endpoint, Swagger |
| UX | Token streaming, a live activity timeline, weather and source cards, history, themes, responsive layout, retry and stop |
| Security | Server-side proxy (no keys or backend URL in the browser), access gate with per-person revocation, production fail-safes on both tiers, rate limits keyed to the real end user, body and size limits, CSRF and open-redirect protection, non-root read-only containers |
| Engineering | Locked dependencies (uv, npm), strict typing (mypy `--strict`, TypeScript strict), ~311 automated tests, Docker, deployment docs |

## 7. Tests executed (final run, 2026-11-04)

| Suite | Result |
|---|---|
| Backend `pytest` | **179 passed**, 2 live tests deselected (opt-in), **99% coverage** |
| Backend Ruff (`check`, `format --check`) | clean |
| Backend mypy `--strict` | no issues (34 files) |
| Frontend Vitest | **132 passed** (8 files), including 40 proxy/SSE and 30 access-gate tests; 6/6 consecutive full runs green |
| Frontend ESLint / `tsc --noEmit` | clean |

The proxy tests cover:
- split network chunks, including split UTF-8 and every 5 bytes;
- multiple events per chunk, unbuffered first-chunk delivery, and terminal `done` and `error` pass-through;
- synthesized `stream_interrupted` events on upstream EOF or error;
- upstream cancellation on browser disconnect and upstream abort on request abort;
- status and `Retry-After` preservation, and sanitization of 401, HTML and network errors;
- body limits by header and while streaming, schema validation, cross-site rejection, and the access requirement.

The gate tests cover token tamper and expiry, revocation by code removal, code change and secret rotation, constant-time matching, safe redirects, the lockout, cookie attributes, and proxy matcher behaviour.

Two test-quality issues were found and fixed:
1. A ChatApp test raced on a transient UI state; it is now deterministic.
2. Whole-app jsdom tests needed a 15 s budget on a machine at a load average of about 100.

## 8. Production build results

- `next build` succeeds. `/`, `/access` and the five API routes are dynamic; the Proxy is registered.
- A build with sentinel values for `BACKEND_API_URL`, `BACKEND_API_ACCESS_KEY`, `ACCESS_CODES` and `ACCESS_SESSION_SECRET` contained **none** of them anywhere in `.next/`. A scan of the 590 KB of HTML and JS served by the running container found neither the key nor the backend address.

## 9. Docker verification results

- Both images build. `docker compose up` reaches healthy/healthy, with ports on 127.0.0.1.
- Direct backend agent call without the key → 401.
- Proxy validation → 422, 415, 400, 413 and 403 as specified.
- **Real providers through the proxy:**
  - JSON Lagos weather;
  - SSE Kenya: `tavily_search` → `weather(Nairobi)` → answer, with events arriving progressively (tools at 1.5 s and 5.8 s, `done` at 11.4 s, 89 token events, no compression).
- **Disconnect:** aborting mid-stream → backend `stream_client_disconnected`, and the turn did not complete.
- **Access gate:**
  - redirect and 401 for anonymous and forged-cookie requests;
  - login sets an HttpOnly, SameSite=Lax cookie; logout clears it;
  - changing a code revoked a live session;
  - 5 failures → lockout with `Retry-After: 900`;
  - logs contain no codes.
- **Headless Chrome, 13/13 checks.** The browser made requests only to its own origin (`POST /api/access`, `GET /api/health`, `POST /api/agent/stream`), never with an `Authorization` header and never to `:8000`.
- **Bug found and fixed during this verification:** login redirects pointed at `http://0.0.0.0:3000` behind the standalone server; they now use relative `Location` headers.

## 10. Remaining limitations

- **Deployed on 2026-11-07** (§12). The Render client-IP header (`CF-Connecting-IP`) and the forwarded end-user IP through the Vercel proxy are verified on production.
- **Cancellation through Vercel (found in production):** a stream abandoned by the browser keeps running on the backend until the turn completes (it worked in Docker). Spend is bounded by the 60 s turn cap and the rate limit. A fix is recommended in `spec.md` §16.4.
- **One intermittent SSE stall** was observed on Vercel (cold start) and not reproduced.
- **In-memory sessions and rate limits:** single backend instance; reset on restart or Render sleep. Browser-only history.
- **Access-attempt limiting:** per server instance, so best effort on Vercel; strong codes are the primary control.
- **Self-hosted frontend (non-Vercel):** no trustworthy end-user IP, so proxied traffic shares one backend rate-limit bucket.
- **Weatherstack:** intermittent failures were observed (3 in about 12 calls); handled honestly but not retried.
- **Legacy files:** `app.py` and `requirements.txt` remain by instruction. The notebook still uses the legacy, unpinned requirements.
- **Contract sync:** `types/agent.ts` is maintained by hand against the Pydantic schemas. There is no automated contract check. The OpenAPI snapshot test proposed in `spec.md` §7 was not implemented; a test only checks that the documented paths exist.

## 11. Exact deployment steps

Full detail is in `docs/DEPLOYMENT.md`.

1. **Generate secrets:** `openssl rand -hex 32` (shared API key), `openssl rand -hex 32` (session secret), and one `openssl rand -base64 18` per reviewer code.
2. **Render:**
   - New → Web Service → connect the repo. Root Directory `backend`, Runtime Docker, 1 instance, Health Check Path `/api/v1/health`.
   - Set `OPENAI_API_KEY`, `TAVILY_API_KEY`, `WEATHER_API_KEY`, `API_ACCESS_KEY`, `APP_ENV=production`, `FRONTEND_URL=<vercel origin>` and `CLIENT_IP_HEADER=CF-Connecting-IP`. (Or use New → Blueprint with `render.yaml`.)
   - Deploy. `curl <render>/api/v1/health` should return 200; a direct `POST /api/v1/agent/query` should return 401.
3. **Verify the client IP:** set `CLIENT_IP_DIAGNOSTICS=true`, run the three curls in DEPLOYMENT.md §3.2, check the expectations, then turn it off and record the result in `spec.md`.
4. **Vercel:**
   - Add New → Project → Root Directory `frontend`, Node 24.
   - Set `BACKEND_API_URL=https://<service>.onrender.com`, `BACKEND_API_ACCESS_KEY=<API_ACCESS_KEY>`, `ACCESS_CODES=<label:code,…>` and `ACCESS_SESSION_SECRET=<secret>`, then deploy.
5. **Finish:**
   - Set the backend `FRONTEND_URL` to the final Vercel origin and redeploy the backend.
   - Run the post-deployment checklist (DEPLOYMENT.md §6): gate redirect, 401 without a cookie, sign-in, streaming answer, DevTools shows only same-origin requests without `Authorization`, and revocation works.
6. **Cost controls:** set an OpenAI budget cap and alerts, and choose provider plans that stop instead of bill overage.

## 12. Production deployment (M12, 2026-11-07)

**URLs:** backend https://search-weather-backend.onrender.com (Render free plan, 1 instance); frontend https://search-weather-agent.vercel.app (Vercel Hobby, access gate). Deployed from `2c28726` with no code changes. Secrets were entered by the owner in each provider's dashboard and never appeared in output or documents. The full evidence is in `spec.md` §16 and `docs/DEPLOYMENT.md` §7.

**How each result was established:**

| Level | What |
|---|---|
| Verified locally (Docker, 2026-11-04) | Everything in §7–§9, including the browser network audit in headless Chrome, and disconnect cancellation |
| Deployed | Both services live; Render startup shows production, API-key auth, one process, and the exact Vercel CORS origin |
| Verified with production requests | Backend health; 401 for missing, wrong and malformed keys; 422 validation; CORS allow and deny; diagnostics off. Render edge headers (Cloudflare rejects a client `CF-Connecting-IP` with 403; `True-Client-IP` overwritten; `X-Forwarded-For` client-appendable, unused). Rate limiting through the proxy keyed on the visitor's real IP, with 7 spoofed headers ignored. Gate on pages and APIs; login, logout and cookie flags; CSRF and open-redirect guards; revocation of one code; session-secret rotation; lockout. JSON and SSE through the proxy with real OpenAI, Tavily and Weatherstack calls; progressive delivery. No secrets or backend URL in client assets |
| **Failed in production** | Browser cancellation through Vercel: the backend turn keeps running (direct aborts to Render are cancelled) |
| Observed once, not reproduced | An SSE stream that stalled after `tool_start` on a cold start |
| Not verified | Browser DevTools and UI rendering on production by a person; a second real visitor on another network; IPv6 clients |
