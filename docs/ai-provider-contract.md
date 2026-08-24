# AI 模型接入边界

MatchPlane 的根平台只需要一个受限的“平台路由器”模型调用，不把供应商 SDK 或 API key 放进 Rust 核心，也不把模型调用下放给子平台。`web/src/platform-router.ts` 支持三种服务端线协议：OpenAI-compatible Chat Completions、Anthropic Messages、Gemini GenerateContent。生产 effective 配置优先读取 rootSuperAdmin WebUI 管理的受保护文件；只有没有可用 managed 配置时才读取 `MATCHPLANE_ROUTER_AI_*` 作为运维 fallback。浏览器只得到 `credentialConfigured`、生效来源和非秘密冲突状态，永远得不到 key、fingerprint 或 provider response body。

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
- 只有一个 OpenAI-compatible 服务时，使用默认协议即可。
- 直接接 Anthropic Messages 时，将协议设为 `anthropic-messages`，endpoint 通常为 `/v1/messages`；认证使用服务端 `x-api-key` 头。
- 直接接 Gemini 时，将协议设为 `gemini-generate-content`，endpoint 可以是 `https://generativelanguage.googleapis.com/v1beta`，模型名使用 Gemini 的模型名；认证使用服务端 `x-goog-api-key` 头。
- 如果网关已经统一了多家模型，继续用 `openai-compatible`，把 provider/model 的选择留给网关做 fallback、预算和审计。

## 生产约束

1. Provider key 只能由 `api.lmm.best` 生成，再经 rootSuperAdmin 的 write-only 密码框写入受限、原子替换的 managed key 文件；也可由运维以 `MATCHPLANE_ROUTER_AI_KEY` 提供 fallback。不得使用 `NEXT_PUBLIC_` 前缀，不得下发给浏览器、外部 Agent 或日志。
2. M0 AI-ready 只接受最终 effective 配置 `https://api.lmm.best/v1`、`gpt-5.6-sol`、`openai-compatible` 与已配置凭据。managed 覆盖 env 时，状态必须明确显示 source 和 endpoint/model/protocol 的非秘密冲突。
3. WebUI 使用“保存待测配置 → 服务端连接测试 → 显式原子启用”；测试或保存失败不替换旧 active 配置。web 进程仍启动，以保证修复后台可访问；不合规时 public AI 返回安全的 `503 degraded`，doctor 在 AI enabled/required 时返回非零。
4. 网关必须提供 HTTPS、请求 deadline、最大输入/输出 token、并发/速率限制和用量账单。不得加入免费模型 fallback；MatchPlane 自身仍保留 deadline、小时级 admission、路由步数与扇出上限。
5. 配置审计只记录 actor、时间、endpoint origin、model、enabled、key_changed 和 request id；不得记录 API key、fingerprint、provider response body、完整用户隐私文本或联系人。
6. 模型只能在授权候选集合内选择，不得创建平台路径、商家 ID、商品 ID，也不得直接执行交易或联系人交换。

## 推荐配置

开发环境可以把 `MATCHPLANE_ROUTER_AI_URL` 指向本机 LiteLLM/vLLM/Ollama 兼容端点；生产环境必须是 HTTPS：

```dotenv
# WebUI managed 配置是生产首选；以下仅为 ops/fallback，key 不写入示例。
MATCHPLANE_ROUTER_AI_URL=https://api.lmm.best/v1
MATCHPLANE_ROUTER_AI_KEY=
MATCHPLANE_ROUTER_AI_MODEL=gpt-5.6-sol
MATCHPLANE_ROUTER_AI_PROTOCOL=openai-compatible
MATCHPLANE_ROUTER_AI_REQUIRED=true
MATCHPLANE_ROUTER_AI_PREFLIGHT_TIMEOUT_MS=20000
MATCHPLANE_ROUTER_AI_PREFLIGHT_BUDGET_MS=4000
```

rootSuperAdmin 在“平台管理 → AI 与登录”保存待测配置后，点击“测试待测配置”。`POST /api/platform/ai/test` 从服务器待测文件读取 key，只发送固定健康检查文本，不会把浏览器输入、密钥、fingerprint 或模型响应内容传给前端。只有返回 `ready` 才写入测试证明并开放“启用已测试配置”；激活通过单个配置指针原子切换到已预写的版本化 key 文件。失败时旧 active 配置与表单输入均保留。

`matchplane provider-preflight --json` 与 `matchplane doctor` 读取最终 effective 配置，因此不会因 `MATCHPLANE_ROUTER_AI_KEY` 为空而误判一个有效 managed key。未配置、timeout、provider 5xx 或 M0 endpoint/model 不匹配都以 `upstream_configuration` 和首选 HTTP `451` 出现在管理员 preflight；public AI 则统一返回不含秘密的 `503 degraded`。这些状态不会阻止 web 进程启动。

`MATCHPLANE_ROUTER_AI_PROTOCOL` 只接受 `openai-compatible`、`anthropic-messages` 或
`gemini-generate-content`；用户请求不能选择协议、endpoint 或模型。Gemini 的 endpoint 不要带 API key
查询参数，密钥只放在服务端 secret manager。`MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS` controls the total wall-clock budget for one recursive
platform route (default 20 seconds, hard maximum 60 seconds). Each provider request remains
bounded to four seconds, and once the shared deadline is reached the router records an explicit
policy fallback instead of waiting through every remaining platform hop.

外部买家/卖家 Agent 的模型由调用方自己选择并承担 token 成本；它们只使用 `matchplane.agent/v1` handoff、平台 MCP 和短期能力凭证，不共享根平台的模型 key。
