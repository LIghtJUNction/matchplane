# 挑战 #11 参与指南

> 平台链接：https://api.lmm.best/challenges/11  
> 仓库：https://github.com/LIghtJUNction/matchplane  
> 发布者邮箱：lightjunction.me@gmail.com

## 1. 在平台接受挑战

1. 登录 https://api.lmm.best（需要 **L1 开发者权限** 才能接受挑战）。
2. 打开 https://api.lmm.best/challenges/11 。
3. 点击 **接受挑战**，填写你的 **GitHub 用户名**（不含 `@`）。
4. 当前仅剩 **1 个名额**（5 人中已有 4 人接受）。

接受后，务必邮件联系发布者说明你的方案方向与 GitHub 账号。

## 2. 与发布者对接（必做）

挑战规则要求：**务必联系发布者，交流设计细节，展示成果。**

建议邮件主题：

```text
[MatchPlane 挑战 #11] 参与确认 — <你的 GitHub 用户名>
```

正文建议包含：

- 你接受的挑战编号与 GitHub 用户名
- 方案简述（产品优先、工具检索、联系方式交换、卖车店铺场景）
- 预计演示方式（本地 / 测试环境 URL）
- 方便沟通的时间

## 3. 本地开发与验收

```sh
# 依赖：Bun、Rust、PostgreSQL（见 README.zh-CN.md）
cd matchplane
matchplane doctor --json
matchplane initialize
matchplane serve web
matchplane serve gateway
```

关键验收路径（需亲自点击验证）：

1. **浏览商品**：首页先看真实商品卡片，可点赞
2. **自然语言选货**：首页输入需求（如「预算 15 万以内的 SUV」）→ 打开选货员 → 通过工具检索商品（非 RAG）
3. **店铺页**：进入卖车店铺，浏览车辆详情
4. **联系方式交换**：双方账号绑定已验证邮箱/手机 → 双方同意后交换（不能手填联系方式）
5. **商城设置**：平台负责人配置 AI 网关、可选微信/手机登录

## 4. 提交与评审

- 在 `LIghtJUNction/matchplane` 提交 PR，聚焦挑战目标
- 在平台提交 Issue / PR 链接作为交付证据
- 发布者 **人工验收**，5 选 1 发 $500 余额，其余安慰奖
- 评审强调：**去 AI 味**、简洁易用、真实可点、工具检索而非 RAG

## 5. 本分支改动说明

`cursor/challenge-11-participation-897f`：

- 商城首页增加 **自然语言需求入口**（「帮我找」），商品仍居首屏，选货员为辅助
- 输入内容预填到选货员对话框，降低发现成本，符合「直接用自然语言描述需求」
- 导购 Agent 系统提示明确：模糊购买意向先用 `ask_user` 问 **预算档位**，下一轮问 **主要用途**，
  条件足够立即通过 `search_public_products` 检索并默认 `show_products` 展示商品卡
- 首页对话快捷示例改为卖车场景（「预算 15 万以内，帮我找一台家用 SUV」），与首页需求入口一致

## 6. 赞助商演示脚本（卖车店铺）

> 前提：AI 网关已在商城设置中配置；卖车店铺已上架若干车辆（含 `year`、`mileage` 等公开字段）。
> 全程零 RAG：检索由模型多轮 **工具调用** 完成（`search_public_products` 是确定性的
> PostgreSQL 全文检索，`show_products` 只允许展示真实检索结果中的 productId）。

1. **首页**：展示真实车辆卡片可浏览、可点赞；在「帮我找」输入框输入 **「我想买辆车」** 并发送。
2. **AI 主动提问（第 1 轮）**：选货员调用 `ask_user`，聊天中出现 **预算档位** 的可点击选项
   （非纯文字反问）。点选「15 万以内」。
3. **AI 主动提问（第 2 轮）**：Agent 继续调用 `ask_user` 询问 **主要用途**（家用通勤 / 越野 / 商务接待）。
   点选「家用通勤」。
4. **工具检索并出卡**：Agent 调用 `search_public_products`（预算、用途进入结构化检索参数），
   再调用 `show_products`，聊天中直接出现 1–6 张真实车辆卡片，正文逐条解释匹配理由。
5. **多轮跟进**：输入 **「对比前两台，再算下总价」**，Agent 依次调用
   `compare_products → show_product_comparison → calculate_total → show_price_summary`；
   若模型跳过工具直接口播，服务端会拒绝该回答（防编造）。
6. **进店**：点开车辆卡进入卖车店铺；店铺页内是同一 Agent 的 **AI 店长** 形态，只谈本店真实车辆。
7. **人工与联系方式**：说 **「请店员联系我确认看车时间」** → 触发 `request_human_handoff`
   店员通知卡；联系方式只能经 `request_contact_consent` 的双方同意卡交换，AI 与店员都不能代答，
   聊天中也不允许手填联系方式。

审计佐证：每轮回复的 `toolCalls` 已写入 `platform_ai_usage` / `platform_match_requests`
（`routing_decision.toolCalls`），可在数据库中当场证明「工具检索而非 RAG」。
