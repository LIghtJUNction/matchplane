FROM rust:1.97.0-trixie@sha256:b92b8c8574f8f3b207fcb0912fb3e2de4041580b5934d90312d53938c9a038a9 AS cli-builder

ENV RUSTUP_TOOLCHAIN=1.97.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends cmake libcurl4-openssl-dev libprotobuf-dev libssl-dev pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .
RUN --mount=type=cache,id=matchplane-web-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=matchplane-web-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=matchplane-web-release-target,target=/build/target,sharing=locked \
    cargo build --release --locked -p xtask --bin matchplane \
    && install -Dm755 target/release/matchplane /build/out/matchplane

FROM oven/bun:1.3.14@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834 AS builder

WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM node:22-trixie-slim@sha256:f4c1b09232a0ae8f765093968ec82107a1be65cb0bfb36fc831195794f139568 AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4173

WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=cli-builder /build/out/matchplane /usr/local/bin/matchplane

USER node
EXPOSE 4173
ENV MATCHPLANE_WEB_NODE=/usr/local/bin/node
ENV MATCHPLANE_WEB_SERVER=/app/server.js
CMD ["/usr/local/bin/matchplane", "serve", "web"]
