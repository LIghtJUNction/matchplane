# Marketplace V1 product signals

This document describes the domain-neutral kernel contract used by a vertical package. A package
may describe vehicles, services, property, people, or another supply type; the root platform does
not embed those fields or a brand name.

## The loop

1. A participant starts with a natural-language demand or supply message.
2. The platform Agent routes the message through the active platform tree.
3. The terminal package Agent may extract its own structured profile and call its own MCP/retrieval
   tools. The kernel persists the narrative, opaque profile projection, and scoped intent.
4. The package returns canonical offer IDs with reasons and, when known, risks/trade-offs.
5. The root revalidates the canonical offer before showing it. The first answer is capped at three
   offers so a participant can compare without reading a catalogue dump.
6. Save, dismiss, open, and compare are recorded as idempotent evidence. One click does not rewrite
   the participant profile; a package Agent decides how repeated evidence changes ranking.
7. A participant can request a contact introduction. Before the request, the kernel stores a
   contact-free sales handoff snapshot so a human receives the existing context instead of asking
   the same questions again.

## Stable kernel resources

- `marketplace_intents`: the current demand/supply narrative and package-owned JSON attributes.
  Continue a conversation with `PATCH /v1/marketplace/intents/{intent_id}` and its optimistic
  `expected_version`; do not create a new intent for every chat turn.
- `marketplace_intent_profiles`: one versioned opaque profile per participant/domain. The root
  enforces tenant and domain scope but does not interpret fields such as budget, use case, energy,
  body style, or any other vertical vocabulary.
- `marketplace_behavior_events`: append-only evidence (`offer.open`, `offer.save`,
  `offer.dismiss`, `offer.compare`, or package-defined keys). Events are idempotent and may carry a
  bounded reason/metadata object.
- `marketplace_offer_preferences`: the latest `saved`, `dismissed`, or `neutral` decision for a
  canonical offer. This is a preference signal, not a contact permission.
- `marketplace_sales_handoffs`: a scoped, contact-free snapshot containing the profile/intent
  context selected by the participant. Contact exchange remains the existing consent-gated
  introduction flow.

## Recommendation contract

Every visible candidate is a canonical offer projection. `reasons` explain why it was returned;
`risks` explain limitations or points that need human confirmation. A UI may translate the advisory
score to qualitative labels such as “非常适合 / 比较适合 / 一般 / 不太适合”, but must not present a
model score as a guarantee or hide the reasons and risks.

The retrieval ABI is optional. A package must declare and operate a real retrieval/MCP adapter
before the root calls it. If the adapter is unavailable, the root may use its bounded canonical
matcher and must show a degraded state; it must not fabricate vector-search results.

## Images and files

Binary media is not embedded in the kernel database. A vertical package declares the media fields
it understands (normally content-addressed URLs or attachment references) and owns the storage
adapter, malware scanning, resizing, and retention policy. A seller can describe an item in chat;
the seller Agent may call the package's media MCP tool, then place the returned reference in the
same draft attributes that the manual schema editor can review. The manual editor remains the
authority before submission. Until a package provides that adapter, the UI must not imply that a
local file has been uploaded or indexed.

## Agent and MCP ownership

The buyer or seller Agent is the caller of the stable resources. `marketplace.*` MCP tools are a
transport for those resources and still require the scoped participant capability. A package owns
schema extraction, embeddings, vector indexes, catalog synchronization, and ranking policy. The
root owns identity, scope, lifecycle, idempotency, consent, and audit invariants.
