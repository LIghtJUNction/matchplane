# ADR 0021：成交事实与门店客户投影

- 状态：已接受
- 日期：2026-08-24

## 背景

`marketplace-v1` 的 sales handoff 是域范围、无联系方式的快照，`summary` 是有界但不透明的
兼容字段。若 generic 写入直接依赖 Web `stores`、Better Auth `member` 或
`user_notifications`，会破坏 root path 和非店铺客户端，把垂直字段塞进内核，并把可靠性错误
交给浏览器多步编排。

直接联系已有权威动作：demand party 在同一 serializable transaction 中把 generic
introduction 转为 `contact_requested`，并写 allowed contact fact。若浏览器在事务提交后才发
通知，关闭页面或网络失败就会永久丢失通知。

## 决策

1. `marketplace_introduction_contact_events` 是联系请求、同意与释放的权威事实。买家直接申请
   联系时，不再额外创建 sales handoff。
2. `marketplace_sales_handoffs` 只承载尚未请求联系方式交换的 AI 转人工记录；保持 generic、
   domain-neutral 与 v1 opaque-summary 兼容。Application 层要求 demand capability。
3. 数据库 trigger 将新的 contact fact 与 sales handoff 原子追加到
   `marketplace_conversion_outbox`。Outbox 只含权威 ID、event type、tenant、claim 状态和审计
   元数据，不含联系方式、模型摘要或 Web schema。
4. 独立 customer projection/notification consumer 负责 claim outbox，解析 canonical
   introduction／offer／store 权威，并幂等投影稳定 store customer、单次 opportunity、可操作
   站内通知，以及后续外部通知 job。
5. retry、recipient resolution、deep link 和状态同步由 projector 负责，不由浏览器负责。
   联系通知深链权威 introduction；AI handoff 通知只能指向 opportunity，不能暗示已同意联系。
6. migration 不回填、不通知历史行。未来 replay 必须先 dry-run，以有界资格规则筛选，经运营
   审批，并写 append-only audit。

## 影响

- 每个已提交 `contact_requested` 都有 durable projection job，消除“联系成功但通知丢失”的
  浏览器窗口。
- Generic MCP、root `/` 与非汽车 handoff 客户端保持 v1 opaque contract。
- 独立 projector 部署前，通知交付尚未完成；outbox backlog 必须显示 degraded health，不能
  静默宣称成功。
- Consumer 按 `(source_type, source_id)` 去重，且绝不能把不可信 summary 当作指令或联系方式。

## 回滚

Outbox 表与 trigger 都是增量结构。移除 trigger 只会停止新增 projection job，不改变权威
introduction 或 handoff。已存在 pending 行仍须保留审计，不得静默删除。
