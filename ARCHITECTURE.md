# MatchPlane architecture

## Authority and consistency

PostgreSQL is the final source of truth. Every externally visible command is first persisted with
its idempotency record and transactional outbox row. Kafka publication is at-least-once; consumers
guard PostgreSQL effects with `consumer_inbox` and guard Valkey projections with an atomic stream
sequence. No correctness property relies on a cache lock or Kafka exactly-once mode.

Each market is a logical order-book shard. Kafka keys commands by `market_id`, while a PostgreSQL
lease with a monotonically increasing fencing token prevents a stale matcher from writing. The
matcher runs a single-threaded event loop per owned shard and invokes the pure
`matchplane-engine` state transition library.

## Data flow

```text
Client -> Gateway -> PostgreSQL(order + outbox)
                         |
                    Event relay -> Kafka command partition
                                      |
                                  Matcher -> deterministic engine
                                      |
                         PostgreSQL(inbox + facts + outbox)
                                      |
                    Event relay -> Kafka facts -> Projector -> Valkey
```

The relational current state and append-only `domain_events` are committed together. A matcher
restores the most recent checksum-verified snapshot, then replays the PostgreSQL event log. Valkey
is rebuilt from facts whenever its sequence has a gap.

## Marketplace, negotiation, and revenue flow

Seller listings and buyer requests are vertical adapters around the same domain-neutral concepts:
the demand/supply participant, a structured intent, an explainable introduction, and a consented
contact exchange. The low-level participant identity is identical on both sides; “buyer” and
“seller” are automotive labels, not separate account implementations. A future dating or services
vertical can reuse the same primitives and replace only its schema, ranking features, copy, and
safety policy.

Explainable matching creates an `offline_deal`; seller exposure events measure the path from
impression to inquiry and contact consent. Contacts and viewing locations are encrypted at the HTTP
boundary, and every contact decision is audited. The seller must accept a contact request before
either party can retrieve the other party's allow-listed phone/WeChat details.

Retrieval is a subplatform adapter behind the versioned `matchplane.retrieval/v1` boundary. The
root receives canonical asset IDs, bounded scores, provider/model versions, and reasons; it does
not require a vector database or exchange raw vectors. The current pgvector worker is only a
compatibility provider for existing deployments. Root policy still validates scope, current asset
state, exposure billing, introductions, contact consent, and settlement.

Agent routing is likewise a platform-owned control-plane operation. The root chooses only from
authorized direct children, invokes the configured provider with a bounded multi-step budget, and
records `cost_bearer = platform` plus provider usage in `platform_ai_usage`. Provider keys remain
server-side; buyers, sellers, and mounted subplatforms never receive a token bill or a browser
credential. Skills and MCP tools are subplatform-owned extension points behind the stable
`matchplane.agent/v1` envelope, not an excuse to bypass authorization or spend without a budget.

For `offline_direct`, buyer and seller settle the vehicle price with each other. The isolated payment
service is optional. The primary off-platform revenue policy is seller-funded promotion: fixed,
impression, click, or qualified-lead campaigns are charged while the offer is being promoted, so
the platform does not need to observe a later WeChat/telephone transaction. A tenant may also opt
into a disclosed transaction fee or a hybrid policy. Online order-book trades use the market-owned
fee rate only when that policy is enabled; the ledger debits the buyer's gross amount, credits the
seller's net amount, and credits the platform commission account in a separate posting. Trade facts
expose all four values rather than embedding a hidden spread.

Payment gateway configuration is data-driven but credentials remain outside PostgreSQL. Test and
production routing are independent, mode switches are versioned and audited, and unresolved old-mode
payments block a switch. Refunds reserve aggregate refundable capacity transactionally. Issued
invoices are immutable; refunds create correction requests and encrypted red-letter artifacts.

## Federation

Node A owns automotive data, node B owns electronics data, and node C is a federation hub. A and B
publish standardized book deltas, summaries, and health facts. C maintains rebuildable aggregate
views and routes AI candidates back to their source node. Cross-node settlement uses an expiring,
idempotent `reserve -> confirm/abort` saga; each source node retains final commit authority.

Control-plane RPC uses gRPC with protocol negotiation and mTLS hooks. Kafka carries order-book and
domain facts. Every envelope contains the mandatory identity, lineage, shard, version, timestamp,
and payload hash fields described in ADR 0003.

## Deployment

A, B, and C should run in independent Kubernetes failure domains. Stateless APIs and workers use
Deployments; matchers use StatefulSets for stable process identity; databases and Kafka are
operator-managed in production. The Helm chart accepts external PostgreSQL, Kafka, and Valkey
endpoints. Local Compose provides a single-node KRaft Kafka, Valkey, and a reproducible PostgreSQL
image containing both TimescaleDB and pgvector.
