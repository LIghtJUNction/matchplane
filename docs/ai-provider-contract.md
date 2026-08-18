# AI 模型接入边界

MatchPlane 的根平台只需要一个受限的“平台路由器”模型调用，不把供应商 SDK 或 API key 放进 Rust 核心，也不把模型调用下放给子平台。当前 `web/src/platform-router.ts` 使用 OpenAI-compatible Chat Completions 线协议：服务端读取 `MATCHPLANE_ROUTER_AI_URL`、`MATCHPLANE_ROUTER_AI_KEY` 和 `MATCHPLANE_ROUTER_AI_MODEL`，只发送已激活候选节点的公开路由描述，严格限制工具参数为候选 slug，并把模型不可用时的策略降级记录为 `degraded`。

因此接入模型的最短路径不是修改 Agent 或子平台，而是在平台边界接一个模型网关：

```text
MatchPlane router
      │ OpenAI-compatible /v1/chat/completions
      ▼
LiteLLM / Vercel AI Gateway / vLLM / Ollama / 自建兼容网关
      │
      ├── OpenAI、Anthropic、Google、DeepSeek、通义、智谱……
      └── provider/model 级别的 fallback、预算与审计
```

## 选型

- 需要统一接入很多原生协议、做模型路由、fallback、预算和用量统计时，优先使用自托管 LiteLLM；把 MatchPlane 的 URL 指向 LiteLLM 的 OpenAI-compatible 入口，`MODEL` 使用网关支持的 `provider/model` 名称。
- 已经运行 Vercel/Next.js，并希望在 TypeScript 中使用原生 provider、结构化输出和工具调用时，可在网关层增加 Vercel AI SDK（`ai` 加对应的 `@ai-sdk/*` provider）。不要把这些 provider 包塞进 Rust 核心。
- MCP 是 Agent 的工具/数据边界，不是模型协议。子平台的向量检索、商品索引和领域 Skill 通过 MCP 暴露；根路由器只决定是否把请求转发给已授权节点。
- 只有一个 OpenAI-compatible 服务时，直接使用现有 `platform-router.ts` 即可；不需要为每个厂商写一份 MatchPlane 适配器。

## 生产约束

1. `MATCHPLANE_ROUTER_AI_KEY` 只能存在 web 服务端密钥文件，不得使用 `NEXT_PUBLIC_` 前缀，也不得下发给浏览器或外部 Agent。
2. 通过网关的模型 allowlist 固定可用模型；MatchPlane 只接受环境变量指定的模型，不接受用户输入的 URL、模型名或 provider 名。
3. 网关必须提供 HTTPS、请求 deadline、最大输入/输出 token、并发/速率限制、fallback 和用量账单。MatchPlane 自身仍保留 4 秒调用超时、小时级 admission、路由步数与扇出上限。
4. 记录 request id、model、token usage、degraded 和成本归属 `platform`，不要记录 API key、完整用户隐私文本或联系人。
5. 模型只能在授权候选集合内选择，不得创建平台路径、商家 ID、商品 ID，也不得直接执行交易或联系人交换。

## 推荐配置

开发环境可以把 `MATCHPLANE_ROUTER_AI_URL` 指向本机 LiteLLM/vLLM/Ollama 兼容端点；生产环境必须是 HTTPS：

```dotenv
MATCHPLANE_ROUTER_AI_URL=https://llm-gateway.example.com/v1/chat/completions
MATCHPLANE_ROUTER_AI_KEY=server-side-secret
MATCHPLANE_ROUTER_AI_MODEL=openai/gpt-4o-mini
MATCHPLANE_ROUTER_AI_TOOL_MODE=required
MATCHPLANE_ROUTER_AI_MAX_TOKENS=512
MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS=20000
```

配置 web 服务并重启后，根管理员可在“平台管理 → AI 与登录”点击“测试连接”。该按钮调用
`POST /api/platform/ai/test`，只发送固定的健康检查文本和 `max_tokens=1`，不会把浏览器输入、密钥或
模型响应内容传给前端；返回 `ready` 后再打开买方/卖方对话验证实际路由。未配置或上游不可用时，页面会
明确显示 `unconfigured`/`failed`，生产路由继续使用可审计的受控降级，不会伪装成 AI 成功。

`MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS` controls the total wall-clock budget for one recursive
platform route (default 20 seconds, hard maximum 60 seconds). Each provider request remains
bounded to four seconds, and once the shared deadline is reached the router records an explicit
policy fallback instead of waiting through every remaining platform hop.

外部买家/卖家 Agent 的模型由调用方自己选择并承担 token 成本；它们只使用 `matchplane.agent/v1` handoff、平台 MCP 和短期能力凭证，不共享根平台的模型 key。
