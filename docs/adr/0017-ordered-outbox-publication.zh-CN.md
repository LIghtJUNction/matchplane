# ADR 0017：有序 Outbox 发布与带围栏的认领

## 状态

已接受。

## 背景

事务性 Outbox 通过 Kafka 提供至少一次交付。此前 relay 使用全局 `SKIP LOCKED` 批量认领；两个 relay 副本可能同时持有同一 Kafka topic 与 message key 的相邻记录。较早记录重试时，较后的分片序列可能先到达 Kafka。超过 60 秒的旧认领被回收后，旧 relay 也可能覆盖新持有者的数据库状态转换。

## 决策

- 每次只认领各 `(topic, message_key)` 最早的一条未发布记录。
- pending、failed 和 publishing 状态在发布完成前都阻塞同一 key 的后续记录。退避只暂停受影响的 key，其他 key 仍可并行处理。
- 每批认领生成 UUID token；发布成功或失败转换必须同时匹配 event ID 和当前 token。
- 继续采用至少一次发布。Kafka 已确认但 PostgreSQL 尚未更新时发生崩溃，仍可能产生重复消息，因此消费者必须保留 inbox 与序列幂等保护。

## 影响

- 多个 relay 副本可以保持 Kafka key 顺序，旧 worker 不能覆盖已被回收的认领。
- 单个 key 的发布被有意串行化；不同 key 仍可并行扩展整体吞吐量。
- 永久无法发布的头部记录会阻塞该 key，后续仍需补充指标、告警和持久化隔离流程。
- 公共 HTTP API、Protobuf envelope、Kafka topic 名称和幂等语义均不变。
