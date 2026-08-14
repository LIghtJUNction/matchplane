# ADR 0007: Vector model partitioning

- Status: Accepted
- Date: 2026-08-14

## Decision

Embedding model identity, version, metric, and dimension are explicit. `asset_embeddings` is list
partitioned by dimension. Each supported dimension gets an expression HNSW index cast to its fixed
`vector(n)` type. A composite foreign key prevents model/dimension mismatches.

AI retrieval returns candidates and scores only. It cannot mutate an order, reservation, ledger,
or trade.
