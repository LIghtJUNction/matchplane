# MatchPlane 代理客户端

这是一个小型、无依赖性、可发布的 Bun/Node 22 客户端，用于需求或供应代理。它使用
双方同级、MCP合同；安装平台拥有的含义
属性/术语有效负载，调用者在能力边界处选择一侧。

将其安装在服务器端代理进程中（切勿在浏览器代码中）：

```sh
bun add @matchplane/agent-client
```

该包在 `dist/index.js` 处公开 ESM，并将其 TypeScript 源保留为类型入口点。
在发布分叉或内部镜像之前运行 `bun run build`。

将 API 密钥和返回的 party capability 保存在 Agent 的服务端密钥存储中，不要把此包打进浏览器。
远程 origin 必须使用 HTTPS；明文 HTTP 仅允许回环地址的本地开发。`access_token_expires_at` 是硬性
截止时间；客户端会拒绝已过期的 capability，调用方须重新建立 session。

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

客户端将功能的`platform_path`复制到每个市场工具调用中。这是
故意：一个已安装路径的功能无法针对同级或父级重播
节点，即使租户和域相同。

每个 MCP 和检索请求都带有配置的截止时间。响应通过流式传输
256 KiB 客户端限制和畸形或过大的正文无法关闭为 `MatchPlaneMcpError`；
SDK 永远不会解析无限制的提供者响应。违反最后期限的情况也被报告为
`MatchPlaneMcpError` 与代码`504`，因此调用者可以使用一个传输错误路径。

儿童拥有的工具使用相同的经过身份验证的客户端，并且仍然受到活动的限制
孩子表现。 `queryRetrieval()` 是稳定的类型化便利包装
`matchplane.retrieval/v1`信封； root仅授权并转发，而child
拥有其目录或矢量搜索实现：

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

使用 `platform:read`、`marketplace:write` 和（当使用
输入`queryRetrieval()`助手）`retrieval:query`，加上最小的
部署所需的`agentSide`元数据（`demand`、`supply`或`both`）。仅需要`platform:read`
可选的第一个`routePlatformIntent()`树查找； Agent使用`handoff()`读取时添加`agent:handoff`
活跃的儿童能力；
切换由调用者资助，并且从不调用 MatchPlane 的托管模型。平台自有
路由器保持受限状态，仅在不存在外部代理时由第一方聊天使用。

募集代理发布报价后，可以调用 `matchDemands(capability, { offer_id, ... })` 查看已明确
公开的匿名需求摘要；该查询不会返回参与者ID或联系方式，也不会代替需求方发起引介。完整的买家/卖家服务器端示例见[`examples/buyer-agent.ts`](examples/buyer-agent.ts)和
[`examples/seller-agent.ts`](examples/seller-agent.ts)。同时共享同一个 SDK 和 MCP 协议：侵犯用
`side: "demand"` 创建意向、选择报价、发起介绍；募集方用 `side: "supply"` 发布
Offer、读取自己可见的介绍。只有经过认证的供给方明确同意后，调用方才可把已审核的 introduction ID
写入 `MATCHPLANE_CONSENTED_INTRODUCTION_ID` 并调用 `consentContact`；未设置时示例默认不授权。
只有双方都同意，平台才会进入联系发布阶段；示例不会把微信、手机号等联系方式交换上市或
模型提示。

## 多步骤技巧

该包还导出 `runBoundedAgentSkill`。它是一个与提供商无关的本地运行程序
买方或卖方自己的技能：调用者提供其模型决策函数和 MCP 传输，
而跑步者则执行 `matchplane.agent/v1` 信封、呼叫者资助的预算、最大步数，
序列化的输入/输出边界，以及调用者提供的 `allowed_mcp_tools` 列表（通常复制
来自可信清单或移交）。它从不使用 MatchPlane 提供程序密钥或转动工具
结果进入联系人/支付机构； MCP仍然是真正的授权边界。

```ts
const result = await runBoundedAgentSkill(request, {
  provider: { id: "my-agent", version: "2026.08", model: "my-provider/model" },
  decide: ({ request, history, remaining_steps }) => myModel.chooseTool({ request, history, remaining_steps }),
  callTool: ({ tool, arguments: input }) => myMcp.call(tool, input),
});
```

`result.steps` 包含代理自己的审核日志的摘要和有界状态元数据。通过一个
当模型/MCP 传输必须有截止时间时，`AbortSignal` 或 `timeout_ms` (1–300000 ms)；
适配器应拒绝传输错误或返回 MCP 的 `{ isError: true }` 形状，以便运行器
记录失败的步骤。 `max_output_tokens` 上的 JSON 保护是保守的序列化大小
查看;调用者仍然对其提供者的准确代币记账负责。平台路线
或者联络流仍需通过经过身份验证的 MatchPlane MCP 工具；跑步者是
编排粘合剂，而不是第二个授权系统。
