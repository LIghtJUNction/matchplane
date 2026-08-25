# 平台合约与注册（v1 兼容）

> 新产品模型是一个商城和一组平级店铺。新接入请使用
> [商城与店铺接入合约](storefront-contract.md)；纸张保留旧清单、API、路径与审计的兼容说明，
> 不再允许新建递归的用户可见平台层级。

MatchPlane采用单一平台模型。平台节点可以是部署根、挂载到平台下的子节点，或同时兼具两者。子垂直是可重构的分区，挂载在某个路径下，例如`https://matx.tech/auto`。该矩阵只提供与领域其他节点的展示，不会替代根平台的身份、鉴权、撮合、卡通一致、支付或审计能力。

部署根是当前机场下标记为 `rootPlatform=true` 的单一 Better Auth 组织；缺货父节点并成为根。如果一个部署根被其他运营方挂载，接收方会通过签名联邦入驻创建 `source_kind=remote` 的子节点投影；原部署的本地根组织不会被直接改挂父节点，因此仍能管理自己的后代。对航方用户而言，这个投影就是一个普通子平台，使用同一个API、账户交换、清单、管理员、API-key与审计边界；"根"和"子平台"只是树上当前位置描述，不是不同的产品类型。

## 身份与授权

根 web 服务使用 [Better Auth](https://better-auth.com/) 作为统一身份源，覆盖邮箱密码账号、邮箱密码、免密链接、校验、密码重置、会话、平台角色和组织作用域成员关系。用户不会在每个子路径重复注册。子平台不得再实现第二套储蓄存储。组织 slug 是挂载路径，更好的身份验证的组织成员是平台域授权的真实来源。对于允许公开访问作用的活跃子平台，首先通过认证的请求/应答请求会幂等地为该组织建立`member`式关系投影；无子平台必须经过邀请。两类路径都不能直接转发管理员角色。`organization.parentOrganizationId`形成邻居平台树。上级管理员仅在目标节点显着注册转发该东方时才能管理继承节点；数据和审计记录仍按目标节点作用域保存。Rust Marketplace成员关系仍作为网关和审计服务使用的领域投影。

当级别注册一个子平台时，发起注册的管理员会以最小父必需的所有者/管理员角色加入到子组织。这与 Better Auth 的组织所有者 API 密钥插件一致：同一规则由该插件统一执行，不存在全局绕过。

在创建第一个账号前设置 `MATCHPLANE_ROOT_ADMIN_EMAIL`。以该邮箱创建并验证成功的账户即可获得配置中的 `rootSuperAdmin` 角色；普通根管理员通过 Better Auth 的 Admin 插件分配，`owner`、`admin`、`subplatform_admin`、`moderator` 与 `member` 由组织插件分配。`BETTER_AUTH_SECRET`必须是唯一生产钥匙，仓库不会生成或持久化该值。

登录页从`/api/auth/providers`读取可用的登录方式。微信、QQ、支付宝通过更好的身份验证`genericOAuth`保留，直到完整的仅服务器提供商配置存在才会显示。请参阅[auth-sso-contract-v1.md](auth-sso-contract-v1.md)了解会话/能力交换与管理员边界。

## 平台 API 密钥

平台对平台、支架对根的调用使用 Better Auth 的组织所有者 API Key 插件；项目本身不第二套密钥或验证逻辑维护。标准头表为
`x-matchplane-api-key`（兼容`x-api-key`也被接受）。使用可识别的钥匙`mpk_`，由Better Auth 仓储存储，仅在创建时可见，且浏览绝不会写入清单或设备本地存储。

内置 Better Auth 接口挂载在 `/api/auth/api-key/*`。平台管理员为目标组织创建密钥时，可设置过渡、命名所有者与资源/动作权限。覆盖父子边界的请求会携带目标`organizationId`；根服务在转发前检查平台树与密钥的组织引用。可通过`auth.api.verifyApiKey`做服务端验证，例如：

```ts
await auth.api.verifyApiKey({
  body: {
    configId: "platform",
    key: request.headers.get("x-matchplane-api-key") ?? "",
    permissions: { platform: ["read"], retrieval: ["query"], media: ["upload"] }
  }
});
```

密钥不会被冒充的用户会话。轮换方式是创建替代密钥、更新消费方，再吊销旧密钥；创建过渡和更好的身份验证限流策略仍会保持开启。拥有`platform:manage_children`的密钥可对后代节点执行；操作只有`retrieval:query`的密钥不能改角色、改清单、改支付或改串口一致。

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

根服务在注册前会按模式验证清单。`id`在全局稳定；`slug`在根机场内部唯一，并作为URL路径。`rootApiVersion`与能力在启用前协商。任选`agent`块仅声明协议、工作流阶段与MCP工具名，不包含端点、预警或库维护配置。`agent.stages`是子平台自有的分类法key，根只校验长度/字符边界；`merchant`、`inventory`只是二手车示例，不是全局枚举。`mcpServerKey`只是稳定的替换键。配置管理员可通过 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 和 key 绑定到 HTTPS MCP 端点；面板本身不能指定 URL 或提供不记名令牌。带有 `agent:tool` 权限的已认证代理可调用通用 HTTP MCP 工具`platform.child.tool`，形成当前`platform_path`、白名单内`tool_name`和构建JSON`arguments`。根服务会在前方再次检查路径可见性与主动注册，终止调用方API密钥，仅添加确定路由头、请求超时和响应体限制，并子平台MCP结果作为可审计工具响应返回。终端未配置时返回明显的降级错误，不会退回到根决策或任何URL。

领域文案、定价能力、筛选器与商品字段不属于根实现。包可在清单中声明 `pricing`、`ui.chat`、`ui.copy`、`ui.filters` 与 `ui.supplyFields`；根服务会校验并传递给通用外壳/插件。联系方式是例外：包不能声明手填字段，交换只使用根 Better Auth 账号中已验证的邮箱或手机，并要求双方明确同意。默认走领域中立市场合约。仍需使用旧仓储的帐篷必须显式声明`marketplaceContract: "legacy-v1"`；仅定价或存在架构并不隐式选择该适配。网关的旧版 HTTP 路由默认关闭，需要运营侧 `MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER=true` 迁移开关打开。根服务不会附带示例清单、垂直营销声明默认或业务货币。卖家提交由激活包架构定义的值，根服务仅保存并转发其配置属性。

### 代理资料上传

需要让请求或卖方在聊天里交图片、PDF或其他材料的包，必须同时提供真实的`media.upload` MCP工具并把它写进`agent.mcpTools`。根网络的`POST /api/platform/media/upload`只做更好的Auth/API-key、tenant/domain/path、MIME、文件名、base64长度和`request_id`形状校验，然后把有限时的请求转发给这个子平台工具；根不保存原始二进制、不扫描、不解析车辆或其他字段字段。子平台负责有效内容扫描、图片/文本提取、存储、`request_id`幂等与保留策略，并返回[`docs/media-attachment-protocol-v1.json`](media-attachment-protocol-v1.json)约定的`media://`引用。聊天草稿引用了交换子平台代理，人工编辑器必须允许参数查看、修改和重新创建报价。

补充后，根通过 [`docs/catalog-protocol-v2.json`](catalog-protocol-v2.json) 将数据库中的规范不透明报价投影投递给子平台的 `catalog.upsert`。浏览器只能提交报价 UUID，根会重新读取所有字段并检查 Better Auth 项；客户端不能创建价格、属性、卖家或 `active` 状态。每次审核激活、宽字段修改和下架都会在同一个 PostgreSQL 事务中读取持久投影作业；中继预设都尝试重新读取规范报价与当前活跃存储绑定，并复用持久化`request_id`。子应答必须按`canonical_version`单调应用、拒绝同版本不同`projection_digest`，并返回格式ACK超时；使用有界退重试，合同错误或后期重试进入死信。v1只需保留为旧的兼容输入，不满足持久ACK，新的根投影只发送v2。同步失败不会回滚根的规范状态：根目录会重新排除非主动报价，应答还必须通过根的主动报价与有效引入交集，因此子目录旧记录不能解锁蒸发、或支付交易状态。

默认中继上限为 25 MiB，部署可用 `MATCHPLANE_MEDIA_MAX_BYTES` 调低或提高到协议硬上限 256 MiB，并同步 Nginx/Ingress/Next body 限制。根会在读取 base64 信封前验证 Better Auth 会话或具备 `media:upload` 权限的 API key。不要把它设置成无界：JSON/base64 中转会按请求大小占用 web内存。视频或更大文件应由子平台提供对象存储直传/MCP URL 协议；没有真实 `media.upload` 队列的包不会显示上传按钮，也不会假装文件已进入检索索引。

`ui.copy` 和 `ui.chat` 的键默认是中文或平台的主语言；需要英文界面时，包可以为同一个键提供 `<key>En` 覆盖，例如 `buyerTitleEn`。没有覆盖时，根通用 shell 使用自己的英文后备；它不会翻译或重写 `supplyFields`、资产属性和商户内容。这样的语言切换不会把领域术语硬编码进根平台，同时保留商户对文案的控制权。

内置注册入口是 `POST /api/platform/subplatforms`。该接口要求 Better Auth 根/父管理员会话、已存在的 `tenantId`/`domainId`、锁定的 Git 提交或不可变存档定位符，以及清单 JSON。它会创建 Better Auth 组织，记录相邻父子和不可变摘要到 `subplatform_registrations`，并返回`state: validated`。在另一次激活前，隔离构建器必须先附加签名后的`build_digest`；web请求不会克隆或执行不受信任的包代码。注册请求不能自报`buildDigest`。生产激活还会对manifest中声明的MCP工具执行端点配置与`initialize`健康门禁；开发环境可以先激活静态包再配置工具服务。构建回调为
`POST /api/platform/subplatforms/build`，由端部署独占令牌`MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN`认证；对相同不可变的摘要幂等。根或管理员仍负责最终激活；构建器不可独立发布。浏览器包可额外提交`artifactPath`（位于`MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT`下的相对摘要目录）和`artifactEntry`（相对HTML文件，默认`index.html`）。这些值与构建摘要一真实含量，不能从公开注册接口注入。

目标内置归档路径，根或父节点管理器先向 `POST /api/platform/subplatforms/upload` 发送 multipart 并带 `archive` 字段（可选 `x-matchplane-parent-organization-id` 请求头）。web 限制进程 64 MiB，仅接受 tar/gzip 或 tar/zstd 后缀，在 `MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT` 下使用随机定位符与 0600 权限存储原始字节，并返回 `upload://<id>`与 SHA-256 摘要；不会解包归档。隔离构建器消费该定位器时会拒绝路径遍历、符号链接、设备文件、超大边界和附加清单，然后通过构建回调已验证的构建摘要即可激活。运营方必须提供可持久写入目录（或 Helm 下 RWX 的上传 PVC）；未配置时以 503 关闭。

静态模板只接受`bun run build`、`npm run build`、`pnpm run build`或`yarn build`，不会把manifest字符串替换shell。默认情况下，包必须提交锁文件并由固定构建器映像使用frozen安装；依赖安装阶段运行在清理过环境的隔离目录中，后续真正执行`build`命令的阶段断网。若确实需要对应最新依赖，可以直观显式设置`assets.dependencyPolicy: "latest"`；当前只允许`bun run build`，构建器可以执行无锁的`bun install --no-save`，并在注册信息中保留源代码、清单和产品摘要。该策略消耗可复现性，不能用于需要稳定回滚的生产包。构建器不接受任何服务端代码、Docker套接字或运行时节点。

## 检索边界

## 递归平台聊天

每个挂载路径共享相同的聊天入口。提交到 `/` 的请求会先由配置根接收并分派给当前激活的子注册；提交到 `/parent/child` 的请求会先在该节点记录，再继续派发给其已激活子项。路由信封与领域关联，携带规范平台路径、请求 ID 与基础逻辑，自行不会构造车辆或其他垂直字段。web 边界为 `POST /api/platform/match`，根服务将信封写入`platform_match_requests`。平台编排器可沿选中的连续后代同一请求，在每个路径执行相同直子路由决策并返回`routingTrace`；每个子节点并可通过稳定市场API创建自己的领域作用域请求。遍历次数上限为`MATCHPLANE_ROUTER_AI_MAX_STEPS`（硬顶点16），单节点顶点路径为`MATCHPLANE_ROUTER_AI_MAX_FANOUT`（硬顶点） 16），达到任一上限会记录为降级（`degraded`）。未激活、取消或不存在的注册不会被调用，根服务会返回显式`accepted`/`degraded`状态而不是静默丢弃。

开启再次托管路由后，每个节点决策仅公开设定工具`matchplane.platform.select_children`（兼容MCP）。其`selectedSlugs`参数是该节点活跃且有权限子节点生成的枚举；模型返回后服务端仍会应用白名单。`MATCHPLANE_ROUTER_AI_TOOL_MODE=auto`启用该工具并保留结构JSON兼容路径，`required`要求模型必须发起工具调用，`disabled`使用传统JSON响应格式。决策审计会记录使用的机制。

### 代理驱动的分阶段匹配

聊天是引流入口，不是单一全局向量检索。决策链为：

1. **商城/子平台** —当前节点只向路由Agent提供其直接可见、已激活关系的子节点注册信息，基于当前人工成员或带作用域的Agent key。公开节点对已认证用户可见，诱导节点只有同一根身份成员在其组织内完成后才可见。Agent可选择零个或多个白名单slug；格式不能slug、查询同级节点、跳过父级或读取父节点。
2. **商家** — 被选中的子平台代理使用自身技能并授权 MCP 工具检查商家标签、审核状态、推广/曝光策略与商家候选。根不将这些字段复制到自己的模式。
3. **货柜/商品** — 子平台代理调用其库存MCP工具，对标准化资产（车辆、产品、服务或其他领域对象）打分排序并返回预设引用、分值与原因。根在允许引入前会验证资产是否活跃、商家授权、价格/预算与推广业务。

MCP 服务器是搜索、商户系统、目录、CRM、支付等工具的扩展边界。技能描述仅多步工作流程和安全策略，不会成为第二套身份或数据存储。一个子平台可在 MCP 工具后接 pgvector、Qdrant、Milvus、Elasticsearch，甚至无管理库。根只持久化协议信封、已选标准化引用、提供商元数据与降级（`degraded`）状态。AI排序结果仅作建议，不可等待、释放电话/微信、支付授权、完成交易或绕过曝光/佣金策略。

部署平台仅承担其托管路由的模型调用令牌；代理、监听及子平台机场不会因该托管路径被隐藏收费。应答或代理若自身承担提供商的费用和模型费用；进入 MatchPlane MCP 的调用是创建工具调用，不代表从根提供者账户扣款。提供者托管在服务端，请求输入承担/步骤/输出应答，并记录`cost_bearer: "platform"`、托管模型和可得的提供商托管路由还额外受 `MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR`（单主题）和 `MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR`（全局）双重限制；外部代理仍按调用方自费（来电者资助）承担。子平台可运行自有 MCP 基础设施，但不能把未模型调用下沉到浏览器、不能向任何一方前沿根令牌，且不得静默复用根全局。
规范Agent/Skill/MCP信封为[`docs/agent-mcp-skill-protocol-v1.json`](agent-mcp-skill-protocol-v1.json)。

### 外部代理交接

外部请求或卖方代理可以在不让部署方承担模型成本的情况下继续漏斗流程，调用 `POST /api/platform/agent/handoff`（或 HTTP MCP 工具 `platform.agent.handoff`）。请求必须使用严格的
[`docs/agent-handoff-protocol-v1.json`](agent-handoff-protocol-v1.json) 信封，包含唯一 `request_id`、激活的 `scope.platform_path`、预设意图、代理能力，以及 `budget.cost_bearer: "caller"`。调用方的 Better Auth 组织 API 密钥必须包含 `agent:handoff` 权限；交互客户端可使用会话。

该端点不充当LLM代理。它只记录交接事件用于审计和主管等，返回当前节点活跃的直接子及其节点声明的技能/MCP工具，并给出稳定的`/api/mcp`与清单路径。它不会查找烟草、支付、发票、退款或管理员权限。`GET /api/platform/agent/handoff`只能由同一会话或API密钥主体读取状态。交接有时效，后续后消失；调用方仍需自行维护代理、模型调用和令牌成本。

### 机器代理能力交换

与市场方能力交接。认知或应答代理需要先创建更好的身份验证组织API密钥，并配置最小必要作用域与角色方向：

```json
{
  "permissions": { "marketplace": ["write"], "agent": ["handoff"] },
  "agentSide": "demand"
}
```

`agentSide` 值存储为 API key 元数据，必须是 `demand`、`supply` 或 `both`。旧字段 `agentRole`仅作为兼容迁移别名接受。另外代理调用
`POST /api/marketplace/agent-session`（或 HTTP MCP 工具 `marketplace.agent.session`），携带 `tenantId`、`domainId`、`platformPath` 和所需内核 `side`（`demand` 或 `supply`）。`role`仅作为已弃用的邻居同意。服务器在生成稳定机器主体并经内部网关桥接交换前，可以更好地进行身份验证Auth key、激活节点路径、组织范围、域与端。响应返回 15 分钟 party bearer 与 `access_token_expires_at`，作用域限定该租户与角色；返回不会返回用户会话、API key 明文、托马斯数据或管理员能力。接下来 party bearer 保留在服务端，随后丢弃，并通过轮换组织 API key 来后续后续交换。

这使得需求方Agent与供给方Agent相同的接入形态：唯一区别在于`side`约束的API密钥与提交资源。机器使用Agent不能任意指定`participant_id`，也不能在请求体中改写子路径。

阶段二与三稳定使用的信封为[`docs/platform-routing-protocol-v1.json`](platform-routing-protocol-v1.json)，包含`stage`、预设意图、标准化候选引用、选中引用、提供者元数据与降级（`degraded`）标志；其中包含不包含车辆专用字段。

主持搜索是任选的子平台，自有烦恼。 发言能力的体现：

```json
"retrieval": {
  "protocol": "matchplane.retrieval/v1",
  "owner": "subplatform"
}
```

根服务不要求特定的矢量数据库、嵌入模型、距离度量或索引策略。适配器可使用 pgvector、Qdrant、Milvus、Elasticsearch、本地索引或托管服务。提供商端点及其引用由配置决定，不来自不受信任的清单。

搜索准确性由各子平台负责。根不规定操纵库、操纵化（嵌入）模型、提示词（提示）、排序公式或目录模式。代理可以通过自身技能和MCP工具使用这些能力，而根仅做授权验证和稳定结果信封验证。

## 领域中立市场内核

Rust网关暴露了一个小型、与垂直关联的持久化契约。它是平台代理与子平台领域模式/搜索架构之间的边界：

| 资源 | 接口 | 权限与用途 |
| --- | --- | --- |
| 参与者（参与者） | `POST /v1/marketplace/participants` | 在`marketplace_sides`中注册一个或双侧内核能力的带域参与方；不要求垂直角色标签。
| 意图（意向） | `POST /v1/marketplace/intents` | 认证参与方创建`demand`或`supply`意向，并可携带不透明JSON`attributes`和`terms`。
| 意图（意向） | `GET /v1/marketplace/intents/{id}?tenant_id=&participant_id=` | 参与方读取自己的意向。
| 报价（募集资金） | `POST /v1/marketplace/offers` | 已认证募集方创建草稿募集意向；对于服务或其他垂直`asset_id`任选。
| 报价（募集资金） | `PATCH /v1/marketplace/offers/{id}` | 创建者或同域修改的`admin/both`能力以`expected_version`替换可编辑字段；active/withdrawn后回到草稿，必须重新审核。
| 报价（募集资金） | `POST /v1/marketplace/offers/{id}/withdraw` | 创建者或同域的 `admin/both` 能力以 `expected_version` 下架草稿/活动消耗，保留版本和审计历史。
| 报价（募集资金） | `POST /v1/marketplace/intents/{id}/matches` | 持有方（需求方）获取活跃投票候选。若未配置检索提供者，可走确定性属性回退。
| 需求（需求发现） | `POST /v1/marketplace/offers/{offer_id}/demand-matches` | 持有方（募集方）只能搜寻已明确允许募集方发现的需求摘要；结果明确需求参与者ID或联系方式。需求方可通过`PATCH /v1/marketplace/intents/{intent_id}/discovery`随时撤回后续发现。
| 报价（募集资金） | `POST /v1/admin/marketplace/offers/{id}/activate` | 运营者或垂直审核流程发布草稿。
| 介绍（引入） | `POST /v1/marketplace/introductions` | 持有方（需求方）记录单个代理勾选的股东意向、份额与确定原因。不会释放股票信息。
| 介绍（引入） | `GET /v1/marketplace/introductions?tenant_id=&participant_id=` | 双方可读取引入投影，但交易所价值。

所有读取接受主叫生成的 id 和幂等键。每个 party-auth 请求还必须携带 `x-matchplane-platform-path`（由能力交换返回的规范路径）。网关会验证短期方承载令牌、精确梯度节点路径、租户/域作用域、需求/过渡角色、激活生命周期、过渡以及跨方不变。`attributes` 与 `terms` 必须是时间 JSON对象，不会被根解释为车辆字段。分数和理由是 AI 建议输出，股市释放仍是独立的、需要一致的状态转换，受现有 `introduction/contact` 契约约束。

相同资源也可通过已认证 HTTP MCP 门面 `/api/mcp` 给外部代理使用，工具包括 `marketplace.intent.create`、`marketplace.offer.create`、`marketplace.offer.update`、`marketplace.offer.withdraw`、`marketplace.offer.match`、`marketplace.demand.match`、`marketplace.intent.discovery.update`、`marketplace.introduction.create` 与 `marketplace.introductions.list`。需求时创建只需显式设置`supply_discovery_enabled: true`将进入募集发现指标；该只返回匿名摘要，不能替代需求方发起引介。需求方可以通过发现更新工具撤回后续发现。子平台自有搜索/技能工具通过通用`platform.child.tool`调用，调用方必须持有`agent:tool`且工具名必须在目标活动清单的白名单中；根仅查询做下游路径授权和有界转发，不把调用方API密钥传给子平台MCP 门面调用调用方的能力转给 Rust 网关，不会保存第二套 schema 或 token。由调用方自费的 Agent 承担其模型并提供库成本；MatchPlane 只需执行构建且可审计的状态变更。

稳定边界携带标准 ID 与分数，不携带：

```http
POST /api/platform/retrieval/query
```

请求/响应形状定义见[`docs/retrieval-protocol-v1.json`](retrieval-protocol-v1.json)。调用该门面时必须采取规范化的`scope.platform_path`、租户/域域作用、领域中立的叙述/要求与决策结果上限。根服务将其转变成目标活动节点清单明确允许的`retrieval.query`MCP工具；只有配置管理员配置了端点且调用方拥有`retrieval:query`时才会转发。每个候选必须返回标准根`asset_id`或规范`offer_id`至少一个（服务等没有目录资产的实际上只需返回`offer_id`），并注明分数、提供者/模型版本与可解释原因/风险。根当前只负责路径、机场、权限和ABI验证；它不会把网关显示_名称或属性视为可信成交授权，也不会依赖检索研究院直接释放网关、支付或结算。创建引入时，Rust网关仍会重新验证提供的状态、作用域和双方权限。未配置搜索终端、上游超时或返回不符合ABI时，根返回可初始化的错误，不会默默使用根平台凭据。

请求按 `request_id` 由提供商 手机幂等；提供商应对重试返回同样结果缓存/复用。提供商可返回空候选列表或 `degraded: true`；根必须在审计中保留该状态而不是静默切换到其他模型。提供数据库和索引工作者不随根平台默认提供；若方启用兼容提供商，也必须通过相同的检索 ABI 接入器配置，不会成为新子平台的要求强制。

任选 `email` 模块公开路由元数据。子平台管理员通过 `/v1/subplatforms/{domain_id}/email-config` 配置 SMTP 主机、TLS 模式、用户名与配置密钥引用。秘密引用不会返回给浏览器；服务端通知工作人员从主机密钥管理器取回。每个子平台都有独立修改记录与乐观版本号，因此子平台引用必须为不可见表单
`secret://subplatform/<tenant-uuid>/<domain-uuid>/<slot-name>`，Web Worker 仅在 `MATCHPLANE_SUBPLATFORM_SECRET_ROOT` 下解析该槽；子管理员不能提交 `env://` 或 `file://`。Better Auth 的全局密码、验证、OTP 与魔法链接始终走根的部署级通道邮件；子通道只用于已认证服务端通知任务（如发票或业务通知）并附带精确`tenant_id/domain_id`。根通道可继续使用`env://` 或 `file://`，因为它不会被子管理员写入。

## 两类注册输入

根管理员只需要提供源，推荐使用纯源发现流程：

1. **Git 仓库**：提交不带备用的 HTTPS 地址。`POST /api/platform/subplatforms/discover` 会创建待解析任务，隔离构建器拉取默认路径的精确 40 位提交，校验清单并回写源摘要、修订和清单。生产构建器只允许操作方配置的 Git 主机；高级 API 仍可直接提交已验证的不可变提交。
2. **归档上传**：先上传`.tar.gz`/`.tar.zst`包取得不透明`upload://`定位器，再提交发现任务。构建器在独立工作根中校验SHA-256，拒绝绝对路径、`..`路径相关、符号链接、设备文件、小型归档和左侧清单，最后把归档摘要作为不可变修订。

发现进入 `queued → discovering → ready/rejected` 状态；只有 `ready` 返回的清单 `POST /api/platform/subplatforms` 创建创建组织和注册。Web 进程不拉取、不解压、不执行来源代码。

注册记录包含 `subplatform_id`、`tenant_id`、`domain_id`、`slug`、来源类型、来源 URL 或上传摘要、固定修订版本、清单摘要、构建摘要、请求范围、许可状态和审核时间。对已存在`id`的重新注册不会静默覆盖现有发布，而会形成新的不修改版本，并要求显式激活。

## 运行时边界

- 根承担账户管理。通过更好的身份验证组织成员投影关系认领一个主动公开子平台；认领只需添加作用域的 `member` 角色，Rust 市场成员投影再补充 `seller`、`dealer` 或 `verified` 等标签，不会生成另一个套账户。管理员标签仍需邀请或由所有者/管理员明确操作。
- 每个子平台命令都标注了 `tenant_id`、`domain_id` 和该 `platform_path` 的能力。网关在敏感操作前会验证能力的精确精确的域作用域；给 `/a` 颁发的令牌不能在同网关的 `/b` 重放。
- 插件是静态前置负载层，不会标注独立数据库、不能签发令牌、不能绕过斯托一致、不能直接调用方。支付余额仍由根/支付服务保存。隔离构建器附加工件定位器后，激活清单会衍生`assets.hosted` URL为`/api/platform/plugin-assets/<mount>/...`；浏览器在`sandbox="allow-scripts"`的iframe中承载该发布。由于该沙箱采用不透明`null`起源，主机通过通配`postMessage`目标，但只接收来自精准iframe窗口和其主机生成的每实例`contextToken`的消息。主机舆舵版本化`matchplane.plugin/v1`背景与造型`match.results`快照；当主机侧推荐集变化时，快照会更新。可请求`chat.open`、`listing.open`、`listing.select`、`listing.submit`与 `navigation`；`listing.open`仅标注结果 id，主机使用最新快照解析再次打开主机拥有的详情/斯托流程。列表提交提出`requestId`，并返回的 `listing.submit.result`。主机在调用市场 API 前会验证卖家角色、更好的身份验证会话、激活京都/域/模式与配置 JSON。工件对应端点在 `MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT`下解析主机本地文件，核验活跃构建摘要，禁止路径与软链接逃逸，并施加严格的CSP。它不会抓取插件提供的URL或运行插件服务端代码。
- 结果桥是"单向数据 + 双向选中"：
  - host 发送 `{ protocol: "matchplane.plugin/v1", type: "match.results", version: 1, contextToken, payload: { listings: [...] } }`，最多包含 100 条由 host 拥有且公开的结果关联。
  - 援方会话的`platform.context`可附带`agentDraft`（`narrative`、任选`intentId`、不透明`attributes`与`attributes`）插件。它只是聊天材料的可编辑草稿，不是已发布援方，也没有提出代币、曼哈顿或支付权限；必须让援方检查并通过`listing.submit`显然，可行仍会做架构、机场和权限。稿草在路由到子平台后会通过新的上下文消息补发，避免聊天与表单脱节。
  - 插件发送 `{ type: "listing.open", contextToken, payload: { listingId } }`；host 会忽略当前快照之外的 id。
  - 买方 `platform.context` 只附带 `auth.status = pending|authenticated|anonymous`，不附带用户资料、cookie 或 token。插件可发送带 `requestId` 的 `auth.open`、`demand.open` 与 `listing.like`；host 分别负责 Better Auth 跳转、打开当前子平台内的根托管会话，以及调用已认证点赞 API，并返回对应的 `*.result`。匿名点赞意图只在根的 `sessionStorage` 中保存供给 id、平台路径和期望计数，登录返回同一路径后由根恢复；凭据始终不会进入 iframe。
  这种约束在保留垂直化渲染能力的同时，将认证、作用域、联系人同意与支付行为留在根服务侧。
- 路径仅在清单校验、API兼容、CSP/资源检查、包扫描和运营审计通过后才激活。取消或吊销会删除路径，但根账号与历史会保留。
  生产环境下，web页面和清单接口会独立校验完整的递归路径是否解析到激活不可变注册；`public/`下静态文件不构成激活授权。
- 清单与插件资产读取与代理路由共享 `membership_policy`可见性检查。公开注册可在未认领成员关系时获取；邀请制发布在调用方更好的身份验证用户或带作用域的代理密钥进行授权该组织子树时，返回相同的未找到（未找到）响应。

## 仓库边界

商店包在各自独立仓库中遵循本合约。核心仓库不保存商店 gitlink、不递归签出实例，也不复制任何商店实现；canonical path 始终来自活动 registry/manifest 记录。运营方可对外部签出运行 `just subplatform-package-check <path>` 或 `just subplatform-package-build-check <path>`。
