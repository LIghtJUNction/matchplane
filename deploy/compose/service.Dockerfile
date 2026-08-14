FROM rust:1.97.0-trixie AS builder

ENV RUSTUP_TOOLCHAIN=1.97.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends cmake libcurl4-openssl-dev libprotobuf-dev libssl-dev pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .
RUN --mount=type=cache,id=matchplane-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=matchplane-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=matchplane-release-target,target=/build/target,sharing=locked \
    cargo build --release --locked --workspace --bins \
    && mkdir -p /out \
    && cp \
        target/release/matchplane-event-relay \
        target/release/matchplane-federation-hub \
        target/release/matchplane-gateway \
        target/release/matchplane-matcher \
        target/release/matchplane-payment-service \
        target/release/matchplane-projector \
        target/release/matchplane-vector-worker \
        target/release/xtask \
        /out/

FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates libssl3 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 12001 --home-dir /nonexistent --shell /usr/sbin/nologin matchplane

COPY --from=builder /out/ /usr/local/bin/

USER matchplane
ENTRYPOINT ["/usr/local/bin/matchplane-gateway"]
