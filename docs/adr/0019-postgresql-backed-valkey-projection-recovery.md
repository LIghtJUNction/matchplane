# ADR 0019: Recover Valkey order-book projections from PostgreSQL

- Status: Accepted
- Date: 2026-08-24

## Context

Valkey stores rebuildable order-book read models. PostgreSQL stores a full `order_book_delta` row in the same transaction that commits each matching command and its outbox message. Every delta is a complete book replacement rather than an incremental patch.

The projector previously accepted only a contiguous sequence. After a Valkey flush, an incoming Kafka record with sequence greater than one was therefore classified as a gap and terminated the process. Restarting replayed the same record and repeated the failure. An idle market also remained unavailable indefinitely because no new record existed to reveal the missing cache entry.

Rewinding Kafka is a poor repair primitive here: retention may be shorter than the required history, replay time grows with topic history, and the durable database already contains a newer complete replacement.

## Decision

1. PostgreSQL `domain_events` rows with `stream_kind = 'order_book_delta'` are the authoritative repair source for the derived Valkey projection.
2. Storage loads the highest sequence for a market and verifies the row sequence, market identity, state-hash encoding, and deterministic Protobuf payload hash before returning it.
3. Valkey exposes an atomic repair operation. It may jump to a newer durable full replacement or replace an incomplete sequence/JSON pair. A complete projection at the same or a newer sequence wins, fencing delayed repairers. Lua compares sequence strings exactly rather than converting them to IEEE-754 numbers.
4. The projector repairs from PostgreSQL when contiguous application reports a gap, then commits the triggering Kafka offset and treats covered later records as duplicates.
5. The authenticated gateway repairs a missing or corrupt market projection on demand. This restores idle markets that receive no post-loss Kafka traffic. If Valkey is transiently unavailable, the endpoint may serve the verified durable projection directly.
6. A partial PostgreSQL index on `(market_id, shard_sequence DESC)` bounds the latest-projection lookup without indexing unrelated event streams.

## Consequences

- Valkey loss no longer requires Kafka rewind or manual cache seeding.
- PostgreSQL remains the source of truth; cache repair never fabricates state from an unverified local value.
- The projector now requires PostgreSQL connectivity, although it queries it only during recovery.
- Concurrent projector and gateway repairs are safe and do not let an older complete projection overwrite a newer one.
- Full replacements make recovery proportional to the current book size rather than retained event history.
- PostgreSQL/Kafka divergence and malformed Kafka-record isolation remain separate reliability concerns; this decision does not hide either condition.
