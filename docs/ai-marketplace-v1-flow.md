# AI marketplace V1 integration flow

This is the implementation boundary for the generic MatchPlane kernel. A package may describe a
vehicle, a service, property, or any other supply type; the kernel never adds a domain schema.

## Who connects the model

There are three separate model responsibilities:

1. **Root platform Agent** — chooses active child paths. It receives a bounded narrative and can
   only select slugs from the server-provided allowlist. Its key is server-side and its cost is
   borne by the platform. It does not extract vehicle fields, query a vector database, or publish
   an offer.
2. **Vertical/package Agent** — runs at the terminal package or at a package-owned service. It
   understands that package's schema, extracts a profile, calls retrieval/media MCP tools, and
   returns canonical `offer_id` references with explanations and risks. The root only validates
   scope, lifecycle and permissions.
3. **Buyer/seller Agent** — an external caller may use the same MCP contract and the typed
   `@matchplane/agent-client` SDK. Its model, tool loop and token bill are caller-owned. It gets a
   short-lived party capability rather than a browser session or a platform model key.

The root router is currently OpenAI-compatible. A deployment can point it at LiteLLM, Vercel AI
Gateway, vLLM, Ollama, or another compatible gateway; provider-specific SDKs stay outside the Rust
kernel. See [`ai-provider-contract.md`](ai-provider-contract.md).

## Buyer flow

```text
chat message
  -> Better Auth + scoped party capability
  -> platform.match (root Agent chooses bounded child paths)
  -> marketplace.intent.create / intent.update (one intent, optimistic version)
  -> package Agent updates opaque profile and calls retrieval.query (optional)
  -> root re-reads active canonical offers by offer_id
  -> UI shows at most three offers, reasons and risks
  -> open/save/dismiss/compare -> append-only behavior events
  -> sales.handoff snapshot -> introduction/contact consent -> contact release
```

The first turn is useful even when the profile is incomplete. Follow-up turns append bounded
conversation context and update the same intent; they do not create a new intent for every
sentence. A package may replace the opaque profile with typed fields such as budget or use case,
but those fields remain package-owned JSON.

## Seller flow and material upload

The seller starts in the same chat component. The conversation creates a `supply` intent and a
reviewable draft. The seller then completes the package schema manually and submits a draft offer;
moderation must activate it before it is matchable.

For a package that supports media, the package manifest advertises a media MCP tool (for example
`media.upload`). The seller Agent, not the root, performs this sequence:

1. Send the selected file/photo to the package media adapter.
2. The adapter validates MIME/size, scans it, stores it under a content-addressed key, and returns
   an opaque `attachment_ref` plus dimensions/hash.
3. The package Agent reads the attachment and proposes schema fields (for a vehicle package this
   can include model, year, mileage, price and photos).
4. The UI places the proposal in the manual editor. The seller reviews, edits and confirms it.
5. `marketplace.offer.create` stores the package-owned attributes/terms and the attachment refs as
   JSON. The root does not store raw binary or infer fields.

If the package has no real media adapter, the UI must not claim that a local file was uploaded or
indexed. Sellers can still paste an approved URL or use the JSON editor. This fail-closed rule
prevents a successful-looking upload from producing an unsearchable listing.

## MCP surface

The authenticated HTTP MCP facade is `/api/mcp`. The stable tools are:

- routing: `platform.match`, `platform.agent.handoff`, `platform.child.tool`;
- marketplace state: `marketplace.agent.session`, `marketplace.intent.create/update`,
  `marketplace.profile.get/upsert`;
- feedback and handoff: `marketplace.behavior.record`, `marketplace.preferences.list`,
  `marketplace.preference.set`, `marketplace.sales.handoff`;
- supply and consent: `marketplace.offer.create/match`, `marketplace.demand.match`,
  `marketplace.introduction.*`.

`retrieval.query` is a package-declared capability, not a default root implementation. The root
retrieval facade validates the `matchplane.retrieval/v1` envelope, forwards only to an active
manifest-approved endpoint, and revalidates returned canonical offers before rendering them.

## Concrete example (package-owned fields)

```json
{
  "narrative": "需要一台适合长途、预算 15 万以内的车",
  "attributes": {
    "category": "vehicle",
    "budget_max_minor": "15000000",
    "use_case": ["long_distance"]
  },
  "terms": { "currency": "CNY", "currency_scale": 2 },
  "attachments": [
    { "attachment_ref": "media://sha256/...", "kind": "image" }
  ]
}
```

The `vehicle` keys above are an example supplied by the auto package; they are not part of the
root ABI. A different package can use the same transport with different attributes and terms.
