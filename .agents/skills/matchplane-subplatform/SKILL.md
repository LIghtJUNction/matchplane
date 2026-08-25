---
name: matchplane-subplatform
description: Build or review a flat MatchPlane merchant-store integration. Use when creating matchplane.subplatform.json, registering a hosted/Git/archive/external store, implementing an owned retrieval adapter, or designing a storefront UI.
---

# MatchPlane Subplatform

Treat a legacy subplatform package as one merchant store inside the marketplace. A store may be
hosted, packaged, or externally connected, but it never contains another store. Historical
organization paths remain compatibility and authorization records; new product behavior uses the
stable store projection described by `docs/storefront-contract.md`.

## Package workflow

1. Start from a reviewed `matchplane.subplatform.json` supplied by the merchant and replace its
   domain content with merchant-supplied manifest data. Do not hard-code vehicle fields in root code.
2. Validate the immutable `id`, slug, API versions, routes, scopes, agent stages/skills/MCP tool
   names, and optional subplatform-owned retrieval declaration.
3. Register a pinned Git commit, archive digest, hosted store, or reviewed external binding. The
   server always attaches it directly to the marketplace root and projects one stable store ID.
4. Activate only after the required build or external health checks pass. A store has one canonical
   one-segment path; legacy aliases do not create a hierarchy.
5. Implement store Agent and MCP tools behind the stable routing/retrieval envelopes. Keep vectors,
   embedding models, prompts, and category schemas inside the store integration.
6. Keep the UI clean and domain-configurable: use the shared chat and consent flows, apply the
   Anthropic-art warm opaque accent treatment, and use Apple-style immediate/focusable controls.

Use [references/manifest-and-mount.md](references/manifest-and-mount.md) for registration, flat
mounting, and retrieval checks. Normative schemas live under `docs/`.
