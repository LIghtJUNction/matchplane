# 平台互联与绑定

平台绑定不是把一个API密钥填进另一个平台就结束。API密钥只说明"这次机器调用被允许做什么"；它不说明对方平台是谁、是否仍然属于原来那棵平台树，也不适合作为长期的人类登录规则。

## 两种接入形态

### 同一部署内嵌子平台

这是 MatchPlane 当前路径：根管理员在控制台登记独立商店 Git 仓库或压缩包，提交固定修订、源摘要和 `matchplane.subplatform/v1` 清单。内置的独立 `matchplane-subplatform-builder` 通过短租约领取登记，生成不可变构建摘要；管理员显式激活后，子平台挂在一个 `parentOrganizationId` 下，使用合成示例路径 `/store-a`。多个子平台共用一个 Web 进程和根 Agent，不需要启动多个 Next.js 进程。若没有部署 builder，登记会停在 `validated`，不会伪装成已激活。核心仓库不递归签出或内置任何商店实例。

子平台自己的搜索、支持库和领域 UI 插件包同样是 MCP 服务内；根只做身份、权限、路由和审计。

### 对方已经独立运行的平台

对方平台不应把数据库或登录凭证交给根平台。现在可以通过持久化入驻状态机建立一个受限的远程节点：

```text
对方管理员批准一次性入驻邀请
        ↓
交换平台公钥 + 签名 manifest（平台路径、协议版本、能力、过期时间）
        ↓
根管理员审核并绑定到指定 parent/domain
        ↓
根管理员激活本地路由投影，并配置远端 MCP bearer token 的 secret 环境变量
        ↓
运行时只访问 allowlist MCP 工具；管理员可以撤销节点，撤销会立即禁用本地路径
```

根管理员可以在后台"远程平台"面板生成一次性邀请，也可以调用：

```text
POST /api/platform/federation/invites
POST /api/platform/federation/enroll
POST /api/platform/federation/bindings/activate
PATCH /api/platform/federation/bindings   {"status":"revoked"}
```

`/enroll` 不要求浏览器会话，但必须同时提交一次性令牌和 Ed25519 签名的
`matchplane.federation/v1` 清单。它只能读取 `pending` 绑定；终端不能自行激活。激活时
根会通过 Better Auth 创建同一平台树中的组织，并创建 `source_kind=remote` 的活动路由
投影。生产环境要求激活请求填写`tokenEnv`，实际承载只来自web进程的秘密环境变量
读取，从未读取数据库或清单。入驻令牌只返回一次，数据库只保存SHA-256摘要。

终端节点可以是另一个部署的 root 平台。接收方不会把终端的本地 root Better Auth 组织直接
改挂到自己的组织树（那会破坏远端继续管理自身子平台的本地根）；激活时创建的是本租户内
`source_kind=remote` 的组织与注册投影。该投影在路径、路由、MCP 白名单、权限和撤销语义上
与内嵌子平台相同，而远端自己的账户、数据和后代仍由远端部署管理。

当前 web 控制面已经具备组织 API key、MCP 子节点工具和 OIDC 客户端边界：`agent:tool`、`retrieval:query`、`platform:manage_children` 等权限必须按用途分别签发；调用必须注明`platform_path`、租户/域范围，并通过清单的工具白名单。根不会把调用方 API key 转发给子平台，子平台依赖由管理员部署`tokenEnv`配置在服务器端，生产端点必须 HTTPS。活动联邦绑定优先从数据库解析端点；内嵌包仍可使用基础的 `MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON` 兼容配置。

## 推荐的绑定步骤

1. 对方平台生成自己的节点id、Ed25519客户端和签名manifest，发布MCP端点；不要在manifest或URL中放secret。
2. 根平台管理员为目标组织/路径生成瞬时入驻token（短TTL、单次使用、数据库只存摘要），对方用token + 完成注册。
3. 根平台保存终端节点全局、manifest摘要、端点、父节点、机场/域范围和状态（pending/active/revoked），人工确认后才活跃。
4. 根平台创建只允许 `retrieval:query` 或 `agent:tool` 的 Better Auth 组织 API 密钥，设置过期时间；需要更强的团体身份时改用 mTLS，API 密钥仍然只做应用层授权。
5. 运行时先做HTTPS/mTLS、签名和白名单验证，再把建立的MCP请求转发给终端。终端返回候选/能力，不直接获取根平台以太、或支付用户会话。
6.轮换或撤销密钥/证书后立即将节点标记为降级/撤销；健康检查失败不得广播全部子平台，也不得自动放宽权限。

## 用户登录不会重复注册

人类用户使用根平台Better Auth会话；子平台通过OIDC将根平台作为身份提供方，并在本地映射主体/组织成员关系。只有机器代理使用范围API密钥或mTLS。这样一个用户在根平台登录后访问可以被授权的多个子平台，不需要为每个节点再建密码账号。

## 当前配置示例

对于已经独立运行、但暂时只提供 MCP 的子平台，建议先走上述签名入驻；内嵌包或迁移期间也可以先配置管理员配置服务端端点（不是浏览器配置）：

```dotenv
MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON={"store-a":{"url":"https://store-a-agent.example/mcp","tokenEnv":"MATCHPLANE_STORE_A_MCP_TOKEN"}}
MATCHPLANE_STORE_A_MCP_TOKEN=server-side-secret
```

环境变量兼容路径只建立工具转发，不会产生持久化平台；生产接入应使用签名入驻身份、手动激活、秘密引用和撤销。不要将永久API密钥设置平台身份，也不会将承载写入Git仓库、清单或浏览器。
