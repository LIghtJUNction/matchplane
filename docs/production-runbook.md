# Production runbook

This runbook is for a single Ubuntu host installation. It keeps the payment service and the
federation workers on private listeners; Nginx is the only public HTTP entry point. The bundled
`configure-ubuntu-host.sh` script is a **test-only** bootstrap and must not be used for a production
tenant.

## 1. Prepare the host

Install PostgreSQL with TimescaleDB and pgvector, Valkey with TLS enabled, Nginx, `curl`, `openssl`,
Node.js 22.12.0 or newer, and the release package. Create the `matchplane` system user/group and install the systemd units
from `packaging/systemd/`. Require `sslmode=verify-full` in the PostgreSQL URL. Keep
`/etc/matchplane/matchplane.env` owned by `root:matchplane`; service-specific credential files under
`/etc/matchplane/services/` must be owned by `root:<service-group>` with mode `0640`.

Before enabling a production service, provision separate PostgreSQL roles and Valkey ACL users for
the web process, gateway, payment service, event relay, matcher, projector, vector worker and
federation hub; keep migrations under a separate owner role. Grant each runtime role only the
tables/functions it needs and never make it a database owner or `CREATEROLE`/`CREATEDB` role. Put
the resulting URLs in one file per unit, for example
`/etc/matchplane/services/payment-service.env`, with only `MATCHPLANE_DATABASE_URL` and
`MATCHPLANE_VALKEY_URL` plus that workload's Kafka TLS paths. Only `event-relay`, `matcher`, and
`projector` need Kafka client paths; only `federation-hub` needs the server certificate, private
key, and client CA paths. The checked-in single-host bootstrap
uses one test role and must not be promoted to production.
Do not place payment-provider credentials in the common environment file; use the payment-only
secret directory or an external secret manager.
The bootstrap's PostgreSQL bootstrap password is root-only and must never be granted to a runtime
service account.

Kafka must likewise issue a distinct client certificate (or SASL identity) for each Kafka client.
The relay may publish only outbox topics, the matcher may consume commands and publish match
results, and the projector may consume book deltas and use its Valkey namespace. Do not reuse one
`client.key` across those units. The units load their per-service files after the common template,
so a missing file stops the unit instead of silently falling back to a shared production identity.

The packaged production template is [packaging/config/matchplane.env](../packaging/config/matchplane.env),
and the systemd units require the per-service files described above. A deployment must provision
all of those files before enabling the units; the package does not generate database or broker
credentials.

For Helm, set `runtime.serviceSecrets.<workload>` and
`runtime.kafkaTlsSecrets.<workload>` for every workload in `deploy/helm/matchplane/values.yaml`.
The chart deliberately fails a production render when one is missing; `runtime.existingSecret` and
`runtime.existingKafkaTlsSecret` are compatibility fallbacks for test renders only.
Replace every placeholder before enabling a service. In particular, use a unique node UUID,
non-development database and Valkey credentials, three TLS files (server certificate, private key,
and client CA), a platform-owned HTTPS payment callback origin, an HTTPS `BETTER_AUTH_URL`, a
high-entropy `BETTER_AUTH_SECRET` (at least 32 characters), and an operator-owned
`MATCHPLANE_ROOT_ADMIN_EMAIL`. The authentication service rejects the example email and placeholder
secret at runtime, and only the explicitly configured `BETTER_AUTH_URL` plus
`BETTER_AUTH_TRUSTED_ORIGINS` are accepted as browser origins. Put the actual Better Auth values in
`/etc/matchplane/secrets/web/better-auth.env` (owned by `root:matchplane-web`, mode `0640`); the
web unit loads that file after the shared environment file so gateway/payment workers cannot read
the signing secret.

Before creating the first administrator, configure the deployment-owned root SMTP route in the
same web-only secret/environment file. Set `MATCHPLANE_ROOT_SMTP_HOST`, `_PORT`, `_TLS_MODE`,
`_USERNAME`, `_CREDENTIAL_SECRET_REF`, and `_FROM_ADDRESS`; the credential reference must be
`file://...` or `env://...`, never a plaintext password. This route is deliberately separate from
`subplatform_email_configs`: a root administrator must be able to receive the first verification
email before any child platform or child SMTP configuration exists. After the root account is
verified, each child administrator can configure its own SMTP route from the scoped subplatform
workspace. Populate a read-only secret root for the web workload using the layout
`<tenant-uuid>/<domain-uuid>/<slot-name>` and set `MATCHPLANE_SUBPLATFORM_SECRET_ROOT`; the
administrator stores only the matching opaque `secret://subplatform/<tenant>/<domain>/<slot>`
reference. Child configuration cannot read deployment `env://` variables or arbitrary
`file://` paths.

The web administrator BFF also needs a narrowly projected copy of the gateway and payment admin
bearers. On systemd, keep them at `/etc/matchplane/secrets/web/payment-admin.token` and
`/etc/matchplane/secrets/web/gateway-admin.token` (mode `0640`, group `matchplane-web`) while the
payment/gateway services retain their own copies. On Helm, put the matching `payment-admin.token`
and `gateway-admin.token` keys in the existing payment/gateway secrets; the web Deployment mounts
only those two keys under `/run/matchplane/admin-secrets`. Do not mount the complete payment secret
or gateway contact-data/invoice-key directories into the web container.

If AI routing is enabled, configure `MATCHPLANE_ROUTER_AI_URL`,
`MATCHPLANE_ROUTER_AI_MODEL`, and `MATCHPLANE_ROUTER_AI_KEY` only in the web service's restricted
environment/secret file. The browser must never receive the provider key. The platform is the
token-cost bearer: every Agent call is bounded to at most 24,000 input characters and 2,048 output
tokens, and `MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR` (default 120 per authenticated subject) limits
abuse. `MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR` adds a deployment-wide cap (default 120),
so creating more verified accounts cannot multiply the hosted-provider bill without an explicit
operator change. Each provider call is atomically admitted under global and per-subject PostgreSQL
advisory locks and recorded in `platform_ai_call_admissions` before the network request, so
concurrent chats cannot all pass the same remaining quota. `MATCHPLANE_ROUTER_AI_MAX_STEPS` (default 8, hard maximum 16)
bounds how many platform nodes one chat request can traverse; each selected child is routed again
only after its active registration and visibility policy are re-read. The `platform_ai_usage`
ledger records the platform bearer, model, bounded budget, and provider-reported token counts
without storing raw prompts or provider credentials. Set a lower quota for a public launch after
observing provider limits; a missing provider deliberately produces an auditable policy fallback
rather than billing a user.

The router sends a bounded `matchplane.platform.select_children` function tool by default
(`MATCHPLANE_ROUTER_AI_TOOL_MODE=auto`). The tool's enum is generated from the server-side
allowlisted children, so a provider cannot route to an unregistered slug. Providers that only
support structured JSON can set `MATCHPLANE_ROUTER_AI_TOOL_MODE=disabled`; `required` is available
when the provider supports mandatory tool calls. The persisted routing decision records whether
the result came from the MCP-compatible tool boundary, structured JSON, or policy fallback.

The package builder is a separate trust boundary. Configure
`MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN` only in the web service's restricted secret file (or the
equivalent Kubernetes `subplatform-builder-token` key). `POST /api/platform/subplatforms` never
accepts a self-reported build digest. The isolated builder calls
`POST /api/platform/subplatforms/build` with that token and the SHA-256 digest of the immutable
static artifact; a root/subplatform administrator must still call the activation endpoint. A
digest callback is idempotent and cannot replace a different digest on an existing registration.
Archive registration uploads are sent to `POST /api/platform/subplatforms/upload`; configure
`MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT` as a writable, durable staging directory (or Helm's
`web.uploadPvc`). The web process stores opaque archives only and does not extract them. The
builder must mount or fetch the same upload object, validate its archive members and manifest in
an isolated workspace, and remove/expire consumed uploads according to the retention policy.
The packaged systemd unit grants the web service write access only to
`/var/lib/matchplane/subplatform-uploads` while keeping `ProtectSystem=strict`; if a deployment
uses a different absolute root, provide an equivalent `ReadWritePaths` override and ownership
for `matchplane-web`.
When a package includes a browser UI, stage its `dist/` directory below the absolute
`MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT` and include the relative `artifactPath` plus HTML
`artifactEntry` in the builder callback. The root records both paths with the build digest and
serves them only after activation through the sandboxed `/api/platform/plugin-assets/<mount>/...`
route. The builder must never place secrets or server code in that directory; use a unique,
digest-addressed subdirectory for every release.

The production Next.js route is fail-closed against unregistered package assets. A path is rendered
only when its complete recursive path resolves through the Better Auth organization tree and has an
active immutable `subplatform_registrations` version. This check also protects the manifest
endpoint; disabling a registration removes both UI and Agent routing without deleting its audit
history. Static package rendering is intentionally available only in non-production profiles.

For a child hosted on a different origin, keep `MATCHPLANE_OIDC_ENABLED=true` on the root web
service. Better Auth then exposes the root OIDC discovery document, Authorization Code + PKCE
endpoints, rotating JWKS, and the consent page. A root platform administrator must register each
active child through `/api/platform/oidc/clients` with its exact HTTPS callback URI; anonymous
dynamic client registration is disabled. The returned `client_secret` is shown once and belongs
only in the child server's secret store. The child identifies users by `(issuer, sub)`, then
exchanges the OIDC result for its own path-scoped MatchPlane capability; OIDC claims never grant
administrator, contact, payment, or sibling-platform access. Disable a client when a child is
removed so refresh tokens are revoked while the registration remains auditable.

## 2. Install the event broker

For a single host, install the pinned KRaft profile as root from the repository checkout:

```sh
sudo bash deploy/scripts/install-kafka.sh
systemctl is-active kafka
```

The script verifies the Apache Kafka archive checksum, creates a dedicated `kafka` user, binds the
broker and controller to loopback, disables automatic topic creation, and creates the five
MatchPlane topics with twelve partitions. It is intentionally a single-node **test/loopback**
profile; use a multi-broker Kafka deployment with TLS, mTLS, and ACLs before accepting production
traffic or a loss of broker redundancy. Production MatchPlane clients fail closed unless
`MATCHPLANE_KAFKA_SECURITY_PROTOCOL=SSL` and the CA/client certificate/key paths are configured.

## 3. Register the production federation node

Production services never auto-register their node identity. Before starting MatchPlane, insert
the operator-managed node row after migrations have created the schema:

```sql
INSERT INTO federation_nodes
  (id, name, grpc_endpoint, signing_key, certificate_fingerprint,
   protocol_major, protocol_minor, status)
VALUES
  ('REPLACE_WITH_NODE_UUID',
   'REPLACE_WITH_UNIQUE_NODE_NAME',
   'https://REACHABLE_HOSTNAME:50051',
   'REPLACE_WITH_OPERATOR_MANAGED_SIGNING_KEY_REFERENCE',
   'REPLACE_WITH_SHA256_CLIENT_CERTIFICATE_FINGERPRINT',
   1, 0, 'active');
```

The `id` must exactly match `MATCHPLANE_NODE_ID`, and the row must remain `active`. Keep the
signing key and certificate private material outside PostgreSQL when the deployment uses an
external secret manager; the database value is the federation identity/reference expected by the
current protocol. Set `MATCHPLANE_GRPC_ADDR` to the local listen address and put the externally
reachable endpoint in this registration row. Do not use `0.0.0.0` as the advertised endpoint.

## 4. Migrate and start the services

Use the packaged CLI as the common backend entrypoint. Run `matchplane doctor --json` before
enabling workloads, apply migrations with `matchplane migrate`, and let systemd/Compose/Helm invoke
`matchplane serve <service>` for each workload. `matchplane mcp serve` is the read-only stdio
operations surface for an on-call Agent.

Provision the root identity before starting the web unit. Use the packaged CLI with operator-owned
values; omit the domain flags if the root should initially have no child domain:

```sh
matchplane provision-root \
  --tenant-slug "$MATCHPLANE_ROOT_TENANT_SLUG" \
  --tenant-name "$MATCHPLANE_ROOT_TENANT_NAME" \
  --tenant-id "$MATCHPLANE_ROOT_TENANT_ID" \
  --admin-email "$MATCHPLANE_ROOT_ADMIN_EMAIL"
```

The command is idempotent for the exact same values, rejects slug/ID mismatches, and prints the
root tenant and administrator assignments without creating any catalogue or vertical data. If the
root was provisioned without a domain, reuse the exact tenant UUID printed by that command as
`--tenant-id` when adding a domain later; omitting it creates a new tenant identity. Set
the printed values in the web service environment and restart it before opening the printed login
path.

After the web unit is reachable, open `GET /api/platform/setup` to inspect the bounded first-run
state. It reports only whether the configured root tenant exists, whether active domains and child
registrations are present, and whether any Better Auth identity exists; it never returns credentials
or account addresses. The first production account must be created from `/login?role=platform` with
the operator-owned `MATCHPLANE_ROOT_ADMIN_EMAIL`; email verification is required before the account
is promoted to `rootSuperAdmin`. Register a child through the authenticated subplatform API, let the
isolated builder attach its immutable build digest, then activate it explicitly. Do not insert
Better Auth users, organizations, or active registrations directly with SQL.

Run the one-shot initializer once for the release, then enable all runtime units together:

```sh
systemctl start matchplane-initialize.service
systemctl enable --now \
  matchplane-gateway.service matchplane-payment-service.service \
  matchplane-event-relay.service matchplane-matcher.service \
  matchplane-projector.service matchplane-vector-worker.service \
  matchplane-federation-hub.service matchplane-web.service
```

The web/Better Auth process listens on `127.0.0.1:4173`, the gateway on `127.0.0.1:8080`, payment on
`127.0.0.1:8081`, and federation gRPC on the configured address. Keep Kafka, PostgreSQL, Valkey,
and the payment API off the public interface.
Expose only the Nginx routes in [deploy/nginx/matchplane.conf](../deploy/nginx/matchplane.conf).

## 5. Verify before opening traffic

Run health probes and inspect the worker consumer groups:

```sh
curl --fail https://PUBLIC_ORIGIN/api/health/ready
curl --fail https://PUBLIC_ORIGIN/api/health/web
curl --fail http://127.0.0.1:8081/health/ready
systemctl --no-pager --plain --full status \
  matchplane-gateway matchplane-payment-service matchplane-event-relay \
  matchplane-matcher matchplane-projector matchplane-vector-worker \
  matchplane-federation-hub matchplane-web kafka
journalctl -u matchplane-matcher -u matchplane-projector --since '-10 min' --no-pager
```

Then execute one authenticated marketplace introduction in a staging/test tenant and one payment
provider sandbox transaction. Confirm the contact audit, outbox/event relay, matcher trade, Valkey
projection, payment webhook/reconciliation, invoice, and refund records before enabling production
provider routes.

## 6. Safe updates and rollback

Before each update, record the running release and take both an encrypted PostgreSQL backup and a
copy of the current binaries, web release, Nginx configuration, and secret references. Verify the
dump with `pg_restore --list` (or the equivalent PostgreSQL tool) and copy a second backup to a
separate host. Download `SHA256SUMS` and verify it before unpacking; for releases published by CI,
also verify the GitHub Artifact Attestation against this repository and ref (for example,
`gh attestation verify matchplane-*.tar.zst --repo LIghtJUNction/matchplane`). Keep a release-scoped,
one-shot rollback timer armed for at least ten minutes while
the health and authenticated business probes run. Cancel it only after an operator confirms the
release; otherwise let it restore the previous application release and configuration.

Never overwrite the active release in place. Stage a versioned directory, verify checksums, switch
the `current` symlink atomically, reload Nginx only after `nginx -t`, and retain the previous
release until the rollback window has ended.

## 7. Payment and domain gates

Production mode must use real gateway configurations with immutable credential digests. Configure
EPay, Waffo Pancake, WeChat Pay, Alipay, and any custom adapter through the payment administrator
API; keep credentials in restricted files or an approved secret manager. Use test mode until
merchant onboarding, callback signature verification, invoice provider configuration, and a
successful sandbox refund are complete.

The checked-in Nginx profile serves `matx.tech` and expects the certificate at
`/etc/letsencrypt/live/matx.tech/`. Confirm that DNS still points at this host and that the
certificate covers `matx.tech` (the current profile intentionally does not claim `www`). On a new
host, install the renewal hook and certificate before switching traffic:

```sh
sudo bash deploy/scripts/install-nginx-certbot-hook.sh
sudo certbot renew --dry-run
sudo certbot certonly --webroot -w /var/www/matchplane/acme \
  -d matx.tech
sudo nginx -t && sudo systemctl reload nginx
```
