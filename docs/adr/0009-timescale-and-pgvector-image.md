# ADR 0009: TimescaleDB and pgvector image

- Status: Accepted
- Date: 2026-08-14

## Decision

Local development builds an explicit PostgreSQL image with pinned TimescaleDB and pgvector
components and verifies both extensions at startup. Canonical event and ledger tables remain normal
PostgreSQL tables so global unique IDs remain enforceable. Timescale hypertables hold rebuildable
market observations whose unique indexes include the time partition column.
