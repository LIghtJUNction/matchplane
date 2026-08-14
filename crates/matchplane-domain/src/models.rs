use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::{
    Amount, AssetId, AssetSchemaId, DomainId, EmbeddingModelId, FederationNodeId,
    FederationSubscriptionId, LedgerEntryId, MarketId, OrderId, PayloadHash, Price, Quantity,
    ReservationId, Scale, ShardId, TenantId, TradeId,
};

/// A tenant that owns isolated domains and markets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tenant {
    /// Tenant ID.
    pub id: TenantId,
    /// Stable machine-readable tenant key.
    pub slug: String,
    /// Human-readable name.
    pub name: String,
    /// Optimistic-lock version.
    pub version: i64,
}

/// A vertical domain that reuses the generic matching kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Domain {
    /// Domain ID.
    pub id: DomainId,
    /// Owning tenant.
    pub tenant_id: TenantId,
    /// Stable key such as `automotive` or `electronics`.
    pub slug: String,
    /// Human-readable name.
    pub name: String,
    /// Optimistic-lock version.
    pub version: i64,
}

/// A versioned JSON Schema for domain-specific asset attributes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetSchema {
    /// Schema ID.
    pub id: AssetSchemaId,
    /// Owning domain.
    pub domain_id: DomainId,
    /// Monotonic schema version.
    pub version: u32,
    /// JSON Schema document.
    pub schema: Value,
}

/// A tradeable asset with strongly typed common fields and JSONB attributes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    /// Asset ID.
    pub id: AssetId,
    /// Owning tenant.
    pub tenant_id: TenantId,
    /// Vertical domain.
    pub domain_id: DomainId,
    /// Schema used to validate `attributes`.
    pub asset_schema_id: AssetSchemaId,
    /// Stable external or business key.
    pub external_key: String,
    /// Domain-specific attributes.
    pub attributes: Value,
    /// Optimistic-lock version.
    pub version: i64,
}

/// Supported vector distance metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingMetric {
    /// Cosine distance.
    Cosine,
    /// Euclidean L2 distance.
    L2,
    /// Inner-product distance.
    InnerProduct,
}

/// Metadata that uniquely identifies an embedding representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingModel {
    /// Model ID.
    pub id: EmbeddingModelId,
    /// Stable model name supplied by the caller or model provider.
    pub name: String,
    /// Immutable model version.
    pub model_version: String,
    /// Vector dimension.
    pub dimension: u32,
    /// Distance metric.
    pub metric: EmbeddingMetric,
}

/// A market whose order book is one logical shard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Market {
    /// Market ID.
    pub id: MarketId,
    /// Owning tenant.
    pub tenant_id: TenantId,
    /// Vertical domain.
    pub domain_id: DomainId,
    /// Logical shard ID.
    pub shard_id: ShardId,
    /// Stable market symbol.
    pub symbol: String,
    /// Decimal places implied by integer prices.
    pub price_scale: Scale,
    /// Decimal places implied by integer quantities.
    pub quantity_scale: Scale,
    /// Optimistic-lock version.
    pub version: i64,
}

/// Buy or sell side of an order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSide {
    /// Acquires the base asset.
    Buy,
    /// Disposes of the base asset.
    Sell,
}

/// Canonical lifecycle state of an order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    /// Persisted but not yet admitted to the book.
    Pending,
    /// Open with its entire quantity remaining.
    Open,
    /// Open after one or more partial fills.
    PartiallyFilled,
    /// Fully filled.
    Filled,
    /// Cancelled by command.
    Cancelled,
    /// Expired deterministically by command time.
    Expired,
    /// Rejected before book admission.
    Rejected,
}

/// Intent accepted by the deterministic matching engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderIntent {
    /// Caller-assigned order ID.
    pub order_id: OrderId,
    /// Owning tenant.
    pub tenant_id: TenantId,
    /// Vertical domain.
    pub domain_id: DomainId,
    /// Target market.
    pub market_id: MarketId,
    /// Buy or sell side.
    pub side: OrderSide,
    /// Limit price.
    pub price: Price,
    /// Original quantity.
    pub quantity: Quantity,
    /// Producer-provided submission time.
    pub submitted_at: OffsetDateTime,
    /// Optional deterministic expiry time.
    pub expires_at: Option<OffsetDateTime>,
}

/// Canonical current-state order projection in PostgreSQL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Order {
    /// Original intent.
    pub intent: OrderIntent,
    /// Remaining unfilled quantity.
    pub remaining_quantity: Quantity,
    /// Lifecycle state.
    pub status: OrderStatus,
    /// Sequence that establishes FIFO priority.
    pub accepted_sequence: Option<u64>,
    /// Caller idempotency key.
    pub idempotency_key: String,
    /// Hash used to reject reuse of a key with another payload.
    pub idempotency_payload_hash: PayloadHash,
    /// Optimistic-lock version.
    pub version: i64,
}

/// State of an asset or funds reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationStatus {
    /// Created but not yet available for matching.
    Pending,
    /// Capacity is held until expiry.
    Held,
    /// Reservation was committed into settlement.
    Confirmed,
    /// Reservation was explicitly released.
    Aborted,
    /// Reservation expired before confirmation.
    Expired,
}

/// A versioned, expiring reservation used locally and by federation sagas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reservation {
    /// Reservation ID.
    pub id: ReservationId,
    /// Order that owns the reservation.
    pub order_id: OrderId,
    /// Reserved quantity or funds units.
    pub quantity: Quantity,
    /// Reservation state.
    pub status: ReservationStatus,
    /// Saga idempotency key.
    pub idempotency_key: String,
    /// Lease fencing token required for state transitions.
    pub fencing_token: i64,
    /// Expiration instant.
    pub expires_at: OffsetDateTime,
    /// Optimistic-lock version.
    pub version: i64,
}

/// An immutable deterministic trade fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trade {
    /// Trade ID derived from the triggering command.
    pub id: TradeId,
    /// Tenant authority boundary.
    pub tenant_id: TenantId,
    /// Vertical domain.
    pub domain_id: DomainId,
    /// Market where the trade occurred.
    pub market_id: MarketId,
    /// Resting order that set the execution price.
    pub maker_order_id: OrderId,
    /// Incoming order.
    pub taker_order_id: OrderId,
    /// Buy-side order.
    pub buy_order_id: OrderId,
    /// Sell-side order.
    pub sell_order_id: OrderId,
    /// Maker price.
    pub price: Price,
    /// Executed quantity.
    pub quantity: Quantity,
    /// Producer-provided command time.
    pub occurred_at: OffsetDateTime,
}

/// Debit or credit side of a double-entry posting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerEntryKind {
    /// Decreases an account balance.
    Debit,
    /// Increases an account balance.
    Credit,
}

/// One immutable posting in the PostgreSQL ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    /// Posting ID.
    pub id: LedgerEntryId,
    /// Trade that caused the posting.
    pub trade_id: TradeId,
    /// Account business key.
    pub account_key: String,
    /// Debit or credit.
    pub kind: LedgerEntryKind,
    /// Signed exact posting amount.
    pub amount: Amount,
    /// Posting time.
    pub occurred_at: OffsetDateTime,
}

/// Candidate returned by vector retrieval without settlement authority.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchCandidate {
    /// Candidate asset.
    pub asset_id: AssetId,
    /// Model used for scoring.
    pub embedding_model_id: EmbeddingModelId,
    /// Lower distance means greater similarity for supported metrics.
    pub distance: f32,
    /// Node to which a command may be routed.
    pub source_node_id: FederationNodeId,
}

/// Checksum-verified serialized order-book state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderBookSnapshot {
    /// Market captured by the snapshot.
    pub market_id: MarketId,
    /// Logical shard captured by the snapshot.
    pub shard_id: ShardId,
    /// Last applied authoritative event sequence.
    pub last_event_sequence: u64,
    /// Snapshot wire version.
    pub schema_version: u32,
    /// Matching engine compatibility version.
    pub engine_version: String,
    /// Serialized canonical state.
    pub state: Vec<u8>,
    /// SHA-256 digest of `state`.
    pub checksum: PayloadHash,
    /// Snapshot creation time supplied by the service.
    pub created_at: OffsetDateTime,
}

/// A mutually authenticated federation participant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FederationNode {
    /// Node ID.
    pub id: FederationNodeId,
    /// Stable node name.
    pub name: String,
    /// Control-plane gRPC endpoint.
    pub grpc_endpoint: String,
    /// Public signing key material or key reference.
    pub signing_key: String,
    /// Monotonic fencing epoch.
    pub fencing_token: i64,
    /// Negotiated protocol major version.
    pub protocol_major: u32,
    /// Negotiated protocol minor version.
    pub protocol_minor: u32,
    /// Optimistic-lock version.
    pub version: i64,
}

/// A node's subscription to standardized federation facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FederationSubscription {
    /// Subscription ID.
    pub id: FederationSubscriptionId,
    /// Subscriber node.
    pub node_id: FederationNodeId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Optional market scope.
    pub market_id: Option<MarketId>,
    /// Fact stream name.
    pub stream: String,
    /// Optimistic-lock version.
    pub version: i64,
}
