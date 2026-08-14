# MatchPlane

MatchPlane is federated AI matching infrastructure. PostgreSQL owns orders, reservations,
trades, ledger entries, events, and audit history; Kafka transports durable facts; Valkey holds
only rebuildable low-latency projections. AI retrieval proposes candidates and never commits a
trade.

The repository is a Rust 2024 modular monorepo with independently deployable services. The same
domain and deterministic matching engine power the initial `automotive` and `electronics`
verticals.

## Prerequisites

- Rust 1.97.0 (installed automatically by `rust-toolchain.toml` when using rustup)
- Node.js 22.23.2 or newer (the web dependency lock uses npm)
- Docker 29+ with Compose
- `protoc` 35+

## Local development

```sh
cp .env.example .env
make compose-config
make dev
make migrate
make smoke
```

In regions where Alpine's official CDN is slow, set `MATCHPLANE_ALPINE_MIRROR` to a trusted HTTPS
mirror before building the PostgreSQL image. Alpine package signatures are still verified by
`apk`; leaving the variable empty keeps the official CDN.

The marketplace HTTP API listens on `http://127.0.0.1:8080`; the isolated payment API listens on
`http://127.0.0.1:8081`. Both expose `/health/live`, `/health/ready`, and `/metrics`.

The responsive buyer, seller, and platform workspaces live in `web/`. Run `npm ci --prefix web`
followed by `npm run dev --prefix web`; the Vite development server listens on
`http://127.0.0.1:4173` and proxies the marketplace and payment APIs. Production builds are staged
under `/usr/share/matchplane/web` in every Linux package.

Vehicle discovery supports seller exposure analytics and explainable buyer recommendations. Offline
introductions release encrypted buyer/seller contact details only to the matched parties, support
private viewing appointments and dual price confirmation, and keep the vehicle's in-person payment
separate from the platform's disclosed commission. See
[docs/marketplace-payments.md](docs/marketplace-payments.md).

## Quality gates

```sh
make check
```

Packaging definitions live under `packaging/` for AUR (`matchplane-git` and
`matchplane-bin`), Ubuntu `.deb`, and Fedora `.rpm`. No project license has been selected; see
`docs/adr/0010-project-license.md`. Package CI builds both AUR variants, an Ubuntu `.deb`, and Fedora
RPM/SRPM artifacts; tagged releases publish artifacts and, when `AUR_SSH_PRIVATE_KEY` is configured,
push `matchplane-git` and `matchplane-bin` to the maintainer's AUR account.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) and the accepted decisions in `docs/adr/`.
