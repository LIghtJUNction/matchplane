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

The root web service uses [Better Auth](https://better-auth.com/) for email/password accounts,
verification, password reset, sessions, platform roles, and organization-scoped memberships.
Subplatforms must not implement a second credential store. The organization slug is the mounted
path, and the Better Auth organization membership is the source of truth for whether a user may
request buyer/seller capabilities or administer that platform node. `organization.parentOrganizationId`
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
  "assets": { "staticDirectory": "src", "buildCommand": "bun run build" }
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

## Retrieval boundary

## Recursive platform chat

Every mounted path exposes the same chat entry. A request submitted at `/` is accepted by the
deployment root and delegated to the currently activated child registrations; a request submitted
at `/parent/child` is first recorded at that node and then delegated to its activated descendants.
The routing envelope is domain-neutral and carries the canonical platform path, request id and
bounded narrative. It never invents a vehicle or other vertical field. The web boundary is
`POST /api/platform/match`; the root stores the envelope in `platform_match_requests`, and each
child may then create its own domain-scoped buyer request through the stable marketplace API.
Unactivated, disabled or missing registrations are not called, and the root returns an explicit
accepted/degraded state instead of silently dropping the request.

### Agent-driven staged matching

The chat is a funnel, not a single global vector search. The decision chain is:

1. **商城/子平台** — the current node gives the routing Agent only its direct, activated child
   registrations. The Agent may select zero or more of those public slugs; it cannot invent a slug,
   query a sibling, skip an ancestor, or see credentials.
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

The deployment platform is the token-cost bearer for every model call initiated by this protocol;
buyers, sellers, and subplatform tenants are never charged a hidden token fee. Provider
credentials stay on the server, requests carry bounded input/step/output budgets, and the routing
audit records `cost_bearer: "platform"`, the selected model, and provider-reported usage when
available. A subplatform may still operate its own MCP infrastructure, but it cannot shift an
unbounded model call to a browser, charge a party for tokens, or silently reuse a root credential.
The normative Agent/Skill/MCP envelope is
[`docs/agent-mcp-skill-protocol-v1.json`](agent-mcp-skill-protocol-v1.json).

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

- Root owns accounts. A party claims a subplatform through
  `marketplace_subplatform_memberships`; the claim adds a scoped role and labels such as `seller`,
  `dealer`, `admin`, or `verified`, without creating another account.
- Every subplatform command carries `tenant_id`, `domain_id`, and the root capability token. The
  gateway checks an active membership for role-sensitive actions.
- Plugins are static frontend adapters. They cannot ship a second database, issue tokens, bypass
  contact consent, or call payment providers directly. Provider credentials remain root/payment
  service secrets.
- A path is activated only after manifest validation, API compatibility, CSP/resource checks,
  package scan, and an operator audit entry. Disable/revoke removes the path while preserving the
  root account and history.

## Repository layout in this project

The automotive adapter is a Git submodule at `subplatforms/auto`. Other verticals should follow the
same contract in their own repositories; the root repository stores only the gitlink and the
registration metadata, not a copied second implementation.
