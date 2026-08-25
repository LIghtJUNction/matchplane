# MatchPlane 统一身份与联邦子平台（v1）

MatchPlane 不要求用户为每个子平台重复注册。Better Auth 是唯一的身份源，子平台只持有一个平台范围的成员投影和能力边界。

## 登录与作用域

1. 用户在根路径或任意子平台路径登录一次，Better Auth 创建全局用户与会话。
2. 浏览器继续携带同一 Better Auth 会话 cookie；访问不同路径时，服务器只根据目标平台解析一次作用域。
3. `/api/marketplace/session` 将会话交换成当前平台节点（`platform_path` + `domain_id`）的短期撮合能力。Rust capability 与节点 scope 一一绑定，不能跨平台复用；token 15 分钟后失效，客户端自动重新交换。
4. 只有注册记录 `membership_policy=public` 的 active 子平台，用户第一次以买家/卖家访问时才会自动写入 Better Auth `member` 关系。这个认领是幂等的，不会创建第二个用户，也不会授予管理权限；`invite` 节点必须接受邀请。
5. 未开放公开认领的子平台返回邀请提示；用户仍使用同一个账号接受邀请即可加入。

同一部署下的路径（例如 `/` 与 `/store-a`）直接复用根平台的 Better Auth cookie。子平台若部署到
不同域名，也不复制用户表或要求再次注册：根平台的 Better Auth OAuth Provider（OIDC）是唯一授权中心，
子平台是 OIDC relying party。子平台必须使用 Authorization Code + PKCE (S256)、`state`、`nonce`，把
回调收到的一次性 code 在服务端兑换，并以 `(issuer, sub)` 建立本地 member 投影；不得把 email 当作
身份主键。code 兑换后立即失效，子平台本地会话只保存最小身份投影，撮合 API 仍使用当前
`tenant_id`、`domain_id` 和 `platform_path` 的短期 capability。这样“一个账号”在同源路径和跨域联邦部署中保持相同语义。

### 跨域 OIDC 实现

当 `MATCHPLANE_OIDC_ENABLED=true`（生产默认通过部署配置开启）时，根平台提供：

- `/.well-known/openid-configuration`：OIDC discovery；
- `/api/auth/oauth2/authorize`、`/api/auth/oauth2/token`、`/api/auth/oauth2/userinfo`：Authorization Code 流程；
- `/api/auth/jwks`：签名密钥集合，Better Auth JWT 插件负责轮换；
- `/oauth/consent`：用户可读的授权确认页。

客户端注册关闭匿名动态注册。根平台管理员为每个外域子平台登记精确 redirect URI、客户端类型、
允许 scope 和 reference id；机密 web 客户端的 secret 只保存在子平台服务端，浏览器永远不接触。
默认只允许 `openid profile email`，不通过 OIDC claim 传递管理员角色或联系方式。目标子平台在
完成 OIDC 回调后，仍必须向根平台交换自己的平台 capability，并重新检查成员策略、组织祖先链和
注册版本。用户撤销根会话或子平台成员关系后，刷新 token、userinfo 和下一次 capability 交换必须失败。

外域子平台的 capability 交换使用根平台的
`POST /api/marketplace/session`。这是一个仅限子平台服务端的请求，不能从浏览器发起：请求体除
`tenantId`、`domainId`、`subplatform`、`platformPath` 和 `role` 外，还要带
`federated: { accessToken, clientId, clientSecret }`。根平台用 Better Auth 的官方
`/oauth2/introspect` 校验 access token、客户端 secret、`openid` scope 和 token 撤销状态，再确认
`clientId` 的注册元数据精确绑定到当前 active 子平台，最后才签发当前节点的短期 marketplace
capability。客户端 secret 不进入浏览器、前端 bundle、日志或 capability；管理员撤销 OIDC 客户端
后，introspection 与后续 capability 交换都会失败。子平台只需把 `(issuer, sub)` 映射到自己的
本地 member 投影，不要复制根平台密码或建立第二套凭据。

根平台普通买家/卖家不需要额外组织成员关系。根平台超级管理员是 Better Auth 全局 `rootSuperAdmin`；每个子平台创建者是该组织的 `owner`，即该子平台的超级管理员。子平台 `admin`/`subplatform_admin` 和 `moderator` 只能由组织管理员邀请或由根平台管理员配置。

## 登录方式

- 国家网络身份认证公共服务是面向国内用户的首选入口（仅在运营方完成官方应用接入或授权网关配置后显示）。它通过 Better Auth `genericOAuth` 的 Authorization Code + PKCE 适配层接入，配置由运营方按正式协议提供；项目不硬编码公共服务 endpoint，也不把国家身份凭据放入浏览器。国家身份回调没有邮箱时，Better Auth 使用基于稳定 subject 的 SHA-256 provider-scoped 占位标识，不把明文身份证号、网号或网证写入用户资料。这个入口是自愿的，其他登录方式必须保持同等可用。
- 密码登录、邮箱验证码和免密链接均由 Better Auth 插件实现；这些是整棵联邦平台共享的身份生命周期，因此统一使用部署方持有的根平台 SMTP。不会依据浏览器传来的 `x-matchplane-subplatform` 选择路由，避免子平台管理员重定向根平台的重置密码、验证码或验证邮件。子平台 SMTP 仅用于由已认证服务端按精确 `tenant_id/domain_id` 发送的平台通知（例如发票、商家通知），不能承载根身份邮件。
- 手机号验证码由 Better Auth `phoneNumber` 插件实现，验证码只交给显式配置的 SMS gateway；手机号格式归一化为 E.164，根平台不绑定某一家短信供应商。
- Passkey 由 Better Auth 官方 `@better-auth/passkey` 插件实现，WebAuthn challenge、凭证和会话都由服务端校验；登录页的钥匙按钮直接调用设备生物识别或安全密钥。
- Google、微信、QQ、支付宝使用 Better Auth `genericOAuth`。每个 provider 必须完整配置 server-only 的 client id、secret、authorization/token/userinfo URL 才会启用，并通过 OAuth 授权页跳转，不在浏览器保存 provider secret。
- 未配置的社会化登录不会渲染假按钮；管理员配置完成后，登录页才会显示对应的跳转授权按钮。
- OAuth 资料没有邮箱时，Better Auth 使用不可对外投递的 provider-scoped 账号标识，不把第三方 access token 暴露给浏览器。

## 安全不变量

- 根平台和子平台共享身份，不共享授权：`user_id` 相同不代表拥有其他组织权限。
- 普通成员自动认领只接受 `member` 角色；任何管理员角色都不能通过公开入口获得。
- 浏览器不持久化 marketplace bearer；短期 capability 只保存在页面内存中，过期或刷新后由
  Better Auth 的 HttpOnly 会话重新交换。这样不会把 Rust 网关凭据留在 `localStorage` 或
  `sessionStorage` 中。
- 带 Better Auth cookie 的管理、认领和 capability 写请求必须来自 `BETTER_AUTH_URL` 或
  `BETTER_AUTH_TRUSTED_ORIGINS`；无 cookie 的组织 API-Key Agent 走独立的机器认证路径。
- 联系电话、微信号、SMTP secret、OAuth secret 不进入 Better Auth session、能力 token、MCP 工具响应或客户端 bundle。
- 平台树变更、成员邀请、认领和能力签发都应记录审计事件；撤销成员关系后，下一次能力交换必须失败。

## 客户端集成

子平台不实现自己的登录页。它只提供 manifest 与路径，使用根平台的 `/login`，并在请求中带 `x-matchplane-subplatform`。需要调用撮合 API 时，调用 `establishMarketplaceSession({ subplatform, platformPath, role })`；不要自行创建 JWT、cookie 或用户表。
