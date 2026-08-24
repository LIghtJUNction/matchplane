# ADR 0017: Ordered outbox publication and fenced claims

## Status

Accepted.

## Context

The transactional outbox is delivered at least once through Kafka. The earlier relay claim selected a global `SKIP LOCKED` batch. Two relay replicas could therefore own adjacent records for the same Kafka topic and message key. A retry of the earlier record could let the later shard sequence reach Kafka first. A relay whose 60-second claim had been reclaimed could also complete a newer owner's database transition.

## Decision

- Claim at most the oldest unpublished record for each `(topic, message_key)`.
- Treat pending, failed, and publishing records as head-of-line blockers until they are published. Backoff therefore stalls only the affected key while unrelated keys continue in parallel.
- Assign every claim batch a UUID token. Publication and failure transitions must match both the event ID and current token.
- Continue to use at-least-once publication. A crash between Kafka acknowledgement and the PostgreSQL transition may still create a duplicate, so consumers must retain their inbox/sequence idempotency guards.

## Consequences

- Multiple relay replicas preserve Kafka key order and stale workers cannot overwrite a reclaimed claim.
- Per-key publication is intentionally serialized; aggregate throughput still scales across independent keys.
- A permanently unpublishable head record blocks its key. Operational metrics, alerting, and a durable quarantine workflow remain required follow-up work.
- Public HTTP APIs, Protobuf envelopes, Kafka topic names, and idempotency semantics do not change.
