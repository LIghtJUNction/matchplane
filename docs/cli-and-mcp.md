# MatchPlane CLI 与 MCP 运维接口

打包后的 `matchplane` 可执行文件是后端工作负载的运营边界。它保持服务选择显式化，并允许 systemd、Compose、Helm 或运营 Agent 使用同一入口：

```sh
matchplane doctor --json
matchplane status --json
matchplane migrate
matchplane provision-root --tenant-slug <slug> --tenant-name <name> --admin-email <operator-email>
matchplane admin-invite --role root-admin
matchplane admin-invite --role subplatform-admin --organization-id <organization-uuid>
matchplane federation-invite --domain-id <domain-uuid>
matchplane serve gateway
matchplane serve subplatform-builder
matchplane mcp serve
```

`provision-root` 是干净安装时的身份初始化步骤。该命令要求运营者提供租户 slug 与展示名，支持可选的首个域名 slug/name/UUID，并通过 `--admin-email`（或 `MATCHPLANE_ROOT_ADMIN_EMAIL`）仅用于打印下一步配置分配。该命令仅在运营者未提供时生成 UUIDv7 标识符，执行迁移，执行幂等的创建/验证事务，并打印生成的 `MATCHPLANE_ROOT_TENANT_ID`、管理员邮箱和登录路径。它不会创建目录、资产 schema、列表、支付提供商或任何业务样例数据。若与现有 ID 或 slug 冲突会失败，而不是覆盖持久化配置。后续要新增域名时，请复用首次调用输出中的 `--tenant-id`，并携带新的域名参数；省略 `--tenant-id` 会生成新 UUID，并且这不是隐式查找。

`admin-invite` 是唯一的管理员入驻入口。它在数据库中只保存 SHA-256 token 摘要，默认 24 小时过期且最多 7 天，只能兑换一次；原始 token 只出现在 CLI 输出的注册 URL 中。首次部署必须先由已验证的 `MATCHPLANE_ROOT_ADMIN_EMAIL` 登录并在 Web 初始化 Better Auth 根组织，之后 `root-admin` 才能自动定位该根组织；`subplatform-admin` 必须显式指定目标组织 UUID。CLI URL 自带 `next` 回跳参数。管理员和普通用户使用同一个 `/login` 表单，Better Auth 建立并验证会话后服务端才兑换邀请并授予 root 角色或组织 admin 成员资格。不要把 URL 写入日志、工单或 shell 历史；如果泄露，请删除对应邀请或等待过期后重新签发。

根作用域的 Better Auth API key 要求运营者通过 `MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID` 提供对应的组织 UUID；web 服务不会从子平台或 marketplace 记录中推断。

平台绑定的入嵌与独立联邦边界见 [`docs/platform-federation-binding.md`](platform-federation-binding.md)：API key 只承担短期机器授权，不能单独代表远端平台身份或入驻信任。

根管理员可用 Web 的“远程平台”面板签发一次性 invite；值班 Agent 也可以通过只读
`matchplane mcp serve` 发现状态，再由受信的变更流程调用
`/api/platform/federation/invites`、`/api/platform/federation/enroll` 和
`/api/platform/federation/bindings/activate`。入驻清单必须使用
[`federation-enrollment-protocol-v1.md`](federation-enrollment-protocol-v1.md) 的签名规则，
激活前不会进入路由树。

`serve` 仅启动一个指定的打包工作负载，并透传其环境变量与标准输入输出。若默认值（`node` 和 `/usr/share/matchplane/web/server.js`）不合适，web 工作负载可使用 `MATCHPLANE_WEB_NODE` 与 `MATCHPLANE_WEB_SERVER`。进程托管仍由监督器负责，例如用户权限、资源限制、重启策略及信号/终止策略。

`matchplane serve subplatform-builder` 只启动隔离构建器二进制；它不读取 `MATCHPLANE_DATABASE_URL`，也不提供 shell/MCP 工具。生产环境应通过独立容器或 systemd sandbox 给予它 `MATCHPLANE_SUBPLATFORM_BUILDER_WEB_URL`、callback token、上传只读目录、artifact 写目录和独立工作根，并显式配置 `bubblewrap`、来源 host allowlist 与构建时间上限。

该 worker 会先 claim `/api/platform/subplatforms/discover/claim`，从 Git/`upload://` 来源读取唯一 `matchplane.subplatform.json`，再回写 `/discover/complete` 或 `/discover/fail`；只有 discovery `ready` 后，Web 管理员才需要登记并等待后续静态构建。源码解析与构建共用独立工作根，不使用共享 `/tmp`。

## MCP stdio 合约

`matchplane mcp serve` 为 MCP 客户端实现换行分隔的 JSON-RPC。它为三个只读工具提供 `initialize`、`tools/list` 与 `tools/call`：

- `platform.status` — 探测网关、支付与 web 的就绪 URL；
- `platform.health` — 给简化客户端返回同一套受限健康报告；
- `platform.doctor` — 校验已加载的 `MATCHPLANE_*` 配置和生产门禁。
  结果保留用于兼容性的首个 `error` 字段，同时额外包含 `errors` 数组，列出所有检测到的阻塞项，便于运营者或 Agent 一次性准备变更集，而不是每次只处理一个失败检查项。敏感值会被脱敏，配置加载器在工作负载启动时依然会快速失败。

URL 使用运营配置项（`MATCHPLANE_GATEWAY_HEALTH_URL`、`MATCHPLANE_PAYMENT_HEALTH_URL` 和 `MATCHPLANE_WEB_HEALTH_URL`），默认指向 loopback。输出包含状态码和脱敏错误，不包含凭据与连接字符串。该服务不会提供 shell 执行、任意 HTTP 转发、数据库写入、支付动作或联系人数据。平台撮合与子平台检索仍在各自的已认证 HTTP/MCP 合约之下，本运维服务器不具备放行权限。web 服务在 `/api/mcp` 提供已认证的 HTTP MCP 门面；其 `platform.match` 工具转发与 chat API 相同的受限路由请求，并接受 Better Auth 会话或有作用域的组织 API key。它支持可选的 `idempotency_key`（最多 240 个可打印字符）；同一调用方、同一规范化平台路径与同一 key 的重试会返回原始路由结果而不再触发托管模型调用，而不同意图内容会被判定为冲突并拒绝。并发重复请求会返回 `409` 并带 `Retry-After: 2`，可在首请求完成后重试。`platform.agent.handoff` 工具会接收调用方自费的 `matchplane.agent/v1` 报文，持久化幂等 handoff，并仅返回活跃的直系子节点能力。它不会调用根模型：外部需求方/供给方 Agent 自行承担 provider 凭据与 token 账单。机器调用请使用带显式 `agent:handoff` 权限的组织 API key。

HTTP 门面在转发前会先校验声明的作用域与预算合约：平台路径必须标准化，tenant/domain/party 标识符必须是 UUID，marketplace 调用必须显式带 `platform_path`，且 Agent handoff 始终调用方自费。Rust 网关依然是最终授权与领域 schema 的仲裁者；这层早期校验仅是确定性的 MCP 边界，不授予实际访问。

活动的子平台工具通过 `platform.child.tool` 暴露；调用方需携带具备 `agent:tool` 的组织 API key，并在请求中给出激活子路径与该子路径 manifest 声明的工具名。web 服务从仅运营端配置的 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 解析终端地址；生产环境要求 HTTPS；会限制请求/响应体大小与超时时间，并且不会将调用方的 `x-matchplane-api-key` 转发到子服务端。这是检索/Skill 扩展点；根服务不决定向量库类型，也不执行子包代码。

检索协议已经有可运行的根代理：`POST /api/platform/retrieval/query` 接收 `matchplane.retrieval/v1` 报文，要求 `scope.platform_path`、`tenant_id`、`domain_id` 与 `retrieval:query` 权限，并只转发到目标 active manifest 声明的 `retrieval.query`。子平台返回的 provider、候选、分数和 `degraded` 会按 [`docs/retrieval-protocol-v1.json`](retrieval-protocol-v1.json) 严格校验；根不会把候选结果当作联系人、支付或成交授权。

机器 Agent 要继续使用通用 marketplace 工具时，请创建组织 API key，并设置 `platform:read`（仅在先调用 `platform.match` 选择平台时需要）、`marketplace:write` 与中性 `agentSide` 元数据，取值为 `demand`、`supply` 或 `both`。如果 Agent 还要调用 typed `queryRetrieval()`，再加入 `retrieval:query`；不要为只发布供给的 key 额外授予检索权限。旧字段 `agentRole` 仅作为兼容迁移别名保留。通过 `/api/mcp` 调用 `marketplace.agent.session`（或 `POST /api/marketplace/agent-session`），并携带生效的 `tenant_id`、`domain_id`、`platform_path` 与内核 `side`（`demand` 或 `supply`）。响应会返回租户/side 作用域的 15 分钟 party bearer 及 `access_token_expires_at` 截止时间。将该 bearer 作为 `Authorization: Bearer ...` 传给 `marketplace.intent.*`、`marketplace.offer.*` 与 `marketplace.introduction.*` 工具。该交换不会创建浏览器会话，不允许调用方指定 `participant_id`，也不会返回联系人信息。

当 doctor 校验或任一就绪探测失败时，退出码为非零。这使得 CLI 适用于 CI、systemd 预检，以及 Agent 的受限工具循环。生产环境应将 `errors` 中每一项都视为必检门禁；不要仅因为测试 Compose 环境的 web 健康接口返回 200 就上线。
