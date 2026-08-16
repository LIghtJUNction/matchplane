//! Privacy-aware vehicle discovery and offline introduction persistence.

use matchplane_domain::{
    AssetId, AssetSchemaId, BuyerRequestId, DomainId, MarketplacePartyId, OfflineDealId, PaymentId,
    PromotionCampaignId, TenantId, VehicleListingId, ViewingAppointmentId,
};
use matchplane_payments::calculate_commission;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgStore, StorageError};

const MAX_VIEWING_APPOINTMENTS_PER_DEAL: i64 = 32;

/// Encrypted contact data supplied when a marketplace identity is registered.
#[derive(Debug, Clone)]
pub struct EncryptedContact {
    /// AES-GCM ciphertext including its authentication tag.
    pub ciphertext: Vec<u8>,
    /// Unique 96-bit AES-GCM nonce.
    pub nonce: Vec<u8>,
    /// Application encryption key version.
    pub key_version: i32,
}

/// Validated command that registers one buyer, seller, or dual-role party.
#[derive(Debug)]
pub struct CreateMarketplaceParty {
    /// Stable party ID.
    pub party_id: MarketplacePartyId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Optional platform node scope. `None` is reserved for root/legacy API parties.
    pub scope_domain_id: Option<DomainId>,
    /// Recursive platform path represented by this capability.
    pub platform_path: String,
    /// Tenant-local identity key.
    pub external_key: String,
    /// Public display name.
    pub display_name: String,
    /// `buyer`, `seller`, or `both`.
    pub role: String,
    /// Domain-neutral kernel capabilities. Legacy role labels are only an adapter projection.
    pub marketplace_sides: Vec<String>,
    /// SHA-256 hash of the high-entropy capability token returned at registration.
    pub access_token_hash: Vec<u8>,
    /// Hard expiry for the capability token.
    pub access_token_expires_at: OffsetDateTime,
    /// Protected contact record.
    pub contact: EncryptedContact,
}

/// Better Auth-backed identity projection that rotates the marketplace capability on login.
#[derive(Debug)]
pub struct EnsureMarketplaceParty {
    /// Stable Better Auth user UUID.
    pub auth_user_id: Uuid,
    /// Stable tenant-scoped party UUID.
    pub party_id: MarketplacePartyId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Child domain represented by this capability; root sessions use `None`.
    pub scope_domain_id: Option<DomainId>,
    /// Recursive platform path represented by this capability.
    pub platform_path: String,
    /// Stable tenant-local identity key.
    pub external_key: String,
    /// Public display name.
    pub display_name: String,
    /// `buyer`, `seller`, or `both`.
    pub role: String,
    /// Domain-neutral kernel capabilities. Legacy role labels are only an adapter projection.
    pub marketplace_sides: Vec<String>,
    /// SHA-256 hash of the newly issued capability token.
    pub access_token_hash: Vec<u8>,
    /// Hard expiry for the newly issued capability token.
    pub access_token_expires_at: OffsetDateTime,
    /// Protected contact record.
    pub contact: EncryptedContact,
}

/// Public marketplace identity metadata. Contact details and credentials are never serialized.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceParty {
    /// Party ID.
    pub party_id: MarketplacePartyId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Tenant-local identity key.
    pub external_key: String,
    /// Public display name.
    pub display_name: String,
    /// Marketplace role.
    pub role: String,
    /// Domain-neutral kernel capabilities used by generic routes.
    pub marketplace_sides: Vec<String>,
    /// Durable account state.
    pub status: String,
    /// Optimistic version.
    pub version: i64,
    /// Registration time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Active party established by a tenant-scoped capability token.
#[derive(Debug, Clone)]
pub struct AuthenticatedParty {
    /// Party ID.
    pub party_id: MarketplacePartyId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// The domain scope bound to this bearer. Root/legacy parties have no child scope.
    pub scope_domain_id: Option<DomainId>,
    /// Recursive platform path bound to this bearer.
    pub platform_path: String,
    /// Marketplace role.
    pub role: String,
    /// Domain-neutral kernel capabilities used by generic routes.
    pub marketplace_sides: Vec<String>,
}

/// Command to publish a seller-owned vehicle.
#[derive(Debug)]
pub struct CreateVehicleListing {
    /// Stable listing ID.
    pub listing_id: VehicleListingId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Automotive domain.
    pub domain_id: DomainId,
    /// Existing schema-validated vehicle asset.
    pub asset_id: AssetId,
    /// Authenticated seller.
    pub seller_party_id: MarketplacePartyId,
    /// Exact asking amount in minor units.
    pub asking_amount: i128,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
    /// Optional publication expiry.
    pub expires_at: Option<OffsetDateTime>,
}

/// Command accepted from a seller's subplatform upload form.
///
/// A submission is intentionally separate from a published listing.  The seller owns the
/// content, while the root operator (or a future moderation workflow) decides when it becomes
/// discoverable and receives an explicit asset authorization.
#[derive(Debug)]
pub struct CreateMarketplaceListingSubmission {
    /// Stable submission identifier.
    pub submission_id: Uuid,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Subplatform/domain scope.
    pub domain_id: DomainId,
    /// Authenticated seller.
    pub seller_party_id: MarketplacePartyId,
    /// Versioned schema selected by the subplatform.
    pub asset_schema_id: AssetSchemaId,
    /// Seller's idempotent key for this supply item.
    pub external_key: String,
    /// Public display name supplied by the seller.
    pub display_name: String,
    /// Subplatform-defined structured attributes.
    pub attributes: Value,
    /// Exact asking amount in minor units.
    pub asking_amount: i128,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
}

/// Seller supply waiting for publication review.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceListingSubmission {
    /// Submission identifier.
    pub submission_id: Uuid,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Subplatform/domain scope.
    pub domain_id: DomainId,
    /// Seller identity.
    pub seller_party_id: MarketplacePartyId,
    /// Versioned schema selected by the subplatform.
    pub asset_schema_id: AssetSchemaId,
    /// Seller's idempotent key.
    pub external_key: String,
    /// Public display name.
    pub display_name: String,
    /// Subplatform-defined structured attributes.
    pub attributes: Value,
    /// Exact asking amount in minor units.
    pub asking_amount: String,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
    /// `pending_review`, `approved`, `rejected`, or `withdrawn`.
    pub status: String,
    /// Optional reviewer identity.
    pub reviewed_by: Option<String>,
    /// Optional review note.
    pub review_reason: Option<String>,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Operator decision that turns one seller submission into a published listing.
#[derive(Debug)]
pub struct ApproveMarketplaceListingSubmission {
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Submission being approved.
    pub submission_id: Uuid,
    /// Operator or moderation workflow actor.
    pub authorized_by: String,
    /// Human-readable audit reason.
    pub reason: String,
}

/// Operator-approved authorization allowing one seller to publish one catalog asset.
#[derive(Debug)]
pub struct SetMarketplaceAssetAuthorization {
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Automotive domain.
    pub domain_id: DomainId,
    /// Catalog asset being authorized.
    pub asset_id: AssetId,
    /// Seller receiving or losing authorization.
    pub seller_party_id: MarketplacePartyId,
    /// Whether the authorization is active.
    pub enabled: bool,
    /// Operator or workflow actor that made the decision.
    pub authorized_by: String,
    /// Human-readable audit reason.
    pub reason: String,
}

/// Durable seller-to-asset authorization state.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceAssetAuthorization {
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Automotive domain.
    pub domain_id: DomainId,
    /// Catalog asset.
    pub asset_id: AssetId,
    /// Authorized seller.
    pub seller_party_id: MarketplacePartyId,
    /// `active` or `revoked`.
    pub status: String,
    /// Actor recorded for the latest decision.
    pub authorized_by: String,
    /// Audit reason recorded for the latest decision.
    pub reason: String,
    /// Optimistic version.
    pub version: i64,
    /// Creation timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last decision timestamp.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Seller listing returned to buyers without private contact details.
#[derive(Debug, Clone, Serialize)]
pub struct VehicleListing {
    /// Listing ID.
    pub listing_id: VehicleListingId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Vehicle asset.
    pub asset_id: AssetId,
    /// Seller identity retained for authorization and contact release, never exposed in a
    /// buyer-facing listing JSON response before an introduction is consented.
    #[serde(skip_serializing)]
    pub seller_party_id: MarketplacePartyId,
    /// Public vehicle title.
    pub display_name: String,
    /// Public schema-validated vehicle attributes.
    pub attributes: Value,
    /// Exact asking amount in minor units.
    pub asking_amount: String,
    /// Currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
    /// Disclosed platform commission rate in basis points.
    pub commission_bps: i32,
    /// Whether commission is authorized before contact or paid after agreement.
    pub commission_collection: String,
    /// Listing lifecycle state.
    pub status: String,
    /// Publication time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub published_at: Option<OffsetDateTime>,
    /// Optional expiry.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    /// Optimistic version.
    pub version: i64,
}

/// Command that stores a buyer's explicit vehicle needs.
#[derive(Debug)]
pub struct CreateBuyerVehicleRequest {
    /// Stable request ID.
    pub request_id: BuyerRequestId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Automotive domain.
    pub domain_id: DomainId,
    /// Authenticated buyer.
    pub buyer_party_id: MarketplacePartyId,
    /// Free-form buyer context.
    pub narrative: String,
    /// Exact attribute preferences represented as a JSON object.
    pub requirements: Value,
    /// Optional lower budget bound in minor units.
    pub budget_min: Option<i128>,
    /// Optional upper budget bound in minor units.
    pub budget_max: Option<i128>,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
}

/// Persisted buyer needs used to explain recommendations.
#[derive(Debug, Clone, Serialize)]
pub struct BuyerVehicleRequest {
    /// Request ID.
    pub request_id: BuyerRequestId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Buyer identity.
    pub buyer_party_id: MarketplacePartyId,
    /// Free-form context.
    pub narrative: String,
    /// Structured requirements.
    pub requirements: Value,
    /// Optional lower budget bound.
    pub budget_min: Option<String>,
    /// Optional upper budget bound.
    pub budget_max: Option<String>,
    /// Currency.
    pub currency: String,
    /// Currency scale.
    pub currency_scale: i16,
    /// Request lifecycle state.
    pub status: String,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// Authenticated recommendation query.
#[derive(Debug)]
pub struct RecommendVehicleListings {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Buyer request being served.
    pub request_id: BuyerRequestId,
    /// Authenticated buyer.
    pub buyer_party_id: MarketplacePartyId,
    /// Client surface identifier retained for request validation/observability. It must never
    /// influence seller-funded billing or exposure deduplication.
    pub exposure_key: String,
    /// Maximum returned results.
    pub limit: usize,
}

/// One explainable buyer-to-vehicle recommendation.
#[derive(Debug, Clone, Serialize)]
pub struct RecommendedListing {
    /// Public listing.
    #[serde(flatten)]
    pub listing: VehicleListing,
    /// Deterministic suitability score in `[0, 1]`.
    pub match_score: f64,
    /// Machine-readable explanations for the score.
    pub match_reasons: Vec<String>,
}

/// Command to turn one recommendation into an offline buyer/seller introduction.
#[derive(Debug)]
pub struct CreateOfflineDeal {
    /// Stable introduction ID.
    pub offline_deal_id: OfflineDealId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Chosen seller listing.
    pub listing_id: VehicleListingId,
    /// Buyer request that produced the match.
    pub buyer_request_id: BuyerRequestId,
    /// Authenticated buyer.
    pub buyer_party_id: MarketplacePartyId,
    /// Hard introduction expiry.
    pub expires_at: OffsetDateTime,
}

/// Privacy-controlled offline vehicle transaction.
#[derive(Debug, Clone, Serialize)]
pub struct OfflineDeal {
    /// Introduction ID.
    pub offline_deal_id: OfflineDealId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Seller listing.
    pub listing_id: VehicleListingId,
    /// Buyer request.
    pub buyer_request_id: BuyerRequestId,
    /// Seller identity.
    pub seller_party_id: MarketplacePartyId,
    /// Buyer identity.
    pub buyer_party_id: MarketplacePartyId,
    /// Recommendation score at introduction time.
    pub match_score: f64,
    /// Recommendation explanations frozen for audit.
    pub match_reasons: Value,
    /// Deal lifecycle state.
    pub status: String,
    /// First successful contact release.
    #[serde(with = "time::serde::rfc3339::option")]
    pub contact_released_at: Option<OffsetDateTime>,
    /// Seller's explicit consent to exchange phone/WeChat contact details.
    #[serde(with = "time::serde::rfc3339::option")]
    pub seller_contact_consent_at: Option<OffsetDateTime>,
    /// Final offline vehicle price, once agreed.
    pub final_amount: Option<String>,
    /// Currency.
    pub currency: String,
    /// Currency scale.
    pub currency_scale: i16,
    /// Disclosed commission basis points.
    pub commission_bps: i32,
    /// Exact commission, initially calculated from the asking price.
    pub commission_amount: Option<String>,
    /// Commission timing policy.
    pub commission_collection: String,
    /// Payment intent securing or settling the platform fee.
    pub commission_payment_id: Option<PaymentId>,
    /// Seller agreement time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub seller_confirmed_at: Option<OffsetDateTime>,
    /// Buyer agreement time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub buyer_confirmed_at: Option<OffsetDateTime>,
    /// Completion time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub completed_at: Option<OffsetDateTime>,
    /// Introduction expiry.
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Idempotent introduction result.
#[derive(Debug, Clone, Serialize)]
pub struct OfflineDealOutcome {
    /// Durable introduction.
    #[serde(flatten)]
    pub deal: OfflineDeal,
    /// Whether an existing listing/request introduction was returned.
    pub duplicate: bool,
}

/// One participant's confirmation of the face-to-face vehicle price.
#[derive(Debug)]
pub struct ConfirmOfflineDeal {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Offline introduction.
    pub offline_deal_id: OfflineDealId,
    /// Authenticated buyer or seller.
    pub actor_party_id: MarketplacePartyId,
    /// Exact vehicle price agreed offline.
    pub final_amount: i128,
}

/// Authenticated request to re-check commission settlement and complete the deal.
#[derive(Debug)]
pub struct FinalizeOfflineDeal {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Offline introduction.
    pub offline_deal_id: OfflineDealId,
    /// Authenticated buyer or seller.
    pub actor_party_id: MarketplacePartyId,
}

/// Offline deal state plus the one concrete action still required.
#[derive(Debug, Clone, Serialize)]
pub struct OfflineDealProgress {
    /// Durable deal state.
    #[serde(flatten)]
    pub deal: OfflineDeal,
    /// `counterparty_confirmation`, `seller_settle_platform_commission`,
    /// `capture_platform_commission`, or `completed`.
    pub next_action: String,
}

/// Command to propose a privacy-protected offline vehicle viewing.
#[derive(Debug)]
pub struct CreateViewingAppointment {
    /// Stable appointment ID.
    pub viewing_id: ViewingAppointmentId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Offline introduction.
    pub offline_deal_id: OfflineDealId,
    /// Buyer or seller proposing the viewing.
    pub proposed_by: MarketplacePartyId,
    /// Viewing start.
    pub starts_at: OffsetDateTime,
    /// Viewing end.
    pub ends_at: OffsetDateTime,
    /// Encrypted private meeting location.
    pub location: EncryptedContact,
}

/// Command to confirm, complete, or cancel a viewing.
#[derive(Debug)]
pub struct TransitionViewingAppointment {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Appointment ID.
    pub viewing_id: ViewingAppointmentId,
    /// Authenticated buyer or seller.
    pub actor_party_id: MarketplacePartyId,
    /// `confirm`, `complete`, or `cancel`.
    pub action: String,
}

/// Offline viewing metadata; protected location fields are never serialized by storage.
#[derive(Debug, Clone, Serialize)]
pub struct ViewingAppointment {
    /// Appointment ID.
    pub viewing_id: ViewingAppointmentId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Offline introduction.
    pub offline_deal_id: OfflineDealId,
    /// Proposer.
    pub proposed_by: MarketplacePartyId,
    /// Viewing start.
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    /// Viewing end.
    #[serde(with = "time::serde::rfc3339")]
    pub ends_at: OffsetDateTime,
    /// Appointment state.
    pub status: String,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// Encrypted location.
    #[serde(skip)]
    pub location_ciphertext: Vec<u8>,
    /// Location nonce.
    #[serde(skip)]
    pub location_nonce: Vec<u8>,
    /// Location key version.
    #[serde(skip)]
    pub encryption_key_version: i32,
}

/// Authenticated request to reveal only the other matched participant's contact.
#[derive(Debug)]
pub struct ReleaseContact {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Introduction ID.
    pub offline_deal_id: OfflineDealId,
    /// Requesting participant.
    pub actor_party_id: MarketplacePartyId,
    /// Non-secret request fingerprint used for audit correlation.
    pub request_fingerprint: Option<Vec<u8>>,
}

/// Seller-authorized request to exchange contact details with the matched buyer.
#[derive(Debug)]
pub struct AcceptContactExchange {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Introduction ID.
    pub offline_deal_id: OfflineDealId,
    /// The matched seller granting consent.
    pub seller_party_id: MarketplacePartyId,
}

/// Encrypted counterpart contact returned only after authorization checks and an audit write.
#[derive(Debug)]
pub struct ContactEnvelope {
    /// Counterpart identity.
    pub target_party_id: MarketplacePartyId,
    /// Counterpart display name.
    pub display_name: String,
    /// Contact ciphertext.
    pub ciphertext: Vec<u8>,
    /// Contact nonce.
    pub nonce: Vec<u8>,
    /// Contact key version.
    pub key_version: i32,
    /// Durable introduction state after release.
    pub deal: OfflineDeal,
}

/// One seller exposure event.
#[derive(Debug)]
pub struct RecordExposure {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Listing being observed.
    pub listing_id: VehicleListingId,
    /// Authenticated viewer when known.
    pub viewer_party_id: Option<MarketplacePartyId>,
    /// `impression`, `detail_view`, `favorite`, `inquiry`, or `matched_contact`.
    pub event_type: String,
    /// Discovery surface.
    pub source: String,
    /// Caller-stable idempotency key.
    pub deduplication_key: String,
    /// Business event time.
    pub occurred_at: OffsetDateTime,
}

/// Seller-facing listing funnel counts.
#[derive(Debug, Clone, Serialize)]
pub struct ExposureMetrics {
    /// Listing ID.
    pub listing_id: VehicleListingId,
    /// Rendered recommendation impressions.
    pub impressions: i64,
    /// Listing detail views.
    pub detail_views: i64,
    /// Favorites.
    pub favorites: i64,
    /// Buyer inquiries.
    pub inquiries: i64,
    /// Privacy-cleared contact matches.
    pub matched_contacts: i64,
    /// Distinct known viewers.
    pub distinct_viewers: i64,
    /// Most recent exposure event.
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_event_at: Option<OffsetDateTime>,
}

/// Seller-funded campaign that pays for qualified exposure while keeping the target domain-neutral.
#[derive(Debug, Clone, Serialize)]
pub struct SellerPromotionCampaign {
    /// Campaign identifier.
    pub campaign_id: PromotionCampaignId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Party funding the campaign.
    pub sponsor_party_id: MarketplacePartyId,
    /// Vertical adapter key, for example `vehicle_listing`.
    pub target_kind: String,
    /// Target identifier owned by the vertical adapter.
    pub target_key: String,
    /// Revenue policy selected by the tenant.
    pub policy: String,
    /// `fixed`, `cpm`, `cpc`, or `cpl`.
    pub pricing_model: String,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
    /// Price per billable unit, or per thousand impressions for CPM.
    pub unit_price: String,
    /// Maximum amount the campaign can spend.
    pub budget_amount: String,
    /// Amount accrued by billable events.
    pub spent_amount: String,
    /// Number of billable events observed.
    pub billable_units: i64,
    /// Adapter-owned targeting and presentation settings.
    pub settings: Value,
    /// Campaign lifecycle state.
    pub status: String,
    /// Campaign start time.
    #[serde(with = "time::serde::rfc3339")]
    pub starts_at: OffsetDateTime,
    /// Optional campaign end time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub ends_at: Option<OffsetDateTime>,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Validated command to start a seller promotion campaign.
#[derive(Debug)]
pub struct CreateSellerPromotion {
    /// Stable campaign identifier.
    pub campaign_id: PromotionCampaignId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Authenticated seller funding the campaign.
    pub sponsor_party_id: MarketplacePartyId,
    /// Vertical adapter key.
    pub target_kind: String,
    /// Vertical-owned target identifier.
    pub target_key: String,
    /// `seller_promotion` or `hybrid`.
    pub policy: String,
    /// `fixed`, `cpm`, `cpc`, or `cpl`.
    pub pricing_model: String,
    /// ISO 4217 currency.
    pub currency: String,
    /// Currency decimal scale.
    pub currency_scale: i16,
    /// Price per event, or per thousand impressions for CPM.
    pub unit_price: i128,
    /// Maximum campaign spend.
    pub budget_amount: i128,
    /// Adapter-owned campaign settings.
    pub settings: Value,
    /// Campaign start time.
    pub starts_at: OffsetDateTime,
    /// Optional campaign end time.
    pub ends_at: Option<OffsetDateTime>,
}

/// Authenticated event that may consume a campaign budget.
#[derive(Debug)]
pub struct RecordSellerPromotionEvent {
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Campaign receiving the event.
    pub campaign_id: PromotionCampaignId,
    /// Authenticated viewer when known.
    pub actor_party_id: Option<MarketplacePartyId>,
    /// `impression`, `click`, `qualified_lead`, or `contact_exchange`.
    pub event_type: String,
    /// Caller-stable deduplication key.
    pub deduplication_key: String,
    /// Business event time.
    pub occurred_at: OffsetDateTime,
}

/// Result of recording one campaign event.
#[derive(Debug, Clone, Serialize)]
pub struct SellerPromotionEventOutcome {
    /// Campaign after applying the event.
    #[serde(flatten)]
    pub campaign: SellerPromotionCampaign,
    /// Whether the event was already recorded.
    pub duplicate: bool,
    /// Amount charged by this event in campaign currency units.
    pub charged_amount: String,
}

impl PgStore {
    /// Registers a protected marketplace party.
    pub async fn create_marketplace_party(
        &self,
        command: &CreateMarketplaceParty,
    ) -> Result<MarketplaceParty, StorageError> {
        validate_role(&command.role)?;
        validate_marketplace_sides(&command.marketplace_sides)?;
        if command.access_token_hash.len() != 32
            || command.contact.nonce.len() != 12
            || command.contact.key_version <= 0
            || command.access_token_expires_at <= OffsetDateTime::now_utc()
        {
            return Err(StorageError::InvalidData(
                "party credential or contact envelope is malformed".to_owned(),
            ));
        }
        validate_platform_scope(command.scope_domain_id, &command.platform_path)?;
        let row = sqlx::query(
            "INSERT INTO marketplace_parties \
             (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role, marketplace_sides, access_token_hash, \
              access_token_expires_at, contact_ciphertext, contact_nonce, contact_key_version) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             RETURNING id, tenant_id, external_key, display_name, role, marketplace_sides, status, version, created_at",
        )
        .bind(command.party_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.scope_domain_id.map(DomainId::into_uuid))
        .bind(&command.platform_path)
        .bind(&command.external_key)
        .bind(&command.display_name)
        .bind(&command.role)
        .bind(&command.marketplace_sides)
        .bind(&command.access_token_hash)
        .bind(command.access_token_expires_at)
        .bind(&command.contact.ciphertext)
        .bind(&command.contact.nonce)
        .bind(command.contact.key_version)
        .fetch_one(self.pool())
        .await?;
        party_from_row(&row)
    }

    /// Creates or updates the tenant-scoped marketplace projection for a Better Auth user.
    ///
    /// The capability hash is rotated on every authenticated bridge request, so the raw token
    /// never needs to be persisted and an old browser capability is invalidated on re-login.
    pub async fn ensure_marketplace_party(
        &self,
        command: &EnsureMarketplaceParty,
    ) -> Result<MarketplaceParty, StorageError> {
        validate_role(&command.role)?;
        validate_marketplace_sides(&command.marketplace_sides)?;
        if command.auth_user_id.is_nil()
            || command.access_token_hash.len() != 32
            || command.contact.nonce.len() != 12
            || command.contact.key_version <= 0
            || command.access_token_expires_at <= OffsetDateTime::now_utc()
        {
            return Err(StorageError::InvalidData(
                "Better Auth party bridge credential or identity is malformed".to_owned(),
            ));
        }
        validate_platform_scope(command.scope_domain_id, &command.platform_path)?;
        let mut transaction = self.pool().begin().await?;
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT party_id FROM marketplace_party_auth_links \
             WHERE tenant_id = $1 AND auth_user_id = $2 AND platform_path = $3 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.auth_user_id)
        .bind(&command.platform_path)
        .fetch_optional(&mut *transaction)
        .await?;
        let party_id = existing.unwrap_or_else(|| command.party_id.into_uuid());
        let row = sqlx::query(
            "INSERT INTO marketplace_parties \
             (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role, marketplace_sides, access_token_hash, \
              access_token_expires_at, contact_ciphertext, contact_nonce, contact_key_version) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             ON CONFLICT (tenant_id, id) DO UPDATE SET \
               scope_domain_id = EXCLUDED.scope_domain_id, platform_path = EXCLUDED.platform_path, \
               external_key = EXCLUDED.external_key, display_name = EXCLUDED.display_name, \
               role = CASE \
                   WHEN marketplace_parties.role = 'both' OR EXCLUDED.role = 'both' THEN 'both' \
                   WHEN marketplace_parties.role = EXCLUDED.role THEN EXCLUDED.role \
                   ELSE 'both' \
               END, marketplace_sides = (\
                   SELECT ARRAY(SELECT DISTINCT side FROM unnest(\
                       marketplace_parties.marketplace_sides || EXCLUDED.marketplace_sides\
                   ) AS side ORDER BY side)\
               ), access_token_hash = EXCLUDED.access_token_hash, \
               access_token_expires_at = EXCLUDED.access_token_expires_at, \
               contact_ciphertext = EXCLUDED.contact_ciphertext, contact_nonce = EXCLUDED.contact_nonce, \
               contact_key_version = EXCLUDED.contact_key_version, version = marketplace_parties.version + 1 \
             RETURNING id, tenant_id, external_key, display_name, role, marketplace_sides, status, version, created_at",
        )
        .bind(party_id)
        .bind(command.tenant_id.into_uuid())
        .bind(command.scope_domain_id.map(DomainId::into_uuid))
        .bind(&command.platform_path)
        .bind(&command.external_key)
        .bind(&command.display_name)
        .bind(&command.role)
        .bind(&command.marketplace_sides)
        .bind(&command.access_token_hash)
        .bind(command.access_token_expires_at)
        .bind(&command.contact.ciphertext)
        .bind(&command.contact.nonce)
        .bind(command.contact.key_version)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO marketplace_party_auth_links (tenant_id, auth_user_id, party_id, platform_path) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (tenant_id, auth_user_id, platform_path) DO UPDATE SET \
               party_id = EXCLUDED.party_id, updated_at = clock_timestamp()",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.auth_user_id)
        .bind(party_id)
        .bind(&command.platform_path)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        party_from_row(&row)
    }

    /// Grants or revokes a seller's explicit right to publish one catalog asset.
    pub async fn set_marketplace_asset_authorization(
        &self,
        command: &SetMarketplaceAssetAuthorization,
    ) -> Result<MarketplaceAssetAuthorization, StorageError> {
        if command.authorized_by.trim().is_empty() || command.authorized_by.len() > 256 {
            return Err(StorageError::InvalidData(
                "authorized_by must contain 1..=256 bytes".to_owned(),
            ));
        }
        if command.reason.trim().is_empty() || command.reason.len() > 2_000 {
            return Err(StorageError::InvalidData(
                "authorization reason must contain 1..=2000 bytes".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.seller_party_id,
            "seller",
        )
        .await?;
        let asset_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM assets \
             WHERE tenant_id = $1 AND domain_id = $2 AND id = $3 AND status = 'active')",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.asset_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        if !asset_exists {
            return Err(StorageError::NotFound("active vehicle asset"));
        }
        let status = if command.enabled { "active" } else { "revoked" };
        let row = sqlx::query(
            "INSERT INTO marketplace_asset_authorizations \
             (tenant_id, domain_id, asset_id, seller_party_id, status, authorized_by, reason) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (tenant_id, domain_id, asset_id, seller_party_id) DO UPDATE SET \
                 status = EXCLUDED.status, authorized_by = EXCLUDED.authorized_by, \
                 reason = EXCLUDED.reason, version = marketplace_asset_authorizations.version + 1 \
             RETURNING tenant_id, domain_id, asset_id, seller_party_id, status, authorized_by, \
                       reason, version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.asset_id.into_uuid())
        .bind(command.seller_party_id.into_uuid())
        .bind(status)
        .bind(&command.authorized_by)
        .bind(&command.reason)
        .fetch_one(&mut *transaction)
        .await?;
        let authorization = asset_authorization_from_row(&row)?;
        if !command.enabled {
            // Revocation is an immediate marketplace control, not merely a guard for future
            // listing creation. Withdraw live inventory atomically so discovery, matching, and
            // promotion billing cannot continue using a seller's revoked asset grant.
            sqlx::query(
                "UPDATE vehicle_listings SET status = 'withdrawn', version = version + 1 \
                 WHERE tenant_id = $1 AND domain_id = $2 AND asset_id = $3 \
                   AND seller_party_id = $4 AND status IN ('active', 'reserved')",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(command.asset_id.into_uuid())
            .bind(command.seller_party_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(authorization)
    }

    /// Authenticates a high-entropy party capability within one tenant and, for child nodes,
    /// the exact recursive platform path represented by that capability.
    ///
    /// Child capabilities are checked against the Rust membership projection. When a party is
    /// linked to a human Better Auth identity, the query also requires the corresponding Better
    /// Auth member row; removing that member therefore revokes access without waiting for the
    /// fifteen-minute capability expiry. Legacy/manual child parties without an auth link remain
    /// usable for the gateway-only integration contract.
    pub async fn authenticate_marketplace_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        access_token_hash: &[u8],
        scope_domain_id: Option<DomainId>,
        scope_platform_path: Option<&str>,
    ) -> Result<AuthenticatedParty, StorageError> {
        if access_token_hash.len() != 32 {
            return Err(StorageError::Forbidden(
                "invalid party credential".to_owned(),
            ));
        }
        if scope_platform_path.is_some_and(|path| path.is_empty() || path.len() > 512) {
            return Err(StorageError::Forbidden(
                "invalid platform path scope".to_owned(),
            ));
        }
        let row = sqlx::query(
            "SELECT p.id, p.tenant_id, p.scope_domain_id, p.platform_path, p.role, p.marketplace_sides \
               FROM marketplace_parties p \
              WHERE p.tenant_id = $1 AND p.id = $2 AND p.access_token_hash = $3 \
                AND p.scope_domain_id IS NOT DISTINCT FROM $4::uuid \
                AND p.platform_path = COALESCE($5::text, p.platform_path) \
                AND p.status = 'active' AND p.access_token_expires_at > clock_timestamp() \
                AND (p.platform_path = '/' \
                     OR EXISTS ( \
                         SELECT 1 FROM marketplace_subplatform_memberships m \
                          WHERE m.tenant_id = p.tenant_id \
                            AND m.domain_id = p.scope_domain_id \
                            AND m.party_id = p.id \
                            AND m.status = 'active' \
                            AND ( \
                                NOT EXISTS ( \
                                    SELECT 1 \
                                      FROM marketplace_party_auth_links l \
                                      JOIN \"user\" u ON u.id = l.auth_user_id \
                                     WHERE l.tenant_id = p.tenant_id \
                                       AND l.party_id = p.id \
                                       AND l.platform_path = p.platform_path \
                                ) \
                                OR EXISTS ( \
                                    SELECT 1 \
                                      FROM marketplace_party_auth_links l \
                                      JOIN \"user\" linked_user \
                                        ON linked_user.id = l.auth_user_id \
                                       AND linked_user.banned IS NOT TRUE \
                                       AND (linked_user.\"banExpires\" IS NULL \
                                            OR linked_user.\"banExpires\" <= clock_timestamp()) \
                                      JOIN \"member\" member_projection \
                                        ON member_projection.\"userId\" = l.auth_user_id \
                                      JOIN \"organization\" organization_projection \
                                        ON organization_projection.id = member_projection.\"organizationId\" \
                                     WHERE l.tenant_id = p.tenant_id \
                                       AND l.party_id = p.id \
                                       AND l.platform_path = p.platform_path \
                                       AND organization_projection.\"tenantId\" = p.tenant_id::text \
                                       AND organization_projection.\"domainId\" = p.scope_domain_id::text \
                                       AND organization_projection.slug = regexp_replace(p.platform_path, '^.*/', '') \
                                ) \
                            ) \
                     ) \
                     OR ( \
                         p.platform_path <> '/' \
                         AND NOT EXISTS ( \
                             SELECT 1 \
                               FROM marketplace_party_auth_links l \
                              WHERE l.tenant_id = p.tenant_id \
                                AND l.party_id = p.id \
                         ) \
                     ))",
        )
        .bind(tenant_id.into_uuid())
        .bind(party_id.into_uuid())
        .bind(access_token_hash)
        .bind(scope_domain_id.map(DomainId::into_uuid))
        .bind(scope_platform_path)
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| StorageError::Forbidden("invalid party credential".to_owned()))?;
        Ok(AuthenticatedParty {
            party_id: MarketplacePartyId::from_uuid(row.try_get("id")?),
            tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
            scope_domain_id: row
                .try_get::<Option<Uuid>, _>("scope_domain_id")?
                .map(DomainId::from_uuid),
            platform_path: row.try_get("platform_path")?,
            role: row.try_get("role")?,
            marketplace_sides: row.try_get("marketplace_sides")?,
        })
    }

    /// Stores seller-supplied structured content as a moderation-ready submission.
    ///
    /// The operation does not publish a listing or grant seller authorization. This keeps the
    /// upload path safe for arbitrary subplatforms while preserving an idempotent seller draft
    /// that an operator can review and publish through the root workflow.
    pub async fn create_marketplace_listing_submission(
        &self,
        command: &CreateMarketplaceListingSubmission,
    ) -> Result<MarketplaceListingSubmission, StorageError> {
        if command.external_key.trim().is_empty() || command.external_key.len() > 256 {
            return Err(StorageError::InvalidData(
                "external_key must contain 1..=256 bytes".to_owned(),
            ));
        }
        if command.display_name.trim().is_empty() || command.display_name.len() > 500 {
            return Err(StorageError::InvalidData(
                "display_name must contain 1..=500 bytes".to_owned(),
            ));
        }
        if !command.attributes.is_object() {
            return Err(StorageError::InvalidData(
                "attributes must be a JSON object".to_owned(),
            ));
        }
        if command.asking_amount <= 0 {
            return Err(StorageError::InvalidData(
                "asking_amount must be positive".to_owned(),
            ));
        }
        validate_currency_code(&command.currency)?;
        if !(0..=18).contains(&command.currency_scale) {
            return Err(StorageError::InvalidData(
                "currency_scale must be between 0 and 18".to_owned(),
            ));
        }

        let mut transaction = self.pool().begin().await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.seller_party_id,
            "seller",
        )
        .await?;
        let schema_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM asset_schemas \
             WHERE tenant_id = $1 AND domain_id = $2 AND id = $3 AND active = true)",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.asset_schema_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        if !schema_exists {
            return Err(StorageError::NotFound("active asset schema"));
        }

        let row = sqlx::query(
            "INSERT INTO marketplace_listing_submissions \
             (id, tenant_id, domain_id, seller_party_id, asset_schema_id, external_key, \
              display_name, attributes, asking_amount, currency, currency_scale) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11) \
             RETURNING id, tenant_id, domain_id, seller_party_id, asset_schema_id, external_key, \
                       display_name, attributes, asking_amount::text AS asking_amount, currency, \
                       currency_scale, status, reviewed_by, review_reason, version, created_at, updated_at",
        )
        .bind(command.submission_id)
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.seller_party_id.into_uuid())
        .bind(command.asset_schema_id.into_uuid())
        .bind(&command.external_key)
        .bind(&command.display_name)
        .bind(&command.attributes)
        .bind(command.asking_amount.to_string())
        .bind(&command.currency)
        .bind(command.currency_scale)
        .fetch_one(&mut *transaction)
        .await?;
        let submission = listing_submission_from_row(&row)?;
        transaction.commit().await?;
        Ok(submission)
    }

    /// Lists a seller's own moderation submissions in reverse update order.
    ///
    /// Authorization is intentionally performed by the gateway before this repository method is
    /// called.  The query still pins every row to the tenant, domain, and seller party so a caller
    /// cannot accidentally mix submissions from another recursive platform scope.
    pub async fn marketplace_listing_submissions(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        seller_party_id: MarketplacePartyId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceListingSubmission>, StorageError> {
        if !(1..=100).contains(&limit) || !(0..=10_000).contains(&offset) {
            return Err(StorageError::InvalidData(
                "listing submission page must use limit 1..=100 and offset 0..=10000".to_owned(),
            ));
        }
        let rows = sqlx::query(
            "SELECT id, tenant_id, domain_id, seller_party_id, asset_schema_id, external_key, \
                    display_name, attributes, asking_amount::text AS asking_amount, currency, \
                    currency_scale, status, reviewed_by, review_reason, version, created_at, updated_at \
             FROM marketplace_listing_submissions \
             WHERE tenant_id = $1 AND domain_id = $2 AND seller_party_id = $3 \
             ORDER BY updated_at DESC, id DESC LIMIT $4 OFFSET $5",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(seller_party_id.into_uuid())
        .bind(limit)
        .bind(offset)
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(listing_submission_from_row).collect()
    }

    /// Publishes one reviewed submission, creates its asset, and grants the seller authorization
    /// in one serializable transaction.
    pub async fn approve_marketplace_listing_submission(
        &self,
        command: &ApproveMarketplaceListingSubmission,
    ) -> Result<VehicleListing, StorageError> {
        if command.authorized_by.trim().is_empty() || command.authorized_by.len() > 256 {
            return Err(StorageError::InvalidData(
                "authorized_by must contain 1..=256 bytes".to_owned(),
            ));
        }
        if command.reason.trim().is_empty() || command.reason.len() > 2_000 {
            return Err(StorageError::InvalidData(
                "approval reason must contain 1..=2000 bytes".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let submission = sqlx::query(
            "SELECT id, tenant_id, domain_id, seller_party_id, asset_schema_id, external_key, \
                    display_name, attributes, asking_amount::text AS asking_amount, currency, \
                    currency_scale, status, reviewed_by, review_reason, version, created_at, updated_at \
             FROM marketplace_listing_submissions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.submission_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("listing submission"))?;
        let submission = listing_submission_from_row(&submission)?;
        if submission.status != "pending_review" {
            return Err(StorageError::Conflict(
                "listing submission is no longer pending review".to_owned(),
            ));
        }
        let asset_id = AssetId::new();
        let listing_id = VehicleListingId::new();
        sqlx::query(
            "INSERT INTO assets (id, tenant_id, domain_id, asset_schema_id, external_key, display_name, attributes) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(asset_id.into_uuid())
        .bind(submission.tenant_id.into_uuid())
        .bind(submission.domain_id.into_uuid())
        .bind(submission.asset_schema_id.into_uuid())
        .bind(&submission.external_key)
        .bind(&submission.display_name)
        .bind(&submission.attributes)
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO marketplace_asset_authorizations \
             (tenant_id, domain_id, asset_id, seller_party_id, status, authorized_by, reason) \
             VALUES ($1, $2, $3, $4, 'active', $5, $6)",
        )
        .bind(submission.tenant_id.into_uuid())
        .bind(submission.domain_id.into_uuid())
        .bind(asset_id.into_uuid())
        .bind(submission.seller_party_id.into_uuid())
        .bind(&command.authorized_by)
        .bind(&command.reason)
        .execute(&mut *transaction)
        .await?;

        let policy = sqlx::query(
            "SELECT commission_bps, offline_commission_collection, price_scale \
             FROM markets WHERE tenant_id = $1 AND domain_id = $2 AND quote_asset_key = $3 \
               AND status = 'active' ORDER BY id LIMIT 1 FOR SHARE",
        )
        .bind(submission.tenant_id.into_uuid())
        .bind(submission.domain_id.into_uuid())
        .bind(&submission.currency)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound(
            "active marketplace commission policy",
        ))?;
        let market_scale: i16 = policy.try_get("price_scale")?;
        if market_scale != submission.currency_scale {
            return Err(StorageError::InvalidData(format!(
                "currency_scale must equal market price_scale {market_scale}"
            )));
        }
        sqlx::query(
            "INSERT INTO vehicle_listings \
             (id, tenant_id, domain_id, asset_id, seller_party_id, asking_amount, currency, \
              currency_scale, commission_bps, commission_collection, status, published_at) \
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, 'active', clock_timestamp())",
        )
        .bind(listing_id.into_uuid())
        .bind(submission.tenant_id.into_uuid())
        .bind(submission.domain_id.into_uuid())
        .bind(asset_id.into_uuid())
        .bind(submission.seller_party_id.into_uuid())
        .bind(&submission.asking_amount)
        .bind(&submission.currency)
        .bind(submission.currency_scale)
        .bind(policy.try_get::<i32, _>("commission_bps")?)
        .bind(policy.try_get::<String, _>("offline_commission_collection")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE marketplace_listing_submissions SET status = 'approved', reviewed_by = $3, \
                    review_reason = $4, version = version + 1 \
             WHERE tenant_id = $1 AND id = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.submission_id)
        .bind(&command.authorized_by)
        .bind(&command.reason)
        .execute(&mut *transaction)
        .await?;
        let listing = listing_in(&mut transaction, listing_id).await?;
        transaction.commit().await?;
        Ok(listing)
    }

    /// Publishes a vehicle using the platform-owned commission policy for its market.
    pub async fn create_vehicle_listing(
        &self,
        command: &CreateVehicleListing,
    ) -> Result<VehicleListing, StorageError> {
        if command.asking_amount <= 0 {
            return Err(StorageError::InvalidData(
                "asking_amount must be positive".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.seller_party_id,
            "seller",
        )
        .await?;
        // Lock the authorization row so revocation and listing creation use one ordering:
        // party -> authorization -> listing.  A revoked grant may therefore either win before
        // this transaction (and reject publication) or wait for this listing to commit and then
        // withdraw it atomically; it cannot leave an unauthorized active listing behind.
        let authorization_status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM marketplace_asset_authorizations \
             WHERE tenant_id = $1 AND domain_id = $2 AND asset_id = $3 \
               AND seller_party_id = $4 FOR SHARE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.asset_id.into_uuid())
        .bind(command.seller_party_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?;
        if authorization_status.as_deref() != Some("active") {
            return Err(StorageError::Forbidden(
                "seller is not authorized to publish this vehicle asset".to_owned(),
            ));
        }
        let policy = sqlx::query(
            "SELECT commission_bps, offline_commission_collection, price_scale \
             FROM markets WHERE tenant_id = $1 AND domain_id = $2 AND quote_asset_key = $3 \
               AND status = 'active' ORDER BY id LIMIT 1 FOR SHARE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(&command.currency)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound(
            "active marketplace commission policy",
        ))?;
        let market_scale: i16 = policy.try_get("price_scale")?;
        if market_scale != command.currency_scale {
            return Err(StorageError::InvalidData(format!(
                "currency_scale must equal market price_scale {market_scale}"
            )));
        }
        sqlx::query(
            "INSERT INTO vehicle_listings \
             (id, tenant_id, domain_id, asset_id, seller_party_id, asking_amount, currency, \
              currency_scale, commission_bps, commission_collection, status, published_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, 'active', \
                     clock_timestamp(), $11)",
        )
        .bind(command.listing_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.asset_id.into_uuid())
        .bind(command.seller_party_id.into_uuid())
        .bind(command.asking_amount.to_string())
        .bind(&command.currency)
        .bind(command.currency_scale)
        .bind(policy.try_get::<i32, _>("commission_bps")?)
        .bind(policy.try_get::<String, _>("offline_commission_collection")?)
        .bind(command.expires_at)
        .execute(&mut *transaction)
        .await?;
        let listing = listing_in(&mut transaction, command.listing_id).await?;
        transaction.commit().await?;
        Ok(listing)
    }

    /// Stores a buyer's structured requirements.
    pub async fn create_buyer_vehicle_request(
        &self,
        command: &CreateBuyerVehicleRequest,
    ) -> Result<BuyerVehicleRequest, StorageError> {
        if !command.requirements.is_object() {
            return Err(StorageError::InvalidData(
                "requirements must be a JSON object".to_owned(),
            ));
        }
        if command.budget_min.is_some_and(|amount| amount < 0)
            || command.budget_max.is_some_and(|amount| amount <= 0)
            || matches!((command.budget_min, command.budget_max), (Some(min), Some(max)) if min > max)
        {
            return Err(StorageError::InvalidData(
                "buyer budget bounds are invalid".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.buyer_party_id,
            "buyer",
        )
        .await?;
        sqlx::query(
            "INSERT INTO buyer_vehicle_requests \
             (id, tenant_id, domain_id, buyer_party_id, narrative, requirements, budget_min, \
              budget_max, currency, currency_scale) \
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10)",
        )
        .bind(command.request_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.buyer_party_id.into_uuid())
        .bind(&command.narrative)
        .bind(&command.requirements)
        .bind(command.budget_min.map(|value| value.to_string()))
        .bind(command.budget_max.map(|value| value.to_string()))
        .bind(&command.currency)
        .bind(command.currency_scale)
        .execute(&mut *transaction)
        .await?;
        let request = buyer_request_in(&mut transaction, command.request_id).await?;
        transaction.commit().await?;
        Ok(request)
    }

    /// Ranks suitable live listings and atomically records seller impressions.
    pub async fn recommend_vehicle_listings(
        &self,
        command: &RecommendVehicleListings,
    ) -> Result<Vec<RecommendedListing>, StorageError> {
        if command.exposure_key.trim().is_empty() || command.exposure_key.len() > 120 {
            return Err(StorageError::InvalidData(
                "exposure_key must contain 1..=120 bytes".to_owned(),
            ));
        }
        let request = self.buyer_vehicle_request(command.request_id).await?;
        if request.tenant_id != command.tenant_id
            || request.buyer_party_id != command.buyer_party_id
        {
            return Err(StorageError::Forbidden(
                "buyer request does not belong to the authenticated buyer".to_owned(),
            ));
        }
        if request.status != "active" && request.status != "matched" {
            return Err(StorageError::Conflict(
                "buyer request is not open for recommendations".to_owned(),
            ));
        }
        let rows = sqlx::query(
            "SELECT l.id, l.tenant_id, l.domain_id, l.asset_id, l.seller_party_id, \
                    a.display_name, a.attributes, l.asking_amount::text AS asking_amount, \
                    l.currency, l.currency_scale, l.commission_bps, l.commission_collection, \
                    l.status, l.published_at, l.expires_at, l.version \
             FROM vehicle_listings l JOIN assets a \
               ON a.tenant_id = l.tenant_id AND a.domain_id = l.domain_id AND a.id = l.asset_id \
             WHERE l.tenant_id = $1 AND l.domain_id = $2 AND l.currency = $3 \
               AND l.currency_scale = $4 AND l.status = 'active' AND a.status = 'active' \
               AND l.seller_party_id <> $5 \
               AND EXISTS (SELECT 1 FROM marketplace_asset_authorizations aa \
                           WHERE aa.tenant_id = l.tenant_id AND aa.domain_id = l.domain_id \
                             AND aa.asset_id = l.asset_id AND aa.seller_party_id = l.seller_party_id \
                             AND aa.status = 'active') \
               AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp()) \
             ORDER BY l.published_at DESC, l.id LIMIT 500",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(request.domain_id.into_uuid())
        .bind(&request.currency)
        .bind(request.currency_scale)
        .bind(command.buyer_party_id.into_uuid())
        .fetch_all(self.pool())
        .await?;

        let budget_min = exact_optional(request.budget_min.as_deref())?;
        let budget_max = exact_optional(request.budget_max.as_deref())?;
        let mut recommendations = Vec::new();
        for row in rows {
            let listing = listing_from_row(&row)?;
            let asking_amount = exact(&listing.asking_amount)?;
            if let Some((match_score, match_reasons)) = suitability(
                &request.requirements,
                &listing.attributes,
                asking_amount,
                budget_min,
                budget_max,
            ) {
                recommendations.push(RecommendedListing {
                    listing,
                    match_score,
                    match_reasons,
                });
            }
        }
        recommendations.sort_by(|left, right| {
            right
                .match_score
                .total_cmp(&left.match_score)
                .then_with(|| {
                    exact(&left.listing.asking_amount)
                        .unwrap_or(i128::MAX)
                        .cmp(&exact(&right.listing.asking_amount).unwrap_or(i128::MAX))
                })
                .then_with(|| {
                    left.listing
                        .listing_id
                        .as_uuid()
                        .cmp(right.listing.listing_id.as_uuid())
                })
        });
        recommendations.truncate(command.limit.clamp(1, 100));

        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        for recommendation in &recommendations {
            // A caller-controlled session key must not manufacture billable impressions. Scope
            // the server-observed recommendation exposure to one buyer/listing/day instead.
            let exposure_date = OffsetDateTime::now_utc().date();
            insert_exposure(
                &mut transaction,
                &RecordExposure {
                    tenant_id: command.tenant_id,
                    listing_id: recommendation.listing.listing_id,
                    viewer_party_id: Some(command.buyer_party_id),
                    event_type: "impression".to_owned(),
                    source: "buyer_recommendations".to_owned(),
                    deduplication_key: format!(
                        "recommend:{}:{}:{}",
                        command.buyer_party_id, recommendation.listing.listing_id, exposure_date
                    ),
                    occurred_at: OffsetDateTime::now_utc(),
                },
            )
            .await?;
        }
        transaction.commit().await?;
        Ok(recommendations)
    }

    /// Creates an idempotent offline introduction from a compatible listing/request pair.
    pub async fn create_offline_deal(
        &self,
        command: &CreateOfflineDeal,
    ) -> Result<OfflineDealOutcome, StorageError> {
        if command.expires_at <= OffsetDateTime::now_utc() {
            return Err(StorageError::InvalidData(
                "offline deal expiry must be in the future".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.buyer_party_id,
            "buyer",
        )
        .await?;
        if let Some(row) = sqlx::query(
            "SELECT id FROM offline_deals WHERE listing_id = $1 AND buyer_request_id = $2 FOR SHARE",
        )
        .bind(command.listing_id.into_uuid())
        .bind(command.buyer_request_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        {
            let deal = offline_deal_in(
                &mut transaction,
                OfflineDealId::from_uuid(row.try_get("id")?),
                false,
            )
            .await?;
            if deal.tenant_id != command.tenant_id || deal.buyer_party_id != command.buyer_party_id {
                return Err(StorageError::Forbidden(
                    "existing introduction belongs to another buyer".to_owned(),
                ));
            }
            transaction.commit().await?;
            return Ok(OfflineDealOutcome {
                deal,
                duplicate: true,
            });
        }
        let row = sqlx::query(
            "SELECT l.seller_party_id, l.expires_at AS listing_expires_at, \
                    l.asking_amount::text AS asking_amount, l.currency, \
                    l.currency_scale, l.commission_bps, l.commission_collection, a.attributes, \
                    r.buyer_party_id, r.requirements, r.budget_min::text AS budget_min, \
                    r.budget_max::text AS budget_max \
             FROM vehicle_listings l \
             JOIN assets a ON a.tenant_id = l.tenant_id AND a.domain_id = l.domain_id AND a.id = l.asset_id \
             JOIN marketplace_asset_authorizations aa \
               ON aa.tenant_id = l.tenant_id AND aa.domain_id = l.domain_id \
              AND aa.asset_id = l.asset_id AND aa.seller_party_id = l.seller_party_id \
             JOIN buyer_vehicle_requests r ON r.tenant_id = l.tenant_id AND r.domain_id = l.domain_id \
             WHERE l.tenant_id = $1 AND l.id = $2 AND r.id = $3 \
               AND l.status = 'active' AND r.status IN ('active', 'matched') \
               AND l.currency = r.currency AND l.currency_scale = r.currency_scale \
               AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp()) \
               AND aa.status = 'active' FOR SHARE OF aa, l, r",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.listing_id.into_uuid())
        .bind(command.buyer_request_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("compatible active listing and buyer request"))?;
        let buyer_party_id = MarketplacePartyId::from_uuid(row.try_get("buyer_party_id")?);
        if buyer_party_id != command.buyer_party_id {
            return Err(StorageError::Forbidden(
                "buyer request does not belong to the authenticated buyer".to_owned(),
            ));
        }
        let seller_party_id = MarketplacePartyId::from_uuid(row.try_get("seller_party_id")?);
        if seller_party_id == buyer_party_id {
            return Err(StorageError::InvalidData(
                "buyer and seller must be different parties".to_owned(),
            ));
        }
        if let Some(listing_expires_at) =
            row.try_get::<Option<OffsetDateTime>, _>("listing_expires_at")?
            && command.expires_at > listing_expires_at
        {
            return Err(StorageError::Conflict(
                "offline deal expiry cannot outlive the vehicle listing".to_owned(),
            ));
        }
        let asking_amount_text: String = row.try_get("asking_amount")?;
        let asking_amount = exact(&asking_amount_text)?;
        let requirements: Value = row.try_get("requirements")?;
        let attributes: Value = row.try_get("attributes")?;
        let budget_min =
            exact_optional(row.try_get::<Option<String>, _>("budget_min")?.as_deref())?;
        let budget_max =
            exact_optional(row.try_get::<Option<String>, _>("budget_max")?.as_deref())?;
        let (match_score, match_reasons) = suitability(
            &requirements,
            &attributes,
            asking_amount,
            budget_min,
            budget_max,
        )
        .ok_or_else(|| {
            StorageError::Conflict("listing is outside the buyer's budget".to_owned())
        })?;
        let commission_bps: i32 = row.try_get("commission_bps")?;
        let commission_bps_u16 = u16::try_from(commission_bps).map_err(|_| {
            StorageError::InvalidData("commission basis points are out of range".to_owned())
        })?;
        let commission_amount = calculate_commission(asking_amount, commission_bps_u16)
            .map_err(|error| StorageError::InvalidData(error.to_string()))?;
        let currency: String = row.try_get("currency")?;
        let currency_scale: i16 = row.try_get("currency_scale")?;
        let commission_collection: String = row.try_get("commission_collection")?;
        sqlx::query(
            "INSERT INTO offline_deals \
             (id, tenant_id, listing_id, buyer_request_id, seller_party_id, buyer_party_id, \
              match_score, match_reasons, currency, currency_scale, commission_bps, \
              commission_amount, commission_collection, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13, $14)",
        )
        .bind(command.offline_deal_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.listing_id.into_uuid())
        .bind(command.buyer_request_id.into_uuid())
        .bind(seller_party_id.into_uuid())
        .bind(buyer_party_id.into_uuid())
        .bind(match_score)
        .bind(json!(match_reasons))
        .bind(&currency)
        .bind(currency_scale)
        .bind(commission_bps)
        .bind(commission_amount.to_string())
        .bind(&commission_collection)
        .bind(command.expires_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO offline_deal_events \
             (id, tenant_id, offline_deal_id, actor_party_id, event_type, to_status, metadata) \
             VALUES ($1, $2, $3, $4, 'match_proposed', 'proposed', \
                     jsonb_build_object('commission_amount', $5::text, 'commission_bps', $6::int))",
        )
        .bind(Uuid::now_v7())
        .bind(command.tenant_id.into_uuid())
        .bind(command.offline_deal_id.into_uuid())
        .bind(command.buyer_party_id.into_uuid())
        .bind(commission_amount.to_string())
        .bind(commission_bps)
        .execute(&mut *transaction)
        .await?;
        insert_exposure(
            &mut transaction,
            &RecordExposure {
                tenant_id: command.tenant_id,
                listing_id: command.listing_id,
                viewer_party_id: Some(command.buyer_party_id),
                event_type: "inquiry".to_owned(),
                source: "offline_match".to_owned(),
                deduplication_key: format!("offline-inquiry:{}", command.offline_deal_id),
                occurred_at: OffsetDateTime::now_utc(),
            },
        )
        .await?;
        sqlx::query(
            "UPDATE buyer_vehicle_requests SET status = 'matched', version = version + 1 \
             WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.buyer_request_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        let deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
        transaction.commit().await?;
        Ok(OfflineDealOutcome {
            deal,
            duplicate: false,
        })
    }

    /// Returns a durable offline introduction.
    pub async fn offline_deal(
        &self,
        offline_deal_id: OfflineDealId,
    ) -> Result<OfflineDeal, StorageError> {
        let row = sqlx::query(OFFLINE_DEAL_SELECT)
            .bind(offline_deal_id.into_uuid())
            .fetch_optional(self.pool())
            .await?
            .ok_or(StorageError::NotFound("offline deal"))?;
        offline_deal_from_row(&row)
    }

    /// Lists introductions visible to one authenticated demand or supply participant.
    pub async fn offline_deals_for_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
    ) -> Result<Vec<OfflineDeal>, StorageError> {
        let rows = sqlx::query(
            "SELECT id, tenant_id, listing_id, buyer_request_id, seller_party_id, \
                    buyer_party_id, match_score, match_reasons, status, contact_released_at, \
                    seller_contact_consent_at, final_amount::text AS final_amount, currency, \
                    currency_scale, commission_bps, commission_amount::text AS commission_amount, \
                    commission_collection, commission_payment_id, seller_confirmed_at, \
                    buyer_confirmed_at, completed_at, expires_at, version, created_at, updated_at \
             FROM offline_deals WHERE tenant_id = $1 \
               AND (seller_party_id = $2 OR buyer_party_id = $2) \
             ORDER BY created_at DESC LIMIT 100",
        )
        .bind(tenant_id.into_uuid())
        .bind(party_id.into_uuid())
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(offline_deal_from_row).collect()
    }

    /// Records the seller's explicit consent before either side can retrieve phone/WeChat data.
    pub async fn accept_contact_exchange(
        &self,
        command: &AcceptContactExchange,
    ) -> Result<OfflineDeal, StorageError> {
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let deal = offline_deal_in(&mut transaction, command.offline_deal_id, true).await?;
        if deal.tenant_id != command.tenant_id {
            return Err(StorageError::NotFound("offline deal"));
        }
        if deal.seller_party_id != command.seller_party_id {
            return Err(StorageError::Forbidden(
                "only the matched seller can accept contact exchange".to_owned(),
            ));
        }
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.seller_party_id,
            "seller",
        )
        .await?;
        if deal.expires_at <= OffsetDateTime::now_utc()
            || matches!(deal.status.as_str(), "declined" | "expired" | "disputed")
        {
            return Err(StorageError::Conflict(
                "offline introduction is no longer available".to_owned(),
            ));
        }
        if deal.seller_contact_consent_at.is_none() {
            sqlx::query(
                "UPDATE offline_deals SET seller_contact_consent_at = clock_timestamp(), \
                 version = version + 1 WHERE tenant_id = $1 AND id = $2 \
                 AND seller_contact_consent_at IS NULL",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.offline_deal_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO offline_deal_events \
                 (id, tenant_id, offline_deal_id, actor_party_id, event_type, to_status, metadata) \
                 VALUES ($1, $2, $3, $4, 'seller_contact_consent', $5, \
                         jsonb_build_object('channels', jsonb_build_array('phone', 'wechat')))",
            )
            .bind(Uuid::now_v7())
            .bind(command.tenant_id.into_uuid())
            .bind(command.offline_deal_id.into_uuid())
            .bind(command.seller_party_id.into_uuid())
            .bind(&deal.status)
            .execute(&mut *transaction)
            .await?;
        }
        let deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
        transaction.commit().await?;
        Ok(deal)
    }

    /// Records one side's face-to-face price confirmation and completes only after both sides
    /// agree and the disclosed platform commission is captured.
    pub async fn confirm_offline_deal(
        &self,
        command: &ConfirmOfflineDeal,
    ) -> Result<OfflineDealProgress, StorageError> {
        if command.final_amount <= 0 {
            return Err(StorageError::InvalidData(
                "final_amount must be positive".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let mut deal = offline_deal_in(&mut transaction, command.offline_deal_id, true).await?;
        validate_deal_participant(
            &mut transaction,
            &deal,
            command.tenant_id,
            command.actor_party_id,
        )
        .await?;
        if deal.status == "completed" {
            transaction.commit().await?;
            return Ok(OfflineDealProgress {
                deal,
                next_action: "completed".to_owned(),
            });
        }
        if deal.expires_at <= OffsetDateTime::now_utc() {
            return Err(StorageError::Conflict(
                "offline introduction has expired; renew it before confirming the price".to_owned(),
            ));
        }
        ensure_listing_authorized(
            &mut transaction,
            deal.tenant_id,
            deal.listing_id,
            deal.seller_party_id,
        )
        .await?;
        if deal.contact_released_at.is_none()
            || !matches!(
                deal.status.as_str(),
                "contact_released" | "viewing_scheduled" | "negotiating" | "deal_pending"
            )
        {
            return Err(StorageError::Conflict(
                "deal price can be confirmed only after contact release".to_owned(),
            ));
        }
        if deal
            .final_amount
            .as_deref()
            .map(exact)
            .transpose()?
            .is_some_and(|amount| amount != command.final_amount)
        {
            return Err(StorageError::Conflict(
                "both parties must confirm the same final_amount".to_owned(),
            ));
        }
        let commission_bps = u16::try_from(deal.commission_bps).map_err(|_| {
            StorageError::InvalidData("commission basis points are out of range".to_owned())
        })?;
        let commission_amount = calculate_commission(command.final_amount, commission_bps)
            .map_err(|error| StorageError::InvalidData(error.to_string()))?;
        let actor_already_confirmed = if command.actor_party_id == deal.seller_party_id {
            deal.seller_confirmed_at.is_some()
        } else {
            deal.buyer_confirmed_at.is_some()
        };
        if !actor_already_confirmed {
            sqlx::query(
                "UPDATE offline_deals SET final_amount = $2::numeric, commission_amount = $3::numeric, \
                     seller_confirmed_at = CASE WHEN seller_party_id = $4 \
                         THEN clock_timestamp() ELSE seller_confirmed_at END, \
                     buyer_confirmed_at = CASE WHEN buyer_party_id = $4 \
                         THEN clock_timestamp() ELSE buyer_confirmed_at END, \
                     status = 'deal_pending', version = version + 1 WHERE id = $1",
            )
            .bind(command.offline_deal_id.into_uuid())
            .bind(command.final_amount.to_string())
            .bind(commission_amount.to_string())
            .bind(command.actor_party_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT INTO offline_deal_events \
                 (id, tenant_id, offline_deal_id, actor_party_id, event_type, to_status, metadata) \
                 VALUES ($1, $2, $3, $4, 'price_confirmed', 'deal_pending', \
                         jsonb_build_object('final_amount', $5::text, 'commission_amount', $6::text))",
            )
            .bind(Uuid::now_v7())
            .bind(command.tenant_id.into_uuid())
            .bind(command.offline_deal_id.into_uuid())
            .bind(command.actor_party_id.into_uuid())
            .bind(command.final_amount.to_string())
            .bind(commission_amount.to_string())
            .execute(&mut *transaction)
            .await?;
        }
        deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
        if deal.seller_confirmed_at.is_some() && deal.buyer_confirmed_at.is_some() {
            let payment_id = captured_commission_payment(&mut transaction, &deal).await?;
            if commission_amount == 0 || payment_id.is_some() {
                complete_offline_deal_in(
                    &mut transaction,
                    &deal,
                    command.actor_party_id,
                    payment_id,
                )
                .await?;
                deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
            }
        }
        let next_action = next_deal_action(&mut transaction, &deal).await?;
        transaction.commit().await?;
        Ok(OfflineDealProgress { deal, next_action })
    }

    /// Completes a doubly-confirmed deal after an asynchronously captured commission payment.
    pub async fn finalize_offline_deal(
        &self,
        command: &FinalizeOfflineDeal,
    ) -> Result<OfflineDealProgress, StorageError> {
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let mut deal = offline_deal_in(&mut transaction, command.offline_deal_id, true).await?;
        validate_deal_participant(
            &mut transaction,
            &deal,
            command.tenant_id,
            command.actor_party_id,
        )
        .await?;
        if deal.status != "completed" {
            if deal.expires_at <= OffsetDateTime::now_utc() {
                return Err(StorageError::Conflict(
                    "offline introduction has expired; renew it before completion".to_owned(),
                ));
            }
            ensure_listing_authorized(
                &mut transaction,
                deal.tenant_id,
                deal.listing_id,
                deal.seller_party_id,
            )
            .await?;
            if deal.seller_confirmed_at.is_none()
                || deal.buyer_confirmed_at.is_none()
                || deal.final_amount.is_none()
            {
                return Err(StorageError::Conflict(
                    "both parties must confirm the same offline price first".to_owned(),
                ));
            }
            let commission_amount = exact_optional(deal.commission_amount.as_deref())?.unwrap_or(0);
            let payment_id = captured_commission_payment(&mut transaction, &deal).await?;
            if commission_amount > 0 && payment_id.is_none() {
                transaction.commit().await?;
                return Err(StorageError::Conflict(
                    "captured platform commission is required before completion".to_owned(),
                ));
            }
            complete_offline_deal_in(&mut transaction, &deal, command.actor_party_id, payment_id)
                .await?;
            deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
        }
        transaction.commit().await?;
        Ok(OfflineDealProgress {
            deal,
            next_action: "completed".to_owned(),
        })
    }

    /// Proposes an encrypted-location vehicle viewing after contact has been released.
    pub async fn create_viewing_appointment(
        &self,
        command: &CreateViewingAppointment,
    ) -> Result<ViewingAppointment, StorageError> {
        if command.starts_at <= OffsetDateTime::now_utc() || command.ends_at <= command.starts_at {
            return Err(StorageError::InvalidData(
                "viewing must have a future start and a later end".to_owned(),
            ));
        }
        if command.location.nonce.len() != 12 || command.location.key_version <= 0 {
            return Err(StorageError::InvalidData(
                "viewing location envelope is malformed".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let deal = offline_deal_in(&mut transaction, command.offline_deal_id, true).await?;
        validate_deal_participant(
            &mut transaction,
            &deal,
            command.tenant_id,
            command.proposed_by,
        )
        .await?;
        if deal.contact_released_at.is_none()
            || !matches!(
                deal.status.as_str(),
                "contact_released" | "viewing_scheduled" | "negotiating"
            )
        {
            return Err(StorageError::Conflict(
                "viewing can be proposed only after contact release".to_owned(),
            ));
        }
        if deal.expires_at <= OffsetDateTime::now_utc() {
            return Err(StorageError::Conflict(
                "offline introduction has expired; viewing is no longer available".to_owned(),
            ));
        }
        if command.ends_at > deal.expires_at {
            return Err(StorageError::InvalidData(
                "viewing must end before the offline introduction expires".to_owned(),
            ));
        }
        let appointment_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM viewing_appointments \
             WHERE tenant_id = $1 AND offline_deal_id = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.offline_deal_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        if appointment_count >= MAX_VIEWING_APPOINTMENTS_PER_DEAL {
            return Err(StorageError::Conflict(
                "offline introduction has reached its viewing appointment limit".to_owned(),
            ));
        }
        sqlx::query(
            "INSERT INTO viewing_appointments \
             (id, tenant_id, offline_deal_id, proposed_by, starts_at, ends_at, \
              location_ciphertext, location_nonce, encryption_key_version) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(command.viewing_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.offline_deal_id.into_uuid())
        .bind(command.proposed_by.into_uuid())
        .bind(command.starts_at)
        .bind(command.ends_at)
        .bind(&command.location.ciphertext)
        .bind(&command.location.nonce)
        .bind(command.location.key_version)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE offline_deals SET status = 'viewing_scheduled', version = version + 1 \
             WHERE id = $1 AND status = 'contact_released'",
        )
        .bind(command.offline_deal_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO offline_deal_events \
             (id, tenant_id, offline_deal_id, actor_party_id, event_type, to_status, metadata) \
             VALUES ($1, $2, $3, $4, 'viewing_proposed', 'viewing_scheduled', \
                     jsonb_build_object('viewing_id', $5::text, 'starts_at', $6::text))",
        )
        .bind(Uuid::now_v7())
        .bind(command.tenant_id.into_uuid())
        .bind(command.offline_deal_id.into_uuid())
        .bind(command.proposed_by.into_uuid())
        .bind(command.viewing_id.to_string())
        .bind(command.starts_at.to_string())
        .execute(&mut *transaction)
        .await?;
        let viewing = viewing_in(&mut transaction, command.viewing_id, false).await?;
        transaction.commit().await?;
        Ok(viewing)
    }

    /// Lists viewing appointments only to a matched buyer or seller.
    pub async fn viewing_appointments(
        &self,
        tenant_id: TenantId,
        offline_deal_id: OfflineDealId,
        actor_party_id: MarketplacePartyId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<ViewingAppointment>, StorageError> {
        if !(1..=50).contains(&limit) || !(0..=MAX_VIEWING_APPOINTMENTS_PER_DEAL).contains(&offset)
        {
            return Err(StorageError::InvalidData(
                "viewing page must use a limit between 1 and 50 and an offset between 0 and 32"
                    .to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        let deal = offline_deal_in(&mut transaction, offline_deal_id, false).await?;
        validate_deal_participant(&mut transaction, &deal, tenant_id, actor_party_id).await?;
        if deal.expires_at <= OffsetDateTime::now_utc() {
            return Err(StorageError::Conflict(
                "offline introduction has expired; viewing details are no longer available"
                    .to_owned(),
            ));
        }
        let rows = sqlx::query(
            "SELECT id, tenant_id, offline_deal_id, proposed_by, starts_at, ends_at, \
                    location_ciphertext, location_nonce, encryption_key_version, status, \
                    version, created_at, updated_at FROM viewing_appointments \
             WHERE tenant_id = $1 AND offline_deal_id = $2 ORDER BY starts_at, id \
             LIMIT $3 OFFSET $4",
        )
        .bind(tenant_id.into_uuid())
        .bind(offline_deal_id.into_uuid())
        .bind(limit)
        .bind(offset)
        .fetch_all(&mut *transaction)
        .await?;
        let viewings = rows
            .iter()
            .map(viewing_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        transaction.commit().await?;
        Ok(viewings)
    }

    /// Applies a participant-authorized viewing transition.
    pub async fn transition_viewing_appointment(
        &self,
        command: &TransitionViewingAppointment,
    ) -> Result<ViewingAppointment, StorageError> {
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let current = viewing_in(&mut transaction, command.viewing_id, true).await?;
        if current.tenant_id != command.tenant_id {
            return Err(StorageError::NotFound("viewing appointment"));
        }
        let deal = offline_deal_in(&mut transaction, current.offline_deal_id, true).await?;
        validate_deal_participant(
            &mut transaction,
            &deal,
            command.tenant_id,
            command.actor_party_id,
        )
        .await?;
        if deal.expires_at <= OffsetDateTime::now_utc() {
            return Err(StorageError::Conflict(
                "offline introduction has expired; viewing transitions are no longer available"
                    .to_owned(),
            ));
        }
        let target = match (current.status.as_str(), command.action.as_str()) {
            ("proposed", "confirm") if command.actor_party_id != current.proposed_by => "confirmed",
            ("proposed" | "confirmed", "cancel") => "cancelled",
            ("confirmed", "complete") if OffsetDateTime::now_utc() >= current.starts_at => {
                "completed"
            }
            _ => {
                return Err(StorageError::Conflict(format!(
                    "viewing cannot apply {} from {}",
                    command.action, current.status
                )));
            }
        };
        sqlx::query(
            "UPDATE viewing_appointments SET status = $2, version = version + 1 WHERE id = $1",
        )
        .bind(command.viewing_id.into_uuid())
        .bind(target)
        .execute(&mut *transaction)
        .await?;
        if target == "completed" {
            sqlx::query(
                "UPDATE offline_deals SET status = 'negotiating', version = version + 1 \
                 WHERE id = $1 AND status = 'viewing_scheduled'",
            )
            .bind(current.offline_deal_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "INSERT INTO offline_deal_events \
             (id, tenant_id, offline_deal_id, actor_party_id, event_type, metadata) \
             VALUES ($1, $2, $3, $4, $5, jsonb_build_object('viewing_id', $6::text))",
        )
        .bind(Uuid::now_v7())
        .bind(command.tenant_id.into_uuid())
        .bind(current.offline_deal_id.into_uuid())
        .bind(command.actor_party_id.into_uuid())
        .bind(format!("viewing_{target}"))
        .bind(command.viewing_id.to_string())
        .execute(&mut *transaction)
        .await?;
        let viewing = viewing_in(&mut transaction, command.viewing_id, false).await?;
        transaction.commit().await?;
        Ok(viewing)
    }

    /// Releases only the other matched participant's encrypted contact and records every decision.
    pub async fn release_offline_contact(
        &self,
        command: &ReleaseContact,
    ) -> Result<ContactEnvelope, StorageError> {
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let mut deal = offline_deal_in(&mut transaction, command.offline_deal_id, true).await?;
        if deal.tenant_id != command.tenant_id {
            return Err(StorageError::NotFound("offline deal"));
        }
        let target_party_id = if command.actor_party_id == deal.buyer_party_id {
            deal.seller_party_id
        } else if command.actor_party_id == deal.seller_party_id {
            deal.buyer_party_id
        } else {
            return Err(StorageError::Forbidden(
                "contact is available only to the matched buyer and seller".to_owned(),
            ));
        };
        ensure_listing_authorized(
            &mut transaction,
            deal.tenant_id,
            deal.listing_id,
            deal.seller_party_id,
        )
        .await?;
        ensure_party_active(&mut transaction, command.tenant_id, command.actor_party_id).await?;
        if matches!(deal.status.as_str(), "declined" | "expired" | "disputed")
            || deal.expires_at <= OffsetDateTime::now_utc()
        {
            insert_contact_audit(&mut transaction, command, target_party_id, "denied").await?;
            transaction.commit().await?;
            return Err(StorageError::Conflict(
                "offline introduction is no longer available".to_owned(),
            ));
        }
        if deal.seller_contact_consent_at.is_none() {
            insert_contact_audit(&mut transaction, command, target_party_id, "denied").await?;
            transaction.commit().await?;
            return Err(StorageError::Conflict(
                "seller consent is required before contact exchange".to_owned(),
            ));
        }

        let commission_amount = exact_optional(deal.commission_amount.as_deref())?.unwrap_or(0);
        let mut commission_payment_id = deal.commission_payment_id;
        if deal.commission_collection == "preauthorized" && commission_amount > 0 {
            commission_payment_id = sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM payment_intents \
                 WHERE tenant_id = $1 AND offline_deal_id = $2 AND payer_party_id = $3 \
                   AND transaction_channel = 'offline_direct' AND purpose = 'platform_commission' \
                   AND ((status = 'authorized' AND amount >= $4::numeric) \
                     OR (status = 'captured' AND captured_amount = $4::numeric \
                         AND refunded_amount = 0)) \
                   AND commission_amount = CASE WHEN status = 'captured' \
                         THEN captured_amount ELSE amount END \
                   AND currency = $5 AND currency_scale = $6 \
                   AND status IN ('authorized', 'captured') \
                 ORDER BY (status = 'captured') DESC, created_at DESC LIMIT 1 FOR SHARE",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.offline_deal_id.into_uuid())
            .bind(deal.seller_party_id.into_uuid())
            .bind(commission_amount.to_string())
            .bind(&deal.currency)
            .bind(deal.currency_scale)
            .fetch_optional(&mut *transaction)
            .await?
            .map(PaymentId::from_uuid);
            if commission_payment_id.is_none() {
                insert_contact_audit(&mut transaction, command, target_party_id, "denied").await?;
                transaction.commit().await?;
                return Err(StorageError::Conflict(
                    "seller commission authorization is required before contact release".to_owned(),
                ));
            }
        }

        let first_release = deal.contact_released_at.is_none();
        if first_release || deal.commission_payment_id != commission_payment_id {
            sqlx::query(
                "UPDATE offline_deals SET status = CASE WHEN status = 'proposed' \
                         THEN 'contact_released' ELSE status END, \
                     contact_released_at = COALESCE(contact_released_at, clock_timestamp()), \
                     commission_payment_id = COALESCE($2, commission_payment_id), version = version + 1 \
                 WHERE id = $1",
            )
            .bind(command.offline_deal_id.into_uuid())
            .bind(commission_payment_id.map(PaymentId::into_uuid))
            .execute(&mut *transaction)
            .await?;
        }
        if first_release {
            sqlx::query(
                "INSERT INTO offline_deal_events \
                 (id, tenant_id, offline_deal_id, actor_party_id, event_type, from_status, to_status) \
                 VALUES ($1, $2, $3, $4, 'contact_released', 'proposed', 'contact_released')",
            )
            .bind(Uuid::now_v7())
            .bind(command.tenant_id.into_uuid())
            .bind(command.offline_deal_id.into_uuid())
            .bind(command.actor_party_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
            insert_exposure(
                &mut transaction,
                &RecordExposure {
                    tenant_id: command.tenant_id,
                    listing_id: deal.listing_id,
                    viewer_party_id: Some(deal.buyer_party_id),
                    event_type: "matched_contact".to_owned(),
                    source: "offline_match".to_owned(),
                    deduplication_key: format!("matched-contact:{}", deal.offline_deal_id),
                    occurred_at: OffsetDateTime::now_utc(),
                },
            )
            .await?;
        }
        insert_contact_audit(&mut transaction, command, target_party_id, "allowed").await?;
        let contact = sqlx::query(
            "SELECT display_name, contact_ciphertext, contact_nonce, contact_key_version \
             FROM marketplace_parties WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR SHARE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(target_party_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("active counterpart"))?;
        deal = offline_deal_in(&mut transaction, command.offline_deal_id, false).await?;
        let envelope = ContactEnvelope {
            target_party_id,
            display_name: contact.try_get("display_name")?,
            ciphertext: contact.try_get("contact_ciphertext")?,
            nonce: contact.try_get("contact_nonce")?,
            key_version: contact.try_get("contact_key_version")?,
            deal,
        };
        transaction.commit().await?;
        Ok(envelope)
    }

    /// Records an idempotent seller-funnel event.
    pub async fn record_seller_exposure(
        &self,
        command: &RecordExposure,
    ) -> Result<bool, StorageError> {
        validate_exposure(command)?;
        let mut transaction = self.pool().begin().await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM vehicle_listings \
             WHERE tenant_id = $1 AND id = $2 AND status = 'active' \
               AND (expires_at IS NULL OR expires_at > clock_timestamp()))",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.listing_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        if !exists {
            return Err(StorageError::NotFound("vehicle listing"));
        }
        // Client telemetry is useful for seller-facing analytics, but it is not trusted evidence
        // for seller-funded billing. Only server-observed recommendation, inquiry, and contact
        // flows call the billable helper below.
        let inserted = insert_exposure_unbilled(&mut transaction, command).await?;
        transaction.commit().await?;
        Ok(inserted)
    }

    /// Returns a listing's exposure funnel only to its seller.
    pub async fn seller_exposure_metrics(
        &self,
        tenant_id: TenantId,
        listing_id: VehicleListingId,
        seller_party_id: MarketplacePartyId,
    ) -> Result<ExposureMetrics, StorageError> {
        let owner: Uuid = sqlx::query_scalar(
            "SELECT seller_party_id FROM vehicle_listings WHERE tenant_id = $1 AND id = $2",
        )
        .bind(tenant_id.into_uuid())
        .bind(listing_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::NotFound("vehicle listing"))?;
        if owner != seller_party_id.into_uuid() {
            return Err(StorageError::Forbidden(
                "listing exposure is visible only to its seller".to_owned(),
            ));
        }
        let row = sqlx::query(
            "SELECT COUNT(*) FILTER (WHERE event_type = 'impression')::bigint AS impressions, \
                    COUNT(*) FILTER (WHERE event_type = 'detail_view')::bigint AS detail_views, \
                    COUNT(*) FILTER (WHERE event_type = 'favorite')::bigint AS favorites, \
                    COUNT(*) FILTER (WHERE event_type = 'inquiry')::bigint AS inquiries, \
                    COUNT(*) FILTER (WHERE event_type = 'matched_contact')::bigint AS matched_contacts, \
                    COUNT(DISTINCT viewer_party_id)::bigint AS distinct_viewers, \
                    MAX(occurred_at) AS last_event_at \
             FROM seller_exposure_events WHERE tenant_id = $1 AND listing_id = $2",
        )
        .bind(tenant_id.into_uuid())
        .bind(listing_id.into_uuid())
        .fetch_one(self.pool())
        .await?;
        Ok(ExposureMetrics {
            listing_id,
            impressions: row.try_get("impressions")?,
            detail_views: row.try_get("detail_views")?,
            favorites: row.try_get("favorites")?,
            inquiries: row.try_get("inquiries")?,
            matched_contacts: row.try_get("matched_contacts")?,
            distinct_viewers: row.try_get("distinct_viewers")?,
            last_event_at: row.try_get("last_event_at")?,
        })
    }

    /// Creates a seller-funded promotion campaign for a vertical-owned target.
    pub async fn create_seller_promotion(
        &self,
        command: &CreateSellerPromotion,
    ) -> Result<SellerPromotionCampaign, StorageError> {
        validate_promotion_command(command)?;
        let mut transaction = self.pool().begin().await?;
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.sponsor_party_id,
            "seller",
        )
        .await?;
        if command.target_kind == "vehicle_listing" {
            let owner: Uuid = sqlx::query_scalar(
                "SELECT seller_party_id FROM vehicle_listings \
                 WHERE tenant_id = $1 AND id = $2",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(Uuid::parse_str(&command.target_key).map_err(|_| {
                StorageError::InvalidData("vehicle listing target_key is invalid".to_owned())
            })?)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StorageError::NotFound("vehicle listing"))?;
            if owner != command.sponsor_party_id.into_uuid() {
                return Err(StorageError::Forbidden(
                    "seller promotion target is not owned by the sponsor".to_owned(),
                ));
            }
        }
        sqlx::query(
            "INSERT INTO seller_promotion_campaigns \
             (id, tenant_id, sponsor_party_id, target_kind, target_key, policy, pricing_model, \
              currency, currency_scale, unit_price, budget_amount, settings, status, starts_at, ends_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $12, 'active', $13, $14)",
        )
        .bind(command.campaign_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.sponsor_party_id.into_uuid())
        .bind(&command.target_kind)
        .bind(&command.target_key)
        .bind(&command.policy)
        .bind(&command.pricing_model)
        .bind(&command.currency)
        .bind(command.currency_scale)
        .bind(command.unit_price.to_string())
        .bind(command.budget_amount.to_string())
        .bind(&command.settings)
        .bind(command.starts_at)
        .bind(command.ends_at)
        .execute(&mut *transaction)
        .await?;
        let campaign = seller_promotion_in(&mut transaction, command.campaign_id, false).await?;
        transaction.commit().await?;
        Ok(campaign)
    }

    /// Returns a campaign only to its funding seller.
    pub async fn seller_promotion(
        &self,
        tenant_id: TenantId,
        campaign_id: PromotionCampaignId,
        sponsor_party_id: MarketplacePartyId,
    ) -> Result<SellerPromotionCampaign, StorageError> {
        let campaign = seller_promotion_in_pool(self.pool(), campaign_id).await?;
        if campaign.tenant_id != tenant_id {
            return Err(StorageError::NotFound("seller promotion campaign"));
        }
        if campaign.sponsor_party_id != sponsor_party_id {
            return Err(StorageError::Forbidden(
                "promotion metrics are visible only to its sponsor".to_owned(),
            ));
        }
        Ok(campaign)
    }

    /// Records one idempotent campaign event and atomically accrues the seller's spend.
    pub async fn record_seller_promotion_event(
        &self,
        command: &RecordSellerPromotionEvent,
    ) -> Result<SellerPromotionEventOutcome, StorageError> {
        validate_promotion_event(command)?;
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let outcome = record_seller_promotion_event_in(&mut transaction, command).await?;
        transaction.commit().await?;
        Ok(outcome)
    }

    async fn buyer_vehicle_request(
        &self,
        request_id: BuyerRequestId,
    ) -> Result<BuyerVehicleRequest, StorageError> {
        let row = sqlx::query(BUYER_REQUEST_SELECT)
            .bind(request_id.into_uuid())
            .fetch_optional(self.pool())
            .await?
            .ok_or(StorageError::NotFound("buyer vehicle request"))?;
        buyer_request_from_row(&row)
    }
}

const PROMOTION_SELECT: &str = "SELECT id, tenant_id, sponsor_party_id, target_kind, target_key, \
        policy, pricing_model, currency, currency_scale, unit_price::text AS unit_price, \
        budget_amount::text AS budget_amount, spent_amount::text AS spent_amount, billable_units, \
        settings, status, starts_at, ends_at, version, created_at, updated_at \
        FROM seller_promotion_campaigns WHERE id = $1";

const PROMOTION_SELECT_FOR_UPDATE: &str = "SELECT id, tenant_id, sponsor_party_id, target_kind, target_key, \
        policy, pricing_model, currency, currency_scale, unit_price::text AS unit_price, \
        budget_amount::text AS budget_amount, spent_amount::text AS spent_amount, billable_units, \
        settings, status, starts_at, ends_at, version, created_at, updated_at \
        FROM seller_promotion_campaigns WHERE id = $1 FOR UPDATE";

async fn seller_promotion_in(
    transaction: &mut Transaction<'_, Postgres>,
    campaign_id: PromotionCampaignId,
    for_update: bool,
) -> Result<SellerPromotionCampaign, StorageError> {
    let statement = if for_update {
        PROMOTION_SELECT_FOR_UPDATE
    } else {
        PROMOTION_SELECT
    };
    let row = sqlx::query(statement)
        .bind(campaign_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StorageError::NotFound("seller promotion campaign"))?;
    seller_promotion_from_row(&row)
}

async fn seller_promotion_in_pool(
    pool: &PgPool,
    campaign_id: PromotionCampaignId,
) -> Result<SellerPromotionCampaign, StorageError> {
    let row = sqlx::query(PROMOTION_SELECT)
        .bind(campaign_id.into_uuid())
        .fetch_optional(pool)
        .await?
        .ok_or(StorageError::NotFound("seller promotion campaign"))?;
    seller_promotion_from_row(&row)
}

fn seller_promotion_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<SellerPromotionCampaign, StorageError> {
    Ok(SellerPromotionCampaign {
        campaign_id: PromotionCampaignId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        sponsor_party_id: MarketplacePartyId::from_uuid(row.try_get("sponsor_party_id")?),
        target_kind: row.try_get("target_kind")?,
        target_key: row.try_get("target_key")?,
        policy: row.try_get("policy")?,
        pricing_model: row.try_get("pricing_model")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        unit_price: row.try_get("unit_price")?,
        budget_amount: row.try_get("budget_amount")?,
        spent_amount: row.try_get("spent_amount")?,
        billable_units: row.try_get("billable_units")?,
        settings: row.try_get("settings")?,
        status: row.try_get("status")?,
        starts_at: row.try_get("starts_at")?,
        ends_at: row.try_get("ends_at")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn record_seller_promotion_event_in(
    transaction: &mut Transaction<'_, Postgres>,
    command: &RecordSellerPromotionEvent,
) -> Result<SellerPromotionEventOutcome, StorageError> {
    let campaign_id = command.campaign_id;
    let campaign = seller_promotion_in(transaction, campaign_id, true).await?;
    if campaign.tenant_id != command.tenant_id {
        return Err(StorageError::NotFound("seller promotion campaign"));
    }
    if let Some(row) = sqlx::query(
        "SELECT charged_amount::text AS charged_amount FROM seller_promotion_events \
         WHERE tenant_id = $1 AND campaign_id = $2 AND deduplication_key = $3",
    )
    .bind(command.tenant_id.into_uuid())
    .bind(campaign_id.into_uuid())
    .bind(&command.deduplication_key)
    .fetch_optional(&mut **transaction)
    .await?
    {
        return Ok(SellerPromotionEventOutcome {
            campaign,
            duplicate: true,
            charged_amount: row.try_get("charged_amount")?,
        });
    }
    let now = OffsetDateTime::now_utc();
    if campaign.status != "active" {
        return Err(StorageError::Conflict(
            "seller promotion campaign is not active".to_owned(),
        ));
    }
    if campaign.starts_at > now {
        return Err(StorageError::Conflict(
            "seller promotion campaign has not started".to_owned(),
        ));
    }
    if campaign.ends_at.is_some_and(|ends_at| ends_at <= now) {
        sqlx::query(
            "UPDATE seller_promotion_campaigns SET status = 'expired', version = version + 1 \
             WHERE tenant_id = $1 AND id = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(campaign_id.into_uuid())
        .execute(&mut **transaction)
        .await?;
        return Err(StorageError::Conflict(
            "seller promotion campaign has expired".to_owned(),
        ));
    }

    let prior_units = campaign.billable_units;
    let unit_price = exact(&campaign.unit_price)?;
    let budget_amount = exact(&campaign.budget_amount)?;
    let spent_amount = exact(&campaign.spent_amount)?;
    let (unit_increment, calculated_charge) = promotion_charge(
        &campaign.pricing_model,
        &command.event_type,
        prior_units,
        unit_price,
    );
    let new_units = prior_units
        .checked_add(unit_increment)
        .ok_or_else(|| StorageError::InvalidData("promotion event count overflow".to_owned()))?;
    let remaining = budget_amount.saturating_sub(spent_amount);
    let charged_amount = calculated_charge.min(remaining).max(0);
    let new_spent = spent_amount
        .checked_add(charged_amount)
        .ok_or_else(|| StorageError::InvalidData("promotion spend overflow".to_owned()))?;
    let next_status = if new_spent >= budget_amount {
        "exhausted"
    } else {
        "active"
    };
    sqlx::query(
        "UPDATE seller_promotion_campaigns SET spent_amount = $3::numeric, billable_units = $4, \
         status = $5, version = version + 1 WHERE tenant_id = $1 AND id = $2",
    )
    .bind(command.tenant_id.into_uuid())
    .bind(campaign_id.into_uuid())
    .bind(new_spent.to_string())
    .bind(new_units)
    .bind(next_status)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO seller_promotion_events \
         (id, tenant_id, campaign_id, actor_party_id, event_type, billable_units, charged_amount, \
          currency, currency_scale, deduplication_key, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11)",
    )
    .bind(Uuid::now_v7())
    .bind(command.tenant_id.into_uuid())
    .bind(campaign_id.into_uuid())
    .bind(command.actor_party_id.map(MarketplacePartyId::into_uuid))
    .bind(&command.event_type)
    .bind(unit_increment)
    .bind(charged_amount.to_string())
    .bind(&campaign.currency)
    .bind(campaign.currency_scale)
    .bind(&command.deduplication_key)
    .bind(command.occurred_at)
    .execute(&mut **transaction)
    .await?;
    let campaign = seller_promotion_in(transaction, campaign_id, false).await?;
    Ok(SellerPromotionEventOutcome {
        campaign,
        duplicate: false,
        charged_amount: charged_amount.to_string(),
    })
}

fn promotion_charge(
    pricing_model: &str,
    event_type: &str,
    prior_units: i64,
    unit_price: i128,
) -> (i64, i128) {
    match pricing_model {
        "cpm" if event_type == "impression" => {
            let new_units = prior_units.saturating_add(1);
            let previous_blocks = i128::from(prior_units / 1_000);
            let new_blocks = i128::from(new_units / 1_000);
            (1, (new_blocks - previous_blocks).saturating_mul(unit_price))
        }
        "cpc" if event_type == "click" => (1, unit_price),
        // CPL charges on the qualified inquiry. A later contact exchange is still recorded for
        // audit, but is not double-billed for the same seller promotion funnel.
        "cpl" if event_type == "qualified_lead" => (1, unit_price),
        "fixed" if event_type == "qualified_lead" && prior_units == 0 => (1, unit_price),
        _ => (0, 0),
    }
}

async fn bill_promotions_for_exposure(
    transaction: &mut Transaction<'_, Postgres>,
    command: &RecordExposure,
) -> Result<(), StorageError> {
    let event_type = match command.event_type.as_str() {
        "impression" => "impression",
        "detail_view" | "favorite" => "click",
        "inquiry" => "qualified_lead",
        "matched_contact" => "contact_exchange",
        _ => return Ok(()),
    };
    let campaigns = sqlx::query(
        "SELECT id FROM seller_promotion_campaigns \
         WHERE tenant_id = $1 AND target_kind = 'vehicle_listing' AND target_key = $2 \
           AND status = 'active' AND starts_at <= $3 \
           AND (ends_at IS NULL OR ends_at > $3) FOR UPDATE",
    )
    .bind(command.tenant_id.into_uuid())
    .bind(command.listing_id.to_string())
    .bind(command.occurred_at)
    .fetch_all(&mut **transaction)
    .await?;
    for row in campaigns {
        let campaign_id = PromotionCampaignId::from_uuid(row.try_get("id")?);
        let promotion_event = RecordSellerPromotionEvent {
            tenant_id: command.tenant_id,
            campaign_id,
            actor_party_id: command.viewer_party_id,
            event_type: event_type.to_owned(),
            deduplication_key: format!("exposure:{}", command.deduplication_key),
            occurred_at: command.occurred_at,
        };
        match record_seller_promotion_event_in(transaction, &promotion_event).await {
            Ok(_) | Err(StorageError::Conflict(_)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn validate_promotion_command(command: &CreateSellerPromotion) -> Result<(), StorageError> {
    if command.target_kind.trim().is_empty()
        || command.target_kind.len() > 64
        || command.target_key.trim().is_empty()
        || command.target_key.len() > 256
    {
        return Err(StorageError::InvalidData(
            "promotion target is invalid".to_owned(),
        ));
    }
    if !matches!(command.policy.as_str(), "seller_promotion" | "hybrid") {
        return Err(StorageError::InvalidData(
            "promotion policy must be seller_promotion or hybrid".to_owned(),
        ));
    }
    if !matches!(
        command.pricing_model.as_str(),
        "fixed" | "cpm" | "cpc" | "cpl"
    ) {
        return Err(StorageError::InvalidData(
            "unsupported promotion pricing model".to_owned(),
        ));
    }
    validate_currency_code(&command.currency)?;
    if command.currency_scale < 0
        || command.currency_scale > 18
        || command.unit_price < 0
        || command.budget_amount <= 0
        || command
            .ends_at
            .is_some_and(|ends_at| ends_at <= command.starts_at)
    {
        return Err(StorageError::InvalidData(
            "promotion price, budget, or time window is invalid".to_owned(),
        ));
    }
    if !command.settings.is_object() {
        return Err(StorageError::InvalidData(
            "promotion settings must be a JSON object".to_owned(),
        ));
    }
    Ok(())
}

fn validate_promotion_event(command: &RecordSellerPromotionEvent) -> Result<(), StorageError> {
    if !matches!(
        command.event_type.as_str(),
        "impression" | "click" | "qualified_lead" | "contact_exchange"
    ) {
        return Err(StorageError::InvalidData(
            "unsupported seller promotion event".to_owned(),
        ));
    }
    if command.deduplication_key.trim().is_empty() || command.deduplication_key.len() > 240 {
        return Err(StorageError::InvalidData(
            "promotion deduplication key is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_currency_code(currency: &str) -> Result<(), StorageError> {
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(StorageError::InvalidData(
            "currency must be a three-letter uppercase ISO code".to_owned(),
        ));
    }
    Ok(())
}

const LISTING_SELECT: &str = "SELECT l.id, l.tenant_id, l.domain_id, l.asset_id, l.seller_party_id, \
        a.display_name, a.attributes, l.asking_amount::text AS asking_amount, l.currency, \
        l.currency_scale, l.commission_bps, l.commission_collection, l.status, l.published_at, \
        l.expires_at, l.version FROM vehicle_listings l JOIN assets a \
        ON a.tenant_id = l.tenant_id AND a.domain_id = l.domain_id AND a.id = l.asset_id WHERE l.id = $1";

const BUYER_REQUEST_SELECT: &str = "SELECT id, tenant_id, domain_id, buyer_party_id, narrative, requirements, \
        budget_min::text AS budget_min, budget_max::text AS budget_max, currency, currency_scale, \
        status, version, created_at FROM buyer_vehicle_requests WHERE id = $1";

const OFFLINE_DEAL_SELECT: &str = "SELECT id, tenant_id, listing_id, buyer_request_id, seller_party_id, \
        buyer_party_id, match_score, match_reasons, status, contact_released_at, \
        seller_contact_consent_at, \
        final_amount::text AS final_amount, currency, currency_scale, commission_bps, \
        commission_amount::text AS commission_amount, commission_collection, commission_payment_id, \
        seller_confirmed_at, buyer_confirmed_at, completed_at, expires_at, version, created_at, updated_at \
        FROM offline_deals WHERE id = $1";

const VIEWING_SELECT: &str = "SELECT id, tenant_id, offline_deal_id, proposed_by, starts_at, ends_at, \
        location_ciphertext, location_nonce, encryption_key_version, status, version, created_at, \
        updated_at FROM viewing_appointments WHERE id = $1";

async fn listing_in(
    transaction: &mut Transaction<'_, Postgres>,
    listing_id: VehicleListingId,
) -> Result<VehicleListing, StorageError> {
    let row = sqlx::query(LISTING_SELECT)
        .bind(listing_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StorageError::NotFound("vehicle listing"))?;
    listing_from_row(&row)
}

fn listing_from_row(row: &sqlx::postgres::PgRow) -> Result<VehicleListing, StorageError> {
    Ok(VehicleListing {
        listing_id: VehicleListingId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        asset_id: AssetId::from_uuid(row.try_get("asset_id")?),
        seller_party_id: MarketplacePartyId::from_uuid(row.try_get("seller_party_id")?),
        display_name: row.try_get("display_name")?,
        attributes: row.try_get("attributes")?,
        asking_amount: row.try_get("asking_amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        commission_bps: row.try_get("commission_bps")?,
        commission_collection: row.try_get("commission_collection")?,
        status: row.try_get("status")?,
        published_at: row.try_get("published_at")?,
        expires_at: row.try_get("expires_at")?,
        version: row.try_get("version")?,
    })
}

fn listing_submission_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<MarketplaceListingSubmission, StorageError> {
    Ok(MarketplaceListingSubmission {
        submission_id: row.try_get("id")?,
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        seller_party_id: MarketplacePartyId::from_uuid(row.try_get("seller_party_id")?),
        asset_schema_id: AssetSchemaId::from_uuid(row.try_get("asset_schema_id")?),
        external_key: row.try_get("external_key")?,
        display_name: row.try_get("display_name")?,
        attributes: row.try_get("attributes")?,
        asking_amount: row.try_get("asking_amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        status: row.try_get("status")?,
        reviewed_by: row.try_get("reviewed_by")?,
        review_reason: row.try_get("review_reason")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn buyer_request_in(
    transaction: &mut Transaction<'_, Postgres>,
    request_id: BuyerRequestId,
) -> Result<BuyerVehicleRequest, StorageError> {
    let row = sqlx::query(BUYER_REQUEST_SELECT)
        .bind(request_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StorageError::NotFound("buyer vehicle request"))?;
    buyer_request_from_row(&row)
}

fn buyer_request_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<BuyerVehicleRequest, StorageError> {
    Ok(BuyerVehicleRequest {
        request_id: BuyerRequestId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        buyer_party_id: MarketplacePartyId::from_uuid(row.try_get("buyer_party_id")?),
        narrative: row.try_get("narrative")?,
        requirements: row.try_get("requirements")?,
        budget_min: row.try_get("budget_min")?,
        budget_max: row.try_get("budget_max")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn offline_deal_in(
    transaction: &mut Transaction<'_, Postgres>,
    offline_deal_id: OfflineDealId,
    for_update: bool,
) -> Result<OfflineDeal, StorageError> {
    let statement = if for_update {
        format!("{OFFLINE_DEAL_SELECT} FOR UPDATE")
    } else {
        OFFLINE_DEAL_SELECT.to_owned()
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(offline_deal_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StorageError::NotFound("offline deal"))?;
    offline_deal_from_row(&row)
}

fn offline_deal_from_row(row: &sqlx::postgres::PgRow) -> Result<OfflineDeal, StorageError> {
    Ok(OfflineDeal {
        offline_deal_id: OfflineDealId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        listing_id: VehicleListingId::from_uuid(row.try_get("listing_id")?),
        buyer_request_id: BuyerRequestId::from_uuid(row.try_get("buyer_request_id")?),
        seller_party_id: MarketplacePartyId::from_uuid(row.try_get("seller_party_id")?),
        buyer_party_id: MarketplacePartyId::from_uuid(row.try_get("buyer_party_id")?),
        match_score: row.try_get("match_score")?,
        match_reasons: row.try_get("match_reasons")?,
        status: row.try_get("status")?,
        contact_released_at: row.try_get("contact_released_at")?,
        seller_contact_consent_at: row.try_get("seller_contact_consent_at")?,
        final_amount: row.try_get("final_amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        commission_bps: row.try_get("commission_bps")?,
        commission_amount: row.try_get("commission_amount")?,
        commission_collection: row.try_get("commission_collection")?,
        commission_payment_id: row
            .try_get::<Option<Uuid>, _>("commission_payment_id")?
            .map(PaymentId::from_uuid),
        seller_confirmed_at: row.try_get("seller_confirmed_at")?,
        buyer_confirmed_at: row.try_get("buyer_confirmed_at")?,
        completed_at: row.try_get("completed_at")?,
        expires_at: row.try_get("expires_at")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn viewing_in(
    transaction: &mut Transaction<'_, Postgres>,
    viewing_id: ViewingAppointmentId,
    for_update: bool,
) -> Result<ViewingAppointment, StorageError> {
    let statement = if for_update {
        format!("{VIEWING_SELECT} FOR UPDATE")
    } else {
        VIEWING_SELECT.to_owned()
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(viewing_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StorageError::NotFound("viewing appointment"))?;
    viewing_from_row(&row)
}

fn viewing_from_row(row: &sqlx::postgres::PgRow) -> Result<ViewingAppointment, StorageError> {
    Ok(ViewingAppointment {
        viewing_id: ViewingAppointmentId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        offline_deal_id: OfflineDealId::from_uuid(row.try_get("offline_deal_id")?),
        proposed_by: MarketplacePartyId::from_uuid(row.try_get("proposed_by")?),
        starts_at: row.try_get("starts_at")?,
        ends_at: row.try_get("ends_at")?,
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        location_ciphertext: row.try_get("location_ciphertext")?,
        location_nonce: row.try_get("location_nonce")?,
        encryption_key_version: row.try_get("encryption_key_version")?,
    })
}

fn party_from_row(row: &sqlx::postgres::PgRow) -> Result<MarketplaceParty, StorageError> {
    Ok(MarketplaceParty {
        party_id: MarketplacePartyId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        external_key: row.try_get("external_key")?,
        display_name: row.try_get("display_name")?,
        role: row.try_get("role")?,
        marketplace_sides: row.try_get("marketplace_sides")?,
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
    })
}

fn asset_authorization_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<MarketplaceAssetAuthorization, StorageError> {
    Ok(MarketplaceAssetAuthorization {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        asset_id: AssetId::from_uuid(row.try_get("asset_id")?),
        seller_party_id: MarketplacePartyId::from_uuid(row.try_get("seller_party_id")?),
        status: row.try_get("status")?,
        authorized_by: row.try_get("authorized_by")?,
        reason: row.try_get("reason")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn ensure_listing_authorized(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    listing_id: VehicleListingId,
    seller_party_id: MarketplacePartyId,
) -> Result<(), StorageError> {
    // Lock both records in the same authorization -> listing order used by revocation and
    // listing creation. This turns every downstream contact/settlement check into a commit-time
    // authorization boundary instead of an unlocked boolean read.
    let authorized_listing: Option<Uuid> = sqlx::query_scalar(
        "SELECT l.id FROM vehicle_listings l \
         JOIN marketplace_asset_authorizations aa \
           ON aa.tenant_id = l.tenant_id AND aa.domain_id = l.domain_id \
          AND aa.asset_id = l.asset_id AND aa.seller_party_id = l.seller_party_id \
         WHERE l.tenant_id = $1 AND l.id = $2 AND l.seller_party_id = $3 \
           AND l.status IN ('active', 'reserved') AND aa.status = 'active' \
           AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp()) \
         FOR SHARE OF aa, l",
    )
    .bind(tenant_id.into_uuid())
    .bind(listing_id.into_uuid())
    .bind(seller_party_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?;
    if authorized_listing.is_none() {
        return Err(StorageError::Conflict(
            "listing authorization is no longer active".to_owned(),
        ));
    }
    Ok(())
}

async fn ensure_party_role(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    party_id: MarketplacePartyId,
    required_role: &str,
) -> Result<(), StorageError> {
    let role: String = sqlx::query_scalar(
        "SELECT role FROM marketplace_parties \
         WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR SHARE",
    )
    .bind(tenant_id.into_uuid())
    .bind(party_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("active marketplace party"))?;
    if role != required_role && role != "both" {
        return Err(StorageError::Forbidden(format!(
            "{required_role} role is required"
        )));
    }
    Ok(())
}

async fn ensure_party_active(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    party_id: MarketplacePartyId,
) -> Result<(), StorageError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM marketplace_parties \
         WHERE tenant_id = $1 AND id = $2 AND status = 'active')",
    )
    .bind(tenant_id.into_uuid())
    .bind(party_id.into_uuid())
    .fetch_one(&mut **transaction)
    .await?;
    if !exists {
        return Err(StorageError::Forbidden(
            "marketplace party is not active".to_owned(),
        ));
    }
    Ok(())
}

async fn validate_deal_participant(
    transaction: &mut Transaction<'_, Postgres>,
    deal: &OfflineDeal,
    tenant_id: TenantId,
    actor_party_id: MarketplacePartyId,
) -> Result<(), StorageError> {
    if deal.tenant_id != tenant_id {
        return Err(StorageError::NotFound("offline deal"));
    }
    if actor_party_id != deal.seller_party_id && actor_party_id != deal.buyer_party_id {
        return Err(StorageError::Forbidden(
            "offline deal is available only to its matched buyer and seller".to_owned(),
        ));
    }
    ensure_party_active(transaction, tenant_id, actor_party_id).await
}

async fn captured_commission_payment(
    transaction: &mut Transaction<'_, Postgres>,
    deal: &OfflineDeal,
) -> Result<Option<PaymentId>, StorageError> {
    let commission_amount = exact_optional(deal.commission_amount.as_deref())?.unwrap_or(0);
    if commission_amount == 0 {
        return Ok(None);
    }
    let payment_id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM payment_intents \
         WHERE tenant_id = $1 AND offline_deal_id = $2 AND payer_party_id = $3 \
           AND transaction_channel = 'offline_direct' AND purpose = 'platform_commission' \
           AND status = 'captured' AND captured_amount = $4::numeric AND refunded_amount = 0 \
           AND commission_amount = captured_amount AND currency = $5 AND currency_scale = $6 \
         ORDER BY created_at DESC LIMIT 1 FOR SHARE",
    )
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.offline_deal_id.into_uuid())
    .bind(deal.seller_party_id.into_uuid())
    .bind(commission_amount.to_string())
    .bind(&deal.currency)
    .bind(deal.currency_scale)
    .fetch_optional(&mut **transaction)
    .await?
    .map(PaymentId::from_uuid);
    Ok(payment_id)
}

async fn next_deal_action(
    transaction: &mut Transaction<'_, Postgres>,
    deal: &OfflineDeal,
) -> Result<String, StorageError> {
    if deal.status == "completed" {
        return Ok("completed".to_owned());
    }
    if deal.seller_confirmed_at.is_none() || deal.buyer_confirmed_at.is_none() {
        return Ok("counterparty_confirmation".to_owned());
    }
    let commission_amount = exact_optional(deal.commission_amount.as_deref())?.unwrap_or(0);
    if commission_amount == 0 {
        return Ok("completed".to_owned());
    }
    let authorization_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM payment_intents \
         WHERE tenant_id = $1 AND offline_deal_id = $2 AND payer_party_id = $3 \
           AND transaction_channel = 'offline_direct' AND purpose = 'platform_commission' \
           AND status = 'authorized' AND amount >= $4::numeric \
           AND commission_amount = amount AND currency = $5 AND currency_scale = $6)",
    )
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.offline_deal_id.into_uuid())
    .bind(deal.seller_party_id.into_uuid())
    .bind(commission_amount.to_string())
    .bind(&deal.currency)
    .bind(deal.currency_scale)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(if authorization_exists {
        "capture_platform_commission".to_owned()
    } else {
        "seller_settle_platform_commission".to_owned()
    })
}

async fn complete_offline_deal_in(
    transaction: &mut Transaction<'_, Postgres>,
    deal: &OfflineDeal,
    actor_party_id: MarketplacePartyId,
    payment_id: Option<PaymentId>,
) -> Result<(), StorageError> {
    if deal.expires_at <= OffsetDateTime::now_utc() {
        return Err(StorageError::Conflict(
            "offline introduction has expired; renew it before completion".to_owned(),
        ));
    }
    sqlx::query(
        "UPDATE offline_deals SET status = 'completed', commission_payment_id = $2, \
             completed_at = clock_timestamp(), version = version + 1 WHERE id = $1",
    )
    .bind(deal.offline_deal_id.into_uuid())
    .bind(payment_id.map(PaymentId::into_uuid))
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "UPDATE vehicle_listings SET status = 'sold', version = version + 1 \
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.listing_id.into_uuid())
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "UPDATE buyer_vehicle_requests SET status = 'closed', version = version + 1 \
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.buyer_request_id.into_uuid())
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "UPDATE offline_deals SET status = 'expired', version = version + 1 \
         WHERE tenant_id = $1 AND listing_id = $2 AND id <> $3 \
           AND status NOT IN ('completed', 'declined', 'expired', 'disputed')",
    )
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.listing_id.into_uuid())
    .bind(deal.offline_deal_id.into_uuid())
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "INSERT INTO offline_deal_events \
         (id, tenant_id, offline_deal_id, actor_party_id, event_type, from_status, to_status, metadata) \
         VALUES ($1, $2, $3, $4, 'deal_completed', $5, 'completed', \
                 jsonb_build_object('settlement', 'offline_direct', \
                     'commission_payment_id', $6::text))",
    )
    .bind(Uuid::now_v7())
    .bind(deal.tenant_id.into_uuid())
    .bind(deal.offline_deal_id.into_uuid())
    .bind(actor_party_id.into_uuid())
    .bind(&deal.status)
    .bind(payment_id.map(|id| id.to_string()))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn insert_exposure(
    transaction: &mut Transaction<'_, Postgres>,
    command: &RecordExposure,
) -> Result<bool, StorageError> {
    insert_exposure_with_billing(transaction, command, true).await
}

async fn insert_exposure_unbilled(
    transaction: &mut Transaction<'_, Postgres>,
    command: &RecordExposure,
) -> Result<bool, StorageError> {
    insert_exposure_with_billing(transaction, command, false).await
}

async fn insert_exposure_with_billing(
    transaction: &mut Transaction<'_, Postgres>,
    command: &RecordExposure,
    bill: bool,
) -> Result<bool, StorageError> {
    validate_exposure(command)?;
    if bill {
        // Re-check the authorization at the billing boundary. Recommendation results are read
        // before this transaction begins, so an operator revocation can otherwise race a stale
        // result into a seller-funded exposure charge.
        let eligible_listing: Option<Uuid> = sqlx::query_scalar(
            "SELECT l.id FROM vehicle_listings l \
             JOIN marketplace_asset_authorizations aa \
               ON aa.tenant_id = l.tenant_id AND aa.domain_id = l.domain_id \
              AND aa.asset_id = l.asset_id AND aa.seller_party_id = l.seller_party_id \
             WHERE l.tenant_id = $1 AND l.id = $2 \
               AND l.status IN ('active', 'reserved') AND aa.status = 'active' \
               AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp()) \
             FOR SHARE OF aa, l",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.listing_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?;
        if eligible_listing.is_none() {
            return Err(StorageError::Conflict(
                "listing authorization is no longer active".to_owned(),
            ));
        }
    }
    let result = sqlx::query(
        "INSERT INTO seller_exposure_events \
         (id, tenant_id, listing_id, viewer_party_id, event_type, source, deduplication_key, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (tenant_id, deduplication_key) DO NOTHING",
    )
    .bind(Uuid::now_v7())
    .bind(command.tenant_id.into_uuid())
    .bind(command.listing_id.into_uuid())
    .bind(command.viewer_party_id.map(MarketplacePartyId::into_uuid))
    .bind(&command.event_type)
    .bind(&command.source)
    .bind(&command.deduplication_key)
    .bind(command.occurred_at)
    .execute(&mut **transaction)
    .await?;
    let inserted = result.rows_affected() == 1;
    if inserted && bill {
        bill_promotions_for_exposure(transaction, command).await?;
    }
    Ok(inserted)
}

async fn insert_contact_audit(
    transaction: &mut Transaction<'_, Postgres>,
    command: &ReleaseContact,
    target_party_id: MarketplacePartyId,
    decision: &str,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO contact_access_audit \
         (id, tenant_id, offline_deal_id, actor_party_id, target_party_id, decision, purpose, \
          request_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, 'match_contact', $7)",
    )
    .bind(Uuid::now_v7())
    .bind(command.tenant_id.into_uuid())
    .bind(command.offline_deal_id.into_uuid())
    .bind(command.actor_party_id.into_uuid())
    .bind(target_party_id.into_uuid())
    .bind(decision)
    .bind(&command.request_fingerprint)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn validate_role(role: &str) -> Result<(), StorageError> {
    if matches!(role, "buyer" | "seller" | "both") {
        Ok(())
    } else {
        Err(StorageError::InvalidData(
            "role must be buyer, seller, or both".to_owned(),
        ))
    }
}

fn validate_marketplace_sides(sides: &[String]) -> Result<(), StorageError> {
    if sides.is_empty()
        || sides.len() > 2
        || sides
            .iter()
            .any(|side| !matches!(side.as_str(), "demand" | "supply"))
        || sides
            .iter()
            .any(|side| sides.iter().filter(|candidate| *candidate == side).count() > 1)
    {
        return Err(StorageError::InvalidData(
            "marketplace_sides must contain one or both unique kernel sides".to_owned(),
        ));
    }
    Ok(())
}

fn validate_platform_scope(
    scope_domain_id: Option<DomainId>,
    platform_path: &str,
) -> Result<(), StorageError> {
    let valid_path = platform_path == "/"
        || (platform_path.len() <= 512
            && platform_path.strip_prefix('/').is_some_and(|value| {
                !value.is_empty()
                    && value.split('/').all(|segment| {
                        !segment.is_empty()
                            && segment.bytes().all(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                            })
                    })
            }));
    if !valid_path || (platform_path == "/" && scope_domain_id.is_some()) {
        return Err(StorageError::InvalidData(
            "platform path and domain scope do not match".to_owned(),
        ));
    }
    if platform_path != "/" && scope_domain_id.is_none() {
        return Err(StorageError::InvalidData(
            "child platform capabilities require a domain scope".to_owned(),
        ));
    }
    Ok(())
}

fn validate_exposure(command: &RecordExposure) -> Result<(), StorageError> {
    if !matches!(
        command.event_type.as_str(),
        "impression" | "detail_view" | "favorite" | "inquiry" | "matched_contact"
    ) {
        return Err(StorageError::InvalidData(
            "unsupported seller exposure event".to_owned(),
        ));
    }
    if command.source.trim().is_empty()
        || command.source.len() > 100
        || command.deduplication_key.trim().is_empty()
        || command.deduplication_key.len() > 200
    {
        return Err(StorageError::InvalidData(
            "exposure source or deduplication key is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn suitability(
    requirements: &Value,
    attributes: &Value,
    asking_amount: i128,
    budget_min: Option<i128>,
    budget_max: Option<i128>,
) -> Option<(f64, Vec<String>)> {
    if budget_min.is_some_and(|minimum| asking_amount < minimum)
        || budget_max.is_some_and(|maximum| asking_amount > maximum)
    {
        return None;
    }
    let required = requirements.as_object()?;
    let offered = attributes.as_object()?;
    let mut matched = 0_usize;
    let mut reasons = Vec::new();
    for (key, expected) in required {
        if expected.is_null() {
            continue;
        }
        if offered.get(key) == Some(expected) {
            matched += 1;
            reasons.push(format!("attribute_match:{key}"));
        }
    }
    let considered = required.values().filter(|value| !value.is_null()).count();
    let attribute_score = if considered == 0 {
        1.0
    } else {
        matched as f64 / considered as f64
    };
    let budget_score = match (budget_min, budget_max) {
        (Some(minimum), Some(maximum)) if maximum > minimum => {
            let midpoint = minimum.saturating_add((maximum - minimum) / 2);
            let half_range = ((maximum - minimum) as f64 / 2.0).max(1.0);
            (1.0 - (asking_amount - midpoint).unsigned_abs() as f64 / half_range).clamp(0.0, 1.0)
        }
        (None, Some(maximum)) if maximum > 0 => {
            (1.0 - asking_amount as f64 / maximum as f64).clamp(0.0, 1.0)
        }
        _ => 1.0,
    };
    reasons.push("within_budget".to_owned());
    let score = if considered == 0 {
        budget_score
    } else {
        attribute_score.mul_add(0.8, budget_score * 0.2)
    };
    Some((score.clamp(0.0, 1.0), reasons))
}

fn exact(value: &str) -> Result<i128, StorageError> {
    value
        .parse()
        .map_err(|_| StorageError::InvalidData("numeric value exceeds exact i128".to_owned()))
}

fn exact_optional(value: Option<&str>) -> Result<Option<i128>, StorageError> {
    value.map(exact).transpose()
}

async fn serializable(transaction: &mut Transaction<'_, Postgres>) -> Result<(), StorageError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suitability_filters_budget_and_explains_attribute_matches() {
        let requirements = json!({"make": "Volvo", "fuel": "electric"});
        let attributes = json!({"make": "Volvo", "fuel": "hybrid"});
        let (score, reasons) = suitability(
            &requirements,
            &attributes,
            250_000,
            Some(200_000),
            Some(300_000),
        )
        .expect("listing is inside budget");
        assert!((0.59..=0.61).contains(&score));
        assert_eq!(reasons, ["attribute_match:make", "within_budget"]);
        assert!(suitability(&requirements, &attributes, 350_000, None, Some(300_000)).is_none());
    }

    #[test]
    fn promotion_pricing_is_deterministic_and_does_not_double_bill_contact() {
        assert_eq!(
            promotion_charge("cpm", "impression", 999, 50_000),
            (1, 50_000)
        );
        assert_eq!(promotion_charge("cpm", "impression", 1_000, 50_000), (1, 0));
        assert_eq!(
            promotion_charge("cpm", "impression", 1_999, 50_000),
            (1, 50_000)
        );
        assert_eq!(promotion_charge("cpm", "click", 1_000, 50_000), (0, 0));
        assert_eq!(
            promotion_charge("cpl", "qualified_lead", 0, 5_000),
            (1, 5_000)
        );
        assert_eq!(
            promotion_charge("cpl", "contact_exchange", 1, 5_000),
            (0, 0)
        );
    }

    #[test]
    fn public_listing_serialization_does_not_expose_seller_identity() {
        let listing = VehicleListing {
            listing_id: VehicleListingId::new(),
            tenant_id: TenantId::new(),
            domain_id: DomainId::new(),
            asset_id: AssetId::new(),
            seller_party_id: MarketplacePartyId::new(),
            display_name: "测试供给".to_owned(),
            attributes: json!({"kind": "example"}),
            asking_amount: "100".to_owned(),
            currency: "CNY".to_owned(),
            currency_scale: 2,
            commission_bps: 100,
            commission_collection: "offline_direct".to_owned(),
            status: "active".to_owned(),
            published_at: None,
            expires_at: None,
            version: 1,
        };
        let value = serde_json::to_value(listing).expect("listing should serialize");
        assert!(
            !value
                .as_object()
                .expect("object response")
                .contains_key("seller_party_id")
        );
    }
}
