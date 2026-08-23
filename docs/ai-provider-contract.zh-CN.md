# AI 模型接入边界

MatchPlane 的根平台只需要一个搭建的"平台路由器"模型调用，不把供应商 SDK 或 API key 调用 Rust 核心，也不把模型调用下放给子平台。`web/src/platform-router.ts` 支持透明服务端线协议：OpenAI 兼容的 Chat Completions、Anthropic Messages、GeminiGenerateContent。服务端读取 `MATCHPLANE_ROUTER_AI_URL`、`MATCHPLANE_ROUTER_AI_KEY`、`MATCHPLANE_ROUTER_AI_MODEL` 和`MATCHPLANE_ROUTER_AI_PROTOCOL`，只发送已激活候选节点的公开路由描述，严格限制工具参数为候选slug，并把模型不可用时的策略降级记录为`degraded`。

因此修改接入模型的最短路径不是Agent或子平台，而是在平台边界接一个模型网关：

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

- 需要使用统一接入很多原始协议、做模型路由、回退、预算和用量统计时，优先使用自托管LiteLLM；把MatchPlane的URL指向LiteLLM的OpenAI兼容入口，`MODEL`网关支持的`provider/model`名称。
- 已经运行 Vercel/Next.js，并希望在 TypeScript 中使用原始提供程序、构造输出和工具调用时，可在网关层增加 Vercel AI SDK（`ai` 加对应的 `@ai-sdk/*` 提供程序）。不要把这些提供程序包塞进 Rust 核心。
- MCP 是 Agent 的工具/数据边界，不是模型协议。子平台的支持搜索、商品索引和领域技能通过 MCP 暴露；根路由器只决定是否把请求转发给已授权节点。
- 只有一个兼容 OpenAI 的服务时，使用默认协议即可。
- 直接接Anthropic Messages时，将协议设为`anthropic-messages`，端点通常为`/v1/messages`；认证使用服务端`x-api-key`头。
- 直接连接Gemini时，将协议设为`gemini-generate-content`，端点可以是`https://generativelanguage.googleapis.com/v1beta`，模型名使用Gemini的模型名；认证使用服务端`x-goog-api-key`头。
- 如果网关已经统一了整个模型，继续用`openai-compatible`，把提供商/模型的选择转移网关做后备、预算和审计。

## 生产约束

1. `MATCHPLANE_ROUTER_AI_KEY`只能存在web服务端密钥文件，不得使用`NEXT_PUBLIC_`导出，也不得下发给浏览器或外部代理。
2.通过网关的模型白名单固定可用模型；MatchPlane只接受环境指标指定的模型，不接受用户输入的URL、模型名或提供商名。
3. 网关必须提供 HTTPS、请求截止时间、最大输入/输出令牌、并发/速率限制、回退和用量费用。MatchPlane 自身仍保留 4 秒调用超时、小时级准入、路由步数与扇出上限。
4. 记录请求id、型号、代币使用情况、降级和成本归属`platform`，不要记录API key、完整的用户隐私文本或合约。
5. 模型只能在授权候选集合内选择，不能创建平台路径、商家ID、商品ID，也不能直接执行交易或股票交易所。

## 推荐配置

开发环境可以把 `MATCHPLANE_ROUTER_AI_URL` 指向本机 LiteLLM/vLLM/Ollama 兼容端点；生产环境必须是 HTTPS：

```dotenv
MATCHPLANE_ROUTER_AI_URL=https://llm-gateway.example.com/v1/chat/completions
MATCHPLANE_ROUTER_AI_KEY=server-side-secret
MATCHPLANE_ROUTER_AI_MODEL=openai/gpt-4o-mini
MATCHPLANE_ROUTER_AI_PROTOCOL=openai-compatible
MATCHPLANE_ROUTER_AI_TOOL_MODE=required
MATCHPLANE_ROUTER_AI_MAX_TOKENS=512
MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS=20000
```

配置web服务并重启后，根管理员可在"平台管理→AI与登录"点击"测试连接"。该按钮调用
`POST /api/platform/ai/test`，只发送固定的健康检查文本和`max_tokens=1`，不会把浏览器输入、按键或
模型响应内容传输给接口；返回 `ready` 应答打开应答/应答对话验证实际路由。未配置或上游不可用时，页面会
明确显示`unconfigured`/`failed`，生产路由继续使用可审计的受控降级，不会伪装成AI成功。

`MATCHPLANE_ROUTER_AI_PROTOCOL` 只接受 `openai-compatible`、`anthropic-messages` 或
`gemini-generate-content`；用户请求不能选择协议、端点或模型。Gemini 的端点不要带 API key
查询参数，按键只放在服务端秘密管理器。`MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS`控制一次递归的总挂钟预算
平台路线（默认 20 秒，硬最大 60 秒）。每个提供商的请求仍然存在
限制为四秒，一旦达到共享截止时间，路由器就会记录一个显式的
策略回退，而不是等待每个剩余的平台跳跃。

外部买家/卖家代理的模型由调用方自己选择并承担代币成本；他们只使用`matchplane.agent/v1`交接、平台MCP和短期能力资源，不共享根平台的模型密钥。
