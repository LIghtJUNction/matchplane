# MatchPlane

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
client shape for both kernel sides and a bounded local Skill runner for multi-step MCP calls.

The repository is a Rust 2024 modular monorepo with independently deployable services. The root
engine is domain-neutral; every vertical is a mounted adapter that supplies its own manifest, UI,
Agent Skill, MCP tools, and optional retrieval implementation. The repository includes an
automotive compatibility adapter only as an example; it is not root-platform data.

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

The core does not seed a tenant, domain, catalogue, vehicle, payment provider, or administrator.
Root contact channels are likewise operator configuration (`MATCHPLANE_ROOT_CONTACT_FIELDS_JSON`);
mounted packages own their presentation fields in `ui.contactFields`. No vertical fields are
compiled into the root UI.
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

Copy the returned root tenant and administrator assignments into the web service environment and
restart it, then open the returned `/login?role=platform` path. Omit the domain flags when the
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

The generic marketplace kernel supports neutral demand/supply participants, explainable
recommendations, consent-controlled introductions, and bounded source references for the separate
payment service without assuming what is being matched. Register a participant through
`POST /v1/marketplace/participants` with `marketplace_sides`, then publish opaque
`attributes`/`terms` supplied by the vertical or participant. The package under `subplatforms/auto`
is only a compatibility adapter: it supplies its own schema and UI and is not seeded into a clean
root deployment. Its legacy HTTP routes are disabled unless an operator explicitly sets
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
