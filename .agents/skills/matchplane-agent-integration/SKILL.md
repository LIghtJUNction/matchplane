---
name: matchplane-agent-integration
description: Connect buyer and seller agents to MatchPlane's bounded Agent, Skill, MCP, routing, and retrieval contracts. Use when adding an external agent, designing buyer/seller handoff, exposing MCP tools, or reviewing token ownership and contact-consent boundaries.
---

# MatchPlane Agent Integration

Use the same integration shape for buyers and sellers. The role changes the intent and allowed
tools; identity, platform scope, audit, and consent rules do not change.

## Integration workflow

1. Declare the current `platformPath`, party role, and a domain-neutral narrative. Never put
   vehicle-specific fields in the root request unless the selected subplatform owns that schema.
2. Authenticate with a Better Auth session for a human chat or an organization API key for a
   machine agent. Keep the key server-side and request only the smallest `platform:read`,
   `retrieval:query`, or marketplace permission needed.
3. Call the platform route boundary. Treat `routePlan`, `routingTrace`, `source`, and `degraded` as
   advisory routing evidence, not as permission to disclose contact details or settle money.
4. At each selected child, invoke only the MCP tools advertised by its immutable manifest. The
   child owns its catalogue, vector store, embeddings, and seller/buyer ranking Skill.
5. Return canonical asset/merchant references and explainable reasons. Ask the root to verify
   active listing state, seller authorization, exposure billing, and consent before introducing
   parties.
6. Release WeChat/phone/contact data only through the platform contact-consent flow after both
   parties opt in. A successful AI match is never consent.

## Token and failure policy

External buyer/seller agents pay for their own model calls. Platform-initiated fallback routing is
bounded by `MATCHPLANE_ROUTER_AI_MAX_STEPS` (default 8, hard maximum 16), input/output limits,
provider timeouts, and an auditable `cost_bearer: "platform"` ledger. Do not retry a degraded
response in a loop; surface it and let the caller decide whether to try another provider.

Use [references/agent-envelope.md](references/agent-envelope.md) for request/result fields and
the minimal MCP tool contract. The normative JSON schemas remain in `docs/agent-mcp-skill-protocol-v1.json`,
`docs/platform-routing-protocol-v1.json`, and `docs/retrieval-protocol-v1.json`.
