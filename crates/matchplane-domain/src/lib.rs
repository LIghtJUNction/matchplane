//! Infrastructure-independent domain types for MatchPlane.
//!
//! This crate contains identifiers, exact numeric values, core entities, matching commands, and
//! matching events. It deliberately contains no database, broker, cache, network, or wall-clock
//! access.

mod envelope;
mod ids;
mod matching;
mod models;
mod numeric;

pub use envelope::{EventEnvelope, PayloadHash, StreamKind};
pub use ids::{
    AccountId, AssetId, AssetSchemaId, BuyerRequestId, CausationId, CorrelationId, DomainId,
    EmbeddingModelId, EventId, FederationNodeId, FederationSubscriptionId, InvoiceId,
    LedgerEntryId, MarketId, MarketplacePartyId, OfflineDealId, OrderId, PaymentGatewayId,
    PaymentId, RefundId, ReservationId, ShardId, TenantId, TradeId, VehicleListingId,
    ViewingAppointmentId,
};
pub use matching::{EngineCommand, EngineCommandKind, EngineEvent, MatchingEvent};
pub use models::{
    Asset, AssetSchema, Domain, EmbeddingMetric, EmbeddingModel, FederationNode,
    FederationSubscription, LedgerEntry, LedgerEntryKind, Market, MatchCandidate, Order,
    OrderBookSnapshot, OrderIntent, OrderSide, OrderStatus, Reservation, ReservationStatus, Tenant,
    Trade,
};
pub use numeric::{Amount, NumericError, Price, Quantity, Scale};
