# 挑战 #11 验收截图

本地演示环境截图（`http://127.0.0.1:4173`，种子店铺 `demo-car-shop`，6 辆在售车）。

| # | 文件 | 对应验收点 |
| --- | --- | --- |
| 01 | `01-homepage-product-first.png` | 首页商品优先：六张车辆卡、帮我找入口 |
| 02 | `02-homepage-mobile.png` | 移动端首页 |
| 03 | `03-homepage-suv-filter.png` | SUV / 轿车分类过滤 |
| 04 | `04-listing-detail-sheet.png` | 车辆详情（点赞、价格、车况字段） |
| 05 | `05-search-chat-opened.png` | 「帮我找」打开选货对话 |
| 06 | `06-search-chat-message.png` | 自然语言需求进入对话（未配 AI 网关时会提示配置） |
| 07 | `07-storefront-demo-car-shop.png` | 卖车店铺页 `/demo-car-shop` |
| 08 | `08-store-manager-chat.png` | 与店长对话 |
| 09 | `09-login.png` | 登录页（邮箱 / Passkey） |
| 10 | `10-register.png` | 注册页 |
| 11 | `11-home-logged-in.png` | 登录后首页（商城控制台入口） |
| 12 | `12-admin-console.png` | 商城后台就绪面板 |
| 13 | `13-admin-login-methods-wechat-sms.png` | 商城设置：登录方式 / 微信扫码 / 短信网关 |
| 14 | `14-search-budget-results.png` | 无 AI 网关时预算检索仍出真实商品卡 |
| 15 | `15-search-budget-choices.png` | 模糊需求先出预算档位选项 |
| 16 | `16-account-dialog-identity-bindings.png` | 登录后账号设置弹窗：账号绑定入口（`/?account=identity`） |
| 17 | `17-identity-bindings-panel.png` | 账号绑定面板：邮箱已绑定，手机号 / 网号 / 微信 / 支付宝绑定项 |
| 18 | `18-identity-bindings-contact-policy-closeup.png` | 联系交换策略特写：只使用已验证绑定，不接受手填联系方式 |
| 19 | `19-store-customers-contact-consent.png` | 店铺控制台「客户」分区：联系方式仍受用户同意保护 |

复现：

```sh
just migrate   # 或已有库
./tools/demo/bootstrap-car-shop-demo.sh
cd web && bun run dev   # :4173
```

截图 16–19 使用演示账号 `admin11@example.com` 登录后拍摄：账号绑定弹窗从 `/?account=identity` 打开，店铺客户分区从 `/demo-car-shop?console=products&storeConsoleSection=customers` 打开。

详细点击路径见 `docs/challenge-11-demo-script.zh-CN.md`。
