# ADR 0020：Kafka 毒消息按分区隔离

- 状态：提议中（部署前必须补齐运维控制与 degraded health）
- 日期：2026-08-24

## 背景

Matcher 与 Projector 原先都在单一进程循环中消费 Kafka。空 payload、损坏的 Protobuf
Envelope、协议约束冲突、确定性引擎错误、PostgreSQL／Valkey 故障或同步提交 offset 失败，
都会终止整个进程。Kubernetes 或 systemd 随后从同一 offset 重启，形成 crash loop，并连带
停止其他正常分区。更严重的是，旧实现会直接提交空消息，且没有持久审计。

Kafka command 是 PostgreSQL 已受理工作的权威交付，绝不能静默跳过。Order-book delta 则是
完整的派生替换快照，权威副本仍在 PostgreSQL，因此 Projector 可以在完成重建后采用更窄的
终止策略。

## 决策

1. 两个消费者都必须校验 Kafka topic、完整 Protobuf message type、schema version、stream
   kind、message key、Envelope 身份与业务域。Projector 还校验价格档位为规范的正整数、
   严格排序，以及 32 字节 state hash。
2. 瞬时错误只暂停对应的 topic-partition。共享控制器使用带抖动的封顶指数退避，随后 seek
   回失败 offset 并恢复该分区；其他分区继续处理。暂停分区的后续 offset 不得提交。
3. 永久错误写入 `kafka_consumer_quarantine`。记录以 consumer、topic、partition、offset
   唯一标识；默认只保存 key／payload 的存在/截断元数据与 SHA-256，不保存原始字节，同时保存
   分类、经过长度限制且不含秘密的错误、出现次数与处理结论。同一不可变 Kafka offset 若出现
   不同字节，视为数据损坏并拒绝覆盖。
4. Matcher 默认 fail-closed：持久隔离后保持分区暂停，且不提交源 offset。修复或丢弃权威
   matching command 必须经过单独、明确的运维策略；运行时不会自行编造跳过策略。
5. Projector 只有在 typed envelope 能给出 market 与 poisoned sequence，且 PostgreSQL
   verified full projection 的 sequence 大于等于该值时，才能执行终止性重建并记录
   `reconciled` 后提交 offset。身份不可解析、无 durable projection、或 durable sequence 落后时
   均保持阻塞且不提交。`discarded_non_authoritative` 必须由未来显式 outbox provenance 证明，
   绝不能仅因“查不到”而推断。
6. 正常消息只在 matching transaction 已应用／验证，或缓存投影已应用／验证后提交 offset。
   offset 提交失败时从同一位置重试；Consumer Inbox 与 sequence fence 保证幂等。

## 影响

- 单个毒消息或依赖故障不再重启整个消费者，也不会阻塞无关分区。
- 权威 matching command 不会静默丢失。Matcher 分区被阻塞是一项需要运维处理的显式事故。
- Projector 可利用 PostgreSQL 权威来源恢复，因为每个 book delta 都是完整替换。
- 在提交 offset 前写审计，崩溃后可能增加重复 sighting；唯一源坐标使其保持幂等。
- PostgreSQL 默认不保留 poison 原始字节，Operator 仅查看 hash 与元数据；未来若增加加密证据
  存储，必须单独鉴权和留存策略。Blocked 行不自动过期，只有显式终态才设置 expires_at。
- 分区暂停状态只存在于当前进程。发生 rebalance 或重启后，新 owner 会再次收到未提交记录，
  并再次隔离或重建；正确性不依赖内存状态。

## 运维

部署前必须提供受鉴权的 hash-only list/status、blocked partition/lag 指标、degraded health，
并对 `quarantine_id`、`partition remains paused` 或持续 retry attempt 告警。终态
retry/reconcile/discard 必须记录 actor、reason、authority proof 与 append-only audit。任何手工
调整 consumer group offset 前，先核对 consumer／topic／partition／offset；部署前执行迁移。

## 回滚

迁移只增加表和索引，旧二进制会忽略隔离表。回滚消费者无需删除数据或索引。在留存期结束且
事故复盘完成前，不得删除隔离记录。
