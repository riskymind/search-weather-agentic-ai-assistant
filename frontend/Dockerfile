# Production image for the Next.js frontend (standalone output).
#   docker build -t search-weather-frontend ./frontend
#   docker run -p 3000:3000 -e BACKEND_API_URL=... -e BACKEND_API_ACCESS_KEY=... -e ACCESS_CODES=... \
#     -e ACCESS_SESSION_SECRET=... search-weather-frontend
#
# The image contains no configuration or secrets: the browser only calls this server's
# same-origin /api/* routes, and the proxy reads BACKEND_API_URL, BACKEND_API_ACCESS_KEY and
# the ACCESS_* gate settings from the runtime environment.

ARG NODE_VERSION=24

# --- Dependencies (exactly as locked) --------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# --- Build ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Runtime: only the traced standalone server and static assets ---------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Files stay root-owned (read-only for the runtime user); the server writes nothing to disk.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/access').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
