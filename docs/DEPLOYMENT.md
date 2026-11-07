# Deployment guide

How to run the stack in Docker, deploy the backend to Render and the frontend to Vercel, and operate the access gate.

> **Status (2026-11-07): deployed and verified with production requests.**
> - Backend: https://search-weather-backend.onrender.com (Render free plan, 1 instance)
> - Frontend: https://search-weather-agent.vercel.app (Vercel Hobby, behind the access gate)
>
> The Render client-IP configuration (§3.2) and the forwarded end-user IP through the Vercel proxy are **verified**. Results and open issues are in §7 and `spec.md` §16.

## 1. Architecture and URLs

```
Browser ──HTTPS──▶ Next.js (Vercel / :3000) ──HTTPS + Bearer key──▶ FastAPI (Render / :8000) ──▶ OpenAI, Tavily, Weatherstack
          same-origin /api/*   proxy.ts gate + route handlers        API_ACCESS_KEY required
          + access cookie      BACKEND_API_URL, BACKEND_API_ACCESS_KEY (server-only)
```

- The browser only calls its own origin (`/api/health`, `/api/agent/query`, `/api/agent/stream`, `/api/access`). It never learns the backend URL or any key.
- The Next.js server calls the backend server-to-server, so **`BACKEND_API_URL` is the URL reachable from the Next.js server**:

| Context | `BACKEND_API_URL` | Browser opens |
|---|---|---|
| Local, no Docker (`uvicorn` + `npm run dev`) | `http://localhost:8000` (the default outside production) | http://localhost:3000 |
| Docker Compose | `http://backend:8000` (set by `docker-compose.yml`) | http://localhost:3000 |
| Production | `https://<service>.onrender.com` | `https://<app>.vercel.app` |

- **Secrets and where they live:**

| Secret | Backend (Render) | Frontend server (Vercel) | Browser |
|---|---|---|---|
| `OPENAI_API_KEY`, `TAVILY_API_KEY`, `WEATHER_API_KEY` | ✅ | ❌ | ❌ |
| Proxy ↔ backend key | `API_ACCESS_KEY` | `BACKEND_API_ACCESS_KEY` (same value) | ❌ |
| `ACCESS_CODES`, `ACCESS_SESSION_SECRET` | ❌ | ✅ | ❌ (only an HttpOnly signed cookie) |

There are no `NEXT_PUBLIC_*` variables. A production build with sentinel values in all four secrets was scanned: none appear anywhere in `.next/` (client or server output). All values are read at runtime.

## 2. Docker (local)

```bash
cp .env.example .env                    # set BACKEND_API_ACCESS_KEY=$(openssl rand -hex 32)
cp backend/.env.example backend/.env    # fill in the three provider keys
docker compose up --build
```

- Frontend: http://localhost:3000. Backend: http://localhost:8000 (`/docs`, `/api/v1/health`).
- **Both ports are published on `127.0.0.1` only.** The backend requires the bearer key, exactly as in production, so `/api/v1/agent/*` returns 401 to direct callers; the frontend proxy holds the key.
- **Access gate:** off by default locally (`ALLOW_PUBLIC_ACCESS` defaults to `true` in Compose). To try it, add `ACCESS_CODES` and `ACCESS_SESSION_SECRET` to `.env` (see `.env.example`) and run `docker compose up -d frontend`.
- `frontend` waits for a healthy `backend`. Both have health checks. Containers run non-root with read-only root filesystems, `tmpfs` `/tmp`, all capabilities dropped and `no-new-privileges`.
- `.env` files are never copied into images. The root `.env` is outside both build contexts; `backend/.env` is passed with `env_file` at runtime.

**Images**
- Backend: `python:3.11-slim`, `uv sync --frozen --no-dev` in a build stage, one uvicorn worker on `$PORT` with `--no-proxy-headers` (§3.2).
- Frontend: `npm ci` build on `node:24-bookworm-slim`, then the `standalone` server on `node:24-alpine` as `node`. The frontend image contains **no configuration**, so the same image works for any backend URL.

## 3. Backend on Render

### 3.1 Steps (dashboard)

1. **New → Web Service**, connect the GitHub repository.
2. **Root Directory:** `backend`. **Runtime:** Docker (Render detects `backend/Dockerfile`). Leave the start command empty, because the image `CMD` is used.
3. **Instance:** one instance. Sessions and rate limits are in memory, so do not scale horizontally.
4. **Environment variables:**

   | Key | Value |
   |---|---|
   | `OPENAI_API_KEY`, `TAVILY_API_KEY`, `WEATHER_API_KEY` | your keys (the Weatherstack plan must support HTTPS) |
   | `API_ACCESS_KEY` | `openssl rand -hex 32`. The **same value** goes into Vercel's `BACKEND_API_ACCESS_KEY` |
   | `APP_ENV` | `production` |
   | `FRONTEND_URL` | your Vercel origin, e.g. `https://search-weather.vercel.app` (CORS allowlist; required in production) |
   | `CLIENT_IP_HEADER` | `CF-Connecting-IP` (see §3.2) |
   | `OPENAI_MODEL`, `LOG_LEVEL`, `RATE_LIMIT_*` | optional |

   Do not set `PORT` (Render provides it) and do not set `ALLOW_PUBLIC_AGENT_API`.
5. **Health Check Path:** `/api/v1/health`.
6. Deploy, then verify:
   ```bash
   curl https://<service>.onrender.com/api/v1/health          # 200, "environment":"production"
   curl -X POST https://<service>.onrender.com/api/v1/agent/query \
     -H 'content-type: application/json' -d '{"message":"hi"}'  # 401 unauthorized
   ```
7. Configure the frontend (§4) with this URL.

Alternatively, **New → Blueprint** reads `render.yaml` and prompts for the secrets.

**Free-tier notes:** instances sleep when idle, so the first request after a pause can take about a minute. The proxy waits up to 110 s and otherwise returns `502 backend_unreachable` or `503/504 backend_unavailable` ("starting up… try again in a minute"). A restart clears sessions and rate-limit counters.

### 3.2 Client IP on Render

Rate limiting needs the caller's IP. Requests reach a Render web service through Cloudflare and then Render's proxy.

- **`X-Forwarded-For` is client-appendable on Render**, so a client could choose a new identity per request. It is never used, and uvicorn runs with `--no-proxy-headers`. (Sources: a Render staff reply in the [feedback forum](https://feedback.render.com/features/p/send-the-correct-xforwardedfor), a [community thread](https://community.render.com/t/missing-x-forwarded-for-header-on-api-rewrites-to-backend/24481) and a [write-up of Render's headers](https://rohitpaulk.com/articles/render-rails-remote-ip). None of these are official Render documentation.)
- **`True-Client-IP` is not used any more.** Cloudflare documents it as [Enterprise-only](https://developers.cloudflare.com/fundamentals/reference/http-headers/), and warns that without Cloudflare adding it, its value can be spoofed.
- **`CF-Connecting-IP`** carries the address that connected to Cloudflare. Cloudflare documents it with no plan restriction, so it is the configured header.
- **Trust boundary:** the header is honoured only when the direct TCP peer is in `TRUSTED_PROXY_CIDRS` (private and loopback ranges by default, intended to match Render's internal proxy). Anything else uses the socket address, and values that are not a single valid IP are ignored.

**With the frontend proxy in front**, the client that connects to Render is the Vercel function for every user. So:
- For authenticated proxy traffic, the backend rate-limits on `X-Client-IP`. The proxy sets it from Vercel's `x-forwarded-for`, which [Vercel overwrites](https://vercel.com/docs/headers/request-headers#x-forwarded-for) to prevent spoofing. The backend honours `X-Client-IP` **only on requests carrying a valid `API_ACCESS_KEY`**, so nobody without the key can choose a rate-limit identity.
- `CF-Connecting-IP` therefore matters for **unauthenticated** traffic: failed key guesses and the health endpoint. Those are rate-limited per real caller, not per Render proxy.

Tested locally (`backend/tests`): spoofed `CF-Connecting-IP`, `True-Client-IP`, `X-Forwarded-For` and `X-Client-IP` from an untrusted peer or without the key do not change the rate-limit identity.

**Verified against the deployed Render service on 2026-11-07** (full results in `spec.md` §16.2):
- `peer_trusted: true`, and `cf-connecting-ip` and `network_client_ip` equal the caller's real IP.
- A client-supplied `CF-Connecting-IP` is **rejected by Cloudflare with HTTP 403 (error 1000)** before it reaches the service. A client-supplied `True-Client-IP` is overwritten, `X-Real-IP` is stripped, and `X-Forwarded-For` keeps the spoofed prefix, which is why it is not used.
- Through the Vercel proxy, rate limiting was keyed on the visitor's real public IP, and spoofed headers sent to Vercel did not change it.
- Diagnostics were then disabled again (404 with a valid key).

Only IPv4 was tested. Repeat the procedure below after changes to Render, Cloudflare or the proxy:

1. Set `CLIENT_IP_DIAGNOSTICS=true` on the Render service and redeploy. The endpoint returns 404 unless this is on **and** `API_ACCESS_KEY` is set, and it always requires the key.
2. From your machine (`KEY` = the backend `API_ACCESS_KEY`):
   ```bash
   B=https://<service>.onrender.com/api/v1/diagnostics/client-ip
   curl -s $B -H "Authorization: Bearer $KEY"                                    # baseline
   curl -s $B -H "Authorization: Bearer $KEY" -H 'CF-Connecting-IP: 6.6.6.6' \
        -H 'True-Client-IP: 6.6.6.6' -H 'X-Forwarded-For: 6.6.6.6'            # spoof attempt
   curl -s https://ifconfig.me                                                # your real IP
   ```
3. Expected for the configuration to be correct:
   - `peer_trusted` is `true` (otherwise adjust `TRUSTED_PROXY_CIDRS` to the reported `peer`).
   - `headers.cf-connecting-ip` equals your real IP **in both calls**, so Cloudflare overwrote the spoofed value.
   - `network_client_ip` equals your real IP **in both calls**.
   - `headers.x-forwarded-for` *starting with* `6.6.6.6` in the second call confirms why that header is not used.
4. If `cf-connecting-ip` is missing or echoes `6.6.6.6`, unset `CLIENT_IP_HEADER`. The service then falls back to the socket peer (rate limits become per Render proxy, a coarser but safe backstop), and the access key still protects the API.
5. Set `CLIENT_IP_DIAGNOSTICS=false` again.

Record the result in `spec.md` §13. Until then, this configuration is documented as **unverified**.

### 3.3 Alternative: Docker on any container host

```bash
docker build -t search-weather-backend ./backend
docker run -d -p 8000:8000 --env-file backend/.env \
  -e APP_ENV=production -e FRONTEND_URL=https://your-frontend.example \
  -e API_ACCESS_KEY=... search-weather-backend
```

This works on Fly.io, Railway, Cloud Run or a VM. Behind a reverse proxy you control, set `CLIENT_IP_HEADER` to a header that proxy **overwrites** (e.g. nginx `proxy_set_header X-Real-IP $remote_addr;` with `CLIENT_IP_HEADER=X-Real-IP`), and narrow `TRUSTED_PROXY_CIDRS` to the proxy's address. The frontend image can run on the same host: `docker run -p 3000:3000 -e BACKEND_API_URL=... -e BACKEND_API_ACCESS_KEY=... -e ACCESS_CODES=... -e ACCESS_SESSION_SECRET=... search-weather-frontend`.

Outside Vercel the frontend has no trustworthy end-user IP, so it sends no `X-Client-IP`. In that case the backend rate-limits all proxied traffic as one client, and the access-code limiter uses a single shared bucket.

## 4. Frontend on Vercel

1. **Add New → Project**, import the repository.
2. **Root Directory:** `frontend`. Framework preset: Next.js (auto-detected). Keep the default install and build commands. Set Node.js 24.x (Project Settings → General).
3. **Environment variables** (Production; add Preview only if previews should work). None of them are `NEXT_PUBLIC_`:

   | Key | Value |
   |---|---|
   | `BACKEND_API_URL` | `https://<service>.onrender.com` (no trailing slash) |
   | `BACKEND_API_ACCESS_KEY` | the backend's `API_ACCESS_KEY` |
   | `ACCESS_CODES` | `reviewer-a:<code>,reviewer-b:<code>`. Codes ≥ 16 characters, e.g. `openssl rand -base64 18` |
   | `ACCESS_SESSION_SECRET` | `openssl rand -hex 32` |
   | `ACCESS_SESSION_TTL_HOURS` | optional, default `168` |

   Without `ACCESS_CODES` (and without `ALLOW_PUBLIC_ACCESS=true`), the production app **refuses every request** with `503 access_not_configured`. It fails closed.

   Create the three secrets with **Sensitive** enabled, so they cannot be read back in the dashboard. Check the names before the first deploy. A typo (for example `ACCESS_CODE`) does not fail the build: it makes the app refuse every request (503) or makes the backend reject the proxy (401).
4. Deploy. Then set the backend's `FRONTEND_URL` to the production origin and redeploy the backend.
5. Verify:
   - Visiting the site redirects to `/access`.
   - `curl -i https://<app>.vercel.app/api/health` returns `401 access_required`.
   - After entering a code, Settings shows "Assistant service is online", and a suggested prompt streams an answer.
   - In DevTools → Network, every request goes to the Vercel origin and none carries `Authorization`.

**Streaming on Vercel:** the stream route sets `maxDuration = 120` seconds. Vercel Hobby allows up to 300 s with Fluid compute ([limits](https://vercel.com/docs/functions/limitations#max-duration)), and the backend caps an agent turn at 60 s. Responses use `Cache-Control: no-cache, no-transform` so they are not buffered.

**Changing variables:** they are read at runtime, but Vercel applies new values only to new deployments, so redeploy after changing them.

### 4.1 Vercel Deployment Protection: why an app-level gate is used instead

Checked against Vercel's docs (November 2026):
- **All Deployments** protection, which covers production domains, is [available on every plan](https://vercel.com/docs/deployment-protection#all-deployments) with **Vercel Authentication**, and Deployment Protection "requires authentication for all requests", so API routes are covered too.
- But [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication) only admits logged-in Vercel users with access. On Hobby that is **one external user per account**, plus **one [shareable link](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links) per account** in total.
- **Password Protection is not available on Hobby** (Pro: $20/month per project).

For a portfolio demo shared with several reviewers who don't have Vercel accounts, and who must be revocable individually, that is not workable. So the app has its own gate (§5.2). Vercel Authentication can still be added on top if only you need access.

## 5. Security

### 5.1 Decisions

| Concern | Decision |
|---|---|
| Provider keys | Only in the backend environment. Logs redact them; error responses never contain them |
| Public agent endpoint | None. The backend requires `API_ACCESS_KEY` in production (fail-safe at startup); the frontend's API routes require an access session; a production frontend without codes fails closed |
| Backend key in the browser | Never. Injected server-side by the route handlers. Verified by bundle scans and a browser network audit (no `Authorization` header, no request off-origin) |
| Request validation | In the proxy (content type, 16 KiB limit by header and while streaming, JSON, schema), then again in the backend |
| Error leakage | The proxy forwards only the backend's fixed error codes and messages; anything else becomes a generic 502/503/504. SSE `error` events come from the backend's sanitized set, or are synthesized by the proxy (`stream_interrupted`) |
| CSRF | Cookies are `SameSite=Lax`; POST routes also reject cross-site `Origin` / `Sec-Fetch-Site`; agent routes require `application/json` |
| Open redirects | `next` accepts only same-site relative paths. Redirect `Location` headers are relative (not built from the server's bind address) |
| Rate limiting | Backend per end-user IP (via the keyed proxy), plus failed-access-code limits in the frontend |

### 5.2 Operating the access gate

- **Grant access:** add `label:code` to `ACCESS_CODES` (one label per person, so revocation is individual) and redeploy. Send the person the URL and their code over a private channel.
- **Revoke one person:** remove (or change) their pair and redeploy. Their sessions stop working immediately, because the cookie signature covers the code.
- **Revoke everyone:** rotate `ACCESS_SESSION_SECRET` and redeploy.
- **Sign out:** Settings → "Sign out of this demo" (clears the cookie on that browser).
- **Session lifetime:** `ACCESS_SESSION_TTL_HOURS` (default 7 days).
- **Failed attempts:** after 5 failures per client (or 50 in total) within 15 minutes, further attempts, including correct ones, are refused with `Retry-After`. Logs record `access_denied`, `access_locked` and `access_granted` (with the label only, never the code).
- **Limits of the attempt limiter:** counters live in the server's memory. That is exact for a single server (Docker), but best effort on Vercel, where each function instance counts separately. Code length is what makes guessing infeasible: a random 16+ character code (≈ 96+ bits) cannot be brute-forced online.
- **Optional extra layer:** a [Vercel Firewall](https://vercel.com/docs/vercel-firewall) rate-limit rule on `POST /api/access`.

### 5.3 Do these regardless

- Set monthly budget caps and alerts in the OpenAI dashboard. Choose Tavily and Weatherstack plans that stop rather than bill overage.
- Keep `RATE_LIMIT_*` conservative. Monitor `rate_limited`, `agent_turn_completed`, `access_denied` and `access_locked`.
- Rotate `API_ACCESS_KEY` (both sides) and access codes if they were ever shared in plain text.

## 6. Post-deployment checklist

Status from the 2026-11-07 deployment. `[x]` means verified with production requests.

- [x] `GET <render>/api/v1/health` is 200 with `"environment":"production"`; a direct `POST <render>/api/v1/agent/query` is 401.
- [x] Client IP verified with the diagnostics endpoint (§3.2), then diagnostics turned off.
- [x] `<vercel>/` redirects to `/access`; `<vercel>/api/health` is 401 without a cookie.
- [x] A code signs in; a multi-tool prompt streams tool activity and the answer (verified at the protocol level with curl).
- [ ] The weather card and sources render in a real browser on production. Not yet confirmed by a person (verified in headless Chrome against Docker).
- [x] Cookie `HttpOnly; Secure; SameSite=Lax`.
- [ ] DevTools: requests only to the Vercel origin, no `Authorization` header. Not yet confirmed by a person on production; the client-asset scan found no backend URL or secret.
- [x] Removing a code from `ACCESS_CODES` and redeploying signs that person out.
- [x] Rotating `ACCESS_SESSION_SECRET` and redeploying signs everyone out.
- [x] 5 failed codes lock further attempts (per Vercel instance).
- [x] Rate limiting is keyed on the visitor's real IP through the proxy, and spoofed headers don't change it.
- [ ] A browser closing a stream cancels the backend turn. **Fails on Vercel** (§7).

## 7. Deployment record (2026-11-07)

| | |
|---|---|
| Commit | `2c28726` (`main`, merge of PR #1) |
| Render | `search-weather-backend` (`srv-dbn6c6l6e07s73dp11v0`), created from `render.yaml`, free plan, 1 instance, Oregon |
| Vercel | `search-weather-agent` (`prj_fz6m6kC4rxGefIlkluMd29ZcOkTU`), root `frontend`, Node 24.x, connected to GitHub (pushes to `main` deploy production) |
| Backend env (non-secret) | `APP_ENV=production`, `FRONTEND_URL=https://search-weather-agent.vercel.app`, `CLIENT_IP_HEADER=CF-Connecting-IP`, `CLIENT_IP_DIAGNOSTICS=false`, `OPENAI_MODEL=gpt-4o-mini`, `LOG_LEVEL=INFO`, `RATE_LIMIT_REQUESTS=20`, `RATE_LIMIT_WINDOW_SECONDS=60` |
| Frontend env (non-secret) | `BACKEND_API_URL=https://search-weather-backend.onrender.com` |
| Secrets (set in each dashboard by the owner) | Render: `OPENAI_API_KEY`, `TAVILY_API_KEY`, `WEATHER_API_KEY`, `API_ACCESS_KEY`. Vercel: `BACKEND_API_ACCESS_KEY`, `ACCESS_CODES`, `ACCESS_SESSION_SECRET` |
| Never set | `ALLOW_PUBLIC_AGENT_API`, `ALLOW_PUBLIC_ACCESS`, `NEXT_PUBLIC_*` |

**Open issues (details in `spec.md` §16.4):**
1. **Cancellation does not propagate through the Vercel proxy.** A stream the browser abandons still runs on the backend until the turn completes. Direct aborts to Render are cancelled within about 1 s, and Docker behaved correctly. This wastes provider spend, bounded by the 60 s turn cap and the rate limit.
2. **One intermittent SSE stall** on the first cold-start stream: it stopped after `tool_start` and stayed open past `maxDuration`. It was not reproduced in four later runs.
3. **Secrets are stored as Encrypted, not Sensitive**, in Vercel. Recreate them as Sensitive.
4. **Render auto-deploy is off** (`render.yaml`), and Vercel deploys on every push to `main`. Deploy backend changes by hand first.

**Operational notes:**
- Vercel applies changed variables only to new deployments. Redeploy from the dashboard, or with a Git push.
- Render's free plan sleeps when idle, and the first request after a pause can take about a minute.
- Restarts clear in-memory sessions and rate-limit counters.
