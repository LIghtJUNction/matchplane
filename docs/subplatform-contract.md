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
  "assets": { "staticDirectory": "src", "buildCommand": "bun run build" }
}
```

The root validates the manifest against the schema before registration. `id` is globally stable;
`slug` is unique within a root tenant and becomes the URL path. `rootApiVersion` and capabilities
are negotiated before the package is enabled.

## Retrieval boundary

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
