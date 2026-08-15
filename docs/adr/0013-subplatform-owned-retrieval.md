# ADR 0013: Subplatform-owned vector retrieval

## Status

Accepted

## Context

Embedding models, vector dimensions, index tuning, privacy policies, and retrieval infrastructure
change at a different pace for every vertical. Binding the root control plane to one vector
database makes every subplatform pay for an implementation it may not use and turns an internal
optimization into a public compatibility promise.

## Decision

1. A subplatform may own its embedding and vector retrieval implementation. The root contract is
   `matchplane.retrieval/v1`, not pgvector, Qdrant, Milvus, Elasticsearch, a model name, or a
   distance metric.
2. The retrieval boundary transports a scoped request and canonical root asset IDs with bounded
   scores/reasons. It never transports raw vectors or provider credentials.
3. The root remains authoritative for tenant/domain scope, asset state, membership, deterministic
   policy, exposure billing, introductions, contact consent, payment and audit. Retrieval is
   advisory and cannot mutate those states.
4. Provider endpoint and secret references are deployment configuration. A package manifest may
   declare protocol ownership, but it cannot make the root fetch an arbitrary URL.
5. The existing root pgvector worker and `/v1/embeddings` APIs remain a compatibility provider while
   deployments migrate. New subplatforms must not depend on the root's database extension; they
   only depend on the versioned retrieval contract.

## Consequences

- A vertical can choose a local or hosted index and upgrade its embedding model without a root
  migration, provided it keeps the protocol and canonical IDs stable.
- Root deployments can keep a simple PostgreSQL authority and avoid exposing vectors across
  subplatform boundaries.
- Candidate responses must be treated as untrusted suggestions: root rechecks scope and current
  state and records the provider/version with the explanation.
- The compatibility pgvector implementation can be removed after all active subplatforms use the
  protocol and the migration is explicitly versioned.
