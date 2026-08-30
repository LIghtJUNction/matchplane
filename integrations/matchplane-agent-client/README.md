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
bundle this package into a browser application. Remote origins must use HTTPS (cleartext HTTP is
accepted only for loopback development). Treat `access_token_expires_at` as a hard 15-minute deadline;
the client rejects expired capabilities and requests must open a fresh session.

```ts
import { MatchPlaneAgentClient, terminalRoutePlanPaths } from "@matchplane/agent-client";

const client = new MatchPlaneAgentClient({
  baseUrl: process.env.MATCHPLANE_URL!,
  apiKey: process.env.MATCHPLANE_AGENT_API_KEY!,
  // Optional; defaults to 60 seconds and is capped at 120 seconds.
  requestTimeoutMs: 60_000,
});

// The same client can first ask the platform-tree router to choose a mounted
// marketplace. The hosted `platform.match` model call is billed to MatchPlane;
// only the Agent's own model/tool loop remains caller-funded.
const route = await client.routePlatformIntent({
  narrative: "寻找适合通勤、预算明确的方案",
  platform_path: "/",
  idempotency_key: crypto.randomUUID(),
});

// `platformPath` is the node where the request started. Continue with an authorized
// child from `routePlan` (a real Agent may open one capability per selected terminal).
const routedPath = terminalRoutePlanPaths(route)[0] ?? process.env.MATCHPLANE_PLATFORM_PATH!;

const capability = await client.openMarketplaceSession({
  tenant_id: process.env.MATCHPLANE_TENANT_ID!,
  domain_id: process.env.MATCHPLANE_DOMAIN_ID!,
  platform_path: routedPath || process.env.MATCHPLANE_PLATFORM_PATH!,
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
  // Optional and explicit: sellers may rank an anonymous summary, never contact details.
  supply_discovery_enabled: true,
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

Every MCP and retrieval request carries the configured deadline. Responses are streamed through a
256 KiB client-side limit and malformed or oversized bodies fail closed as `MatchPlaneMcpError`;
the SDK never parses an unbounded provider response. A deadline breach is also reported as
`MatchPlaneMcpError` with code `504`, so callers can use one transport-error path.

Child-owned tools use the same authenticated client and are still constrained by the active
child manifest. `queryRetrieval()` is a typed convenience wrapper for the stable
`matchplane.retrieval/v1` envelope; the root only authorizes and forwards it, while the child
owns its catalogue or vector-search implementation:

```ts
const result = await client.queryRetrieval({
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  narrative: "预算内、适合通勤的方案",
  requirements: { budget_max: 100000 },
  limit: 10,
});

// A supply Agent may upload a photo/document first. The root only checks the bounded
// envelope and scope; the active child owns scanning, storage and media:// references.
const attachment = await client.uploadMedia({
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  kind: "image",
  file_name: "offer-front.jpg",
  media_type: "image/jpeg",
  size_bytes: imageBytes.byteLength,
  data_base64: Buffer.from(imageBytes).toString("base64"),
});

// After the seller has reviewed the draft, publish only a generic public projection.
// Domain fields stay inside attributes/terms owned by the mounted package.
await client.upsertCatalogOffer({
  tenant_id: capability.tenant_id,
  domain_id: capability.domain_id,
  platform_path: capability.platform_path,
  offer: {
    offer_id: "00000000-0000-4000-8000-000000000001",
    external_key: "seller-offer-1",
    display_name: "供给方提交的方案",
    attributes: { /* package-defined fields */ },
    terms: { /* package-defined pricing/terms */ },
    attachments: [attachment.attachment.attachment_ref],
    status: "draft",
  },
});

// For another child-owned MCP tool, use the generic allowlisted bridge:
const toolResult = await client.callChildTool({
  platform_path: capability.platform_path,
  tool_name: "catalog.search",
  arguments: { query: "通勤" },
});
```

Create separate keys for demand and supply Agents with `platform:read`, `marketplace:write`, and (when using the
typed `queryRetrieval()` helper) `retrieval:query`, plus the smallest
`agentSide` metadata (`demand`, `supply`, or `both`) needed by the deployment. `platform:read` is only needed for
the optional first `routePlatformIntent()` tree lookup; add `agent:handoff` when the Agent uses `handoff()` to read
active child capabilities;
the handoff is caller-funded and never invokes MatchPlane's hosted model. The platform's own
router remains bounded and is only used by the first-party chat when no external Agent is present.

供给 Agent 发布 offer 后，可以调用 `matchDemands(capability, { offer_id, ... })` 查看已明确
公开的匿名需求摘要；该查询不会返回参与者 ID 或联系方式，也不会代替需求方发起引介。完整的 buyer/seller 服务器端示例见 [`examples/buyer-agent.ts`](examples/buyer-agent.ts) 和
[`examples/seller-agent.ts`](examples/seller-agent.ts)。两者共享同一个 SDK 和 MCP 协议：买方用
`side: "demand"` 创建 intent、选择 offer、发起 introduction；供给方用 `side: "supply"` 发布
offer、读取自己可见的 introductions。只有经过认证的供给方明确同意后，调用方才可把已审核的
introduction ID 放进 `MATCHPLANE_CONSENTED_INTRODUCTION_ID` 并调用 `consentContact`；未设置时示例
默认不授权。只有双方都同意，平台才会进入 contact release 阶段；示例不会把微信、手机号等联系方式放进 listing 或
模型 prompt。

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
