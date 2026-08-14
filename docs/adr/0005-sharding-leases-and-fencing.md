# ADR 0005: Market sharding, leases, and fencing

- Status: Accepted
- Date: 2026-08-14

## Decision

`market_id` identifies a logical shard. A persisted route assigns its Kafka partition and routing
epoch. Kafka group ownership is the normal coordinator, but every authoritative matcher write also
checks a PostgreSQL lease and monotonically increasing fencing token.

## Recovery

Rebalancing pauses input, records a checkpoint, and transfers ownership. A new writer acquires a
higher token, loads a checksum-verified snapshot, and replays `domain_events`. Stale tokens cannot
commit.
