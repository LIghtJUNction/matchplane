# ADR 0003：事件信封和分片序列

- 状态：已接受
- 日期：2026-08-14

## 决定

每个命令、事件和联合消息都携带`event_id`、`correlation_id`、
`causation_id`、`source_node_id`、`tenant_id`、`domain_id`、`market_id`、`shard_id`、
`shard_sequence`、`schema_version`、`occurred_at` 和 `payload_hash`。

`(source_node_id, shard_id, stream_kind)` 内的序列是单调的。有效负载哈希是
基于确定性 Protobuf 有效负载字节的 SHA-256。消费者检测到重复的ID，缓冲或拒绝
间隙，并支持重播。
