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
COPY web/patches ./patches
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
      if [ -d /app/.next/standalone/node_modules/.bun ]; then \
        mkdir -p /app/standalone/node_modules; \
        cp -a /app/.next/standalone/node_modules/.bun /app/standalone/node_modules/.bun; \
        next_link=/app/standalone/node_modules/next; \
        if [ -L "$next_link" ]; then \
          target=$(readlink "$next_link"); \
          case "$target" in \
            ../../node_modules/.bun/*) \
              fragment=${target#../../node_modules/.bun/}; \
              unlink "$next_link"; \
              ln -s ".bun/$fragment" "$next_link"; \
              ;; \
          esac; \
        fi; \
        external_aliases=$(grep -RhoE '"[A-Za-z0-9@._/-]+-[0-9a-f]{14,}"' /app/.next/server 2>/dev/null | sed -E 's/^"|"$//g' | sort -u || true); \
        for external_alias in $external_aliases; do \
          package_name=$(printf '%s\\n' "$external_alias" | sed -E 's/-[0-9a-f]{14,}$//'); \
          source_link=/app/node_modules/$package_name; \
          if [ -L "$source_link" ]; then \
            package_link=$(readlink "$source_link"); \
            case "$package_link" in \
              ../../node_modules/.bun/*) \
                package_fragment=${package_link#../../node_modules/.bun/}; \
                alias_path=/app/standalone/node_modules/$external_alias; \
                mkdir -p "$(dirname "$alias_path")"; \
                [ -e "$alias_path" ] || ln -s ".bun/$package_fragment" "$alias_path"; \
                ;; \
            esac; \
          fi; \
        done; \
      fi; \
    else \
      echo 'Next standalone server.js was not produced' >&2; \
      exit 1; \
    fi
RUN node /app/scripts/validate-standalone-output.mjs /app/standalone

FROM node:22-trixie-slim@sha256:f4c1b09232a0ae8f765093968ec82107a1be65cb0bfb36fc831195794f139568 AS runner

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=4173

WORKDIR /app
COPY --from=builder --chown=node:node /app/standalone ./
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=builder --chown=node:node /app/licenses ./licenses
COPY --from=cli-builder /build/out/matchplane /usr/local/bin/matchplane

USER node
EXPOSE 4173
ENV MATCHPLANE_WEB_NODE=/usr/local/bin/node
ENV MATCHPLANE_WEB_SERVER=/app/server.js
CMD ["/usr/local/bin/matchplane", "serve", "web"]
