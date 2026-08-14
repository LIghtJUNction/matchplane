ARG TIMESCALE_IMAGE=timescale/timescaledb:2.29.1-pg18@sha256:373eb0fee9c0f8e0b4b0d4e74c7d0dd463dce05de6b49982701c4b540e94cba0
FROM ${TIMESCALE_IMAGE}

ARG PGVECTOR_VERSION=0.8.6
ARG ALPINE_MIRROR=https://dl-cdn.alpinelinux.org/alpine

LABEL org.opencontainers.image.title="MatchPlane PostgreSQL"
LABEL org.opencontainers.image.description="PostgreSQL 18 with TimescaleDB 2.29.1 and pgvector 0.8.6"
LABEL org.opencontainers.image.version="18.4-timescaledb2.29.1-pgvector0.8.6"

ADD --checksum=sha256:d076a3098010905fd60256649327809651f6288327db6413f0938305f62ea299 \
    https://codeload.github.com/pgvector/pgvector/tar.gz/8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c \
    /tmp/pgvector.tar.gz

RUN set -eux; \
    sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories; \
    apk add --no-cache --virtual .pgvector-build-deps \
        build-base \
        postgresql18-dev; \
    mkdir /tmp/pgvector; \
    tar -xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS="" with_llvm=no; \
    make -C /tmp/pgvector install with_llvm=no; \
    test -f "$(pg_config --sharedir)/extension/vector.control"; \
    grep -Fq "default_version = '${PGVECTOR_VERSION}'" "$(pg_config --sharedir)/extension/vector.control"; \
    rm -rf /tmp/pgvector /tmp/pgvector.tar.gz; \
    apk del .pgvector-build-deps
