# ADR 0003: Event envelope and shard sequences

- Status: Accepted
- Date: 2026-08-14

## Decision

Every command, event, and federation message carries `event_id`, `correlation_id`,
`causation_id`, `source_node_id`, `tenant_id`, `domain_id`, `market_id`, `shard_id`,
`shard_sequence`, `schema_version`, `occurred_at`, and `payload_hash`.

Sequences are monotonic within `(source_node_id, shard_id, stream_kind)`. Payload hashes are
SHA-256 over deterministic Protobuf payload bytes. Consumers detect duplicate IDs, buffer or reject
gaps, and support replay.
