use matchplane_domain::{
    AccountId, AssetId, CorrelationId, DomainId, EmbeddingModelId, EventId, FederationNodeId,
    MarketId, OrderId, OrderIntent, OrderSide, OrderStatus, PayloadHash, Quantity, ShardId,
    TenantId, TradeId,
};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

/// Validated order data submitted to the authoritative transaction boundary.
#[derive(Debug, Clone)]
pub struct SubmitOrder {
    /// Pure matching intent.
    pub intent: OrderIntent,
    /// Required caller idempotency key.
    pub idempotency_key: String,
    /// Account from which capacity will be held by the matcher.
    pub reservation_account_id: AccountId,
    /// Account credited in the other traded asset.
    pub settlement_account_id: AccountId,
    /// Exact reservation amount: `price * quantity` for buys, quantity for sells.
    pub reservation_amount: Quantity,
    /// Node accepting the command.
    pub source_node_id: FederationNodeId,
    /// End-to-end correlation ID.
    pub correlation_id: CorrelationId,
}

/// Result of idempotent order acceptance.
#[derive(Debug, Clone, Serialize)]
pub struct SubmitOrderOutcome {
    /// Stable order identifier.
    pub order_id: OrderId,
    /// Durable command event ID.
    pub command_id: EventId,
    /// Market shard command sequence.
    pub shard_sequence: u64,
    /// `true` when an identical prior request was returned.
    pub duplicate: bool,
}

/// PostgreSQL-authoritative order projection returned by the API.
#[derive(Debug, Clone, Serialize)]
pub struct StoredOrder {
    /// Order ID.
    pub order_id: OrderId,
    /// Tenant boundary.
    pub tenant_id: TenantId,
    /// Domain boundary.
    pub domain_id: DomainId,
    /// Market ID.
    pub market_id: MarketId,
    /// Buy or sell.
    pub side: OrderSide,
    /// Exact integer price encoded as text for JSON clients.
    pub price: String,
    /// Exact original quantity encoded as text.
    pub original_quantity: String,
    /// Quantity already filled by authoritative trades.
    pub filled_quantity: String,
    /// Exact remaining quantity encoded as text.
    pub remaining_quantity: String,
    /// Remaining quantity protected by confirmed or live federation Sagas.
    pub federated_reserved_quantity: String,
    /// Quantity that can still be matched locally without violating federation holds.
    pub locally_available_quantity: String,
    /// Lifecycle state.
    pub status: OrderStatus,
    /// FIFO priority position when admitted.
    pub accepted_sequence: Option<u64>,
    /// Caller idempotency key.
    pub idempotency_key: String,
    /// Submission time.
    #[serde(with = "time::serde::rfc3339")]
    pub submitted_at: OffsetDateTime,
}

/// PostgreSQL-authoritative balance shown to a buyer or seller.
#[derive(Debug, Clone, Serialize)]
pub struct StoredAccount {
    /// Account ID.
    pub account_id: AccountId,
    /// Tenant boundary.
    pub tenant_id: TenantId,
    /// Business-facing owner key.
    pub owner_key: String,
    /// Asset or currency held by this account.
    pub asset_key: String,
    /// Immediately available exact amount.
    pub available_amount: String,
    /// Exact amount protected for pending or open orders.
    pub reserved_amount: String,
    /// Optimistic state version.
    pub version: i64,
}

/// PostgreSQL-authoritative immutable trade fact.
#[derive(Debug, Clone, Serialize)]
pub struct StoredTrade {
    /// Trade ID.
    pub trade_id: TradeId,
    /// Maker order.
    pub maker_order_id: OrderId,
    /// Taker order.
    pub taker_order_id: OrderId,
    /// Buy order.
    pub buy_order_id: OrderId,
    /// Sell order.
    pub sell_order_id: OrderId,
    /// Exact integer execution price.
    pub price: String,
    /// Exact integer execution quantity.
    pub quantity: String,
    /// Exact buyer-paid quote amount.
    pub gross_amount: String,
    /// Disclosed platform commission rate in basis points.
    pub commission_bps: i32,
    /// Exact amount credited to the platform account.
    pub commission_amount: String,
    /// Exact amount credited to the seller after commission.
    pub seller_net_amount: String,
    /// Deterministic event time.
    #[serde(with = "time::serde::rfc3339")]
    pub occurred_at: OffsetDateTime,
}

/// One row claimed from the transactional outbox.
#[derive(Debug, Clone)]
pub struct OutboxMessage {
    /// Event identity.
    pub event_id: EventId,
    /// Kafka topic.
    pub topic: String,
    /// Kafka partitioning key.
    pub message_key: String,
    /// Monotonic sequence within the message stream.
    pub shard_sequence: u64,
    /// Complete Protobuf envelope bytes.
    pub payload: Vec<u8>,
    /// Number of publication attempts including this claim.
    pub attempts: i32,
    /// Fences acknowledgements from workers whose stale claim was reclaimed.
    pub claim_token: Uuid,
}

/// Result of committing a consumed command and its deterministic events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchCommitOutcome {
    /// The command and all derived state were atomically persisted.
    Applied,
    /// The consumer inbox proves this exact event was already applied.
    Duplicate,
}

/// One exact aggregate level in a PostgreSQL-authoritative order-book projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookProjectionLevel {
    /// Exact integer price text.
    pub price: String,
    /// Exact integer aggregate quantity text.
    pub quantity: String,
}

/// Latest PostgreSQL-authoritative full order-book projection used to repair derived caches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookProjection {
    /// Market whose full book is represented.
    pub market_id: MarketId,
    /// Last applied market command sequence.
    pub sequence: u64,
    /// Aggregate bids in highest-price-first order.
    pub bids: Vec<BookProjectionLevel>,
    /// Aggregate asks in lowest-price-first order.
    pub asks: Vec<BookProjectionLevel>,
    /// Matching-engine state checksum.
    pub state_hash: PayloadHash,
}

/// Latest checksum-protected order-book snapshot and its replay position.
#[derive(Debug, Clone)]
pub struct BookSnapshot {
    /// Last persisted domain-event sequence.
    pub last_event_sequence: u64,
    /// Canonical engine bytes.
    pub state: Vec<u8>,
    /// Expected SHA-256 hash.
    pub checksum: PayloadHash,
}

/// Caller-provided embedding ready for pgvector persistence.
#[derive(Debug, Clone)]
pub struct VectorRecord {
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Asset being represented.
    pub asset_id: AssetId,
    /// Versioned embedding model.
    pub embedding_model_id: EmbeddingModelId,
    /// Actual model output; MatchPlane does not fabricate embeddings.
    pub values: Vec<f32>,
}

/// One pgvector nearest-neighbour result.
#[derive(Debug, Clone, Serialize)]
pub struct CandidateMatch {
    /// Candidate asset.
    pub asset_id: AssetId,
    /// Model used for retrieval.
    pub embedding_model_id: EmbeddingModelId,
    /// Distance under the model's configured metric.
    pub distance: f64,
    /// Authority node to which a deterministic command may be routed.
    pub source_node_id: FederationNodeId,
}

/// Validated source-authority request for an expiring cross-node reservation.
#[derive(Debug, Clone)]
pub struct ReserveFederated {
    /// Remote node requesting capacity.
    pub source_node_id: FederationNodeId,
    /// Tenant boundary.
    pub tenant_id: TenantId,
    /// Domain boundary.
    pub domain_id: DomainId,
    /// Source-owned market.
    pub market_id: MarketId,
    /// Source-owned order.
    pub order_id: OrderId,
    /// Exact quantity held from local matching.
    pub quantity: Quantity,
    /// Saga idempotency key.
    pub idempotency_key: String,
    /// Digest of the canonical reservation request.
    pub request_hash: PayloadHash,
    /// Monotonic caller fencing token.
    pub fencing_token: i64,
    /// Anti-replay nonce.
    pub nonce: String,
    /// Hard reservation expiration.
    pub expires_at: OffsetDateTime,
}

/// PostgreSQL-owned state of a federation reservation.
#[derive(Debug, Clone)]
pub struct FederationReservation {
    /// Reservation ID.
    pub reservation_id: matchplane_domain::ReservationId,
    /// Current state.
    pub status: String,
    /// Optimistic state version.
    pub version: i64,
    /// Fencing token accepted by the source authority.
    pub fencing_token: i64,
    /// Hard expiration.
    pub expires_at: OffsetDateTime,
}

/// Compare-and-swap transition requested by `confirm` or `abort`.
#[derive(Debug, Clone)]
pub struct FederationTransition {
    /// Authenticated federation node requesting the transition.
    pub source_node_id: FederationNodeId,
    /// Reservation ID.
    pub reservation_id: matchplane_domain::ReservationId,
    /// Original saga idempotency key.
    pub idempotency_key: String,
    /// Version observed by the caller.
    pub expected_version: i64,
    /// Fencing token returned by reserve.
    pub fencing_token: i64,
    /// Anti-replay nonce for this transition request.
    pub nonce: String,
}

/// Metadata needed to build an event envelope for a market shard.
#[derive(Debug, Clone)]
pub(crate) struct MarketContext {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub market_id: MarketId,
    pub shard_id: ShardId,
    pub base_asset_key: String,
    pub quote_asset_key: String,
}
