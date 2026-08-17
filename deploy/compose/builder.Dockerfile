FROM rust:1.97.0-trixie@sha256:b92b8c8574f8f3b207fcb0912fb3e2de4041580b5934d90312d53938c9a038a9 AS builder

ENV RUSTUP_TOOLCHAIN=1.97.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends cmake libcurl4-openssl-dev libprotobuf-dev libssl-dev pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .
RUN --mount=type=cache,id=matchplane-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=matchplane-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=matchplane-builder-target,target=/build/target,sharing=locked \
    cargo build --release --locked -p matchplane-subplatform-builder \
    && mkdir -p /out \
    && cp target/release/matchplane-subplatform-builder /out/

FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap ca-certificates git nodejs npm \
    && npm install --global --no-fund --no-audit pnpm@10.15.1 yarn@1.22.22 \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && useradd --system --uid 12002 --home-dir /nonexistent --shell /usr/sbin/nologin matchplane-builder \
    && mkdir -p /var/lib/matchplane/subplatform-builder-work /var/lib/matchplane/subplatform-artifacts /var/lib/matchplane/subplatform-uploads \
    && chown -R matchplane-builder:matchplane-builder /var/lib/matchplane

COPY --from=builder /out/matchplane-subplatform-builder /usr/local/bin/matchplane-subplatform-builder

USER matchplane-builder
ENTRYPOINT ["/usr/local/bin/matchplane-subplatform-builder"]
