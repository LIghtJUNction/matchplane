# ADR 0020: Partition-local Kafka poison-record isolation

- Status: Proposed (operator controls and degraded health are required before deployment)
- Date: 2026-08-24

## Context

The matcher and projector consumed Kafka in one process-level loop. A missing payload, malformed
Protobuf envelope, violated protocol invariant, deterministic engine failure, PostgreSQL/Valkey
failure, or synchronous offset-commit failure could terminate the process. Kubernetes or systemd
then restarted the same consumer at the same offset, creating a crash loop that stopped unrelated
partitions as well. Empty records were worse: both consumers committed them without durable audit.

Kafka commands are authoritative delivery of PostgreSQL-admitted work and must never be silently
skipped. Order-book deltas are derived, complete replacements whose canonical copy remains in
PostgreSQL, so the projector may use a narrower terminal policy after rebuilding its state.

## Decision

1. Both consumers validate the Kafka topic, fully qualified Protobuf message type, schema version,
   stream kind, message key, envelope identity, and domain scope before processing. The projector
   also validates exact positive level values, strict price ordering, and the 32-byte state hash.
2. Transient record failures pause only the affected topic-partition. A shared controller schedules
   capped exponential retry with jitter, seeks back to the failed offset, and resumes that partition.
   Other assigned partitions keep making progress. No later offset from the paused partition is
   committed.
3. Permanent failures are written to `kafka_consumer_quarantine`, uniquely keyed by consumer,
   topic, partition, and offset. The row retains presence/truncation metadata and SHA-256 hashes;
   raw key and payload bytes are redacted by default. It also stores classification, a bounded
   secret-free diagnostic, sighting count, and disposition. Reuse of an immutable Kafka offset with
   different bytes is rejected as corruption.
4. Matcher failures default to fail-closed: after durable quarantine the partition remains paused
   and the source offset remains uncommitted. Repairing or discarding an authoritative matching
   command requires a separate explicit operator policy; the runtime never invents one.
5. Projector failures may be terminally reconciled only when a typed envelope yields a market and
   poisoned sequence and PostgreSQL has a verified full projection at that sequence or later. The
   projector then performs monotonic Valkey repair, records `reconciled`, and only then commits the
   poisoned offset. Missing/unparseable identity, no durable projection, or a durable sequence behind
   the poisoned sequence remains blocked and uncommitted. `discarded_non_authoritative` requires a
   future explicit outbox-provenance proof and is never inferred from absence alone.
6. Successful processing commits offsets only after the matching transaction is applied/verified or
   the cache projection is applied/verified. A commit failure is itself retried from the same offset;
   existing inbox and sequence fences make that retry idempotent.

## Consequences

- One poisoned or dependency-failing partition no longer restarts the whole consumer or stalls every
  unrelated partition.
- No authoritative matching command is silently lost. A blocked matcher partition is intentionally
  visible as an incident requiring operator action.
- Projector recovery can make forward progress because its PostgreSQL source is authoritative and
  every book delta is a complete replacement.
- Publishing durable audit before committing an offset can produce repeat sightings after a crash,
  but the unique source coordinates make those repeats idempotent.
- Raw poison bytes are not retained in PostgreSQL by default. Operators see hashes and metadata;
  any future encrypted evidence store requires separate authorization and retention policy. Blocked
  rows never expire automatically. Only explicitly resolved rows receive an expiry timestamp.
- Pauses are process-local. After a rebalance or restart, the same uncommitted record is delivered to
  the new owner and is quarantined or reconciled again; correctness does not depend on in-memory
  pause state.

## Operations

Before deployment, provide an authenticated hash-only list/status view, blocked-partition and lag
metrics, degraded health, and alerts for `quarantine_id`, `partition remains paused`, or repeated
retry attempts. Terminal retry/reconcile/discard requires actor, reason, authority proof, and an
append-only audit. Investigate the exact consumer/topic/partition/offset before any group-offset
change. Apply migrations before deploying either updated consumer.

## Rollback

The migration is additive and old binaries ignore the quarantine table. Rolling back consumers does
not require dropping data or indexes. Do not remove quarantine rows until retention and incident
review are complete.
