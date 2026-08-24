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
