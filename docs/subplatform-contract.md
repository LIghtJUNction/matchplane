# Platform contract and registration

MatchPlane uses one platform model. A platform node may be a deployment root, a child mounted under
another platform, or both at the same time. A vertical is a replaceable package mounted under a
path, for example `https://matx.tech/auto`. The package supplies presentation and domain adapters;
it does not replace root identity, authorization, matching, contact consent, payment or audit.

The deployment root is simply the node with no `parentOrganizationId`. If that node is mounted by
another operator, it becomes that operator's child without changing its code or data model. Every
node uses the same API, account, manifest, administrator, API-key and audit mechanisms; “root” and
“subplatform” describe the current position in the tree, not different product types.

## Identity and authorization

The root web service uses [Better Auth](https://better-auth.com/) for the single global identity:
email/password accounts, email OTP, magic links, verification, password reset, sessions, platform
roles, and organization-scoped memberships. A user never registers again for each child path.
Subplatforms must not implement a second credential store. The organization slug is the mounted
path, and the Better Auth organization membership is the source of truth for platform-scoped
authorization. For an active child that permits public access, the first authenticated buyer/seller
request idempotently claims a `member` projection for that organization; private children require
an invitation. Neither path can grant an admin role. `organization.parentOrganizationId`
forms the recursive platform tree. A manager may administer descendants only when the target node's
registration explicitly grants that ancestor relationship; data and audit records remain scoped to
the target node. Rust marketplace memberships remain the domain projection used by the gateway and
audit services.

When a parent registers a child, the registering manager is added to the child's organization with
the minimum required owner/admin role. This is how the same rule is enforced by Better Auth's
organization-owned API-key plugin; no global bypass is used.

Set `MATCHPLANE_ROOT_ADMIN_EMAIL` before creating the first account. A verified account created with
that email receives the configured `rootSuperAdmin` role; ordinary root admins are assigned through
Better Auth's Admin plugin, while `owner`, `admin`, `subplatform_admin`, `moderator`, and `member`
are assigned through the Organization plugin. `BETTER_AUTH_SECRET` must be a unique production
secret and is never generated or persisted by the repository.

The login page discovers enabled methods from `/api/auth/providers`. WeChat, QQ and Alipay are
reserved through Better Auth `genericOAuth` and remain hidden until the complete server-only
provider configuration is present. See [auth-sso-contract-v1.md](auth-sso-contract-v1.md) for the
session/capability exchange and administrator boundary.

## Platform API keys

Platform-to-platform and adapter-to-root calls use Better Auth's organization-owned API Key plugin;
the project does not maintain a second key table or verifier. The canonical header is
`x-matchplane-api-key` (the compatibility header `x-api-key` is also accepted). Keys use the
recognizable `mpk_` prefix, are hashed by Better Auth, are shown only at creation, and are never
placed in a manifest or browser local storage.

The built-in Better Auth endpoints are mounted below `/api/auth/api-key/*`. A platform manager
creates a key for the target organization with a short expiry, a named owner, and resource/action
permissions. Requests that cross a parent/child boundary carry the target `organizationId`; the
root checks the platform tree and the key's organization reference before forwarding the call.
Verification is server-side with `auth.api.verifyApiKey`, for example:

```ts
await auth.api.verifyApiKey({
  body: {
    configId: "platform",
    key: request.headers.get("x-matchplane-api-key") ?? "",
    permissions: { platform: ["read"], retrieval: ["query"] }
  }
});
```

Keys never create an impersonated user session. Rotate by creating a replacement, update the
consumer, then revoke the old key; expiration and Better Auth rate limits remain enabled. A key
with `platform:manage_children` may operate on descendants, while a key with only
`retrieval:query` cannot change roles, listings, payments or contact consent.

## Manifest

Every package must contain `matchplane.subplatform.json` at its repository or archive root:

```json
{
  "apiVersion": "matchplane.subplatform/v1",
  "id": "com.example.auto",
  "slug": "auto",
  "displayName": "Example Auto",
  "description": "...",
  "email": { "providerKey": "example-auto", "fromAddress": "no-reply@example.com" },
  "rootApiVersion": "v1",
  "entry": "src/index.ts",
  "routes": ["/auto"],
  "capabilities": ["demand", "supply", "explainable_matching"],
  "requiredScopes": ["marketplace:read", "marketplace:write"],
  "agent": {
    "protocol": "matchplane.agent/v1",
    "stages": ["merchant", "inventory"],
    "skills": ["matchplane.matching.v1"],
    "mcpTools": ["catalog.search", "merchant.search"]
  },
  "assets": { "staticDirectory": "dist", "buildCommand": "bun run build" }
}
```

The root validates the manifest against the schema before registration. `id` is globally stable;
`slug` is unique within a root tenant and becomes the URL path. `rootApiVersion` and capabilities
are negotiated before the package is enabled. The optional `agent` block advertises protocol,
workflow stages and MCP tool names only; it contains no endpoints, credentials or vector-store
configuration.

The built-in registration intake is `POST /api/platform/subplatforms`. It requires a Better Auth
root/parent administrator session, an existing `tenantId`/`domainId`, a pinned Git commit or
immutable archive locator, and the manifest JSON. It creates the Better Auth organization,
records the recursive parent and immutable digest in `subplatform_registrations`, and returns
`state: validated`. An isolated builder must attach a signed `build_digest` before a separate
activation operation is allowed; the web request never clones or executes untrusted package code.
The registration request cannot self-report `buildDigest`. The builder callback is
`POST /api/platform/subplatforms/build`, authenticated by a deployment-only
`MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN`, and is idempotent for the same immutable digest. A root or
parent administrator still performs the final activation; a builder cannot publish a package by
itself. A browser package may additionally send `artifactPath` (a relative, digest-addressed
directory under `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT`) and `artifactEntry` (a relative HTML file,
defaulting to `index.html`). These values are immutable alongside the build digest and are never
accepted from the public registration request.

For the built-in archive path, a root or parent-node manager first sends a multipart request with
an `archive` field to `POST /api/platform/subplatforms/upload` (optionally setting the
`x-matchplane-parent-organization-id` header). The web process enforces a 64 MiB limit, accepts
only tar/gzip or tar/zstd suffixes, stores opaque bytes below `MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT`
with a random locator and mode `0600`, and returns `upload://<id>` plus the SHA-256 digest. It
never extracts the archive. The isolated builder consumes that locator, rejects traversal,
symlinks, devices, oversized entries and missing manifests, then attaches the verified build
digest through the builder callback before activation. Operators must provide a durable writable
root (or an RWX upload PVC in Helm); leaving it unset fails closed with `503`.

## Retrieval boundary

## Recursive platform chat

Every mounted path exposes the same chat entry. A request submitted at `/` is accepted by the
deployment root and delegated to the currently activated child registrations; a request submitted
at `/parent/child` is first recorded at that node and then delegated to its activated descendants.
The routing envelope is domain-neutral and carries the canonical platform path, request id and
bounded narrative. It never invents a vehicle or other vertical field. The web boundary is
`POST /api/platform/match`; the root stores the envelope in `platform_match_requests`. The bounded
platform Orchestrator may continue the same request through selected descendants, calling the same
direct-child route decision at each path and returning a `routingTrace`; each child may then create
its own domain-scoped buyer request through the stable marketplace API. The traversal is capped by
`MATCHPLANE_ROUTER_AI_MAX_STEPS` (hard maximum 16), and hitting the cap is recorded as degraded.
Unactivated, disabled or missing registrations are not called, and the root returns an explicit
accepted/degraded state instead of silently dropping the request.

When the hosted router is enabled, each node decision exposes only the bounded
`matchplane.platform.select_children` MCP-compatible tool. Its `selectedSlugs` argument is an enum
generated from that node's active, authorized children; the server still applies the allowlist after
the model responds. `MATCHPLANE_ROUTER_AI_TOOL_MODE=auto` enables the tool while retaining the
structured-JSON compatibility path, `required` requires a provider tool call, and `disabled` uses
the legacy JSON response format. The decision audit records which mechanism was used.

### Agent-driven staged matching

The chat is a funnel, not a single global vector search. The decision chain is:

1. **商城/子平台** — the current node gives the routing Agent only its direct, activated child
   registrations visible to the current human membership or scoped Agent key. Public nodes are
   visible to authenticated users; invite-only nodes appear only after the same root identity has
   accepted membership. The Agent may select zero or more of those allowlisted slugs; it cannot
   invent a slug, query a sibling, skip an ancestor, or see credentials.
2. **商家** — the selected subplatform Agent uses its own Skill and authorized MCP tools to inspect
   seller labels, verification, promotion/exposure policy and merchant candidates. The root does not
   copy those fields into its schema.
3. **货柜/商品** — the subplatform Agent calls its inventory MCP tools to rank canonical assets
   (vehicle, product, service or another domain object) and returns bounded references, scores and
   reasons. The root verifies active inventory, seller authorization, price/budget and promotion
   billing before allowing an introduction.

MCP servers are the extension boundary for search, seller systems, catalogues, CRM, payments or
other tools. Skills describe the multi-step workflow and its safety policy; they do not become a
second identity or data store. A subplatform may connect pgvector, Qdrant, Milvus, Elasticsearch
or no vector database at all behind an MCP tool. The root only persists the protocol envelope,
selected canonical references, provider metadata and degraded state. AI ranking is advisory: it
cannot grant contact, release phone/WeChat details, authorize payment, mark a transaction
complete, or bypass seller exposure/commission policy.

The deployment platform is the token-cost bearer only for model calls made by its hosted router;
buyers, sellers, and subplatform tenants are never charged a hidden token fee for that hosted path.
When a buyer or seller brings its own Agent, that Agent owns its provider credentials and model
costs; calls into MatchPlane MCP are bounded tool calls, not an invitation to spend from the root
provider account. Provider credentials stay server-side, requests carry bounded input/step/output
budgets, and hosted routing audits `cost_bearer: "platform"`, the selected model, and
provider-reported usage when available. Hosted calls are additionally constrained by both the
per-subject `MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR` limit and the deployment-wide
`MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR` limit; external Agents remain caller-funded.
A subplatform may still operate its own MCP infrastructure,
but it cannot shift an unbounded model call to a browser, charge a party for root tokens, or silently
reuse a root credential.
The normative Agent/Skill/MCP envelope is
[`docs/agent-mcp-skill-protocol-v1.json`](agent-mcp-skill-protocol-v1.json).

### External Agent handoff

An external buyer or seller Agent can continue the funnel without making the deployment pay for
its model by calling `POST /api/platform/agent/handoff` (or the HTTP MCP tool
`platform.agent.handoff`). The request must use the strict
[`docs/agent-handoff-protocol-v1.json`](agent-handoff-protocol-v1.json) envelope, including a
unique `request_id`, an active `scope.platform_path`, a bounded intent, Agent capabilities and
`budget.cost_bearer: "caller"`. The caller's Better Auth organization API key must carry the
`agent:handoff` permission; sessions are accepted for interactive clients.

The endpoint is deliberately not a proxy to an LLM. It records the handoff for audit and
idempotency, returns the current node's active direct children and their advertised Skills/MCP
tools, and gives the caller the stable `/api/mcp` and manifest paths. It never grants contact,
payment, invoice, refund or administrator authority. `GET /api/platform/agent/handoff` can read
the status only for the same session or API key subject. Handoffs expire after a bounded interval;
the caller remains responsible for its own Agent credentials, model calls and token costs.

### Machine Agent capability exchange

The handoff is intentionally separate from a marketplace party capability. A buyer/seller Agent
that needs to create generic intents, offers, matches, or introductions first creates a Better Auth
organization API key with the smallest required scopes:

```json
{
  "permissions": { "marketplace": ["write"], "agent": ["handoff"] },
  "agentRole": "buyer"
}
```

The `agentRole` value is stored as API-key metadata and must be `buyer`, `seller`, or `both`. The
Agent then calls `POST /api/marketplace/agent-session` (or the HTTP MCP tool
`marketplace.agent.session`) with `tenantId`, `domainId`, `platformPath`, and its requested role.
The server verifies the Better Auth key, active recursive path, organization scope, domain, and
role before deriving a stable machine principal and exchanging it through the internal gateway
bridge. The response contains a short-lived (15-minute) party bearer plus
`access_token_expires_at`, scoped to that tenant and role; it never contains a user session,
API-key value, contact data, or an administrator capability. Store the party bearer server-side,
discard it at the deadline, and rotate the organization API key to revoke future exchanges.

This gives buyer and seller Agents the same integration shape: the only difference is the
role-scoped API key and the `side`/resource they submit. A machine Agent cannot choose an
arbitrary `participant_id` or widen a child path by putting another ID in the request body.

The stable envelope for stages two and three is
[`docs/platform-routing-protocol-v1.json`](platform-routing-protocol-v1.json). It carries a
`stage`, bounded intent, canonical candidate references, selected references, provider metadata
and a `degraded` flag. It intentionally contains no vehicle-specific keys.

Vector retrieval is an optional subplatform-owned adapter. A manifest that owns retrieval declares:

```json
"retrieval": {
  "protocol": "matchplane.retrieval/v1",
  "owner": "subplatform"
}
```

The root does not require a particular vector database, embedding model, dimension, distance
metric, or indexing strategy. The adapter may use pgvector, Qdrant, Milvus, Elasticsearch, a local
index, or a hosted service. The provider endpoint and its credential reference are deployment
configuration, not untrusted package manifest data.

Retrieval accuracy is the responsibility of each subplatform. The root does not prescribe a
vector store, embedding model, prompt, ranking formula or catalogue schema. Agents may use those
through their own Skill and MCP tools, while the root only checks authorization and the stable
result envelope.

## Domain-neutral marketplace kernel

The Rust gateway exposes a small, vertical-independent persistence contract. It is the boundary
between a platform Agent and a subplatform-owned schema or retrieval adapter:

| Resource | Endpoint | Authority and purpose |
| --- | --- | --- |
| intent | `POST /v1/marketplace/intents` | An authenticated party creates a `demand` or `supply` narrative with opaque JSON `attributes` and `terms`. |
| intent | `GET /v1/marketplace/intents/{id}?tenant_id=&participant_id=` | The owning party reads its intent. |
| offer | `POST /v1/marketplace/offers` | An authenticated supply party creates a draft offer; `asset_id` is optional for services and other verticals. |
| offer | `POST /v1/marketplace/intents/{id}/matches` | The owning demand party receives active offer candidates. A deterministic attribute fallback is available when no retrieval provider is configured. |
| offer | `POST /v1/admin/marketplace/offers/{id}/activate` | An operator or vertical moderation workflow publishes a draft. |
| introduction | `POST /v1/marketplace/introductions` | The owning demand party records one Agent-selected offer, score and bounded reasons. This never releases contact data. |
| introduction | `GET /v1/marketplace/introductions?tenant_id=&participant_id=` | Either participant reads the introduction projection without contact values. |

All writes accept caller-generated IDs and idempotency keys. Every party-authenticated request must
also carry `x-matchplane-platform-path` (the canonical path returned by the capability exchange).
The gateway checks the short-lived party bearer token, exact recursive node path, tenant/domain
scope, demand/supply role, active lifecycle, expiry, and cross-party invariant. `attributes` and
`terms` must be JSON objects and are never interpreted as vehicle fields by the root. Scores and
reasons are advisory Agent output; contact release remains a separate consented transition in the
existing introduction/contact contract.

The same resources are available to external Agents through the authenticated HTTP MCP facade at
`/api/mcp` using `marketplace.intent.create`, `marketplace.offer.create`,
`marketplace.offer.match`, `marketplace.introduction.create`, and
`marketplace.introductions.list`. The MCP facade forwards the caller's party capability to the
Rust gateway and does not store a second schema or token. A caller-funded Agent therefore owns its
model and vector-store cost while MatchPlane only enforces bounded, auditable state changes.

The stable boundary carries canonical IDs and scores, never vectors:

```http
POST /v1/retrieval/query
```

The request and response shape is defined in
[`docs/retrieval-protocol-v1.json`](retrieval-protocol-v1.json). The root sends a request ID,
tenant/domain scope, the domain-neutral demand narrative/attributes, and a bounded result limit.
The subplatform returns canonical root `asset_id` values, scores, provider/model version, and
explainable reasons. The root then verifies scope, listing state, membership, exposure billing,
and deterministic policy before it creates an introduction. A score or candidate response can
never authorize contact, payment, or settlement.

Requests are idempotent by `request_id`; providers should cache or replay the same result for a
retry. A provider may return an empty candidate list or `degraded: true`; the root must preserve
that state in audit rather than silently falling back to a different model. If a deployment keeps
the existing root pgvector worker, it is treated as a compatibility provider implementing the same
boundary, not as a requirement imposed on new subplatforms.

The optional `email` block is public routing metadata only. A subplatform administrator configures
the SMTP host, TLS mode, username and a deployment secret reference through
`/v1/subplatforms/{domain_id}/email-config`. The secret reference is never returned to the browser;
the worker that sends login links resolves it from the host secret manager. Each subplatform has
its own row and optimistic version, so changing one provider cannot change another subplatform's
mail route.

## Two registration inputs

The root operator can register either:

1. **Git repository** — submit an HTTPS/SSH repository URL and an immutable commit SHA. The root
   fetches the commit in an isolated builder, verifies the manifest and optional signature, builds
   static assets, records the repository URL/SHA/digest, and creates the path/domain membership.
2. **Archive upload** — upload a `.tar.gz`/`.tar.zst` package with a SHA-256 digest. The root
   rejects absolute paths, `..` traversal, symlinks, device files, oversized archives and missing
   manifests before extracting into an isolated build directory. The resulting digest is recorded
   as the immutable release identity.

The registration record contains `subplatform_id`, `tenant_id`, `domain_id`, `slug`, source kind,
source URL or upload digest, pinned revision, manifest digest, build digest, requested scopes,
approval state and audit timestamps. Re-registering an existing `id` never silently overwrites a
release; it creates a new immutable version and requires an explicit activation.

## Runtime boundaries

- Root owns accounts. A party claims an active public subplatform through the Better Auth
  organization membership projection; the claim adds only a scoped `member` role, and the Rust
  marketplace projection adds labels such as `seller`, `dealer`, or `verified` without creating
  another account. Admin labels require an invitation or an owner/admin action.
- Every subplatform command carries `tenant_id`, `domain_id`, and a capability minted for that
  `platform_path`. The gateway checks the capability's exact domain scope before role-sensitive
  actions; a token minted for `/a` cannot be replayed against `/b` in the same tenant.
- Plugins are static frontend adapters. They cannot ship a second database, issue tokens, bypass
  contact consent, or call payment providers directly. Provider credentials remain root/payment
  service secrets. After the isolated builder attaches an artifact locator, the active manifest
  gets a derived `assets.hosted` URL under `/api/platform/plugin-assets/<mount>/...`; the browser
  hosts that release in a `sandbox="allow-scripts"` iframe. Because this sandbox intentionally
  gives the frame an opaque `null` origin, the host uses a wildcard `postMessage` target but
  accepts messages only from the exact iframe window and its host-generated, per-iframe
  `contextToken`. The host sends only a versioned `matchplane.plugin/v1` context message and
  accepts bounded `chat.open`, `listing.select`, `listing.submit` and `navigation` requests.
  Listing submissions include a `requestId` and receive a matching `listing.submit.result`. The
  host validates the seller role, Better Auth session, active
  tenant/domain/schema and bounded JSON before calling the marketplace API. The artifact endpoint
  resolves host-local files under
  `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT`, checks the active build digest, rejects traversal and
  symlink escapes, and applies a restrictive CSP. It never fetches a plugin-supplied URL or runs
  plugin server code.
- A path is activated only after manifest validation, API compatibility, CSP/resource checks,
  package scan, and an operator audit entry. Disable/revoke removes the path while preserving the
  root account and history.
  In production, the web page and manifest endpoint independently verify that the complete
  recursive path resolves to an active immutable registration; a static file in `public/` is not
  an activation grant.
- Manifest and plugin-artifact reads apply the same `membership_policy` visibility check as Agent
  routing. Public registrations may be fetched without a membership claim; invite-only releases
  return the same not-found response until the caller's Better Auth user or scoped Agent key is
  authorized for that organization subtree.

## Repository layout in this project

The automotive adapter is a Git submodule at `subplatforms/auto`. Other verticals should follow the
same contract in their own repositories; the root repository stores only the gitlink and the
registration metadata, not a copied second implementation.
