# 生产运行手册

本文档适用于单台 Ubuntu 主机配置。支付服务与联邦相关工作人员均监听森林地址；Nginx 是唯一对外暴露的 HTTP 入口。配置脚本 `configure-ubuntu-host.sh` 左右**测试启动脚本**，不得用于生产基地。

## 1. 准备主机

安装 PostgreSQL（含 TimescaleDB 与 pgvector）、启用 TLS 的 Valkey、Nginx、`curl`、`openssl`、Node.js 22.12.0 及以上版本，以及发布包。创建 `matchplane` 系统用户/组，并安装 `packaging/systemd/` 下的 systemd 单元。PostgreSQL 相关字符串必须要求 `sslmode=verify-full`。`/etc/matchplane/matchplane.env`文件应由 `root:matchplane` 持有；`/etc/matchplane/services/` 下各服务专用密钥文件由 `root:<service-group>` 持有，权限为 `0640`。

若启用内置隔离子平台构建器，请先运行 `sudo bash deploy/scripts/install-bun.sh`。使用 Bun 官方安装脚本获取最新稳定版，安装到 `/opt/bun-stable/bin/bun`，不会把版本写入子平台包；重复运行即可升级。安装后用 `bun --version` 与 `bun --revision` 留存运维记录。Bun 官方安装脚本要求 Linux 主机拥有 `unzip`，脚本会在启用时通过 apt 安装。

在启用生产服务前，为 web 进程、网关、支付服务、事件转发器（事件转发器）、匹配器（匹配器）、投影仪（投影服务）、向量工作者（支持工作器）和联邦中心（联邦枢纽）分别预置 PostgreSQL 角色与 Valkey ACL 用户；迁移脚本应使用独立的所有者（所有权）角色。子平台构建者不得获得数据库或 Valkey 权限，它只能通过 web 的短权限回调令牌每个运行时角色只分配其必需的表和函数权限，不要将其设置为数据库所有者或`CREATEROLE`/`CREATEDB`。把生成的连接串按服务单独写入一个文件，例如
`/etc/matchplane/services/payment-service.env`，仅包含`MATCHPLANE_DATABASE_URL`、`MATCHPLANE_VALKEY_URL`以及该服务实例的Kafka TLS路径。若Valkey使用专用CA而不是主机信任库，在同一个文件中设置`MATCHPLANE_VALKEY_CA_FILE`；客户端会以该PEM CA作为信任节点，不会降级到不加密证书。`event-relay`、`matcher`、`projector`需要Kafka客户端路径；`federation-hub` 需要服务端证书、私钥与客户端CA路径。仓库内置的单机初始化引导（bootstrap）使用测试角色，不能用于生产。

请勿将支付提供商凭据放入通用环境文件；应使用支付专用密钥目录或外部密钥管理系统。

该初始化引导的 PostgreSQL 初始化密码为root专用，永远无法给任何运行时服务账号。

Kafka 侧也必须为每个 Kafka 客户端获取独立客户端证书（或 SASL ）身份。转发器（relay）只能发布发件箱主题，匹配器可消费命令并发布匹配结果，投影仪可消费书增量并使用 Valkey 命名空间。不要在这些单元之间复用同一个 `client.key`。各单元会在公共模板事件后加载各自配置文件，若文件缺失则单元会直接失败而不会回退到共享身份生产。

备份后的生产模板位于 [packaging/config/matchplane.env](../packaging/config/matchplane.env)，systemd 单元依赖上述各服务文件。配置前必须先补齐部分文件，包内不会生成数据库或broker 账户。

在 Helm 部署中，需在 `deploy/helm/matchplane/values.yaml` 为每个服务实例设置 `runtime.serviceSecrets.<workload>` 与 `runtime.kafkaTlsSecrets.<workload>`。图表会在生产渲染需求值时刻意失败；`runtime.existingSecret` 与`runtime.existingKafkaTlsSecret`唯一是测试渲染的兼容回退项。启用前替换掉所有占位符。尤其要使用：唯一的节点 UUID、非开发环境的数据库和 Valkey 仓库、三份TLS 文件（服务端证书、私钥、客户端 CA）、平台涉及的 HTTPS 支付回调源站、HTTPS 的 `BETTER_AUTH_URL`、至少 32 个字符的高熵 `BETTER_AUTH_SECRET`，以及运营方持有的 `MATCHPLANE_ROOT_ADMIN_EMAIL`。认证服务将在运行时拒绝示例邮箱与占位秘密，并且只接受明确配置的 `BETTER_AUTH_URL` 和 `BETTER_AUTH_TRUSTED_ORIGINS` 作为浏览器来源。请把真实的Better Auth 配置写入 `/etc/matchplane/secrets/web/better-auth.env`（由 `root:matchplane-web` 持有，模式 `0640`）；web 单元会在共享环境文件加载该文件之后，避免网关和支付工作负载读取签名密钥。

在创建首个管理员时，请在同一个 web-only 机密/环境文件中配置根 SMTP 通道。设置`MATCHPLANE_ROOT_SMTP_HOST`、`_PORT`、`_TLS_MODE`、`_USERNAME`、`_CREDENTIAL_SECRET_REF`与`_FROM_ADDRESS`；秘密引用必须是`file://...`或`env://...`，不得明文写入密码。该通道与 `subplatform_email_configs` 工业隔离：root 管理员必须能在尚无任何子平台或子 SMTP 配置时接收首封验证码邮件。root 账号验权完成后，各子管理员可在其作用域子平台空间配置自己的 SMTP。为 web 负载设置根目录，布局为 `<tenant-uuid>/<domain-uuid>/<slot-name>`，并配置 `MATCHPLANE_SUBPLATFORM_SECRET_ROOT`；管理员仅存储形如 `secret://subplatform/<tenant>/<domain>/<slot>` 的不透明引用。子平台配置无法读取配置级`env://`变量或任意`file://`路径。

web 管理员 BFF 还需要网关和支付管理员 token 的缩小权限投影副本。在 systemd 下，分别放在 `/etc/matchplane/secrets/web/payment-admin.token` 与 `/etc/matchplane/secrets/web/gateway-admin.token`（权限 `0640`，组 `matchplane-web`）；支付与网关服务保留各自副本。在 Helm 下，将对应的 `payment-admin.token` 与 `gateway-admin.token` 写入现有支付/网关密钥；web Deployment只需挂载这两个密钥到`/run/matchplane/admin-secrets`。不要将完整支付密钥目录或网关 contact-data/invoice-key 目录挂载进 web 容器。

若启用 AI 路由，请仅在 web 服务的设定环境/密钥文件中`MATCHPLANE_ROUTER_AI_URL`、`MATCHPLANE_ROUTER_AI_MODEL`、`MATCHPLANE_ROUTER_AI_KEY`。浏览器绝不能获取供应商密钥。平台承担 token 成本；每次 Agent 调用上限为 24,000 个输入字符与 2,048 个输出 token，`MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR`（默认每个已认证主体 120）限制。`MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR`限制增加配置级上限上限（默认120），新增更多已验证账号时，托管供应商账单线性增长。每次供应商调用在入网前通过PostgreSQL全局与主体级咨询锁原子统计，并记录到`platform_ai_call_admissions`，避免纠纷同时通过相同左边限额。`MATCHPLANE_ROUTER_AI_MAX_STEPS`（默认8，硬上限16）一次中继可穿越的平台节点数，`MATCHPLANE_ROUTER_AI_MAX_FANOUT`（默认4，硬上限） 16）限制每个节点迭代扩散的分支数；`MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS`（默认 20 秒，硬上限 60 秒）一次递归路由的总墙钟时间，达到后记录受控策略回退并继续等待。每次选子节点前会重新读取其生效注册和可见策略。`platform_ai_usage`账本记录平台承载、模型、邻居布局与供应商回传的令牌数，不保存原始提示或供应商赤字。公测前请结合供应商损失调整小损失；当供应商损失时，会返回可审计的策略回退，而不是给用户歌剧。

拥有检索或其他代理工具的子平台，请配置清单中的 `agent.mcpServerKey`，并在 web 服务定义环境中通过 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 与该密钥绑定。每个包含操作方管理的 HTTPS `url`，需要时带 `tokenEnv`，其值从部署云端管理器挂载对加载。不要把端点或令牌写进仓库。`platform.child.tool`只要接受活跃且可见的子路径和清单中声明的工具名，且会终止调用方、强制请求超时与响应体限制。

商店 Agent 必须由商店运营方独立构建和部署，并通过运营方持有的 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 绑定到活动清单记录；核心 Compose 刻意不捆绑任何商店 Agent、token、数据卷或代理路由。生产部署应为每个 Agent 使用独立用户、持久化数据目录、专用 secret，并通过 HTTPS/mTLS 或受控内网网关暴露 `/mcp`。Agent 必须绑定活动注册给出的 tenant、domain 和 canonical path，不能从固定路径或示例名称推断作用域。子服务的 `catalog.upsert`、`retrieval.query` 和 `media.upload` 只处理通用 ABI；向量库、媒体扫描器和领域字段仍由商店运营方负责。激活包含 MCP 工具的注册前，运行一次 `initialize` 健康探测；没有健康 endpoint 时保持 registration 不可路由。

路由默认会发送预设函数工具 `matchplane.platform.select_children`（`MATCHPLANE_ROUTER_AI_TOOL_MODE=auto`）。工具的可选项枚举由服务端白名单（白名单）中子节点生成，因此供应商无法路由到未注册 slug。仅支持构成 JSON 的供应商可设置 `MATCHPLANE_ROUTER_AI_TOOL_MODE=disabled`；供应商支持强制工具调用时可用 `required`。 JSON，还是回策略退。

子平台备用器是独立的信任边界。`MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN`（或生产的`_TOKEN_FILE`）只配置在 web 与 builder 的决策交换机文件（或相当于 Kubernetes 的`subplatform-builder-token` key）中。systemd 必须把同一个随机值分别写入 `/etc/matchplane/secrets/web/builder.token`（`root:matchplane-web`, `0640`）和`/etc/matchplane/secrets/builder/builder.token`（`root:matchplane-builder`, `0640`）；web 单元前置，builder 单元前置，不能把 builder 目录授予 web 用户。`POST /api/platform/subplatforms` 不接受调用方自报的构建摘要。内置 `matchplane-subplatform-builder` 以无权限用户运行，只能声明/回写发现与构建租约；它没有数据库、支付、AI 或浏览器控件，也不挂载 Docker 套接字。它会校验Git 的完整 40 位提交、来源 SHA-256、manifest SHA-256，拒绝压缩路径穿越、软硬链接、设备文件、超大边界，并在 `bubblewrap --unshare-net` 的静态构建沙箱中只执行 `bun/npm/pnpm/yarn` 的固定构建模板。Bun 首先从 `/opt/bun-stable/bin` 与系统路径解析；操作方若需要另一个绝对路径，可通过`MATCHPLANE_SUBPLATFORM_BUILDER_BUN`覆盖，不一定要把当时版本写入进子平台运行包或服务代码。构建结果写入内容选定的工件目录，构建器永远不能激活路由。

发现通过 `POST /api/platform/subplatforms/discover/claim` 取得租约，成功后调用 `/discover/complete` 回写 `sourceDigest`、immutable `pinnedRevision`、`manifestDigest` 与清单；失败调用 `/discover/fail`，任务可重试但超过上限会进入 `rejected`。完成发现后，构建器再通过 `POST /api/platform/subplatforms/build/claim` 取得注册租约，成功后调用 `/build` 回写 `sourceDigest`、`manifestDigest`、`buildDigest`、`artifactPath` 与 `artifactEntry`；失败调用 `/build/fail`。租约到期可被另一名工人接管，回调须匹配租约。归档注册转发发到`POST /api/platform/subplatforms/upload`，请配置`MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT`为可写、持久的 staging 目录（或 Helm 的 builder/web 上传 PVC）。web 进程只存储不透明归档，不解压内容；builder 使用独立工作根（不要使用共享 `/tmp`），并按保留策略使用独立 builder 镜像、复杂根文件系统、tmpfs `/tmp`、CPU/内存/PID 提升和 drop-all 功能；Kubernetes 生产渲染必须提供 builder与web消耗的artifact/upload PVC。根/子平台管理员仍需调用激活接口。

当某个包包含浏览端 UI 时，清单的 `assets.staticDirectory` 必须生成含 `index.html` 的静态目录；构建器将其复制到 `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT/builds/<buildDigest>`，回调中的 `artifactPath` 固定为相对内容寻址的目录根目录，仅在激活后沙化箱路由 `/api/platform/plugin-assets/<mount>/...` 提供。构建器不得在该目录中保留密钥或服务端代码；每个版本使用唯一摘要地址目录。Git 来源摘要按固定提交的`git archive --format=tar`字节计算，归档来源摘要按上传原始字节计算；注册时提交的摘要必须与worker重算值一致。若清单声明了`agent.mcpTools`，生产激活还会要求对应的操作MCP端点已配置、通过公网/DNS校验并成功完成一次`initialize`；工具服务未就绪时保持不可路由，而不是返回"已启用"假状态。开发环境可先激活再补端点。

生产的环境 Next.js 路由针对未注册包资产采用失败关闭。只有当完整的递归路径可在更好的身份验证组织树中解析且`subplatform_registrations`有积极且不可变版本时才会渲染页面。该校验同样保护清单端点；取消注册会同时移除 UI 与代理路由，但不会清除审计历史。静态包渲染仅在非生产配置文件开放。

若子平台托管在不同来源，请在根 web 保持 `MATCHPLANE_OIDC_ENABLED=true`。Better Auth 将提供 root OIDC 发现、授权码 + PKCE 端点、轮换 JWKS 与同意页面。根平台管理员须通过 `/api/platform/oidc/clients` 为每个活跃子平台注册，且回调 URI 必须精确为 HTTPS；匿名动态客户端注册已关闭。返回的 `client_secret`只显示一次，并且仅写入子服务器密钥存储。子平台通过`(issuer, sub)`标识用户，再将OIDC结果交换为路径域内的MatchPlane能力；OIDC不会声明失去管理员、联系、支付或兄弟平台权限。删除子平台时请取消应答客户端，以恢复刷新令牌；审计记录仍保留。

对于国内用户的国家网络身份认证首选登录按 [国家身份登录契约](./national-identity-auth.md) 配置。它必须使用运营方获取官方应用接入点或授权网关；未配置时保持隐藏，邮箱/手机号、密钥和 OAuth 提供商继续可用。

## 2. 安装事件总线

在单机场景下，以 root 身份从仓库签出并安装固定的 KRaft 配置文件：

```sh
sudo bash deploy/scripts/install-kafka.sh
systemctl is-active kafka
```

脚本会解密 Apache Kafka 包的签名和，创建专用`kafka`用户，将代理与控制器绑定到环回地址（环回），取消自动创建主题，并创建五个 MatchPlane 主题（12 个分区）。该脚本刻意是单节点**测试/回环**配置；生产接入前请恢复支持 TLS/mTLS/ACL 的多代理集群；在客户端删除前不要承接生产流量。MatchPlane生产客户端将失败关闭，除非配置了 `MATCHPLANE_KAFKA_SECURITY_PROTOCOL=SSL` 与 CA/客户端证书和私钥路径。

## 3. 注册生产联邦节点

生产服务不会自注册节点身份。启动MatchPlane前，请在数据库迁移创建模式后插入由运营方管理的节点记录：

```sql
INSERT INTO federation_nodes
  (id, name, grpc_endpoint, signing_key, certificate_fingerprint,
   protocol_major, protocol_minor, status)
VALUES
  ('REPLACE_WITH_NODE_UUID',
   'REPLACE_WITH_UNIQUE_NODE_NAME',
   'https://REACHABLE_HOSTNAME:50051',
   'REPLACE_WITH_OPERATOR_MANAGED_SIGNING_KEY_REFERENCE',
   'REPLACE_WITH_SHA256_CLIENT_CERTIFICATE_FINGERPRINT',
   1, 0, 'active');
```

`id`必须与`MATCHPLANE_NODE_ID`精确一致，且该行保持`active`。若部署使用外部密钥管理器，请将签名密钥与证书私钥材料放在PostgreSQL外部；数据库中的值应为该协议要求的联邦身份引用。设置`MATCHPLANE_GRPC_ADDR`为本地监听地址，锁定附近的外部端点读取注册行。请勿将`0.0.0.0`外部广播的端点。

此 `federation_nodes` 表是 Order/Event Saga 的 gRPC 节点身份，不属于远程商城平台绑定。
远程 MatchPlane 平台应在 Web 的"远程平台"面板生成瞬时邀请，通过
`POST /api/platform/federation/enroll` 提交 Ed25519 清单，再由根管理员调用激活接口。激活
后会创建`source_kind=remote`配置路由投影；生产时必须给绑定`tokenEnv`，并把对应的承载
秘密只挂载到web进程。取消绑定会必须同时禁用本地路径，重新接入生成新邀请。完整
报文与规范JSON签名规则见[`docs/federation-enrollment-protocol-v1.md`](federation-enrollment-protocol-v1.md)。

## 4. 迁移并启动服务

使用预留CLI作为统一后台入口。启用服务实例前先运行`matchplane doctor --json`，再执行`matchplane migrate`，然后让systemd/Compose/Helm为各服务调用`matchplane serve <service>`。`matchplane mcp serve`是给值班代理使用的麻烦的stdio运维面。

启动 web 单元前先落地根组织身份。使用资源 CLI 并提供运营方管理值；如果根开始时不需要子域，可省略域参数：

```sh
export MATCHPLANE_ROOT_TENANT_SLUG=your-root-slug
export MATCHPLANE_ROOT_TENANT_NAME='Your platform name'
export MATCHPLANE_ROOT_ADMIN_EMAIL=admin@example.com
matchplane provision-root \
  --tenant-slug "$MATCHPLANE_ROOT_TENANT_SLUG" \
  --tenant-name "$MATCHPLANE_ROOT_TENANT_NAME" \
  --admin-email "$MATCHPLANE_ROOT_ADMIN_EMAIL"
```

该对相同入参幂等；对slug/ID不一致会执行，且仅输出根机场与管理员分配，不会创建目录、资产模式或任何业务样例数据。若先前未带域建立根，则输出命令中的租户UUID在拒绝后续域时加为`--tenant-id`复用；省略会新建租户身份。将输出命令值写入web服务环境后重启，再打开登录路径。web后，通过`/login?role=platform` 登录并在就绪面板上点击"初始化根平台组织"。该操作调用 Better Auth 的组织 API，将结果标记为该机场根组织，并仅收编历史未挂父节点的子节点。该操作幂等。`MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID` 仅希望将根作用域 API key 锁定到 UUID 的简单场景，为可选项，不宜从子包推导。

web 接近后访问 `/setup`（或 `/admin`）进入根管理员工作台。如果 root 管理员邮箱尚未配置，web 会以锁定状态运行，仅限预设状态，不会创建兜底管理员。配置运营方持有的 `MATCHPLANE_ROOT_ADMIN_EMAIL` 与 root SMTP 后重启 web，管理员先使用该邮箱在 `/login?role=platform` 注册并完成更好的身份验证验证，再在后台点击"初始化根平台组织"；只有根组织存在后，服务器才执行 `matchplane admin-invite --role root-admin`。CLI 输出的一次性`/admin/register?token=...&next=...` URL 必须通过受信渠道认知管理员；管理员与普通用户使用相同的登录/注册页面，完成更好的身份验证后会获得`rootAdmin`角色，并自动返回正确的管理工作区。子平台管理员`matchplane admin-invite --role subplatform-admin --organization-id <uuid>`，链接会回到对应子平台管理路径。也可以访问 `GET /api/platform/setup` 查看结构首次运行状态，返回是否有好的配置根网关、是否有激活域和子平台注册、是否存在 Better Auth 身份，不返回账户或地址账户。通过已认证子平台 API 注册子平台，等待隔离构建器附加不添加构建摘要后显激活方式。不要直接使用 SQL 插入 Better Auth 用户、组织、管理员角色或激活注册。

每个发布先执行一次性初始化器，再批量启用运行时单元：

```sh
systemctl start matchplane-initialize.service
systemctl enable --now \
  matchplane-gateway.service matchplane-payment-service.service \
  matchplane-event-relay.service matchplane-matcher.service \
  matchplane-projector.service matchplane-vector-worker.service \
  matchplane-federation-hub.service matchplane-web.service \
  matchplane-subplatform-builder.service
```

web/Better Auth 监听 `127.0.0.1:4173`，网关监听 `127.0.0.1:8080`，支付服务监听 `127.0.0.1:8081`，联邦 gRPC 使用配置地址。Kafka、PostgreSQL、Valkey 与支付 API 均不要公开到公网。Nginx 仅转发 [deploy/nginx/matchplane.conf](../deploy/nginx/matchplane.conf) 中声明路由。媒体上传的准确路径已解除 Nginx 默认的 1 MiB body 拦截；web 会先验证会话或 API key，再按`MATCHPLANE_MEDIA_MAX_BYTES` 施加 25 MiB 默认、256 MiB 硬顶部。托管读写图像读取绝对路径 `MATCHPLANE_HOSTED_MEDIA_ROOT`（释放包默认 `/var/lib/matchplane/media`）；该目录必须持久化、只对 `matchplane-web` 可写并加载加载。如果部署调整上传顶部，必须同步超时、内存和监控。不要把应用层顶部改成无界，超大视频应由停车场的对象存储直传。

## 5. 上线前验收

执行健康检查并检查消费者组状态：

```sh
curl --fail https://PUBLIC_ORIGIN/api/health/ready
curl --fail https://PUBLIC_ORIGIN/api/health/web
curl --fail http://127.0.0.1:8081/health/ready
systemctl --no-pager --plain --full status \
  matchplane-gateway matchplane-payment-service matchplane-event-relay \
  matchplane-matcher matchplane-projector matchplane-vector-worker \
  matchplane-federation-hub matchplane-web matchplane-subplatform-builder kafka
journalctl -u matchplane-matcher -u matchplane-projector --since '-10 min' --no-pager
```

然后在测试或预发机场各执行一次已认证市场介绍与一次支付供应商的沙箱交易。再确认联系审计、发件箱/事件中继、匹配器成交、Valkey投影、支付webhook/对、发票与退款记录，最后再放开生产供应商路由。

## 6. 安全更新与回滚

生产迁移前先按 [PostgreSQL backup gate](./postgresql-backup-gate.md) 显式启用本机 timer、执行一次 service，再把只读校验作为迁移门禁：

```sh
sudo matchplane-postgres-backup-verify && sudo matchplane migrate
```

校验失败时不得绕过；该门禁不实现自动 restore，也不能替代加密异机副本。

升级前先记录当前运行版本，并备份加密后的 PostgreSQL 与当前二进制、web 发布件、Nginx 同时配置、密钥引用。使用 `pg_restore --list`（或同等关系关系 PostgreSQL 工具）验证转储，再把第二份备份放到独立主机上。解包前下载 `SHA256SUMS` 并校验；CI 发布版本建议再校验 GitHub Artifact Attestation 与仓库、ref 对应（示例：
`gh attestation verify matchplane-*.tar.zst --repo LIghtJUNction/matchplane`）。在健康与业务元素运行阶段保持一个针对发布版本的单次回滚定时器，至少十分钟。仅当运营方确认本次发布有效时再关闭该定时器，否则应按定时器自动回退到上一个应用版本与配置。

不要对正在发布的版本原地覆盖。请先准备好版本化目录、校验校验和，再原子切换`current`符号链接；Nginx只能在`nginx -t`成功后重新加载，并在回滚窗口结束前保留上一个版本。

## 7. 支付与域名门禁

生产模式必须使用真实网关与不可变发票。通过管理员支付API配置EPay、Waffo Pancake、微信支付、支付宝及自行定制，预定保存在预设文件或合规发票管理系统。完成商户入网、回调签名验签、发票配置与一次的沙箱退款前，仍请保持测试模式。

内置的 Nginx 配置仅服务`matx.tech`，并希望证书位于`/etc/letsencrypt/live/matx.tech/`。请确认 DNS 仍指向该主机，且证书覆盖`matx.tech`（当前配置将未再覆盖`www`）。新主机接入时请先安装续期钩子并配置证书，切换流量：

```sh
sudo bash deploy/scripts/install-nginx-certbot-hook.sh
sudo certbot renew --dry-run
sudo certbot certonly --webroot -w /var/www/matchplane/acme \
  -d matx.tech
sudo nginx -t && sudo systemctl reload nginx
```
