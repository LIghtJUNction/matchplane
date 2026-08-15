# MatchPlane 统一身份与联邦子平台（v1）

MatchPlane 不要求用户为每个子平台重复注册。Better Auth 是唯一的身份源，子平台只持有一个平台范围的成员投影和能力边界。

## 登录与作用域

1. 用户在根路径或任意子平台路径登录一次，Better Auth 创建全局用户与会话。
2. 浏览器继续携带同一 Better Auth 会话 cookie；访问不同路径时，服务器只根据目标平台解析一次作用域。
3. `/api/marketplace/session` 将会话交换成当前平台节点（`platform_path` + `domain_id`）的短期撮合能力。Rust capability 与节点 scope 一一绑定，不能跨平台复用；token 15 分钟后失效，客户端自动重新交换。
4. 只有注册记录 `membership_policy=public` 的 active 子平台，用户第一次以买家/卖家访问时才会自动写入 Better Auth `member` 关系。这个认领是幂等的，不会创建第二个用户，也不会授予管理权限；`invite` 节点必须接受邀请。
5. 未开放公开认领的子平台返回邀请提示；用户仍使用同一个账号接受邀请即可加入。

同一部署下的路径（例如 `/` 与 `/used-car`）直接复用根平台的 Better Auth cookie。若未来把
子平台部署到不同域名，不复制用户表或要求再次注册：把根平台作为唯一 OIDC/授权中心，子平台
只接收一次性授权码并建立本地 `member` 投影；授权码兑换后立即失效，撮合 API 仍使用当前
`tenant_id`、`domain_id` 和 `platform_path` 的短期 capability。这样“一个账号”在同源路径和跨域联邦部署中保持相同语义。

根平台普通买家/卖家不需要额外组织成员关系。根平台超级管理员是 Better Auth 全局 `rootSuperAdmin`；每个子平台创建者是该组织的 `owner`，即该子平台的超级管理员。子平台 `admin`/`subplatform_admin` 和 `moderator` 只能由组织管理员邀请或由根平台管理员配置。

## 登录方式

- 密码登录、邮箱验证码和免密链接均由 Better Auth 插件实现；邮箱发送使用目标子平台配置的 SMTP 路由（按 active registration 的 slug 映射到其 `domain_id`，不要求 domain slug 与 URL slug 相同）。
- 微信、QQ、支付宝使用 Better Auth `genericOAuth`。每个 provider 必须完整配置 server-only 的 client id、secret、authorization/token/userinfo URL 才会启用。
- 未配置的社会化登录不会渲染假按钮；登录页显示“已预留，待管理员配置”的说明。
- OAuth 资料没有邮箱时，Better Auth 使用不可对外投递的 provider-scoped 账号标识，不把第三方 access token 暴露给浏览器。

## 安全不变量

- 根平台和子平台共享身份，不共享授权：`user_id` 相同不代表拥有其他组织权限。
- 普通成员自动认领只接受 `member` 角色；任何管理员角色都不能通过公开入口获得。
- 联系电话、微信号、SMTP secret、OAuth secret 不进入 Better Auth session、能力 token、MCP 工具响应或客户端 bundle。
- 平台树变更、成员邀请、认领和能力签发都应记录审计事件；撤销成员关系后，下一次能力交换必须失败。

## 客户端集成

子平台不实现自己的登录页。它只提供 manifest 与路径，使用根平台的 `/login`，并在请求中带 `x-matchplane-subplatform`。需要调用撮合 API 时，调用 `establishMarketplaceSession({ subplatform, platformPath, role })`；不要自行创建 JWT、cookie 或用户表。
