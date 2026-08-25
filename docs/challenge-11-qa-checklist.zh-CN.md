# 挑战 #11 手动 QA 清单：赞助点击链路（Sponsor Click-Through）验证

> 平台挑战页：https://api.lmm.best/challenges/11
> 参与指南：`docs/challenge-11-participation.zh-CN.md`
> 提交手册：`docs/challenge-11-submission-playbook.zh-CN.md`
> 相关设计：ADR 0011（卖方推广营收）、ADR 0015 第 8 条（赞助曝光必须贴标签）、`docs/marketplace-payments.zh-CN.md`

本清单验证 **卖方推广（赞助）活动的点击计费链路**：买家在商城里的真实点击
（详情浏览 / 收藏）如何变成赞助活动的 `click` 计费事件，以及去重、预算、
可见性是否符合规则。每项都标注了对应的自动化测试；标注「仅手动」的项目
目前没有自动化覆盖，必须亲自点通。

## 0. 链路速览

曝光事件（`marketplace_seller_exposures`）→ 赞助计费事件（`seller_promotion_events`）的映射
（见 `crates/matchplane-storage/src/marketplace.rs` 的 `bill_promotions_for_exposure`）：

| 曝光 event_type | 计费 event_type | 触发计费的定价模型 |
| --- | --- | --- |
| `impression`（推荐渲染，服务端记录） | `impression` | `cpm`（每满 1000 次计一档） |
| `detail_view` / `favorite`（买家点击） | `click` | `cpc`（每次点击按单价扣费） |
| `inquiry`（发起引介） | `qualified_lead` | `cpl`；`fixed` 只计首个 |
| `matched_contact`（联系方式放行） | `contact_exchange` | 只留审计记录，**不重复扣费** |

涉及的网关端点（`services/matchplane-gateway/src/main.rs`）：

- `POST /v1/marketplace/promotions` — 创建赞助活动
- `GET  /v1/marketplace/promotions/{campaign_id}` — 出资方查看活动指标
- `POST /v1/marketplace/listings/{listing_id}/exposures` — 买家客户端上报点击类曝光
- `GET  /v1/marketplace/listings/{listing_id}/exposure-metrics` — 卖家查看漏斗

## 1. 环境与测试数据准备

- [ ] 服务启动：`matchplane initialize && matchplane serve gateway && matchplane serve web`
      （或 `just dev`），迁移含 `202608140004_seller_promotions.sql`
- [ ] 准备一个租户、一个卖家 party（含 `seller` 角色）、一个买家 party（含 `buyer` 角色）、
      一条 `active` 的车辆 listing（卖车店铺场景）
- [ ] 用卖家身份创建一条 **CPC** 赞助活动：

```sh
curl -sS -X POST "$GATEWAY/v1/marketplace/promotions" \
  -H "authorization: Bearer $SELLER_TOKEN" -H "content-type: application/json" \
  -d '{
    "tenant_id": "'$TENANT'",
    "sponsor_party_id": "'$SELLER_PARTY'",
    "target_kind": "vehicle_listing",
    "target_key": "'$LISTING_ID'",
    "pricing_model": "cpc",
    "currency": "CNY", "currency_scale": 2,
    "unit_price": "500", "budget_amount": "1500"
  }'
```

预期：`201`，活动 `status = active`、`spent_amount = 0`。

- [ ] **归属校验**：用卖家 A 的 token 给卖家 B 的 listing 创建活动 →
      拒绝，报错 `seller promotion target is not owned by the sponsor`（仅手动）
- [ ] **参数校验**：`pricing_model` 传 `cpa`、`policy` 传其它值、`budget_amount` 为 0 → 均被拒绝（仅手动）

## 2. 点击计费主链路（CPC，本清单核心）

- [ ] **详情点击计费**：买家 token 调
      `POST /v1/marketplace/listings/{id}/exposures`，body `{"event_type":"detail_view", ...}` →
      `201 {"duplicate":false}`；随后出资方 `GET /v1/marketplace/promotions/{id}` 可见
      `billable_units = 1`、`spent_amount = 500`
      - 对应测试：CPC 单价计算
        `crates/matchplane-storage/src/marketplace.rs::tests::promotion_pricing_is_deterministic_and_does_not_double_bill_contact`；
        `detail_view → click` 的映射与入库链路为**仅手动**
- [ ] **收藏点击计费**：同上，`event_type = "favorite"` → 同样按 `click` 扣一次单价
      （去重键含事件类型，与 `detail_view` 互不冲突）（仅手动）
- [ ] **同日重复点击去重**：同一买家、同一 listing、同一事件类型当日再次上报 →
      `200 {"duplicate":true}`，`spent_amount` / `billable_units` 均不变
      （去重键 `public:{买家}:{listing}:{事件}:{日期}`，见 `record_exposure`）（仅手动）
- [ ] **公共端点白名单**：`event_type` 传 `impression` / `inquiry` / `matched_contact` →
      `400 public exposure endpoint accepts only detail_view or favorite`，
      即客户端**不能**伪造服务端专属事件刷计费（仅手动）
- [ ] **角色限制**：无 token、或用仅有 `seller` 角色的 party 上报曝光 → 拒绝（`require_role("buyer")`）（仅手动）
- [ ] **CPM 活动不因点击扣费**：给同一 listing 建 `cpm` 活动后重放点击 → 该活动不产生扣费
      - 对应测试：同上 Rust 单测中 `promotion_charge("cpm", "click", ...) == (0, 0)` 断言

## 3. 曝光（impression）与漏斗其余事件

- [ ] **推荐渲染记曝光**：买家在选货员对话（`MatchChat`，exposure key 形如 `chat-*`）
      或买家需求接口获得推荐 → 服务端按「买家 × listing × 日」记一次 `impression`，
      调用方自定义 key **不能**刷出多次计费曝光（仅手动；参考
      `recommend_vehicle_listings` 内注释）
- [ ] **CPM 每满 1000 次计一档**：第 999 → 1000 次曝光跨档时才扣一次单价
      - 对应测试：Rust 单测 `promotion_pricing_is_deterministic_and_does_not_double_bill_contact`
        的三个 `cpm/impression` 断言
- [ ] **CPL 只计合格线索**：发起引介（offline deal）→ 记 `inquiry` → CPL 活动扣一次；
      随后联系方式放行记 `matched_contact` → **不再扣费**，仅留审计
      - 对应测试：同上单测中 `cpl/qualified_lead == (1, 5000)` 与 `cpl/contact_exchange == (0, 0)` 断言；
        引介/放行触发入库为**仅手动**

## 4. 预算与活动状态

- [ ] **预算封顶即耗尽**：上例预算 1500 / 单价 500，第 3 次有效点击后
      `spent_amount = budget_amount`、`status = exhausted`；第 4 次点击不再扣费（仅手动）
- [ ] **扣费不超余额**：余额不足单价时按剩余额度收敛（`charge = min(计算值, 剩余)`）（仅手动）
- [ ] **耗尽 / 过期不阻断自然流量**：活动 `exhausted` 或 `expired` 后，买家上报
      `detail_view` 仍然 `201` 成功（计费冲突被吞掉，只影响赞助账，不影响有机漏斗）（仅手动）
- [ ] **到期自动翻转**：`ends_at` 已过的 `active` 活动在下一次事件时自动置 `expired`（仅手动）
- [ ] **未开始 / 暂停活动不计费**：`starts_at` 在未来或 `paused` 的活动不产生扣费（仅手动）

## 5. 指标可见性与隐私

- [ ] **活动指标仅出资方可见**：非 sponsor 的 party 调 `GET /v1/marketplace/promotions/{id}` →
      `403 promotion metrics are visible only to its sponsor`（仅手动）
- [ ] **曝光漏斗仅卖家可见**：`GET /v1/marketplace/listings/{id}/exposure-metrics`
      需要 `seller` 角色，返回 `impressions / detail_views / favorites / inquiries /
      matched_contacts / distinct_viewers` 各计数与点击数一致（仅手动）
- [ ] **公开 listing 不泄露卖家身份**：面向买家的 listing JSON 不含 `seller_party_id`
      - 对应测试：`crates/matchplane-storage/src/marketplace.rs::tests::public_listing_serialization_does_not_expose_seller_identity`

## 6. 商城 UI 点击路径（挑战 #11 分支相关）

- [ ] **首页商品优先、点赞可用**：首页先见真实商品卡片，点赞按钮实时加 1、
      单账号 5 次封顶、无 offer 的演示卡不出现点赞控件
      - 对应测试：`web/src/components/MarketplaceHome.test.tsx` 的
        “shows the total and lets the viewer add another like” /
        “stops at five likes for one account” /
        “does not render a like control when liking is unavailable”
- [ ] **「帮我找」到选货员**：首页输入需求（如「预算 15 万以内的 SUV」）点「帮我找」→
      选货员展开且输入被预填
      - 对应测试：同文件 “opens the shopping clerk with a hero need prompt”
- [ ] **选货员推荐可点开**：推荐卡片可点进商品/店铺详情（该点击最终应体现在
      `detail_views` 与 CPC 扣费上，结合第 2 节复查）
      - 对应测试：推荐渲染见 `web/src/components/MatchChat.test.tsx`
        “shows a public attachment photo inside the assistant answer”；点击→计费闭环为**仅手动**
- [ ] **赞助位必须贴标签**（ADR 0015 第 8 条）：检查首页、分类筛选、推荐流中
      不存在未标注的赞助位；若后续引入赞助位，必须带明确「赞助/推广」标识，
      且不得静默取代有机排序（当前 UI 未实现赞助位，确认没有即通过）（仅手动）

## 7. 自动化回归命令

```sh
# Rust：含赞助计价单测（promotion_pricing_*、public_listing_serialization_*）
cargo test -p matchplane-storage --locked

# Web：首页/选货员交互测试
cd web && bunx vitest run \
  src/components/MarketplaceHome.test.tsx \
  src/components/MatchChat.test.tsx

# 全量门禁（fmt / clippy / 全部测试 / 子平台校验）
just check
```

## 8. 结果记录

| 项 | 结论（通过 / 失败 / 阻塞） | 备注（环境、截图、请求响应） |
| --- | --- | --- |
| §1 准备 | | |
| §2 CPC 点击计费 | | |
| §3 曝光与漏斗 | | |
| §4 预算与状态 | | |
| §5 可见性与隐私 | | |
| §6 UI 点击路径 | | |

> 提交挑战成果前，请把本表结论连同关键请求/响应片段附在验收邮件
> （见提交手册第 2.2 节模板 B）与 PR 描述中。

---

## 9. 挑战 #11 核心买家旅程（发布者人工验收必点）

> 本节对齐挑战页要求（商品浏览、自然语言选货、工具检索非 RAG、联系方式交换、去 AI 味）。
> 与上文 §2–§5 的赞助计费链路无关；**验收挑战 #11 以本节为准**。

| # | 步骤 | 预期 | 自动化 |
| --- | --- | --- | --- |
| A1 | 打开 `/`，首屏可见真实商品卡片 | 商品优先，非大段 AI 文案 | `MarketplaceHome.test.tsx` 部分覆盖 |
| A2 | 给商品点赞 | 计数更新 | `MarketplaceListingCard` 测试 |
| A3 | 首页「帮我找」输入「预算 15 万以内的 SUV」→ 打开选货员 | 输入预填到对话框 | `MarketplaceHome.test.tsx` |
| A4 | 发送「我想买辆车」 | AI 通过 `ask_user` 弹出可点选预算/用途（非纯文字追问） | 仅手动 + `platform-shopping-agent.test.ts` 提示词 |
| A5 | 完成追问后 | 出现真实车辆卡片 + 推荐理由（`show_products`） | 仅手动 |
| A6 | 「对比前两台，算总价」 | 走比较/计价工具，非模型口算 | 仅手动 |
| A7 | 进入卖车店铺页 | 可浏览该店车辆 | 仅手动 |
| A8 | 申请联系/约看 | 仅展示**已验证**邮箱/手机；不可手填联系方式 | `StoreContactConsentCard.test.tsx` |
| A9 | 双方同意（需 gateway 联调） | 店员在工作台「同意交换」后，店员与买家各自可读取对方联系方式（买家入口：店铺页「联系申请」面板） | 部分：`StoreContactRequestsPanel.test.tsx`；释放链路仅手动 |
| A10 | 商城负责人控制台配置 AI | 保存网关/模型/测试连接成功 | 仅手动 |
| A11 | 登录页 | 配置后可见微信/手机验证码入口（可用 mock） | `LoginScreen.test.tsx` 部分覆盖 |

**必点 Top 5（无自动化替代）：** A4、A5、A8、A9、A10。

| 项 | 结论 | 备注 |
| --- | --- | --- |
| §9 买家旅程 | | |
