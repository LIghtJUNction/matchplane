# 平台合约与注册（v1 兼容）

> 新产品模型是一个商城和一组平级店铺。新接入请使用
> [商城与店铺接入合约](storefront-contract.md)；本文保留旧清单、API、路径与审计的兼容说明，
> 不再允许新建递归的用户可见平台层级。

MatchPlane 采用单一平台模型。平台节点可以是部署根、挂载到其他平台下的子节点，或同时兼具两者。子垂直是可替换的软件包，挂载在某个路径下，例如 `https://matx.tech/auto`。该软件包只提供展示与领域适配，不会替代根平台的身份、鉴权、撮合、联系人同意、支付或审计能力。

部署根是当前租户下标记为 `rootPlatform=true` 的单一 Better Auth 组织；仅仅缺少父节点并不足以成为根。若一个部署根被其他运营方挂载，接收方会通过签名联邦入驻创建 `source_kind=remote` 的子节点投影；原部署的本地 root 组织不会被直接改挂父节点，因此仍能管理自己的后代。对接收方用户而言，这个远端投影就是一个普通子平台，使用同一套 API、账户交换、清单、管理员、API-key 与审计边界；“root”和“subplatform”只是树上当前位置描述，不是不同产品类型。

## 身份与授权

根 web 服务使用 [Better Auth](https://better-auth.com/) 作为统一身份源，覆盖邮箱密码账号、邮箱 OTP、免密链接、校验、密码重置、会话、平台角色和组织作用域成员关系。用户不会在每个子路径重复注册。子平台不得再实现第二套凭据存储。组织 slug 是挂载路径，Better Auth 的组织成员关系是平台作用域授权的真实来源。对于允许公开访问的活跃子平台，首次通过认证的买方/卖方请求会幂等地为该组织建立 `member` 投影；私有子平台必须经过邀请。两类路径都不能直接授予管理员角色。`organization.parentOrganizationId` 形成递归平台树。上级管理员仅在目标节点注册显式授予该祖先关系时才能管理后代节点；数据和审计记录仍按目标节点作用域保存。Rust marketplace 成员关系仍作为网关和审计服务使用的领域投影。

当父级注册一个子平台时，发起注册的管理员会以最小必需的 owner/admin 角色加入到子组织。这与 Better Auth 的组织所有者 API key 插件一致：同一规则由该插件统一执行，不存在全局绕过。

在创建首个账号前设置 `MATCHPLANE_ROOT_ADMIN_EMAIL`。以该邮箱创建并验证成功的账户会获得配置中的 `rootSuperAdmin` 角色；普通根管理员通过 Better Auth 的 Admin 插件分配，`owner`、`admin`、`subplatform_admin`、`moderator` 与 `member` 由 Organization 插件分配。`BETTER_AUTH_SECRET` 必须是唯一生产密钥，仓库不会生成或持久化该值。

登录页从 `/api/auth/providers` 读取可用登录方式。微信、QQ、支付宝通过 Better Auth `genericOAuth` 保留，直到完整的 server-only provider 配置存在才会显示。详见 [auth-sso-contract-v1.md](auth-sso-contract-v1.md) 了解会话/能力交换与管理员边界。

## 平台 API Key

平台对平台、适配器对根的调用使用 Better Auth 的组织所有者 API Key 插件；项目本身不维护第二套 key 表或验证逻辑。标准 header 为
`x-matchplane-api-key`（兼容 `x-api-key` 也会被接受）。Key 使用可识别前缀 `mpk_`，由 Better Auth 哈希存储，仅在创建时可见，且绝不会写入清单或浏览器本地存储。

内置 Better Auth 接口挂载在 `/api/auth/api-key/*`。平台管理员为目标组织创建 key 时，可设置较短过期、命名 owner 与资源/动作权限。跨越父子边界的请求会携带目标 `organizationId`；根服务在转发前检查平台树与 key 的组织引用。可通过 `auth.api.verifyApiKey` 做服务端校验，例如：

```ts
await auth.api.verifyApiKey({
  body: {
    configId: "platform",
    key: request.headers.get("x-matchplane-api-key") ?? "",
    permissions: { platform: ["read"], retrieval: ["query"], media: ["upload"] }
  }
});
```

Key 不会创建被冒充的用户会话。轮换方式是创建替代 key、更新消费方，再吊销旧 key；过期和 Better Auth 限流策略仍会保持开启。拥有 `platform:manage_children` 的 key 可对后代节点执行操作；只有 `retrieval:query` 的 key 不能改角色、改清单、改支付或改联系人同意。

## 清单（manifest）

每个包都必须在仓库根或归档根目录包含 `matchplane.subplatform.json`：

```json
{
  "apiVersion": "matchplane.subplatform/v1",
  "id": "com.example.auto",
  "slug": "auto",
  "displayName": "Example Auto",
  "description": "...",
  "marketplaceContract": "generic-v1",
  "pricing": { "mode": "fixed", "currency": "XXX", "currencyScale": 2, "label": "Price" },
  "email": { "providerKey": "example-auto", "fromAddress": "no-reply@example.com" },
  "rootApiVersion": "v1",
  "entry": "src/index.ts",
  "routes": ["/auto"],
  "capabilities": ["demand", "supply", "explainable_matching"],
  "requiredScopes": ["marketplace:read", "marketplace:write"],
  "agent": {
    "protocol": "matchplane.agent/v1",
    "stages": ["merchant", "inventory"],
    "skills": ["matchplane.matching.v1"],
    "mcpTools": ["catalog.search", "merchant.search", "media.upload"],
    "mcpServerKey": "example-auto"
  },
  "assets": { "staticDirectory": "dist", "buildCommand": "bun run build" }
}
```

根服务在注册前会按 schema 验证清单。`id` 在全局稳定；`slug` 在根租户内唯一，并作为 URL 路径。`rootApiVersion` 与能力在启用前协商。可选 `agent` 块仅声明协议、工作流阶段与 MCP 工具名，不包含 endpoint、凭据或向量库配置。`agent.stages` 是子平台自有的 taxonomy key，根只校验长度/字符边界；`merchant`、`inventory` 只是二手车示例，不是全局枚举。`mcpServerKey` 仅是稳定的查找键。部署管理员可通过 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 将该 key 绑定到 HTTPS MCP endpoint；软件包本身不能指定 URL 或提供 bearer token。带有 `agent:tool` 权限的已认证 Agent 可调用通用 HTTP MCP 工具 `platform.child.tool`，传入当前 `platform_path`、白名单内 `tool_name` 和受限 JSON `arguments`。根服务会在转发前再次检查路径可见性与活跃注册，剥离调用方 API key，仅添加受限路由头、请求超时和响应体限制，并将子平台 MCP 结果作为可审计工具响应返回。终端未配置时返回明确的 degraded 错误，不会回退到根凭据或任意 URL。

领域文案、定价能力、筛选器与商家字段属于软件包，不属于根实现。软件包可在清单中声明 `pricing`、`ui.chat`、`ui.copy`、`ui.filters` 与 `ui.supplyFields`；根服务会校验并传递给通用 shell/plugin。联系方式是例外：包不能声明手填字段，交换只使用根 Better Auth 账号已验证的邮箱或手机，并要求双方明确同意。默认走领域中立 marketplace 合约。仍需使用旧垂直适配器的软件包必须显式声明 `marketplaceContract: "legacy-v1"`；仅定价或存在 schema 并不隐式选择该适配器。网关的 legacy HTTP 路由默认关闭，需要运营侧 `MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER=true` 迁移开关打开。根服务不会附带示例清单、垂直营销声明或默认业务货币。卖家提交由激活包 schema 定义的值，根服务仅保存并转发其结构化属性。

### Agent 资料上传

需要让买方或卖方在聊天里交图片、PDF 或其他材料的包，必须同时提供真实的 `media.upload` MCP 工具并把它写进 `agent.mcpTools`。根 web 的 `POST /api/platform/media/upload` 只做 Better Auth/API-key、tenant/domain/path、MIME、文件名、base64 长度和 `request_id` 形状校验，然后把有限时的请求转发给这个子平台工具；根不保存原始二进制、不扫描、不解析车辆或其他领域字段。子平台负责恶意内容扫描、图片尺寸/文本提取、内容寻址存储、`request_id` 幂等与保留策略，并返回 [`docs/media-attachment-protocol-v1.json`](media-attachment-protocol-v1.json) 约定的 `media://` 引用。聊天草稿会把引用交给子平台 Agent，人工编辑器必须允许供给方查看、修改和删除后再创建 offer。

供给创建后，根通过 [`docs/catalog-protocol-v2.json`](catalog-protocol-v2.json) 将数据库中的 canonical opaque offer projection 投递给子平台的 `catalog.upsert`。浏览器只能提交 offer UUID，根会重新读取供给所有字段并检查 Better Auth 所属关系；客户端不能伪造价格、属性、卖家或 `active` 状态。每次审核激活、宽字段修改和下架都会在同一个 PostgreSQL 事务中写入 durable projection job，并绑定当时不可变的 registration、canonical path 与 MCP server key；新注册版本激活时会在同一激活事务中为该店全部规范商品重新投递，即使商品版本本身没有变化。relay 每次尝试都重新读取 canonical offer、确认这个 destination 仍是当前 active binding，并复用持久化 `request_id`；endpoint URL 与 bearer token 可以在稳定 server key 后安全轮换。子适配器必须按 `canonical_version` 单调应用、拒绝同版本不同 `projection_digest`，并返回结构化 ACK；超时使用有界退避重试，合同错误或耗尽重试进入 dead-letter。v1 仅保留为旧适配器的兼容输入，不满足 durable ACK，新的根投影只发送 v2。同步失败不会回滚根的规范状态：根目录会立刻排除非 active offer，买方还必须通过根的 active offer 与有效引入交集，因此子目录旧记录不能解锁联系人、支付或交易状态。

默认 relay 上限为 25 MiB，部署可用 `MATCHPLANE_MEDIA_MAX_BYTES` 调低或提高到协议硬上限 256 MiB，并同步 Nginx/Ingress/Next body 限制。根会在读取 base64 envelope 前验证 Better Auth 会话或具备 `media:upload` 权限的 API key。不要把它设成无界：JSON/base64 中转会按请求大小占用 web 内存。视频或更大文件应由子平台提供对象存储直传/MCP URL 协议；没有真实 `media.upload` 适配器的包不会显示上传按钮，也不会假装文件已经进入检索索引。

`ui.copy` 和 `ui.chat` 的键默认是中文或平台的主语言；需要英文界面时，包可以为同一个键提供 `<key>En` 覆盖，例如 `buyerTitleEn`。没有覆盖时，根通用 shell 使用自己的英文 fallback；它不会翻译或重写 `supplyFields`、资产属性和商家内容。这样语言切换不会把领域术语硬编码进根平台，同时保留商家对文案的控制权。

内置注册入口是 `POST /api/platform/subplatforms`。该接口要求 Better Auth 根/父管理员会话、已存在的 `tenantId`/`domainId`、锁定的 Git commit 或不可变 archive 定位符，以及 manifest JSON。它会创建 Better Auth 组织，记录递归父子关系和不可变 digest 到 `subplatform_registrations`，并返回 `state: validated`。在另一次激活前，隔离构建器必须先附加签名后的 `build_digest`；web 请求不会克隆或执行不受信任的包代码。注册请求不能自报 `buildDigest`。生产激活还会对 manifest 中声明的 MCP 工具执行 endpoint 配置与 `initialize` 健康门禁；开发环境可以先激活静态包再配置工具服务。构建回调为
`POST /api/platform/subplatforms/build`，由部署端独占 token `MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN` 认证；对同一不可变 digest 幂等。根或父管理员仍负责最终激活；builder 不可独立发布软件包。浏览器包可额外提交 `artifactPath`（位于 `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT` 下的相对 digest 目录）和 `artifactEntry`（相对 HTML 文件，默认 `index.html`）。这些值与 build digest 一并不可变，不能从公开注册接口注入。

针对内置归档路径，根或父节点管理员先向 `POST /api/platform/subplatforms/upload` 发送 multipart 并带 `archive` 字段（可选 `x-matchplane-parent-organization-id` 请求头）。web 进程限制 64 MiB，仅接受 tar/gzip 或 tar/zstd 后缀，在 `MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT` 下使用随机定位符与 0600 权限存储原始字节，并返回 `upload://<id>` 与 SHA-256 digest；不会解包归档。隔离构建器消费该 locator 时会拒绝路径遍历、符号链接、设备文件、超大条目和缺失清单，然后通过构建回调附加已验证的 build digest 后方可激活。运营方必须提供可持久写入目录（或 Helm 下 RWX 的上传 PVC）；未配置时以 503 关闭。

静态构建模板只接受 `bun run build`、`npm run build`、`pnpm run build` 或 `yarn build`，不会把 manifest 字符串交给 shell。默认情况下，包必须提交对应锁文件并由固定 builder image 使用 frozen 安装；依赖安装阶段运行在清理过环境的隔离目录中，后续真正执行 `build` 命令的阶段断网。若确实需要跟随最新依赖，清单可以显式设置 `assets.dependencyPolicy: "latest"`；当前只允许 `bun run build`，构建器会执行无锁的 `bun install --no-save`，并在注册信息中保留源码、清单和产物摘要。该策略牺牲可复现性，不能用于需要稳定回滚的生产包。构建器不接受任意服务端代码、Docker socket 或运行时密钥。

## 检索边界

## 递归平台聊天

每个挂载路径共享同一聊天入口。提交到 `/` 的请求会先由部署根接收并分派给当前激活的子注册；提交到 `/parent/child` 的请求会先在该节点记录，再继续派发给其已激活后代。路由 envelope 与领域无关，携带规范平台路径、请求 ID 与受限意图，不会自行构造车辆或其他垂直字段。web 边界是 `POST /api/platform/match`，根服务将 envelope 写入 `platform_match_requests`。平台编排器可沿选中的后代继续同一请求，在每个路径执行相同 direct-child 路由决策并返回 `routingTrace`；每个子节点随后可通过稳定 marketplace API 创建自己的领域作用域买方请求。遍历次数上限为 `MATCHPLANE_ROUTER_AI_MAX_STEPS`（硬上限 16），单节点分支上限为 `MATCHPLANE_ROUTER_AI_MAX_FANOUT`（硬上限 16），达到任一上限会记录为降级（`degraded`）。未激活、禁用或不存在的注册不会被调用，根服务会返回显式 `accepted`/`degraded` 状态而不是静默丢弃。

开启托管路由后，每个节点决策仅暴露受限工具 `matchplane.platform.select_children`（兼容 MCP）。其 `selectedSlugs` 参数是该节点活跃且有权限子节点生成的枚举；模型返回后服务端仍会再次应用白名单。`MATCHPLANE_ROUTER_AI_TOOL_MODE=auto` 启用该工具并保留结构化 JSON 兼容路径，`required` 要求模型必须发起工具调用，`disabled` 使用传统 JSON 响应格式。决策审计会记录使用的机制。

### Agent 驱动的分阶段匹配

聊天是引流入口，不是单一全局向量检索。决策链为：

1. **商城/子平台** — 当前节点只向路由 Agent 提供其直接可见、已激活的子节点注册信息，基于当前人工成员关系或带作用域的 Agent key。公开节点对已认证用户可见，邀请制节点只有同一根身份在其组织内完成成员关系后才可见。Agent 可选择零个或多个白名单 slug；不能伪造 slug、查询同级节点、跳过祖先或读取凭据。
2. **商家** — 被选中的子平台 Agent 使用自身 Skill 和授权 MCP 工具检查商家标签、审核状态、推广/曝光策略与商家候选。根不将这些字段复制到自己的 schema。
3. **货柜/商品** — 子平台 Agent 调用其 inventory MCP 工具，对标准化资产（vehicle、product、service 或其他领域对象）打分排序并返回受限引用、分值与原因。根在允许引入前会验证资产是否活跃、商家授权、价格/预算与推广计费。

MCP 服务器是搜索、商家系统、目录、CRM、支付等工具的扩展边界。Skill 仅描述多步工作流和安全策略，不会成为第二套身份或数据存储。一个子平台可在 MCP 工具后接 pgvector、Qdrant、Milvus、Elasticsearch，甚至无向量库。根只持久化协议 envelope、已选标准化引用、provider 元数据与降级（`degraded`）状态。AI 排序结果仅作建议，不可授予联系人、释放电话/微信、支付授权、交易完成或绕过商家曝光/佣金策略。

部署平台仅承担其托管路由的模型调用 token 成本；买方、卖方及子平台租户不会因该托管路径被隐藏收费。买方或卖方若自带 Agent，则该 Agent 自行承担 provider 凭据和模型费用；进入 MatchPlane MCP 的调用是受限工具调用，不代表从根 provider 账户扣款。provider 凭据留在服务端，请求携带输入/步骤/输出预算，并记录 `cost_bearer: "platform"`、所选模型和可得的 provider 用量。托管路由还额外受 `MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR`（单主题）和 `MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR`（全局）双重限制；外部 Agent 仍按调用方自费（caller-funded）承担。子平台可运行自有 MCP 基础设施，但不能把未受限模型调用下沉到浏览器、不能向任何一方收取根 token，且不得静默复用根凭据。
规范 Agent/Skill/MCP envelope 为 [`docs/agent-mcp-skill-protocol-v1.json`](agent-mcp-skill-protocol-v1.json)。

### 外部 Agent 交接

外部买方或卖方 Agent 可在不让部署方承担模型成本的情况下继续漏斗流程，调用 `POST /api/platform/agent/handoff`（或 HTTP MCP 工具 `platform.agent.handoff`）。请求必须使用严格的
[`docs/agent-handoff-protocol-v1.json`](agent-handoff-protocol-v1.json) envelope，包含唯一 `request_id`、激活的 `scope.platform_path`、受限意图、Agent 能力，以及 `budget.cost_bearer: "caller"`。调用方的 Better Auth 组织 API key 必须包含 `agent:handoff` 权限；交互式客户端可使用会话。

该端点故意不充当 LLM 代理。它仅记录交接事件用于审计和幂等，返回当前节点活跃的直接子节点及其宣告的 Skills/MCP 工具，并给出稳定的 `/api/mcp` 与清单路径。它不会授予联系人、支付、发票、退款或管理员权限。`GET /api/platform/agent/handoff` 只能由同一会话或 API key 主体读取状态。交接有时效，过期后失效；调用方仍需自行维护 Agent 凭据、模型调用和 token 成本。

### 机器 Agent 能力交换

交接与 marketplace party capability 有意分离。买方或卖方 Agent 需要先创建 Better Auth 组织 API key，并配置最小必需作用域与角色方向：

```json
{
  "permissions": { "marketplace": ["write"], "agent": ["handoff"] },
  "agentSide": "demand"
}
```

`agentSide` 值存储为 API key 元数据，必须是 `demand`、`supply` 或 `both`。旧字段 `agentRole` 仅作为兼容迁移别名接受。随后 Agent 调用
`POST /api/marketplace/agent-session`（或 HTTP MCP 工具 `marketplace.agent.session`），携带 `tenantId`、`domainId`、`platformPath` 和所需内核 `side`（`demand` 或 `supply`）。`role` 仅作为已弃用的适配器别名接受。服务器在生成稳定机器主体并经内部网关桥接交换前，会校验 Better Auth key、激活递归路径、组织 scope、domain 与 side。响应返回 15 分钟 party bearer 与 `access_token_expires_at`，作用域限定该 tenant 与 role；不会返回用户会话、API key 明文、联系人数据或管理员能力。请将 party bearer 保留在服务端，截止后丢弃，并通过轮换组织 API key 来撤销后续交换。

这使需求方 Agent 与供给方 Agent 使用同一接入形态：唯一区别在于 `side` 约束的 API key 与提交资源。机器 Agent 不能任意指定 `participant_id`，也不能在请求体中改写子路径。

阶段二与三稳定使用的 envelope 为 [`docs/platform-routing-protocol-v1.json`](platform-routing-protocol-v1.json)，包含 `stage`、受限意图、标准化候选引用、选中引用、provider 元数据与降级（`degraded`）标志；其中有意不包含车辆专属字段。

向量检索是可选的子平台自有适配器。声明检索能力的 manifest：

```json
"retrieval": {
  "protocol": "matchplane.retrieval/v1",
  "owner": "subplatform"
}
```

根服务不要求特定向量数据库、向量化（Embedding）模型、维度、距离度量或索引策略。适配器可使用 pgvector、Qdrant、Milvus、Elasticsearch、本地索引或托管服务。provider endpoint 和其凭据引用由部署配置决定，不来自不可信包清单。

检索准确性由各子平台负责。根不规定向量库、向量化（embedding）模型、提示词（prompt）、排序公式或目录 schema。Agent 可通过自身 Skill 和 MCP 工具使用这些能力，而根仅做授权校验和稳定结果 envelope 校验。

## 领域中立 marketplace 内核

Rust 网关暴露一套小型、与垂直无关的持久化合同。它是平台 Agent 与子平台领域 schema/检索适配器之间的边界：

| 资源 | 接口 | 权限与用途 |
| --- | --- | --- |
| participant（参与者） | `POST /v1/marketplace/participants` | 在 `marketplace_sides` 中注册一侧或双侧内核能力的带作用域参与方；不要求垂直角色标签。 |
| intent（意向） | `POST /v1/marketplace/intents` | 已认证参与方创建 `demand` 或 `supply` 意向，并可携带不透明 JSON `attributes` 与 `terms`。 |
| intent（意向） | `GET /v1/marketplace/intents/{id}?tenant_id=&participant_id=` | 参与方读取自己的意向。 |
| offer（供给） | `POST /v1/marketplace/offers` | 已认证供给方创建草稿供给意向；对于服务或其他垂直 `asset_id` 可选。 |
| offer（供给） | `PATCH /v1/marketplace/offers/{id}` | 创建者或同 domain 的 `admin/both` capability 以 `expected_version` 替换可编辑字段；active/withdrawn 修改后回到 draft，必须重新审核。 |
| offer（供给） | `POST /v1/marketplace/offers/{id}/withdraw` | 创建者或同 domain 的 `admin/both` capability 以 `expected_version` 下架 draft/active 供给，保留版本和审计历史。 |
| offer（供给） | `POST /v1/marketplace/intents/{id}/matches` | 持有方（需求方）获取活跃供给候选。若未配置检索 provider，可走确定性属性回退。 |
| demand（需求发现） | `POST /v1/marketplace/offers/{offer_id}/demand-matches` | 持有方（供给方）只能检索已明确允许供给方发现的需求摘要；结果不含需求参与者 ID 或联系方式。需求方可通过 `PATCH /v1/marketplace/intents/{intent_id}/discovery` 随时撤回后续发现。 |
| offer（供给） | `POST /v1/admin/marketplace/offers/{id}/activate` | 运营者或垂直审核流程发布草稿。 |
| introduction（引入） | `POST /v1/marketplace/introductions` | 持有方（需求方）记录单个 Agent 选中的供给意向、分数与受限原因。不会释放联系人信息。 |
| introduction（引入） | `GET /v1/marketplace/introductions?tenant_id=&participant_id=` | 双方可读取引入投影，但不含联系人值。 |

所有写入接受 caller 生成的 id 和幂等键。每个 party-auth 请求还必须携带 `x-matchplane-platform-path`（由 capability exchange 返回的规范路径）。网关会校验短期 party bearer token、精确递归节点路径、tenant/domain 作用域、需求/供给角色、激活生命周期、过期时间以及跨方不变式。`attributes` 与 `terms` 必须是 JSON 对象，不会被根解释为车辆字段。分数和理由是 AI 建议输出，联系人释放仍是独立的、需同意的状态转换，受现有 `introduction/contact` 合约约束。

同一资源也可通过已认证 HTTP MCP 门面 `/api/mcp` 给外部 Agent 使用，工具包括 `marketplace.intent.create`、`marketplace.offer.create`、`marketplace.offer.update`、`marketplace.offer.withdraw`、`marketplace.offer.match`、`marketplace.demand.match`、`marketplace.intent.discovery.update`、`marketplace.introduction.create` 与 `marketplace.introductions.list`。需求创建时只有显式设置 `supply_discovery_enabled: true` 才会进入供给发现索引；该查询只返回匿名摘要，不能替代需求方发起引介。需求方可以通过 discovery update 工具撤回后续发现。子平台自有检索/Skill 工具通过通用 `platform.child.tool` 调用，调用方必须持有 `agent:tool` 且工具名必须在目标 active manifest 的白名单中；根仅做递归路径授权和有界转发，不把调用方 API Key 传给子平台 endpoint。MCP 门面会把调用方的 party capability 转给 Rust 网关，不会保存第二套 schema 或 token。由调用方自费的 Agent 自行承担其模型和向量库成本；MatchPlane 仅执行受限且可审计的状态变更。

稳定边界携带标准 ID 与分数，不携带向量：

```http
POST /api/platform/retrieval/query
```

请求/响应形状定义见 [`docs/retrieval-protocol-v1.json`](retrieval-protocol-v1.json)。调用该门面时必须携带规范化的 `scope.platform_path`、tenant/domain 作用域、领域中立的 narrative/requirements 与受限结果上限。根服务会将它转成目标 active 节点 manifest 明确允许的 `retrieval.query` MCP tool；只有部署管理员配置了 endpoint 且调用方拥有 `retrieval:query` 时才会转发。每个候选必须返回标准 root `asset_id` 或 canonical `offer_id` 至少一个（服务等没有目录资产的垂直只需返回 `offer_id`），并携带分数、provider/model 版本与可解释原因/风险。根当前只负责路径、租户、权限和 ABI 校验；它不会把远端 display_name 或 attributes 当作可信成交授权，也不会凭检索响应直接释放联系人、支付或结算。创建 introduction 时，Rust 网关仍会重新校验 offer 的状态、作用域和双方权限。未配置检索终端、上游超时或返回不符合 ABI 时，根返回可观测的错误，不会默默使用根平台凭据。

请求按 `request_id` 由 provider 自行幂等；provider 应对重试返回同样结果缓存/复用。provider 可返回空候选列表或 `degraded: true`；根必须在审计中保留该状态，而不是静默切换到其他模型。向量数据库和索引 worker 不随根平台默认提供；若部署方启用兼容 provider，也必须通过同一 retrieval ABI 接入，不会成为新子平台的强制要求。

可选 `email` 模块仅为公开路由元数据。子平台管理员通过 `/v1/subplatforms/{domain_id}/email-config` 配置 SMTP 主机、TLS 模式、用户名与部署密钥引用。secret 引用不会返回给浏览器；服务端通知 worker 从主机密钥管理器取回。每个子平台有独立记录与乐观版本号，因此修改一个提供商不会影响其他子平台邮件路由。子平台引用必须为不可见表单
`secret://subplatform/<tenant-uuid>/<domain-uuid>/<slot-name>`，web worker 仅在 `MATCHPLANE_SUBPLATFORM_SECRET_ROOT` 下解析该 slot；子管理员不能提交 `env://` 或 `file://`。Better Auth 的全局密码、校验、OTP 与魔法链接始终走根的部署级邮件通道；子通道只用于已认证服务端通知任务（如发票或商家通知）并附带精确 `tenant_id/domain_id`。根通道可继续使用 `env://` 或 `file://`，因为它不会被子管理员写入。

## 两类注册输入

根管理员只需要提供来源，推荐使用 source-only discovery 流程：

1. **Git 仓库**：提交不带凭据的 HTTPS 地址。`POST /api/platform/subplatforms/discover` 会创建待解析任务，隔离构建器拉取默认分支的精确 40 位 commit，校验清单并回写来源 digest、revision 和 manifest。生产构建器只允许运营方配置的 Git host；高级 API 仍可直接提交已验证的不可变 commit。
2. **归档上传**：先上传 `.tar.gz`/`.tar.zst` 包取得不透明 `upload://` locator，再提交 discovery 任务。构建器在独立工作根中校验 SHA-256，拒绝绝对路径、`..` 路径穿透、符号链接、设备文件、超大归档和缺失清单，最后把归档 digest 作为 immutable revision。

Discovery 进入 `queued → discovering → ready/rejected` 状态；只有 `ready` 返回的 manifest 才会交给 `POST /api/platform/subplatforms` 创建组织和 registration。Web 进程不拉取、不解压、不执行来源代码。

注册记录包含 `subplatform_id`、`tenant_id`、`domain_id`、`slug`、来源类型、来源 URL 或上传 digest、锁定修订版本、清单 digest、build digest、请求 scope、审批状态和审计时间戳。对已存在 `id` 的重新注册不会静默覆盖已有发布，而会形成新的不可变版本，并要求显式激活。

## 运行时边界

- 根承担账户管理。买方/卖方通过 Better Auth 组织成员关系投影认领一个活跃公开子平台；认领只会添加带作用域的 `member` 角色，Rust marketplace 成员投影再补充 `seller`、`dealer` 或 `verified` 等标签，不会生成另一套账户。管理员标签仍需邀请或由 owner/admin 明确操作。
- 每个子平台命令都携带 `tenant_id`、`domain_id` 和该 `platform_path` 的 capability。网关在敏感操作前会校验 capability 的精确域作用域；给 `/a` 颁发的 token 不能在同租户的 `/b` 重放。
- 插件是静态前端适配层，不会携带独立数据库、不能签发 token、不能绕过联系人同意、不能直接调用支付方。支付凭据仍由根/payment service 保存。隔离构建器附加 artifact locator 后，激活清单会衍生 `assets.hosted` URL 为 `/api/platform/plugin-assets/<mount>/...`；浏览器在 `sandbox="allow-scripts"` 的 iframe 中承载该发布。由于该沙箱采用不透明 `null` origin，host 通过通配 `postMessage` 目标，但只接收来自精确 iframe 窗口和其主机生成的每实例 `contextToken` 的消息。host 每次发送 versioned `matchplane.plugin/v1` context 与受限 `match.results` 快照；当 host 侧推荐集变化时，快照会更新。插件可请求 `chat.open`、`listing.open`、`listing.select`、`listing.submit` 与 `navigation`；`listing.open` 仅携带结果 id，host 使用最新快照解析后再打开 host-owned 详情/联系人流程。列表提交携带 `requestId`，并返回对应的 `listing.submit.result`。host 在调用 marketplace API 前会校验 seller 角色、Better Auth 会话、激活租户/domain/schema 与受限 JSON。artifact endpoint 在 `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT` 下解析主机本地文件，核验 active build digest，禁止路径穿透与软链接逃逸，并施加严格 CSP。它不会抓取插件提供的 URL 或运行插件服务端代码。
- 结果桥是“单向数据 + 双向选中”：
  - host 发送 `{ protocol: "matchplane.plugin/v1", type: "match.results", version: 1, contextToken, payload: { listings: [...] } }`，最多包含 100 条由 host 拥有且公开的结果卡片。
  - 供给方会话的 `platform.context` 可附带 `agentDraft`（`narrative`、可选 `intentId`、不透明 `attributes` 与 `terms`）。它只是聊天材料的可编辑草稿，不是已发布供给，也不携带 token、联系人或支付权限；插件必须让供给方检查并通过 `listing.submit` 明确提交，宿主仍会做 schema、租户和权限校验。草稿在路由到子平台后会通过新的 context 消息补发，避免聊天与表单脱节。
  - 插件发送 `{ type: "listing.open", contextToken, payload: { listingId } }`；host 会忽略当前快照之外的 id。
  - 买方 `platform.context` 只附带 `auth.status = pending|authenticated|anonymous`，不附带用户资料、cookie 或 token。插件可发送带 `requestId` 的 `auth.open`、`demand.open` 与 `listing.like`；host 分别负责 Better Auth 跳转、打开当前子平台内的根托管会话，以及调用已认证点赞 API，并返回对应的 `*.result`。匿名点赞意图只在根的 `sessionStorage` 中保存供给 id、平台路径和期望计数，登录返回同一路径后由根恢复；凭据始终不会进入 iframe。
  这种约束在保留垂直化渲染能力的同时，将认证、作用域、联系人同意与支付行为留在根服务侧。
- 路径仅在清单校验、API 兼容、CSP/资源检查、包扫描和运营审计通过后才激活。禁用或吊销会移除路径，但根账号与历史会保留。
  生产环境下，web 页面和清单接口会独立校验完整的递归路径是否解析到活跃不可变注册；`public/` 下静态文件不构成激活授权。
- 清单与插件资产读取与 Agent 路由共享 `membership_policy` 可见性检查。公开注册可在未认领成员关系时获取；邀请制发布在调用方 Better Auth 用户或带作用域的 Agent key 未被授权该组织子树时，返回相同的未找到（not-found）响应。

## 仓库边界

商店包在各自独立仓库中遵循本合约。核心仓库不保存商店 gitlink、不递归签出实例，也不复制任何商店实现；canonical path 始终来自活动 registry/manifest 记录。运营方可对外部签出运行 `just subplatform-package-check <path>` 或 `just subplatform-package-build-check <path>`。
