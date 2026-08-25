# 生产运行手册

本文档适用于单台 Ubuntu 主机部署。支付服务与联邦相关 worker 均监听私有地址；Nginx 是唯一对外暴露的 HTTP 入口。打包脚本 `configure-ubuntu-host.sh` 仅为**测试启动脚本**，不得用于生产租户。

## 1. 准备主机

安装 PostgreSQL（含 TimescaleDB 与 pgvector）、启用 TLS 的 Valkey、Nginx、`curl`、`openssl`、Node.js 22.12.0 及以上版本，以及发布包。创建 `matchplane` 系统用户/组，并安装 `packaging/systemd/` 下的 systemd 单元。PostgreSQL 连接字符串必须要求 `sslmode=verify-full`。`/etc/matchplane/matchplane.env` 文件应由 `root:matchplane` 持有；`/etc/matchplane/services/` 下各服务专用密钥文件由 `root:<service-group>` 持有，权限为 `0640`。

若启用内置隔离子平台 builder，先运行 `sudo bash deploy/scripts/install-bun.sh`。它使用 Bun 官方安装脚本获取最新稳定版，安装到 `/opt/bun-stable/bin/bun`，不会把版本写入子平台包；重复运行即可升级。安装后用 `bun --version` 与 `bun --revision` 留存运维记录。Bun 官方安装脚本要求 Linux 主机具备 `unzip`，脚本会在缺少时通过 apt 安装。

在启用生产服务前，为 web 进程、网关、支付服务、event relay（事件转发器）、matcher（匹配器）、projector（投影服务）、vector worker（向量工作器）和 federation hub（联邦枢纽）分别预置 PostgreSQL 角色与 Valkey ACL 用户；迁移脚本应使用独立的 owner（所有者）角色。子平台 builder 不得获得数据库或 Valkey 凭据，它只通过 web 的短权限 callback token 工作。每个运行时角色只授予其必需的表和函数权限，不要将其设置为数据库 owner 或 `CREATEROLE`/`CREATEDB`。把生成的连接串按服务单独写入一个文件，例如
`/etc/matchplane/services/payment-service.env`，仅包含 `MATCHPLANE_DATABASE_URL`、`MATCHPLANE_VALKEY_URL` 以及该服务实例的 Kafka TLS 路径。若 Valkey 使用部署专用 CA 而不是主机信任库，在同一文件中设置 `MATCHPLANE_VALKEY_CA_FILE`；客户端会以该 PEM CA 作为信任锚，不会降级到不校验证书。`event-relay`、`matcher`、`projector` 需要 Kafka 客户端路径；`federation-hub` 需要服务端证书、私钥与 client CA 路径。仓库内置的单机初始化引导（bootstrap）使用测试角色，不能用于生产。

请勿将支付提供商凭据放入通用环境文件；应使用支付专用密钥目录或外部密钥管理系统。

该初始化引导的 PostgreSQL 初始化密码为 root 专用，永远不得授予给任何运行时服务账号。

Kafka 侧也必须为每个 Kafka 客户端发放独立客户端证书（或 SASL 身份）。事件转发器（relay）只能发布 outbox 主题，matcher 可消费命令并发布匹配结果，projector 可消费 book 增量并使用其 Valkey 命名空间。不要在这些单元之间复用同一个 `client.key`。各单元会在公共模板之后加载各自配置文件，若文件缺失则单元会直接失败而不会回退到共享的生产身份。

打包后的生产模板位于 [packaging/config/matchplane.env](../packaging/config/matchplane.env)，systemd 单元依赖上述各服务文件。部署前必须先补齐全部文件，包内不会生成数据库或 broker 凭据。

在 Helm 部署中，需在 `deploy/helm/matchplane/values.yaml` 为每个服务实例设置 `runtime.serviceSecrets.<workload>` 与 `runtime.kafkaTlsSecrets.<workload>`。chart 会在生产渲染缺少值时刻意失败；`runtime.existingSecret` 与 `runtime.existingKafkaTlsSecret` 仅是测试渲染的兼容回退项。启用服务前要替换掉所有占位符。尤其要使用：唯一的 node UUID、非开发环境的数据库和 Valkey 凭据、三份 TLS 文件（服务端证书、私钥、client CA）、平台所属的 HTTPS 支付回调源站、HTTPS 的 `BETTER_AUTH_URL`、至少 32 字符的高熵 `BETTER_AUTH_SECRET`，以及运营方持有的 `MATCHPLANE_ROOT_ADMIN_EMAIL`。认证服务会在运行时拒绝示例邮箱与占位 secret，并且只接受明确配置的 `BETTER_AUTH_URL` 与 `BETTER_AUTH_TRUSTED_ORIGINS` 作为浏览器来源。请把真实的 Better Auth 配置写入 `/etc/matchplane/secrets/web/better-auth.env`（由 `root:matchplane-web` 持有，模式 `0640`）；web 单元会在共享环境文件之后加载该文件，避免网关和支付工作负载读取签名密钥。

在创建首个管理员之前，请在同一 web-only secret/environment 文件中配置部署级 root SMTP 通道。设置 `MATCHPLANE_ROOT_SMTP_HOST`、`_PORT`、`_TLS_MODE`、`_USERNAME`、`_CREDENTIAL_SECRET_REF` 与 `_FROM_ADDRESS`；凭据引用必须是 `file://...` 或 `env://...`，不得明文写密码。该通道与 `subplatform_email_configs` 故意隔离：root 管理员必须能在尚无任何子平台或子 SMTP 配置时接收首封验证码邮件。root 账号验权完成后，各子管理员可在其作用域子平台空间配置自己的 SMTP。为 web 负载设置只读密钥根目录，布局为 `<tenant-uuid>/<domain-uuid>/<slot-name>`，并配置 `MATCHPLANE_SUBPLATFORM_SECRET_ROOT`；管理员仅存储形如 `secret://subplatform/<tenant>/<domain>/<slot>` 的不透明引用。子平台配置不能读取部署级 `env://` 变量或任意 `file://` 路径。

web 管理员 BFF 还需要网关和支付管理员 token 的窄权限投影副本。在 systemd 下，分别放在 `/etc/matchplane/secrets/web/payment-admin.token` 与 `/etc/matchplane/secrets/web/gateway-admin.token`（权限 `0640`，组 `matchplane-web`）；支付与网关服务保留各自副本。在 Helm 下，将对应的 `payment-admin.token` 与 `gateway-admin.token` 写入现有 payment/gateway secret；web Deployment 仅挂载这两个 key 到 `/run/matchplane/admin-secrets`。不要将完整支付密钥目录或 gateway contact-data/invoice-key 目录挂载进 web 容器。

若启用 AI 路由，请仅在 web 服务的受限环境/密钥文件中配置 `MATCHPLANE_ROUTER_AI_URL`、`MATCHPLANE_ROUTER_AI_MODEL`、`MATCHPLANE_ROUTER_AI_KEY`。浏览器绝不能拿到供应商 key。平台承担 token 成本；每次 Agent 调用上限为 24,000 个输入字符与 2,048 个输出 token，`MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR`（默认每个已认证主体 120）限制滥用。`MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR` 增加部署级总量上限（默认 120），以防新增更多已验证账号时，托管供应商账单线性增长。每次供应商调用在入网前通过 PostgreSQL 全局与主体级 advisory lock 原子计数，并记录到 `platform_ai_call_admissions`，避免并发对话同时通过同一剩余额度。`MATCHPLANE_ROUTER_AI_MAX_STEPS`（默认 8，硬上限 16）限制一次聊天可穿越的平台节点数，`MATCHPLANE_ROUTER_AI_MAX_FANOUT`（默认 4，硬上限 16）限制每个节点向下扩散的分支数；`MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS`（默认 20 秒，硬上限 60 秒）限制一次递归路由的总墙钟时间，达到后记录受控策略回退并停止继续等待。每次选子节点前会重新读取其生效注册和可见策略。`platform_ai_usage` 账本记录平台 bearer、模型、限额预算与供应商回传的 token 数，不保存原始 prompt 或供应商凭据。公测前请结合供应商限额调小配额；当供应商缺失时，会返回可审计的策略回退，而不是给用户计费。

对拥有 retrieval 或其他 Agent 工具的子平台，请配置 manifest 中的 `agent.mcpServerKey`，并在 web 服务受限环境中通过 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 与该 key 绑定。每个条目包含运营方管理的 HTTPS `url`，需要时带 `tokenEnv`，其值从部署密钥管理器挂载。不要把 endpoint 或 token 写进仓库。`platform.child.tool` 仅接受活跃且可见的子路径和 manifest 中声明的工具名，且会剥离调用方凭据、强制请求超时与响应体限制。

Web 的 catalog projection relay 默认启用；它从 `marketplace_offer_projection_jobs` 领取带 PostgreSQL lease 的小批次，按 `matchplane.catalog/v2` 投递并验证结构化 ACK。可用 `MATCHPLANE_CATALOG_RELAY_ENABLED=false` 显式停止领取，或用 `_INTERVAL_MS`（1–60 秒）、`_BATCH_SIZE`（1–32）、`_LEASE_SECONDS`（15–300）与 `_MAX_ATTEMPTS`（1–8）调整有界运行参数。滚动发布必须先添加 destination 列和新唯一约束，再部署理解 immutable registration 的网关/Web writer，最后移除旧的 version-only 唯一约束；仓库中的 `202608220002`/`202608220003` 已按这个顺序拆分。监控使用 `sudo matchplane catalog-projections status --limit 20`，或让只读运营 Agent 调用 `platform.catalog_projections.status`；它按 `status` 聚合 job，报告最老 actionable/dead age，并只返回不含 payload/endpoint/token 的有界问题行。禁止直接改 canonical offer、job 或 ACK。确需重放时只能执行 `sudo matchplane catalog-projections replay <dead-job-uuid> --reason "<已验证的修复原因>"`：命令会在事务内锁住 dead row、重新读取规范 offer 与当前 active immutable destination，并写入平台审计；destination 变化时旧 job 会被 supersede，而不是复制旧 payload。只读 MCP 故意不提供 replay。

商店 Agent 必须由商店运营方独立构建和部署，并通过运营方持有的 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 绑定到活动清单记录；核心 Compose 刻意不捆绑任何商店 Agent、token、数据卷或代理路由。生产部署应为每个 Agent 使用独立用户、持久化数据目录、专用 secret，并通过 HTTPS/mTLS 或受控内网网关暴露 `/mcp`。Agent 必须绑定活动注册给出的 tenant、domain 和 canonical path，不能从固定路径或示例名称推断作用域。子服务的 `catalog.upsert`、`retrieval.query` 和 `media.upload` 只处理通用 ABI；向量库、媒体扫描器和领域字段仍由商店运营方负责。激活包含 MCP 工具的注册前，运行一次 `initialize` 健康探测；没有健康 endpoint 时保持 registration 不可路由。

路由默认会发送受限函数工具 `matchplane.platform.select_children`（`MATCHPLANE_ROUTER_AI_TOOL_MODE=auto`）。该工具的可选项枚举由服务端 allowlist（白名单）中子节点生成，因此供应商无法路由到未注册 slug。仅支持结构化 JSON 的供应商可设置 `MATCHPLANE_ROUTER_AI_TOOL_MODE=disabled`；供应商支持强制工具调用时可用 `required`。持久化的路由决策会记录结果来源于 MCP-compatible tool boundary、结构化 JSON，还是策略回退。

子平台打包器是独立的信任边界。`MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN`（或生产的 `_TOKEN_FILE`）只配置在 web 与 builder 的受限密钥文件（或等效 Kubernetes 的 `subplatform-builder-token` key）中。systemd 必须把同一个随机值分别写入 `/etc/matchplane/secrets/web/builder.token`（`root:matchplane-web`, `0640`）和 `/etc/matchplane/secrets/builder/builder.token`（`root:matchplane-builder`, `0640`）；web 单元只读前者，builder 单元只读后者，不能把 builder 目录授予 web 用户。`POST /api/platform/subplatforms` 不接受调用方自报的 build digest。内置 `matchplane-subplatform-builder` 以无特权用户运行，只能 claim/回写 discovery 与构建租约；它没有数据库、支付、AI 或浏览器密钥，也不挂载 Docker socket。它会校验 Git 的完整 40 位 commit、来源 SHA-256、manifest SHA-256，拒绝归档路径穿越、软硬链接、设备文件、超大条目，并在 `bubblewrap --unshare-net` 的静态构建沙箱中只执行 `bun/npm/pnpm/yarn` 的固定 build 模板。Bun 默认从 `/opt/bun-stable/bin` 与系统 PATH 解析；运营方若需要另一个绝对路径，可通过 `MATCHPLANE_SUBPLATFORM_BUILDER_BUN` 覆盖，不必把运行时版本写进子平台包或服务代码。构建结果写入内容寻址的 artifact 目录，builder 永远不能激活路由。

源码发现通过 `POST /api/platform/subplatforms/discover/claim` 取得租约，成功后调用 `/discover/complete` 回写 `sourceDigest`、immutable `pinnedRevision`、`manifestDigest` 与 manifest；失败调用 `/discover/fail`，任务可重试但超过上限会进入 `rejected`。完成 discovery 后，构建器再通过 `POST /api/platform/subplatforms/build/claim` 取得 registration 租约，成功后调用 `/build` 回写 `sourceDigest`、`manifestDigest`、`buildDigest`、`artifactPath` 与 `artifactEntry`；失败调用 `/build/fail`。租约过期可被另一 worker 接管，回调必须匹配 lease。归档注册上传发到 `POST /api/platform/subplatforms/upload`，请配置 `MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT` 为可写、持久的 staging 目录（或 Helm 的 builder/web upload PVC）。web 进程只存储不透明归档，不解压内容；builder 使用独立工作根（不要使用共享 `/tmp`），并按保留策略清理已消费上传。Compose 使用独立 builder image、只读根文件系统、tmpfs `/tmp`、CPU/内存/PID 上限和 drop-all capabilities；Kubernetes 生产渲染必须提供 builder 与 web 共用的 artifact/upload PVC。根/子平台管理员仍需调用激活接口。

当某个包包含浏览器端 UI 时，清单的 `assets.staticDirectory` 必须生成含 `index.html` 的静态目录；builder 会将它复制到 `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT/builds/<buildDigest>`，回调中的 `artifactPath` 固定为对应的相对 content-addressed 目录，root 仅在激活后通过沙箱化路由 `/api/platform/plugin-assets/<mount>/...` 提供。构建器不得在该目录放置密钥或服务端代码；每个版本使用唯一 digest 地址目录。Git 来源 digest 按固定 commit 的 `git archive --format=tar` 字节计算，归档来源 digest 按上传原始字节计算；注册时提交的 digest 必须与 worker 重算值一致。若 manifest 声明了 `agent.mcpTools`，生产激活还会要求对应的运营 MCP endpoint 已配置、通过公网/DNS 校验并成功完成一次 `initialize`；工具服务未就绪时保持不可路由，而不是返回“已启用”假状态。开发环境可先激活再补 endpoint。

生产环境的 Next.js 路由针对未注册包资产采用 fail-closed。只有当完整递归路径可在 Better Auth 组织树中解析且对应 `subplatform_registrations` 有活跃且不可变版本时才会渲染页面。该校验同样保护 manifest 端点；禁用注册会同时移除 UI 与 Agent 路由，但不会清除审计历史。静态包渲染仅在非生产 profile 开放。

若子平台托管在不同 origin，请在根 web 保持 `MATCHPLANE_OIDC_ENABLED=true`。Better Auth 将提供 root OIDC discovery、Authorization Code + PKCE 端点、轮换 JWKS 与同意页。根平台管理员须通过 `/api/platform/oidc/clients` 为每个活跃子平台注册，且 callback URI 必须精确为 HTTPS；匿名动态客户端注册已关闭。返回的 `client_secret` 只展示一次，并且仅写入子服务器密钥存储。子平台通过 `(issuer, sub)` 标识用户，再将 OIDC 结果交换为自身路径域内的 MatchPlane capability；OIDC 声明不会授予管理员、联系方式、支付或兄弟平台权限。移除子平台时请禁用对应 client，以回收刷新令牌；审计记录仍保留。

面向国内用户的国家网络身份认证首选登录按 [国家身份登录契约](./national-identity-auth.md) 配置。它必须使用运营方取得的官方应用接入凭据或授权网关；未配置时入口保持隐藏，邮箱/手机号、Passkey 和其他 OAuth provider 继续可用。

## 2. 安装事件总线

在单机场景下，以 root 身份从仓库签出并安装固定 KRaft profile：

```sh
sudo bash deploy/scripts/install-kafka.sh
systemctl is-active kafka
```

脚本会校验 Apache Kafka 包的校验和，创建专用 `kafka` 用户，将 broker 与 controller 绑定到环回地址（loopback），禁用自动创建主题，并创建五个 MatchPlane 主题（12 个分区）。该脚本刻意是单节点**测试/回环**配置；生产接入前请改为支持 TLS/mTLS/ACL 的多 broker 集群；在客户端冗余丢失前不要承接生产流量。MatchPlane 生产客户端将 fail-closed，除非配置了 `MATCHPLANE_KAFKA_SECURITY_PROTOCOL=SSL` 与 CA/客户端证书和私钥路径。

## 3. 注册生产联邦节点

生产服务不会自注册节点身份。启动 MatchPlane 前，请在数据库迁移创建 schema 后插入由运营方管理的节点记录：

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

`id` 必须与 `MATCHPLANE_NODE_ID` 精确一致，且该行保持 `active`。若部署使用外部密钥管理器，请把签名密钥与证书私钥材料放在 PostgreSQL 外；数据库中的值应为该协议要求的联邦身份引用。设置 `MATCHPLANE_GRPC_ADDR` 为本地监听地址，并将可达的外部 endpoint 写入注册行。请勿将 `0.0.0.0` 用作对外广播的 endpoint。

这张 `federation_nodes` 表是订单/事件 Saga 的 gRPC 节点身份，不等同于远程商城平台绑定。
远程 MatchPlane 平台应在 Web 的“远程平台”面板生成一次性 invite，通过
`POST /api/platform/federation/enroll` 提交 Ed25519 清单，再由根管理员调用激活接口。激活
后才会创建 `source_kind=remote` 路由投影；生产必须给绑定配置 `tokenEnv`，并把对应 bearer
secret 只挂载到 web 进程。撤销绑定会同时禁用本地路径，重新接入必须生成新 invite。完整
报文与规范 JSON 签名规则见 [`docs/federation-enrollment-protocol-v1.md`](federation-enrollment-protocol-v1.md)。

## 4. 迁移并启动服务

使用打包 CLI 作为统一后台入口。启用服务实例前先跑 `matchplane doctor --json`，再执行 `matchplane migrate`，然后让 systemd/Compose/Helm 为各服务调用 `matchplane serve <service>`。`matchplane mcp serve` 是给值班 Agent 使用的只读 stdio 运维面。

启动 web 单元前先落地根组织身份。使用打包 CLI 并提供运营方管理值；如果根开始时不需要子域，可省略 domain 参数：

```sh
export MATCHPLANE_ROOT_TENANT_SLUG=your-root-slug
export MATCHPLANE_ROOT_TENANT_NAME='Your platform name'
export MATCHPLANE_ROOT_ADMIN_EMAIL=admin@example.com
matchplane provision-root \
  --tenant-slug "$MATCHPLANE_ROOT_TENANT_SLUG" \
  --tenant-name "$MATCHPLANE_ROOT_TENANT_NAME" \
  --admin-email "$MATCHPLANE_ROOT_ADMIN_EMAIL"
```

该命令对相同入参幂等；对 slug/ID 不一致会拒绝执行，并且仅输出根租户与管理员分配，不会创建目录、资产 schema 或任何业务样例数据。若先前未带 domain 建立根组织，请将命令输出中的 tenant UUID 在后续加域时作为 `--tenant-id` 复用；省略会新建 tenant 身份。将输出值写入 web 服务环境后重启，再开放登录路径。web 可达后，通过 `/login?role=platform` 登录并在就绪面板点击“初始化根平台组织”。该操作调用 Better Auth 的 organization API，将结果标记为该租户根组织，并仅收编历史未挂父节点的子节点。该操作幂等。`MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID` 仅用于希望将根作用域 API key 锁定到单一 UUID 的部署场景，为可选项，不应从子包推导。

web 可达后访问 `/setup`（或 `/admin`）进入根管理员工作台。如果 root 管理员邮箱尚未配置，web 会以锁定状态运行，仅暴露受限状态，不会创建兜底管理员。配置运营方持有的 `MATCHPLANE_ROOT_ADMIN_EMAIL` 与 root SMTP 后重启 web，管理员先使用该邮箱在 `/login?role=platform` 注册并完成 Better Auth 验证，再在后台点击“初始化根平台组织”；只有根组织存在后，服务器才可执行 `matchplane admin-invite --role root-admin`。CLI 输出的一次性 `/admin/register?token=...&next=...` URL 必须通过受信渠道交给管理员；管理员与普通用户使用同一登录/注册页面，完成 Better Auth 验证后邀请才会授予 `rootAdmin` 角色，并自动回到正确的管理工作区。子平台管理员使用 `matchplane admin-invite --role subplatform-admin --organization-id <uuid>`，链接会回到对应子平台管理路径。也可以访问 `GET /api/platform/setup` 查看受限首次运行状态，仅返回是否存在配置好的 root 租户、是否有活跃域和子平台注册、是否已有 Better Auth 身份，不返回凭据或账户地址。通过已认证子平台 API 注册子平台，等待隔离构建器附加不可变 build digest 后显式激活。不要直接用 SQL 插入 Better Auth 用户、组织、管理员角色或激活注册。

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

web/Better Auth 监听 `127.0.0.1:4173`，网关监听 `127.0.0.1:8080`，支付服务监听 `127.0.0.1:8081`，联邦 gRPC 使用配置地址。Kafka、PostgreSQL、Valkey 与支付 API 均不要暴露到公网。Nginx 仅转发 [deploy/nginx/matchplane.conf](../deploy/nginx/matchplane.conf) 中声明路由。媒体上传的精确路径已解除 Nginx 默认的 1 MiB body 拦截；web 会先验证会话或 API key，再按 `MATCHPLANE_MEDIA_MAX_BYTES` 施加 25 MiB 默认、256 MiB 硬上限。托管店铺图片写入绝对路径 `MATCHPLANE_HOSTED_MEDIA_ROOT`（发行包默认 `/var/lib/matchplane/media`）；该目录必须持久化、只对 `matchplane-web` 可写并纳入备份。如果部署调整上传上限，必须同步超时、内存和监控。不要把应用层上限改成无界，超大视频应由外部店铺的对象存储直传。

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

然后在测试或预发租户各执行一次已认证 marketplace introduction 与一次支付供应商的 sandbox 交易。再确认联系审计、outbox/event relay、matcher 成交、Valkey 投影、支付 webhook/对账、发票与退款记录，最后再放开生产供应商路由。

## 6. 安全更新与回滚

生产迁移前先按 [PostgreSQL backup gate](./postgresql-backup-gate.md) 显式启用本机 timer、执行一次 service，再把只读校验作为迁移门禁：

```sh
sudo matchplane-postgres-backup-verify && sudo matchplane migrate
```

校验失败时不得绕过；该门禁不实现自动 restore，也不能替代加密异机副本。

每次更新前先记录当前运行版本，并同时备份加密后的 PostgreSQL 与当前二进制、web 发布件、Nginx 配置、密钥引用。使用 `pg_restore --list`（或同等 PostgreSQL 工具）验证 dump，再把第二份备份放到独立主机。解包前下载 `SHA256SUMS` 并校验；CI 发布版本建议再校验 GitHub Artifact Attestation 与仓库、ref 对应关系（示例：
`gh attestation verify matchplane-*.tar.zst --repo LIghtJUNction/matchplane`）。在健康与业务探针运行阶段保持一份针对发布版本的单次回滚定时器，至少十分钟。仅当运营方确认本次发布有效时再关闭该定时器，否则应按定时器自动回退到上一个应用版本与配置。

不要对正在发布的版本原地覆盖。请先准备版本化目录、校验 checksum，再原子切换 `current` 符号链接；Nginx 仅在 `nginx -t` 成功后 reload，并在回滚窗口结束前保留上一版本。

## 7. 支付与域名门禁

生产模式必须使用真实网关与不可变凭据摘要。通过支付管理员 API 配置 EPay、Waffo Pancake、WeChat Pay、Alipay 及任意自定义适配器，凭据保存在受限文件或合规密钥管理系统。完成商户入网、回调签名验签、发票提供商配置与一次成功的 sandbox 退款前，仍请保持测试模式。

内置的 Nginx 配置仅服务 `matx.tech`，并期望证书位于 `/etc/letsencrypt/live/matx.tech/`。请确认 DNS 仍指向该主机，且证书覆盖 `matx.tech`（当前配置故意未覆盖 `www`）。新主机接入时请先安装续期钩子并部署证书，再切换流量：

```sh
sudo bash deploy/scripts/install-nginx-certbot-hook.sh
sudo certbot renew --dry-run
sudo certbot certonly --webroot -w /var/www/matchplane/acme \
  -d matx.tech
sudo nginx -t && sudo systemctl reload nginx
```
