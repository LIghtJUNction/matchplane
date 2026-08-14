# ADR 0004: Deterministic matching

- Status: Accepted
- Date: 2026-08-14

## Decision

The matching engine is a pure Rust state machine. It receives commands containing all time and ID
inputs and emits domain events. It has no database, broker, cache, network, random-number, or wall
clock dependency. Price and quantity use checked scaled integers.

## Consequences

Identical command streams produce identical events and state hashes. Service adapters own I/O,
leases, persistence, and retries.
