# MatchPlane

MatchPlane is federated AI matching infrastructure. PostgreSQL owns orders, reservations,
trades, ledger entries, events, and audit history; Kafka transports durable facts; Valkey holds
only rebuildable low-latency projections. AI retrieval proposes candidates and never commits a
trade.

Every deployment uses the same recursive platform model: the current root is simply the platform
node without a parent, and a mounted platform can own its own children. Human accounts use Better
Auth; platform-to-platform credentials use Better Auth organization API keys with explicit scopes.

The repository is a Rust 2024 modular monorepo with independently deployable services. The same
domain and deterministic matching engine power the initial `automotive` and `electronics`
verticals.

## Prerequisites

- Rust 1.97.0 (installed automatically by `rust-toolchain.toml` when using rustup)
- Bun 1.3.14 or newer (the Next.js web dependency lock uses Bun)
- just 1.40.0 or newer (repository task runner)
- Docker 29+ with Compose
- `protoc` 35+

## Local development

```sh
cp .env.example .env
just compose-config
just dev
just migrate
just smoke
```

In regions where Alpine's official CDN is slow, set `MATCHPLANE_ALPINE_MIRROR` to a trusted HTTPS
mirror before building the PostgreSQL image. Alpine package signatures are still verified by
`apk`; leaving the variable empty keeps the official CDN.

The marketplace HTTP API listens on `http://127.0.0.1:8080`; the isolated payment API listens on
`http://127.0.0.1:8081`. Both expose `/health/live`, `/health/ready`, and `/metrics`.

The responsive buyer, seller, and platform workspaces live in `web/`. Run `bun install --cwd web`
followed by `bun run --cwd web dev`; the Next.js development server listens on
`http://127.0.0.1:4173`. Production builds use the Next standalone server and are staged under
`/usr/share/matchplane/web` in every Linux package; the packaged `matchplane-web.service` serves
the UI and Better Auth routes.

Vehicle discovery supports seller exposure analytics and explainable buyer recommendations. Offline
introductions release encrypted buyer/seller contact details only to the matched parties, support
private viewing appointments and dual price confirmation, and keep the vehicle's in-person payment
separate from the platform's disclosed commission. See
[docs/marketplace-payments.md](docs/marketplace-payments.md).

## Quality gates

```sh
just check
```

Packaging definitions live under `packaging/` for AUR (`matchplane-git` and
`matchplane-bin`), Ubuntu `.deb`, and Fedora `.rpm`. The project is released under the MIT License;
see `docs/adr/0010-project-license.md`. Package CI builds both AUR variants, an Ubuntu `.deb`, and Fedora
RPM/SRPM artifacts; tagged releases publish artifacts and, when both `AUR_SSH_PRIVATE_KEY` and the
reviewed `AUR_SSH_KNOWN_HOSTS` entry are configured, push `matchplane-git` and `matchplane-bin` to
the maintainer's AUR account.

The Helm chart intentionally refuses to render without `image.digest` set to the immutable SHA-256
digest of the published container image; a mutable tag is retained only as release metadata.

For a single Ubuntu host, see the [production runbook](docs/production-runbook.md) before enabling
production mode. It covers the pinned Kafka profile, operator-managed federation node registration,
service ordering, payment onboarding, backups, and the DNS/certificate gate.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) and the accepted decisions in `docs/adr/`.
