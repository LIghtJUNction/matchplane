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

# Keep Bun as the package-manager contract, but run the Next build with Node. Bun 1.3.14 can
# crash with SIGILL/segmentation faults while Next/Turbopack builds inside Docker on some
# GitHub-hosted x86 runners. Dependencies are still resolved from the pinned bun.lock; using the
# same pinned Node image as the runtime makes the build path deterministic and avoids that Bun
# runtime crash.
FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef AS web-deps

WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./

FROM node:22-trixie-slim@sha256:f4c1b09232a0ae8f765093968ec82107a1be65cb0bfb36fc831195794f139568 AS builder

WORKDIR /app
COPY --from=web-deps /app ./
RUN node node_modules/next/dist/bin/next build
# Next 16 preserves the path relative to outputFileTracingRoot in the
# standalone bundle. Normalize both the monorepo (`standalone/web`) and the
# package-local (`standalone`) layouts before copying into the runtime image.
RUN set -eux; \
    mkdir -p /app/standalone; \
    if [ -f /app/.next/standalone/server.js ]; then \
      cp -a /app/.next/standalone/. /app/standalone/; \
    elif [ -f /app/.next/standalone/web/server.js ]; then \
      cp -a /app/.next/standalone/web/. /app/standalone/; \
    else \
      echo 'Next standalone server.js was not produced' >&2; \
      exit 1; \
    fi

FROM node:22-trixie-slim@sha256:f4c1b09232a0ae8f765093968ec82107a1be65cb0bfb36fc831195794f139568 AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4173

WORKDIR /app
COPY --from=builder --chown=node:node /app/standalone ./
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=cli-builder /build/out/matchplane /usr/local/bin/matchplane

USER node
EXPOSE 4173
ENV MATCHPLANE_WEB_NODE=/usr/local/bin/node
ENV MATCHPLANE_WEB_SERVER=/app/server.js
CMD ["/usr/local/bin/matchplane", "serve", "web"]
