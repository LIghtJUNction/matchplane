# MatchPlane CLI 与 MCP 运维接口

备份后的 `matchplane` 执行文件是改变工作负载的运营边界。它保持服务选择显着化的方式，并允许 systemd、Compose、Helm 或运营代理使用相同的入口：

```sh
matchplane doctor --json
matchplane status --json
matchplane migrate
matchplane provision-root --tenant-slug <slug> --tenant-name <name> --admin-email <operator-email>
matchplane admin-invite --role root-admin
sudo matchplane passwd
matchplane admin-invite --role subplatform-admin --organization-id <organization-uuid>
matchplane federation-invite --domain-id <domain-uuid>
matchplane serve gateway
matchplane serve subplatform-builder
matchplane mcp serve
```

`provision-root` 是干净安装时的初始化步骤。该命令要求运营者提供网关 slug 与显示名称，支持可选的首个域名 slug/name/UUID，并通过 `--admin-email`（或 `MATCHPLANE_ROOT_ADMIN_EMAIL`）输出下一步配置参数。该命令仅在运营者未提供时生成 UUIDv7 原型，执行迁移并完成网关和配置验证操作，并打印生成的 `MATCHPLANE_ROOT_TENANT_ID`、管理员邮箱和登录路径。它不会创建目录、资产示例、列表、支付成功或任何业务样例数据。与现有 ID 或 slug 冲突会失败，而不是覆盖持久化配置。后续要新增域名时，请复用第一次调用输出中的`--tenant-id`，并填写新的域名参数；最后`--tenant-id`会生成新的 UUID，并且这不是隐式查找。

`admin-invite` 是唯一的管理员入驻入口。它在数据库中只保存 SHA-256 令牌摘要，默认 24 小时过期且最多 7 天，只能兑换一次；原始令牌只出现在 CLI 输出的注册 URL 中已。首次部署必须先由验证的 `MATCHPLANE_ROOT_ADMIN_EMAIL` 登录并在 Web 初始化 Better Auth 根组织，之后 `root-admin`才能自动定位该根；`subplatform-admin` 必须显指定目标组织 UUID。CLI URL 自带 `next` 回跳参数。管理员和普通用户使用同一个 `/login` 组织表单，更好的身份验证建立并验证会话后服务端才交换邀请并获取 root 角色或管理员成员。不要把组织 URL 写入日志、工单或 shell 历史记录；如果是，请删除应答邀请或等待后期重新分配。

`passwd` 是服务器上的根管理员维护。命令它只接受 `rootSuperAdmin` 或 `rootAdmin` 账号，自动从主机受保护的 MatchPlane 配置读取默认管理员与数据库连接，因此经常维护只需一个命令；未配置默认管理员时才在 TTY 中询问邮箱。新密码默认通过隐藏的 TTY 两次读取；`--password-stdin` 可用于秘密管理员建立一行密码。密码不会出现在命令参数或日志中，成功后会撤销目标账号的全部 Better Auth 会话：

```sh
sudo matchplane passwd
```

命令自动读取主机的 root 拥有的配置文件；消耗手动加载环境变量。若需覆盖默认管理员，使用 `--email admin@matx.tech`；`auth passwd` 与旧的 `auth reset-password` 仍兼容输入。非 TTY 自动化必须显式使用 `--password-stdin`，并秘密管理器直接提供密码，不要让密码写进 shell 或历史命令参数。

根作用域的 Better Auth API 密钥要求运营者通过 `MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID` 提供对应的组织 UUID；web 服务不会从子平台或市场记录中推断。

平台绑定的入嵌与独立联邦边界参见 [`docs/platform-federation-binding.md`](platform-federation-binding.md)：API 密钥仅承担短期机器授权，不能单独代表远端平台或入驻信任。

根管理员可用 Web 的"远程平台"面板发出一次性邀请；值班代理也可以通过对话
`matchplane mcp serve`发现状态，再由受信的变更流程调用
`/api/platform/federation/invites`、`/api/platform/federation/enroll` 和
`/api/platform/federation/bindings/activate`。入驻清单必须使用
[`federation-enrollment-protocol-v1.md`](federation-enrollment-protocol-v1.md)的签名规则，
激活前不会进入路由树。

`serve`仅启动一个指定的备用工作负载，并透传其环境变量与标准输入输出。若默认值（`node`和`/usr/share/matchplane/web/server.js`）不合适，web工作负载可使用`MATCHPLANE_WEB_NODE`和`MATCHPLANE_WEB_SERVER`。当显节点路径不存在时，CLI会依次探测`/usr/local/bin/node`、`/usr/bin/node`和PATH中的`node`，兼容发行版包与运营方安装的固定节点运行时；若不可用，仍保留原配置路径以便systemd记录错误。进程托管仍由监督语音器负责，例如用户权限、资源限制、重启策略及信号/终止策略。

`matchplane serve subplatform-builder`只启动隔离构建器二进制文件；它不读取`MATCHPLANE_DATABASE_URL`，也不提供shell/MCP工具。生产环境应通过独立容器式或systemd沙箱给予它`MATCHPLANE_SUBPLATFORM_BUILDER_WEB_URL`、回调令牌、上传目录、artifact目录写和独立工作根，并显配置`bubblewrap`、来源主机白名单与构建时间限制。Bun包可通过`MATCHPLANE_SUBPLATFORM_BUILDER_BUN`指定绝对路径（例如官方安装脚本生成的`/opt/bun/bin/bun`）；未设置时使用服务路径中的`bun`，运行时版本由运营方选择，不写入子平台清单。

该worker会先声明`/api/platform/subplatforms/discover/claim`，从Git/`upload://`来源读取唯一`matchplane.subplatform.json`，再回写`/discover/complete`或`/discover/fail`；只有发现`ready`后，Web管理员才需要登记并等待后续静态构建。源码解析与构建占用独立工作根，不使用共享`/tmp`。

## MCP stdio 合约

`matchplane mcp serve` 为 MCP 客户端实现换行分隔的 JSON-RPC。它为四个串口工具提供 `initialize`、`tools/list` 和 `tools/call`：

- `platform.status` — 探测网关、支付与 web 的验证 URL；
- `platform.health` — 给予简化客户端返回同一套基础健康报告；
- `platform.doctor` — 验证已加载的 `MATCHPLANE_*` 配置和生产门禁止。
- `platform.ai.status` — 专用检查平台托管代理的服务端 URL 来源、协议、模型和交换机是否齐全；其优先读取 Web 管理员保存到主机受保护目录的启用配置，并在该配置不可用时回退到 `MATCHPLANE_ROUTER_AI_*` 环境变量，与实际路由器的选择顺序一致。
  结果保留用于兼容性的首个 `error` 字段，同时额外包含 `errors` 阵列，顺序所有检测到的阻塞项，除运营者或代理一次性准备变更集，是每次只处理一个失败检查项。敏感值会被脱敏，配置加载器在负载启动时同样会失败。

健康 URL 使用运营配置项（`MATCHPLANE_GATEWAY_HEALTH_URL`、`MATCHPLANE_PAYMENT_HEALTH_URL` 和 `MATCHPLANE_WEB_HEALTH_URL`），默认指向环回。输出包含状态码和脱敏错误，不包含税务与连接字符串。`platform.status`、`platform.doctor` 和 `platform.ai.status` 还会返回 `hosted_agent` 摘要：它只包含 origin、协议、模型、`key_configured` 和保护秘密的修复提示，不会把完整端点、API key、主机文件或提示打出来。该服务不会提供 shell 执行、任何 HTTP 转发、数据库写入、支付动作或理论数据。平台撮合与子平台检索各自的已认证 HTTP/MCP 合约，本运维服务器不具备放行权限。web 服务在 `/api/mcp` 提供内容已认证的 HTTP MCP 门面；其 `platform.match` 工具转发与聊天 API它支持域内任意的`idempotency_key`（最多240个可打印字符）；同一约定方、同一规范化平台路径与同一密钥的重试会返回原始路由结果而不再触发托管模型，而不同的意愿内容会被调用为冲突并拒绝。重复的请求会返回`409`并带`Retry-After: 2`，可在首请求完成后重试。`platform.agent.handoff`工具会接收调用方自费的`matchplane.agent/v1`报文，持久化幂等切换，并仅返回激活的直系子节点能力。不会调用根模型：外部需求方/接收方代理自行承受提供者结算与令牌。机器调用请使用带显式`agent:handoff`权限的组织API密钥。

HTTP 门面在转发前会先验证声明的作用域与预算签约：平台路径标准化，租户/域/方标识符必须是 UUID，市场调用必须显式带 `platform_path`，并且代理切换始终调用方自费。Rust 网关仍然是最终授权与领域架构的仲裁者；这层验证早期仅是确定性的 MCP 边界，不接收实际访问。

活动的子平台工具通过 `platform.child.tool` 提出；调用方需携带 `agent:tool` 的组织 API 密钥，并在请求中给出激活子路径与该子路径清单声明的工具名。web 服务仅从操作端配置的 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 解析地址；生产环境要求 HTTPS；会限制请求/响应体大小与超时时间，并且不会调用方的 `x-matchplane-api-key`转发到子服务端。这是搜索/技能扩展点；根服务不决定支持库类型，也不执行子包代码。

声明 `media.upload` 的包转发通过 `POST /api/platform/media/upload` 接收浏览器/Agent 的架构数据请求。根会先验证浏览器会话或具备 `media:upload` 权限的 API key，再读取 base64 信封组织；浏览器会话还必须拥有当前子平台成员权限。根只转发临时 base64 信封，子平台必须扫描、存储和图片/文档解析，并返回 `media://`默认请求大小为 25 MiB，补充 `MATCHPLANE_MEDIA_MAX_BYTES` 配置至 256 MiB 上限；反向代理必须同步配置，禁止用无界体解除所有限制。

搜索协议已经有可运行的根代理：`POST /api/platform/retrieval/query`接收`matchplane.retrieval/v1`报文，要求`scope.platform_path`、`tenant_id`、`domain_id`和`retrieval:query`权限，并只声明转发到目标主动清单的`retrieval.query`。子平台返回的提供商、候选、分数和`degraded`会按[`docs/retrieval-protocol-v1.json`](retrieval-protocol-v1.json) 严格验证；不会根把授权候选结果提交股票、支付或成交。

相同报文也可通过已认证的 HTTP MCP 门面调用：向 `POST /api/mcp` 发送 JSON-RPC `tools/call`，工具名为 `platform.retrieval.query`，`arguments` 直接使用上述 `matchplane.retrieval/v1` 信封。它复用专用搜索门面的 `retrieval:query`、东京/域/邻近路径校验和活动清单白名单，不会为可指定端点的通用 HTTP转发；`tools/list` 会公布完整的输入模式。

机器Agent继续要使用通用市场工具时，请创建组织API密钥，并设置`platform:read`（仅在先调用`platform.match`选择平台时需要）、`marketplace:write`与中性`agentSide`元数据，取值`demand`、`supply`或`both`。如果Agent还要调用类型`queryRetrieval()`，重新加入`retrieval:query`；不要为只发布RB的密钥额外检索权限。旧字段`agentRole`仅作为兼容迁移别名保留。通过`/api/mcp`调用`marketplace.agent.session`（或`POST /api/marketplace/agent-session`），并取得生效的`tenant_id`、`domain_id`、`platform_path`与内核`side`（`demand` 或 `supply`）。响应会返回机场/旁作用域的 15 分钟方承载及 `access_token_expires_at` 焊接时间。通知承载作为 `Authorization: Bearer ...` 传给 `marketplace.intent.*`、`marketplace.offer.*`、`marketplace.demand.match`、`marketplace.intent.discovery.update` 与`marketplace.introduction.*`工具。需求代理仅在意图时显式设置`supply_discovery_enabled: true`，赋能代理才能看到适配器参与者ID和联系方式的需求摘要；需求方可随时调用发现更新撤回后续发现。这不继于引介或打印机同意。该交换不会创建浏览器会话，不允许调用方指定`participant_id`，也不会返回接口信息。

当 doctor 验证或任何一个就绪探测失败时，退出码为非零。这使得 CLI 适用于 CI、systemd 预检，以及 Agent 的基础工具循环。生产环境应将 `errors` 中每一个都视为必检门；不要仅因为测试 Compose 的 web 健康接口返回 200 就上线。
