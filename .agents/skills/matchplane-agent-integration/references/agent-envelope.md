# Agent envelope quick reference

The root accepts a bounded narrative at `POST /api/platform/match` from a Better Auth session. A
machine integration uses an organization-owned `mpk_` API key and the canonical
`x-matchplane-api-key` header where the target endpoint permits it. The provider sees only
allowlisted child metadata; tenant/domain authority stays server-side.

An Agent stage follows:

```json
{
  "protocol": "matchplane.agent/v1",
  "stage": "merchant",
  "scope": { "platform_path": "/market/auto" },
  "intent": { "narrative": "...", "requirements": {} },
  "skill": "matchplane.matching.v1",
  "allowed_mcp_tools": ["merchant.search", "inventory.search"],
  "budget": {
    "max_steps": 8,
    "max_input_characters": 24000,
    "max_output_tokens": 512,
    "cost_bearer": "platform"
  }
}
```

An MCP tool must return bounded, explainable canonical references. Tool output can improve ranking,
but cannot authorize contact exchange, payment, settlement, or a hidden cross-tenant query.

## Marketplace capability exchange

An external demand or supply Agent does not create a separate browser account on every child
platform. A Better Auth organization API key is the machine identity; bind it to the smallest
`marketplace:write` permission and set API-key metadata `agentSide` to `demand`, `supply`, or
`both`. Call `marketplace.agent.session` through `/api/mcp` (or
`POST /api/marketplace/agent-session`) with the active `tenant_id`, `domain_id`, `platform_path`,
and requested side. The platform verifies the mounted path, parent/child organization access, and
active registration before returning a short-lived (15-minute) party bearer plus its
`access_token_expires_at` deadline.

Use that bearer only as `Authorization: Bearer ...` for the generic marketplace MCP tools. The
exchange derives the party identity from the API key, so callers cannot choose a participant ID;
it also returns no contact values and creates no browser session. Both buyer and seller Agents use
the same client shape—the role only narrows the allowed marketplace actions. All external Agent
handoffs and marketplace calls are caller-funded; a platform fallback is a separate, explicitly
bounded path and never silently charges an external Agent.
