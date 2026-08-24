//! PostgreSQL repositories, migrations, transactional outbox, and consumer inbox primitives.

mod book_projection;
mod catalog_projection;
mod consumer_failure;
mod conversion_projection;
mod conversion_recovery;
mod federation;
mod generic_marketplace;
mod marketplace;
mod matching;
mod orders;
mod outbox;
mod platform;
mod subplatform;
mod types;
mod vectors;

use sqlx::{PgPool, postgres::PgPoolOptions};
use thiserror::Error;

pub use catalog_projection::{
    CatalogProjectionCounts, CatalogProjectionProblem, CatalogProjectionReplayOutcome,
    CatalogProjectionStatus,
};
pub use consumer_failure::{
    KafkaFailureClass, KafkaFailureDisposition, QuarantineKafkaRecord, QuarantinedKafkaRecord,
};
pub use conversion_projection::{
    MarketplaceConversionBacklog, MarketplaceConversionClaimBatch,
    MarketplaceConversionFailureDisposition, MarketplaceConversionFailureOutcome,
    MarketplaceConversionJob, MarketplaceConversionProjectionOutcome,
    MarketplaceConversionRecoveryAction, MarketplaceConversionRecoveryOutcome,
};
pub use conversion_recovery::VerifiedHostOperator;
pub use generic_marketplace::{
    AcceptMarketplaceContact, CreateMarketplaceIntent, CreateMarketplaceIntroduction,
    CreateMarketplaceOffer, CreateMarketplaceSalesHandoff, MarketplaceBehaviorEventOutcome,
    MarketplaceContactEnvelope, MarketplaceDemandCandidate, MarketplaceIntent,
    MarketplaceIntentOutcome, MarketplaceIntentProfile, MarketplaceIntroduction,
    MarketplaceIntroductionOutcome, MarketplaceOffer, MarketplaceOfferCandidate,
    MarketplaceOfferOutcome, MarketplaceOfferPreference, MarketplaceSalesHandoff,
    MatchMarketplaceDemands, MatchMarketplaceOffers, RecordMarketplaceBehaviorEvent,
    RequestMarketplaceContact, SetMarketplaceOfferPreference, UpdateMarketplaceDemandDiscovery,
    UpdateMarketplaceIntent, UpdateMarketplaceOffer, UpsertMarketplaceIntentProfile,
    WithdrawMarketplaceOffer,
};
pub use marketplace::{
    AcceptContactExchange, ApproveMarketplaceListingSubmission, AuthenticatedParty,
    BuyerVehicleRequest, ConfirmOfflineDeal, ContactEnvelope, CreateBuyerVehicleRequest,
    CreateMarketplaceListingSubmission, CreateMarketplaceParty, CreateOfflineDeal,
    CreateSellerPromotion, CreateVehicleListing, CreateViewingAppointment, EncryptedContact,
    EnsureMarketplaceParty, ExposureMetrics, FinalizeOfflineDeal, MarketplaceAssetAuthorization,
    MarketplaceListingSubmission, MarketplaceParty, OfflineDeal, OfflineDealOutcome,
    OfflineDealProgress, RecommendVehicleListings, RecommendedListing, RecordExposure,
    RecordSellerPromotionEvent, ReleaseContact, SellerPromotionCampaign,
    SellerPromotionEventOutcome, SetMarketplaceAssetAuthorization, TransitionViewingAppointment,
    VehicleListing, ViewingAppointment,
};
pub use platform::{
    ProvisionRootDomain, ProvisionRootPlatform, ProvisionedDomain, ProvisionedRootPlatform,
    ProvisionedTenant,
};
pub use subplatform::{SubplatformEmailConfig, UpsertSubplatformEmailConfig};
pub use types::{
    BookProjection, BookProjectionLevel, BookSnapshot, CandidateMatch, FederationReservation,
    FederationTransition, MatchCommitOutcome, OutboxMessage, ReserveFederated, StoredAccount,
    StoredOrder, StoredTrade, SubmitOrder, SubmitOrderOutcome, VectorRecord,
};

/// PostgreSQL storage facade shared by service adapters.
#[derive(Debug, Clone)]
pub struct PgStore {
    pool: PgPool,
}

/// Storage failures that retain SQLx context at the library boundary.
#[derive(Debug, Error)]
pub enum StorageError {
    /// PostgreSQL operation failed.
    #[error("PostgreSQL operation failed: {0}")]
    Sqlx(#[from] sqlx::Error),
    /// Embedded migration failed.
    #[error("PostgreSQL migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    /// A request reused a business idempotency key with different content.
    #[error("idempotency key was already used with a different payload")]
    IdempotencyConflict,
    /// An authenticated caller is not allowed to perform the requested marketplace action.
    #[error("forbidden: {0}")]
    Forbidden(String),
    /// Current durable state conflicts with the requested marketplace action.
    #[error("conflict: {0}")]
    Conflict(String),
    /// A requested entity does not exist in the caller's authority scope.
    #[error("{0} was not found")]
    NotFound(&'static str),
    /// Exact values in PostgreSQL could not be represented by the domain model.
    #[error("stored data is invalid: {0}")]
    InvalidData(String),
    /// A conditional reservation update prevented an oversell.
    #[error("account has insufficient available balance for this reservation")]
    InsufficientBalance,
    /// Another logical writer currently owns the market shard.
    #[error("market shard is owned by another live matcher")]
    LeaseUnavailable,
    /// The requested order quantity is not currently available to a federation saga.
    #[error("order has insufficient unreserved quantity for this federation reservation")]
    ReservationUnavailable,
    /// A federation caller used a fencing token older than the source authority has observed.
    #[error("federation fencing token is stale")]
    StaleFencingToken,
    /// A federation nonce was already consumed by a different operation.
    #[error("federation replay nonce has already been consumed")]
    ReplayDetected,
    /// A reservation compare-and-swap used an obsolete state version.
    #[error("federation reservation version does not match")]
    ReservationVersionConflict,
    /// A reservation cannot move from its durable state to the requested state.
    #[error("federation reservation cannot transition from {from} to {to}")]
    InvalidReservationTransition {
        /// Durable current state.
        from: String,
        /// Requested target state.
        to: &'static str,
    },
    /// An event or command could not be encoded for durable transport.
    #[error("wire protocol conversion failed: {0}")]
    Wire(#[from] matchplane_protocol::WireError),
    /// The deterministic order book could not produce a verified snapshot.
    #[error("matching engine state failed validation: {0}")]
    Engine(#[from] matchplane_engine::EngineError),
    /// JSON encoding or decoding failed at a persistence boundary.
    #[error("JSON persistence failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub(crate) fn bounded_operator_text(
    value: &str,
    maximum: usize,
    label: &str,
) -> Result<String, StorageError> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(StorageError::InvalidData(format!(
            "{label} must contain 1..={maximum} printable bytes"
        )));
    }
    Ok(value.to_owned())
}

impl PgStore {
    /// Opens a bounded PostgreSQL pool.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the initial connection cannot be established.
    pub async fn connect(database_url: &str, max_connections: u32) -> Result<Self, StorageError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    /// Wraps an existing SQLx pool.
    #[must_use]
    pub const fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Borrows the underlying pool for explicitly scoped queries.
    #[must_use]
    pub const fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Executes embedded database migrations.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] if any migration fails.
    pub async fn migrate(&self) -> Result<(), StorageError> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        Ok(())
    }

    /// Checks whether PostgreSQL accepts a trivial query.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the database is unavailable.
    pub async fn ping(&self) -> Result<(), StorageError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }
}
