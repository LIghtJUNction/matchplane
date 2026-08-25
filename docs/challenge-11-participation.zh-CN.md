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
- 新增 **卖车店铺演示引导**：`tools/demo/bootstrap-car-shop-demo.sh` 一条命令种入
  托管店铺「星辰二手车行」（slug `demo-car-shop`）与 6 辆可公开浏览的在售车
  （幂等、仅限开发档，遵循 `tests/integration/fixture.sql` 的显式数据边界）
- 新增 **评审演示脚本** [docs/challenge-11-demo-script.zh-CN.md](challenge-11-demo-script.zh-CN.md)，
  按验收点逐步给出可点击路径
- 导购 Agent 系统提示明确：模糊购买意向先用 `ask_user` 问 **预算档位**，下一轮问 **主要用途**，
  条件足够立即通过 `search_public_products` 检索并默认 `show_products` 展示商品卡
- 首页对话快捷示例改为卖车场景（「预算 15 万以内，帮我找一台家用 SUV」），与首页需求入口一致
- **登录页跟随部署能力**：配置短信网关后自动出现「验证码」标签页并支持手机号登录；
  配置邮件后出现「免密链接」；未配置时输入框不再提示手机号，密码框输错手机号会指引正确方式
- **商城设置新增「登录方式」面板**：实时检测微信 / 手机 / 邮箱等登录方式的启用状态，
  未配置的方式直接列出所需环境变量清单（见第 7 节），支持「重新检测」
- **联系交换闭环打磨**（同意卡 + 账号绑定）：
  - 同意卡「前往账号绑定」原来跳到无效参数的首页，现在 **原地打开账号绑定弹窗**，
    聊天上下文不丢失；绑定完成后点「我已完成绑定，重新检测」即可继续同意流程
  - 未登录时同意卡直接给「前往登录」（带返回地址），不再显示无效的「重试」
  - 账号绑定面板支持 **邮箱验证码验证**：邮箱未验证时一键发送 6 位验证码完成验证，
    验证后才能进入联系交换（此前未验证邮箱在面板中无任何操作入口）
  - 绑定手机号时验证码已发送后可 **「换个手机号」** 重新输入（此前输错号码会卡死表单）

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
8. **双方同意后的互相披露**：店员在 **店铺工作台 → 联系申请** 点「同意交换」后，
   双方各自读取对方的已验证联系方式——店员在同一列表点「查看对方联系方式」；
   买家回到店铺页，在 **「联系申请」** 面板点「查看对方联系方式」（店员未同意前显示「等待店员同意」）。

审计佐证：每轮回复的 `toolCalls` 已写入 `platform_ai_usage` / `platform_match_requests`
（`routing_decision.toolCalls`），可在数据库中当场证明「工具检索而非 RAG」。

## 7. 微信 / 手机登录配置清单（商城运营）

登录方式的凭据只存在服务器环境变量中，不入库、不进浏览器。配置状态可在
**商城后台 → 商城设置 → 登录方式** 面板实时查看；未配置的方式会在面板中列出下面的清单。

### 7.1 微信登录（可选）

| 环境变量 | 说明 |
| --- | --- |
| `MATCHPLANE_WECHAT_OAUTH_CLIENT_ID` | 微信开放平台 AppID |
| `MATCHPLANE_WECHAT_OAUTH_CLIENT_SECRET` | 微信开放平台 AppSecret |
| `MATCHPLANE_WECHAT_OAUTH_AUTHORIZATION_URL` | 授权地址（与下两项同时填写） |
| `MATCHPLANE_WECHAT_OAUTH_TOKEN_URL` | 令牌地址 |
| `MATCHPLANE_WECHAT_OAUTH_USERINFO_URL` | 用户信息地址 |
| `MATCHPLANE_WECHAT_OAUTH_DISCOVERY_URL` | 支持 OIDC 的网关可只填这一项，替代上面三个地址 |
| `MATCHPLANE_WECHAT_OAUTH_SCOPES` | 可选，逗号分隔，默认 `openid,profile,email` |

要求：Client ID、Client Secret 与完整的端点契约（discovery 或三个地址）缺一不可，
配置不完整时服务器只记录告警、登录页不显示微信按钮。生产环境地址必须是 HTTPS。
微信账号通常没有已验证邮箱，因此只会通过账号页的 **显式绑定** 关联到已有账号，
不会按邮箱隐式合并（防止账号被劫持）。

### 7.2 手机号验证码登录（可选）

| 环境变量 | 说明 |
| --- | --- |
| `MATCHPLANE_SMS_PROVIDER_URL` | HTTPS 短信网关地址；服务器向它 `POST { phoneNumber, code, purpose }` |
| `MATCHPLANE_SMS_PROVIDER_TOKEN` | 可选，作为 `Bearer` token 随请求发送 |

验证码由认证服务生成并散列存储（6 位、5 分钟有效、最多 3 次尝试），短信网关只负责发送。
注册仍以邮箱为主；手机验证码是已有账号的登录方式。

### 7.3 邮箱验证码 / 免密链接

不需要环境变量：在 **商城设置 → 账号邮件** 中配置 SMTP 并启用后自动开启。

### 7.4 生效与验证

1. 修改环境变量后重启 Web 服务（登录页能力接口最多缓存 60 秒）。
2. 商城后台 → 商城设置 → 登录方式，点「重新检测」，确认目标方式显示 **已启用**。
3. 退出登录后打开登录页：配置微信后「其他方式」出现微信按钮；配置短信后出现
   「验证码」标签页，输入框提示「邮箱或手机号」。
