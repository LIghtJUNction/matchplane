---
name: matchplane-subplatform
description: Build or review a recursive, domain-neutral MatchPlane subplatform package. Use when creating matchplane.subplatform.json, registering a Git/archive plugin, adding child platforms, implementing an owned retrieval adapter, or designing a subplatform UI.
---

# MatchPlane Subplatform

Treat a subplatform as another MatchPlane node, not as a second product architecture. It may have
children of its own and may later be mounted below another operator without changing its account,
API, or administrator model.

## Package workflow

1. Start from `subplatforms/auto/matchplane.subplatform.json` and replace domain content with
   merchant-supplied manifest data. Do not hard-code vehicle fields in root code.
2. Validate the immutable `id`, slug, API versions, routes, scopes, agent stages/skills/MCP tool
   names, and optional subplatform-owned retrieval declaration.
3. Register a pinned Git commit or archive digest. The root records the manifest/source digest and
   creates the Better Auth organization; an isolated builder must attach the build digest.
4. Activate only after the build digest matches. A child path is unavailable until all ancestor
   registrations are active, and the database cycle/depth guard remains authoritative.
5. Implement the child Agent and MCP tools behind the stable routing/retrieval envelopes. Keep
   vectors, embedding models, prompts, and catalogue schemas inside the subplatform.
6. Keep the UI clean and domain-configurable: use the shared chat and consent flows, apply the
   Anthropic-art warm opaque accent treatment, and use Apple-style immediate/focusable controls.

Use [references/manifest-and-mount.md](references/manifest-and-mount.md) for the registration,
nesting, and retrieval checklist. Normative schemas live under `docs/`.
