# 联系交换审计（Contact Exchange Audit）

> 审计对象：`matchplane` @ `980c498`
> 审计方式：静态代码审阅 + 本地 dev server 冒烟（HTTP 200，空目录空态正常渲染）
> 结论：**通过** —— 联系方式披露只发生在双方同意之后；只使用 Better Auth 已验证渠道；未发现手填联系方式或单方披露路径。

## 1. 已验证渠道是唯一数据源

`web/app/api/account/contact-channels/route.ts`

- GET 需要有效 Better Auth 会话（`auth.api.getSession`），未登录 401。
- 返回的 channels 只包含 `emailVerified === true` 的 email 与 `phoneNumberVerified === true` 的 phoneNumber。
- 没有任何请求参数可以改变返回内容；未验证渠道不出现在响应里。

`web/src/components/StoreContactConsentCard.tsx`

- 数据来自 `getVerifiedContactChannels()`（即上述端点）。
- 空态文案：「没有已验证的邮箱或手机 —— 请先在账号中绑定并验证联系方式；平台不支持手填。」
- 同意区明示：「同意后，只有以下已验证绑定可在店员也同意后交换。AI 不能修改这些内容，也不能替你同意。」
- 组件内**没有**任何联系方式输入框。

## 2. 同意门禁（MCP → Rust 网关）

Web MCP 外观（`web/app/api/mcp/route.ts`）把联系方式相关工具显式映射到网关 introduction 端点：

| 工具 | 网关路径 |
| --- | --- |
| `marketplace.introduction.contact.request` | `POST /v1/marketplace/introductions/{id}/contact/request` |
| `marketplace.introduction.contact.consent` | `POST /v1/marketplace/introductions/{id}/contact/consent` |
| `marketplace.introduction.contact.release` | `POST /v1/marketplace/introductions/{id}/contact` |

代码注释明确：网关是租户范围、角色检查、幂等与同意的权威（the gateway remains the authority for tenant scope, role checks, idempotency and consent）。

## 3. Rust 存储层守卫

`crates/matchplane-storage/src/marketplace.rs` → `release_offline_contact`（约 L2319-2360），释放联系方式时依次执行，任一失败即拒绝并写审计：

1. 可串行化事务（`serializable`）——防并发竞态。
2. 交易参与方匹配——只有撮合到的 buyer/seller 本人可请求，否则 `Forbidden`。
3. 租户校验——`deal.tenant_id != command.tenant_id` → `NotFound`。
4. listing 授权 + 参与方活跃检查。
5. 交易状态/过期检查——`declined`/`expired`/`disputed` 或已过期 → `Conflict` + 审计 `denied`。
6. 卖方同意必查——`seller_contact_consent_at.is_none()` → `Conflict("seller consent is required before contact exchange")` + 审计 `denied`。

买方同意由其主动发起 request 体现；卖方同意必须显式落库（migration `202608140003_contact_exchange_consent.sql` 增列 `seller_contact_consent_at` 并带部分索引；同意动作在存储层约 L1895-1908 幂等写入并记 `seller_contact_consent` 审计事件）。

## 4. 结论

- 披露需要：登录 + 交易参与方 + 交易有效 + 卖方已同意（买方由发起动作同意）。
- 披露内容只来自 Better Auth 已验证 email/phone。
- 无手填入口；AI/Agent 无权修改同意状态或渠道值。
- 拒绝路径全部落审计（`insert_contact_audit ... 'denied'`）。

## 5. 备注（非缺陷）

- 卖方同意落库同样运行在事务内并要求卖方为交易参与方，与 release 属同一守卫族；未发现绕过路径。
- 本审计未做线上双账号端到端联调（需要真实撮合数据，属部署验收范畴）。
