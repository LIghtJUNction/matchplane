# MatchPlane

[![CI](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml)
[![Packages](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml/badge.svg)](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml)
[![License: MIT](https://img.shields.io/github/license/LIghtJUNction/matchplane)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

MatchPlane is federated AI matching infrastructure. PostgreSQL owns orders, reservations,
trades, ledger entries, events, and audit history; Kafka transports durable facts; Valkey holds
only rebuildable low-latency projections. AI retrieval proposes candidates and never commits a
trade.

Every deployment uses the same recursive platform model: the configured tenant has one explicit
`rootPlatform` organization, and a mounted platform can own its own children. Human accounts use
Better Auth; platform-to-platform credentials use Better Auth organization API keys with explicit
scopes.

The packaged `matchplane` CLI is the common backend and operations entrypoint: use
`matchplane serve <service>` to start a workload, `matchplane doctor/status --json` for bounded
diagnostics, and `matchplane mcp serve` for read-only MCP tools. The web service's `/api/mcp`
facade exposes the authenticated platform and marketplace tools for external Agents. The
dependency-free `integrations/matchplane-agent-client` package provides the same caller-funded
publishable client shape for both kernel sides and a bounded local Skill runner for multi-step MCP
calls; Agent owners can install it in their own server-side runtime without taking a platform token
dependency.

Remote platforms can use `matchplane federation-invite --domain-id <uuid>` or the root administrator
panel to generate a one-time signed enrollment token. A submitted remote node remains `pending`
until a root administrator activates it; active nodes and embedded subplatforms share the same
organization, manifest, MCP allowlist, and path-routing model.

The repository is a Rust 2024 modular monorepo with independently deployable services. The root
engine is domain-neutral; every store supplies its own manifest, UI, Agent Skill, MCP tools, and
optional retrieval implementation from an independently owned checkout or deployment. The core
repository does not vendor or bundle any store instance.

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

The core does not seed a tenant, domain, catalogue, vehicle, payment provider, or production
administrator. Local Compose is an explicit development exception: when
`MATCHPLANE_ENVIRONMENT=development` and `MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true`, the first
account may enter the root workspace without SMTP so the operator can inspect the UI. Never carry
that flag into a public deployment.
Contact exchange uses only email or phone bindings verified by the root Better Auth account.
Operators and mounted packages cannot define manual contact-entry fields, and disclosure still
requires explicit consent from both parties.
Set `MATCHPLANE_ROOT_ADMIN_EMAIL` to an operator-owned address, then provision only the identities
you want to mount:

```sh
cargo run --locked -p xtask -- provision-root \
  --tenant-slug <root-slug> \
  --tenant-name <root-name> \
  --domain-slug <first-domain-slug> \
  --domain-name <first-domain-name> \
  --admin-email <operator-email>
```

Copy the returned root tenant assignment into the web service environment and
restart it. First open `/login?role=platform`, create and verify the configured operator
account, then initialize the root organization from the platform readiness panel. Only after
that organization exists can you issue a one-time administrator URL from the server (never
commit or log it):

```sh
cargo run --locked -p xtask -- admin-invite --role root-admin
```

To change a root administrator password from the host, use the operator-only CLI command. It reads
the protected host configuration automatically, then reads the password from a hidden prompt (or
from stdin with `--password-stdin`), never places the password in command-line arguments, and
revokes every existing session for the account:

```sh
sudo matchplane passwd
```

Open the returned `/admin/register?token=...&next=...` link; it uses the same login/register page as every
other account, returns to the requested administrator workspace, and promotes the signed-in user only after Better Auth verification. Omit the domain flags when the
root should start without a child; to add a domain later, reuse the exact `--tenant-id` printed by
the first invocation and pass the new domain flags. Omitting `--tenant-id` creates a new UUID rather
than implicitly selecting an existing tenant. The command is idempotent for matching values and
refuses to overwrite an existing identity.

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

For a shared development or test host, use the [development/test runbook](docs/development-test-runbook.md).
It keeps the MatchPlane profile separate from Next.js' optimized `NODE_ENV`, documents the CLI
startup order, and keeps hosted AI and payment providers in sandbox mode. The test host is not a
production deployment.

The generic marketplace kernel supports neutral demand/supply participants, explainable
recommendations, consent-controlled introductions, and bounded source references for the separate
payment service without assuming what is being matched. Register a participant through
`POST /v1/marketplace/participants` with `marketplace_sides`, then publish opaque
`attributes`/`terms` supplied by the store or participant. Store packages and Agents are built,
deployed, and bound independently; the core Compose deliberately bundles none. Legacy HTTP routes
remain disabled unless an operator explicitly sets
`MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER=true`; new packages use the manifest-declared generic contract. See
[docs/marketplace-payments.md](docs/marketplace-payments.md) for the payment and commission
boundary.

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
Tagged CI releases publish both the Rust service image and the standalone Next.js/Better Auth web
image to GHCR. Kubernetes deployments must provide both immutable digests and a
`matchplane-web-secrets` Secret containing `better-auth-secret` and `root-admin-email`.

For a single Ubuntu host, see the [production runbook](docs/production-runbook.md) before enabling
production mode. It covers the pinned Kafka profile, operator-managed federation node registration,
service ordering, payment onboarding, backups, and the DNS/certificate gate.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) and the accepted decisions in `docs/adr/`.
