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
