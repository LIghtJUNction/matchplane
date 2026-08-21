# 国家网络身份认证登录

MatchPlane 为国内用户预留国家网络身份认证公共服务作为首选登录入口，其他方式仍由同一 Better Auth 身份体系提供 fallback：邮箱或手机号、密码、邮箱/手机验证码、免密链接、Passkey，以及已配置的微信、QQ、支付宝和 Google。

## 运行方式

登录页不会渲染一个“看起来能用”的假按钮。只有服务端检测到完整的、由运营方取得授权的国家网络身份认证接入配置时，才会把“国家网络身份认证”提升到登录页首位。点击后由 Better Auth `genericOAuth` 走 Authorization Code + PKCE 回调；登录成功后仍然进入同一个 MatchPlane 会话和平台作用域，不会为子平台创建第二个账号。

当前适配层支持两种官方接入形态：

1. 运营方提供的 OIDC discovery 地址；或
2. 运营方提供的授权、令牌、用户信息三个 HTTPS endpoint（例如官方 SDK/授权网关的服务端桥接）。

项目不猜测或硬编码公共服务的地址、签名算法、证书和 SDK 参数。国家网络身份认证公共服务的正式接入需要按照运营方获得的应用接入协议、SDK 或授权网关填写配置；没有这些凭据时，按钮保持隐藏，fallback 登录可正常使用。

## 配置

商城负责人可在“商城设置 → 国家网络身份认证”填写下列同一组参数。Client Secret 会写入 Web 服务可读的受保护目录，浏览器随后不会再收到它；由于 Better Auth 在启动时加载 OAuth 插件，保存后需要重启 Web 服务才会生效。环境变量仍作为未使用商城设置时的兼容方式，绝不把 secret 放进 `NEXT_PUBLIC_*` 或浏览器 bundle：

```dotenv
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_ID=...
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_SECRET=...
# 二选一：
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_DISCOVERY_URL=https://approved-gateway.example/.well-known/openid-configuration
# 或填写完整 endpoint 套件：
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_AUTHORIZATION_URL=https://approved-gateway.example/authorize
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_TOKEN_URL=https://approved-gateway.example/token
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_USERINFO_URL=https://approved-gateway.example/userinfo
MATCHPLANE_NATIONAL_IDENTITY_OAUTH_SCOPES=openid
```

Compose 会把同名变量传给 web。Helm 使用 `web.nationalIdentity.*` 填写非敏感 endpoint 和 client id，并从 `runtime.existingWebSecret` 的 `national-identity-client-secret` 键读取 client secret；不要把该 secret 写入 `values.yaml`。

生产环境的 endpoint 必须是 HTTPS。若配置不完整，服务端会记录一条不含 secret 的配置告警，并将 provider 视为未启用。`SCOPES` 默认为 `openid`，不会因为通用社交登录的默认值而申请 `email`。

## 数据与合规边界

- MatchPlane 只把 provider 的稳定 subject 用于账号关联；对国家网络身份 provider，写入 Better Auth 的关联键和内部占位邮箱都是 SHA-256 派生值，不保存明文身份证号、网号或网证内容。
- 国家身份 provider 没有邮箱时，内部占位邮箱不是联系地址，也不会向它发送邮件。需要邮件、短信、发票或售后联系的业务，应在启用这些渠道前通过受认证的账号资料流程取得对应联系方式。
- 不从国家身份回调中要求用户再次填写明文身份信息；真实身份核验结果仅用于法律允许的场景，并在业务层按最小化原则保存。
- 国家网络身份认证是自愿的。未使用网号/网证的用户必须得到与使用者同等的服务，因此 fallback 入口不会被隐藏或降级。
- 任何实名核验、年龄标识、风控或线下交易要求都应由具体业务子平台按适用法律单独声明和留痕，不把身份属性暴露给 Agent、MCP 或普通撮合结果。

## 运维验收

1. 在授权网关注册精确的 Better Auth callback URI（通常由 Better Auth 的 generic OAuth provider 生成，以上线环境实际日志/配置为准），启用 PKCE 和 state/nonce 校验。
2. 先在测试/沙箱凭据下验证：发起登录、拒绝授权、回调重放、缺少 subject、令牌过期、用户取消，以及切换到邮箱/手机号 fallback。
3. 检查数据库和日志中不出现 client secret、access token、明文身份证件号或网号/网证；只允许 provider-scoped 的关联记录和审计摘要。
4. 上线前确认国家网络身份认证 APP/SDK、授权网关和备案/隐私政策的运营主体与 MatchPlane 部署主体一致，并保存接入协议版本。

## 规范依据

- [国家网络身份认证公共服务管理办法（中国网信网）](https://www.cac.gov.cn/2025-05/23/c_1749711107835487.htm)
- [六部门联合公布说明（中国网信网）](https://www.cac.gov.cn/2025-05/23/c_1749711107837215.htm)
- [网络安全技术 国家网络身份认证公共服务 应用接入要求（全国标准信息公共服务平台）](https://std.samr.gov.cn/gb/search/gbDetailed?id=52AF72FB0308403AE06397BE0A0AD6A8)
