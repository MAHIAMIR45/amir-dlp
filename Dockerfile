# Render deployment (Docker runtime) — Next.js standalone + bundled yt-dlp
# standalone binary + cookie pool. 100% yt-dlp + cookies, no other backend.
#
# Build happens on Render's build machine (full RAM); the runner image only
# ships the self-contained .next/standalone output + engine files.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
# ca-certificates: yt-dlp + node HTTPS need system CA store.
# bun: cliBaseArgs passes --js-runtimes bun to yt-dlp — make sure the
# runtime actually exists in PATH (node alone is not enough for nsig).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g bun --silent
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Self-contained Next.js server (server.js + traced node_modules + .next/static + public)
COPY --from=builder /app/.next/standalone ./
# yt-dlp engine files (binary + cookie pool + python fallback scripts)
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/python ./python
RUN chmod +x /app/bin/yt-dlp /app/python/cookies/*.txt || true

EXPOSE 3000
CMD ["node", "server.js"]
