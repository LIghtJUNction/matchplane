# MatchPlane Agent client

This is a small, dependency-free Bun/Node 22 client for a buyer or seller Agent. It uses the
same class and MCP contract for both roles; only the organization API-key metadata (`agentRole`),
the requested role, and the domain-neutral `side`/resource payload differ.

Keep the API key and returned party capability in the Agent's server-side secret store. Do not
bundle this package into a browser application.

```ts
import { MatchPlaneAgentClient } from "@matchplane/agent-client";

const client = new MatchPlaneAgentClient({
  baseUrl: process.env.MATCHPLANE_URL!,
  apiKey: process.env.MATCHPLANE_AGENT_API_KEY!,
});

const buyer = await client.openMarketplaceSession({
  tenant_id: process.env.MATCHPLANE_TENANT_ID!,
  domain_id: process.env.MATCHPLANE_DOMAIN_ID!,
  platform_path: "/used-car",
  role: "buyer",
});

const intent = await client.createIntent(buyer, {
  tenant_id: buyer.tenant_id,
  domain_id: buyer.domain_id,
  participant_id: buyer.party_id,
  side: "demand",
  narrative: "寻找符合我预算和时间条件的目标",
  attributes: { /* subplatform-owned fields */ },
  terms: { /* subplatform-owned terms */ },
  idempotency_key: crypto.randomUUID(),
});
```

Create separate keys for buyer and seller Agents with `marketplace:write` and
`agentRole: buyer|seller`. Call `handoff()` when the Agent needs the active child capabilities;
the handoff is caller-funded and never invokes MatchPlane's hosted model. The platform's own
router remains bounded and is only used by the first-party chat when no external Agent is present.
