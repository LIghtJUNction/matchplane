# MatchPlane Agent client

This is a small, dependency-free, publishable Bun/Node 22 client for a demand or supply Agent. It uses the
same class and MCP contract for both sides; the mounted platform owns the meaning of the
attribute/term payloads and the caller chooses the side at the capability boundary.

Install it in the server-side Agent process (never in browser code):

```sh
bun add @matchplane/agent-client
```

The package exposes ESM at `dist/index.js` and keeps its TypeScript source as the type entrypoint.
Run `bun run build` before publishing a fork or an internal mirror.

Keep the API key and returned party capability in the Agent's server-side secret store. Do not
bundle this package into a browser application. Treat `access_token_expires_at` as a hard 15-minute
deadline and request a fresh capability after it expires.

```ts
import { MatchPlaneAgentClient } from "@matchplane/agent-client";

const client = new MatchPlaneAgentClient({
  baseUrl: process.env.MATCHPLANE_URL!,
  apiKey: process.env.MATCHPLANE_AGENT_API_KEY!,
});

const capability = await client.openMarketplaceSession({
  tenant_id: process.env.MATCHPLANE_TENANT_ID!,
  domain_id: process.env.MATCHPLANE_DOMAIN_ID!,
  platform_path: process.env.MATCHPLANE_PLATFORM_PATH!,
  side: "demand",
});

const intent = await client.createIntent(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  participant_id: capability.party_id,
  side: "demand",
  narrative: "寻找符合我约束条件的合适供给",
  attributes: { /* subplatform-owned fields */ },
  terms: { /* subplatform-owned terms */ },
  idempotency_key: crypto.randomUUID(),
});

// Contact is a separate, consent-gated sequence. A successful match alone never releases data.
await client.requestContact(capability, {
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  introduction_id: process.env.MATCHPLANE_INTRODUCTION_ID!,
  participant_id: capability.party_id,
  idempotency_key: `contact-request:${process.env.MATCHPLANE_INTRODUCTION_ID!}`,
});
```

The client copies the capability's `platform_path` into every marketplace tool call. This is
intentional: a capability for one mounted path cannot be replayed against a sibling or parent
node, even when the tenant and domain are the same.

Create separate keys for demand and supply Agents with `marketplace:write` and the smallest
`agentSide` metadata (`demand`, `supply`, or `both`) needed by the deployment. Call `handoff()` when the Agent needs
the active child capabilities;
the handoff is caller-funded and never invokes MatchPlane's hosted model. The platform's own
router remains bounded and is only used by the first-party chat when no external Agent is present.

## Multi-step Skills

The package also exports `runBoundedAgentSkill`. It is a provider-neutral local runner for a
buyer's or seller's own Skill: the caller supplies its model decision function and MCP transport,
while the runner enforces the `matchplane.agent/v1` envelope, caller-funded budget, maximum steps,
serialized input/output bounds, and the caller-provided `allowed_mcp_tools` list (normally copied
from a trusted manifest or handoff). It never uses the MatchPlane provider key or turns a tool
result into contact/payment authority; MCP remains the real authorization boundary.

```ts
const result = await runBoundedAgentSkill(request, {
  provider: { id: "my-agent", version: "2026.08", model: "my-provider/model" },
  decide: ({ request, history, remaining_steps }) => myModel.chooseTool({ request, history, remaining_steps }),
  callTool: ({ tool, arguments: input }) => myMcp.call(tool, input),
});
```

`result.steps` contains digests and bounded status metadata for the Agent's own audit log. Pass an
`AbortSignal` or `timeout_ms` (1–300000 ms) when the model/MCP transport must have a deadline;
adapters should reject on transport errors or return MCP's `{ isError: true }` shape so the runner
records a failed step. The JSON guard on `max_output_tokens` is a conservative serialized-size
check; the caller remains responsible for its provider's exact token accounting. A platform route
or contact flow still has to pass through the authenticated MatchPlane MCP tools; the runner is
orchestration glue, not a second authorization system.
