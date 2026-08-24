# 挑战 #11 PR 文案候选（9 版）

## 1 · 工程师极简

**TITLE:** challenge #11: 首页找货、联系方式、控制台登录配置

**BODY:**
改了首页搜索入口和商品卡片，联系方式交换流程能走通，商城后台加了微信/短信 配置面板。卖车 demo 用 `./tools/demo/bootstrap-car-shop-demo.sh` 起数据。`cd web && bun run test` 过。

---

## 2 · 跟发布者说话

**TITLE:** 挑战11交付：matchplane 卖车场景能点了

**BODY:**
light 你好，这版按挑战页要求做的。

首页先看车，右上角「帮我找」填预算能筛商品；聊天里会先问预算和用途，再出卡片，不是瞎编。联系方式只能走账号里验证过的邮箱/手机，双方同意才给。

商城设置里加了微信登录和短信 网关的配置界面（没配真实密钥也能用 mock 演示 OTP）。`tools/demo/bootstrap-car-shop-demo.sh` 一键起「星辰二手车行」六台样车。

我本地点过一遍，测试也跑了。你那边要是方便，按 `docs/challenge-11-demo-script.zh-CN.md` 验一下就行。

---

## 3 · 干清单

**TITLE:** Challenge 11 — buyer flow, contact consent, mall login config

**BODY:**
- 首页：商品网格 + 「帮我找」输入
- 搜索：工具检索，非向量
- 联系：StoreContactConsentCard，verified channels only
- 控制台：WeChat OAuth panel、SMS gateway panel、LoginMethodsPanel
- Demo：`demo-car-shop`，bootstrap 脚本
- 测试：`cd web && bun run test`

验收：`docs/challenge-11-qa-checklist.zh-CN.md` §9

---

## 4 · 一段话说完

**TITLE:** matchplane 挑战11

**BODY:**
首页商品优先，加了预算搜索，卡片改成类似二手车的样子，联系要走验证渠道。后台能配微信和短信登录，有卖车 demo 脚本。web 测试全绿，细节见 docs。

---

## 5 · 只有事实

**TITLE:** feat: challenge 11 participation bundle

**BODY:**
变更范围：web 前端 + demo 脚本 + 文档。

- `MarketplaceHome` / `MarketplaceListingCard` / `MatchChat` / `FloatingMarketplaceClerk`
- `WeChatLoginConfigPanel` / `PhoneLoginConfigPanel` / `LoginMethodsPanel`
- `StoreContactConsentCard` / `IdentityBindingsPanel`
- `tools/demo/bootstrap-car-shop-demo.sh` → slug `demo-car-shop`

运行：`just dev` → `just migrate` → bootstrap 脚本。测试：`cd web && bun run test`。

---

## 6 · 英文标题

**TITLE:** Challenge #11: product-first mall UX and car-shop demo

**BODY:**
针对 api.lmm.best 挑战 #11。

买家侧：首屏商品、自然语言找货、工具循环检索、联系方式双方同意。运营侧：微信 QR 登录与 SMS 网关可在商城控制台配置。附带 demo 车行种子数据与验收文档。

测试：`cd web && bun run test`（361 tests）。

---

## 7 · 给赞助人的信

**TITLE:** [Challenge #11] MatchPlane 参与提交

**BODY:**
发布者您好，

我做了什么：
- 商城首页以商品为主，搜索入口不抢戏
- 买家描述需求后，系统用工具查在售车辆（不用 RAG）
- 联系方式必须绑定验证，双方点同意才释放
- 商城后台可配置微信登录、短信验证码登录

您怎么验：
1. 跑 demo 脚本见 `docs/challenge-11-demo-script.zh-CN.md`
2. 按 `docs/challenge-11-qa-checklist.zh-CN.md` §9 逐项点

还差的：真实微信开放平台 appid、真实短信签名（可用 mock 先看流程）。

---

## 8 · 给不懂技术的人

**TITLE:** 卖车商城体验改进（挑战11）

**BODY:**
这版让网站更像正常卖车页面：一打开先看到车，想找可以说预算。问客服的地方不会满屏「人工智能」字样。留电话必须用自己账号里验证过的号码，双方同意才互相看到。

店主在后台可以设置：顾客能不能用微信登录、能不能收短信验证码。

---

## 9 · 十分钟赶工 human

**TITLE:** 挑战11：先把卖车流程跑通

**BODY:**
## 改了啥

首页能直接看车，上面有个框写预算点「帮我找」。聊天会先问你大概多少预算、家用还是商用，再给几款车，应该都是库里真实上架的。

联系卖家要走同意，不能手填微信号。后台加了微信和短信的配置页，没配也能用本地 mock 收验证码试一下。

`./tools/demo/bootstrap-car-shop-demo.sh` 会塞一个 demo 店和六台样车，具体点哪我写在 `docs/challenge-11-demo-script.zh-CN.md` 了。

测试跑过，21 个 commit 可能有点散，你要觉得乱我可以再 squash。
