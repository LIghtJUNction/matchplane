# AI 模型接入边界

MatchPlane 根平台通过一份服务端供应商配置运行托管路由器。供应商凭据只保存在服务器受保护存储中，不得下发给浏览器、子平台、外部 Agent 或日志。

配置合约只支持三种线协议：

- `openai-compatible`
- `anthropic-messages`
- `gemini-generate-content`

平台不强制任何 endpoint、模型或供应商。TokenRhythm/DeepSeek 的 OpenAI-compatible 部署是合法配置；Anthropic 与 Gemini 的官方 API 根地址在选择对应协议后同样合法。

## 生效配置

配置同时满足以下条件才是 AI-ready：

1. 协议是上述三个已知值之一。
2. 模型 ID 非空、不超过 256 个字符，并以 ASCII 字母或数字开头；其余字符只允许 ASCII 字母、数字、`.`、`_`、`-`、`/` 或 `:`。Gemini 会把模型 ID 放入原生模型路径，因此额外禁止 `/` 和 `:`。
3. endpoint 使用 HTTPS，不含 userinfo、query 或 fragment，并通过公网 endpoint 安全校验。
4. 服务端凭据已配置。
5. 配置已启用。
6. 如果设置了 origin allowlist，endpoint 的精确 origin 必须在允许范围内。

只要 managed 状态存在，rootSuperAdmin WebUI 管理的配置就具有权威性。即使该配置被禁用、不完整或无法读取，MatchPlane 也会失败关闭，不会静默使用环境凭据。环境中的 endpoint、model、protocol 差异只作为非秘密、信息性的冲突报告。

只有完全不存在 managed 状态时，`MATCHPLANE_ROUTER_AI_*` 才作为运维 fallback。面向浏览器的安全状态可以返回生效来源、endpoint origin、模型、协议、凭据是否存在、policy issues、冲突和 `originAllowlistApplied`。状态不得返回所谓“必选供应商元组”、API key、fingerprint、credential file 或供应商响应正文。

## 可选 origin allowlist

`MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS` 是可选的、以逗号分隔的精确 HTTPS origin 列表：

```dotenv
MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS=https://api.anthropic.com,https://generativelanguage.googleapis.com
```

每项只能包含 scheme、host 和可选 port。path、query、fragment、userinfo、空项及非 HTTPS origin 都是无效配置，并会失败关闭。变量为空或未设置时，允许任意公网 HTTPS origin；运行时 DNS 与传输安全校验仍然生效。

allowlist 同时约束 managed 与 environment 配置。状态只报告是否应用 allowlist，不返回列表内容。

## 手动配置模型

三种协议及各种 OpenAI-compatible 供应商之间不存在官方、可移植的统一模型列表 API。管理员必须从供应商文档复制准确的模型 ID，并在启用前执行连接测试。

因此 WebUI 使用必填的手动模型输入和协议专属说明，不提供模型下拉框，也不会联系供应商枚举模型。`POST /api/platform/ai/models` 仅保留一个兼容版本：通过 trusted-origin、登录和 rootSuperAdmin 校验后，固定返回 HTTP `410` 与代码 `manual_model_configuration_required`，绝不联系供应商。

示例：

```dotenv
# TokenRhythm / DeepSeek 的 OpenAI-compatible endpoint
MATCHPLANE_ROUTER_AI_URL=https://tokenrhythm.studio
MATCHPLANE_ROUTER_AI_MODEL=deepseek-v4-flash-0731
MATCHPLANE_ROUTER_AI_PROTOCOL=openai-compatible

# Anthropic 官方根地址
MATCHPLANE_ROUTER_AI_URL=https://api.anthropic.com
MATCHPLANE_ROUTER_AI_MODEL=claude-sonnet-4-6
MATCHPLANE_ROUTER_AI_PROTOCOL=anthropic-messages

# Gemini 官方根地址
MATCHPLANE_ROUTER_AI_URL=https://generativelanguage.googleapis.com
MATCHPLANE_ROUTER_AI_MODEL=gemini-2.5-flash
MATCHPLANE_ROUTER_AI_PROTOCOL=gemini-generate-content
```

模型是否可用以及模型 ID 会随时间变化；以上示例只说明合约形状，不构成固定模型目录。

## Managed 生命周期与秘密

WebUI 生命周期是：**保存待测配置 → 服务端连接测试 → 显式原子启用**。保存或测试待测配置不会替换当前 active 配置；只有取得 ready 测试证明后才能启用。

API key 输入框是 write-only。按生命周期规则允许时，留空会保留服务器中的待测或 active key；读取接口只返回 `credentialConfigured`。存储 generation schema 与版本化 credential reference 保持不变。

配置审计可以记录 actor、时间、endpoint origin、model、protocol、enabled、key_changed 与 request ID，不得记录 key、fingerprint、供应商响应正文、用户隐私文本或联系方式。

外部买家/卖家 Agent 自己选择模型并承担 token 成本。它们只使用受限的 `matchplane.agent/v1` handoff、平台 MCP 工具和短期能力凭证，不共享根平台供应商 key。
