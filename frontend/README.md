# Search + Weather Assistant: Frontend

Next.js (App Router) chat interface for the FastAPI agent in [`../backend`](../backend). Answers stream over Server-Sent Events, tool activity shows as it happens, weather results render as structured cards and search results as clickable sources.

The browser never talks to the backend directly. It calls this app's **same-origin `/api/*` route handlers**, which validate the request, add the backend's bearer token **on the server** and forward the call. An optional **access gate** restricts the whole app (pages and API routes) to people holding an access code.

## Requirements

- Node.js **24** (`.nvmrc`)
- The backend running and reachable **from this server** (default `http://localhost:8000`)

## Setup and run

```bash
cd frontend
npm ci
cp .env.example .env.local      # optional in development: the defaults work with a local backend
npm run dev                     # http://localhost:3000
```

All variables are **server-only**: there are no `NEXT_PUBLIC_*` variables, nothing is inlined into the browser bundle, and changes take effect on restart (no rebuild).

| Variable | Default | Description |
|---|---|---|
| `BACKEND_API_URL` | `http://localhost:8000` outside production; **required in production** | FastAPI base URL as reached from this server (Compose: `http://backend:8000`; Vercel: `https://<service>.onrender.com`) |
| `BACKEND_API_ACCESS_KEY` | none | Must equal the backend's `API_ACCESS_KEY`; sent as `Authorization: Bearer …` |
| `ACCESS_CODES` | none | Turns the access gate on. Comma-separated `label:code` pairs, one per person; codes ≥ 16 characters |
| `ACCESS_SESSION_SECRET` | none | Required with `ACCESS_CODES`; ≥ 32 characters; signs session cookies |
| `ACCESS_SESSION_TTL_HOURS` | `168` | Session lifetime |
| `ALLOW_PUBLIC_ACCESS` | `false` | A production build **refuses every request** without `ACCESS_CODES` unless this is `true` |

## API routes (same origin)

| Route | Forwards to | Notes |
|---|---|---|
| `GET /api/health` | `GET /api/v1/health` | Returns only `status`, `service`, `version`, `environment` |
| `POST /api/agent/query` | `POST /api/v1/agent/query` | JSON answer |
| `POST /api/agent/stream` | `POST /api/v1/agent/stream` | SSE, forwarded chunk by chunk without buffering |
| `POST /api/access` | (none) | Access-code form → session cookie |
| `POST /api/access/logout` | (none) | Clears the cookie |

**Validation before forwarding:** `Content-Type: application/json` (415), body ≤ 16 KiB by `Content-Length` *and* while reading (413), valid JSON (400), and the backend's schema: non-blank `message` of ≤ 4000 code points, `session_id` null or ≤ 64 characters (422). Only `message` and `session_id` are forwarded. Cross-site POSTs are refused (403). Every API route checks access itself, in addition to `proxy.ts`.

**Error handling:** backend 409, 413, 422, 429 (with `Retry-After`) and its own 500/502/504 keep their status, error code and fixed message. Backend authentication failures (a wrong `BACKEND_API_ACCESS_KEY`), unknown routes and non-envelope responses (for example a platform error page) become a generic `502 backend_unavailable`, logged on the server. Network failures → `502 backend_unreachable`; timeouts (110 s) → `504 upstream_timeout`. Backend URLs, keys and raw upstream bodies are never returned.

**Streaming:** bytes are passed through as they arrive, so event boundaries are preserved, and responses carry `Cache-Control: no-cache, no-transform` (which also stops compression from buffering). If the browser disconnects, the upstream request is aborted, which cancels the agent run on the backend. If the backend connection drops before a terminal event, the proxy appends a sanitized `error` event (`stream_interrupted`), so the browser always receives `done` or `error`.

## Access gate

- `/access` shows a plain HTML form (works without JavaScript). A correct code sets an **HttpOnly, SameSite=Lax** cookie (`Secure` over HTTPS) holding `v1.<label>.<expiry>.<HMAC>`. The cookie never contains the code.
- The HMAC covers a hash of the code, so a session stays valid only while its label still has the same code.
  - **Grant:** add a `label:code` pair and redeploy or restart.
  - **Revoke one person:** remove or change their pair. Their existing sessions stop working immediately.
  - **Revoke everyone:** rotate `ACCESS_SESSION_SECRET`.
- **Failed attempts:** 5 per client per 15 minutes, and 50 in total per 15 minutes. After that, attempts are refused with `Retry-After`, even with the correct code.
  - The counters are in memory: exact on a single server (Docker), best effort on Vercel, where each function instance counts separately.
  - The real protection is code strength: 16 or more random characters, e.g. `openssl rand -base64 18`.
- "Sign out of this demo" in Settings clears the cookie.

## Docker

```bash
docker build -t search-weather-frontend .
docker run --rm -p 3000:3000 -e BACKEND_API_URL=http://host.docker.internal:8000 \
  -e BACKEND_API_ACCESS_KEY=... -e ALLOW_PUBLIC_ACCESS=true search-weather-frontend
```

The image contains no configuration or secrets. It runs the `standalone` server on `node:24-alpine` as a non-root user. Fonts are vendored (`src/app/fonts`). The full stack (`docker compose up --build`) and Vercel deployment are covered in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server (`output: "standalone"` for Docker) |
| `npm test` | Vitest: React Testing Library (jsdom) for the UI, node environment for route handlers, proxy and gate. No backend needed; `fetch` is mocked |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | `tsc --noEmit` (strict mode) |

## How it works

```
src/
  proxy.ts             access gate for pages and API routes (Next.js 16 "proxy", formerly middleware)
  app/
    page.tsx           chat page (rendered per request) -> ClientApp
    access/page.tsx    access-code form
    api/               route handlers: health, agent/query, agent/stream, access, access/logout
  server/              server-only: config, backend proxy, SSE pass-through, access gate, login limiter
  components/          ChatApp (container) + presentational components
  hooks/               useChat, useConversations (localStorage), useTheme, useBackendHealth, useStickToBottom
  lib/
    api.ts             the only browser module that makes requests (same-origin /api/*; JSON + SSE, ApiError)
    sse.ts             incremental SSE parser (used by the browser and by the proxy's terminal-event check)
    chat.ts            conversation model + pure reducer applying stream events
  types/agent.ts       mirror of the backend Pydantic schemas
```

- **Contract.** `src/types/agent.ts` mirrors `backend/app/schemas/*.py`; keep them in sync. The proxy does not change payloads.
- **Streaming.** `fetch` + `ReadableStream` (`EventSource` cannot POST). The parser handles split chunks, several events per chunk, CRLF/CR line endings, multi-line `data:`, keep-alive comments and split UTF-8. Token text before a `tool_start` is preamble and is discarded; `done.answer` is authoritative.
- **Sessions and history.** The backend's `session_id` is stored per conversation. Conversations are kept in `localStorage`, in **this browser only** (maximum 50).
- **Safety.** Only safe execution events are shown, with no model reasoning. External links use `rel="noopener noreferrer"`, only `http(s)` URLs become links, and raw HTML in answers is never rendered.
