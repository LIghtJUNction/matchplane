FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ARG RUST_VERSION=1.97.0
ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/cargo \
    RUSTUP_HOME=/rustup \
    PATH=/cargo/bin:${PATH}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        dpkg-dev \
        libcurl4-openssl-dev \
        libprotobuf-dev \
        libssl-dev \
        pkg-config \
        protobuf-compiler \
        zstd \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 --silent --show-error --fail \
        https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && rustc --version \
    && cargo --version

# The repository toolchain file also requests developer components. Package builds
# only need the already-installed compiler, so avoid a network sync on every run.
ENV RUSTUP_TOOLCHAIN=${RUST_VERSION}

WORKDIR /work
