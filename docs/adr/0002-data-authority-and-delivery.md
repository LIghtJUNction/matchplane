# ADR 0002: Data authority and delivery

- Status: Accepted
- Date: 2026-08-14

## Decision

PostgreSQL is authoritative. Database writes and outgoing messages use a transactional outbox.
PostgreSQL consumers use a unique inbox row in the same transaction as their effect. Kafka is an
at-least-once persistent bus. Valkey stores only derived, sequence-guarded projections.

## Consequences

A relay crash can duplicate publication without duplicating facts. Valkey loss affects latency,
not correctness, and is repaired by replay.
