FROM oven/bun:1.3.14@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834 AS builder

WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM node:22.12.0-bookworm-slim@sha256:cc993f948cbd77c7cdfa0a9cc5b05e9ec9554c6ecf8cf98b90a2012156a4b998 AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4173

WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static

USER node
EXPOSE 4173
CMD ["node", "server.js"]
