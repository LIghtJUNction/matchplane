//! Privacy-aware vehicle discovery and offline introduction persistence.

use matchplane_domain::{
    AssetId, BuyerRequestId, DomainId, MarketplacePartyId, OfflineDealId, PaymentId, TenantId,
    VehicleListingId, ViewingAppointmentId,
};
use matchplane_payments::calculate_commission;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgStore, StorageError};

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
    /// Tenant-local identity key.
    pub external_key: String,
    /// Public display name.
    pub display_name: String,
    /// `buyer`, `seller`, or `both`.
    pub role: String,
    /// SHA-256 hash of the high-entropy capability token returned at registration.
    pub access_token_hash: Vec<u8>,
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
    /// Marketplace role.
    pub role: String,
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
    /// Seller identity.
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

/// Authenticated recommendation query with an exposure-deduplication key.
#[derive(Debug)]
pub struct RecommendVehicleListings {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Buyer request being served.
    pub request_id: BuyerRequestId,
    /// Authenticated buyer.
    pub buyer_party_id: MarketplacePartyId,
    /// Unique key for one rendered recommendation surface.
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

impl PgStore {
    /// Registers a protected marketplace party.
    pub async fn create_marketplace_party(
        &self,
        command: &CreateMarketplaceParty,
    ) -> Result<MarketplaceParty, StorageError> {
        validate_role(&command.role)?;
        if command.access_token_hash.len() != 32
            || command.contact.nonce.len() != 12
            || command.contact.key_version <= 0
        {
            return Err(StorageError::InvalidData(
                "party credential or contact envelope is malformed".to_owned(),
            ));
        }
        let row = sqlx::query(
            "INSERT INTO marketplace_parties \
             (id, tenant_id, external_key, display_name, role, access_token_hash, \
              contact_ciphertext, contact_nonce, contact_key_version) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             RETURNING id, tenant_id, external_key, display_name, role, status, version, created_at",
        )
        .bind(command.party_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(&command.external_key)
        .bind(&command.display_name)
        .bind(&command.role)
        .bind(&command.access_token_hash)
        .bind(&command.contact.ciphertext)
        .bind(&command.contact.nonce)
        .bind(command.contact.key_version)
        .fetch_one(self.pool())
        .await?;
        party_from_row(&row)
    }

    /// Authenticates a high-entropy party capability within one tenant.
    pub async fn authenticate_marketplace_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        access_token_hash: &[u8],
    ) -> Result<AuthenticatedParty, StorageError> {
        if access_token_hash.len() != 32 {
            return Err(StorageError::Forbidden(
                "invalid party credential".to_owned(),
            ));
        }
        let row = sqlx::query(
            "SELECT id, tenant_id, role FROM marketplace_parties \
             WHERE tenant_id = $1 AND id = $2 AND access_token_hash = $3 AND status = 'active'",
        )
        .bind(tenant_id.into_uuid())
        .bind(party_id.into_uuid())
        .bind(access_token_hash)
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| StorageError::Forbidden("invalid party credential".to_owned()))?;
        Ok(AuthenticatedParty {
            party_id: MarketplacePartyId::from_uuid(row.try_get("id")?),
            tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
            role: row.try_get("role")?,
        })
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
        ensure_party_role(
            &mut transaction,
            command.tenant_id,
            command.seller_party_id,
            "seller",
        )
        .await?;
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
        for recommendation in &recommendations {
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
                        command.request_id, command.exposure_key, recommendation.listing.listing_id
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
            "SELECT l.seller_party_id, l.asking_amount::text AS asking_amount, l.currency, \
                    l.currency_scale, l.commission_bps, l.commission_collection, a.attributes, \
                    r.buyer_party_id, r.requirements, r.budget_min::text AS budget_min, \
                    r.budget_max::text AS budget_max \
             FROM vehicle_listings l \
             JOIN assets a ON a.tenant_id = l.tenant_id AND a.domain_id = l.domain_id AND a.id = l.asset_id \
             JOIN buyer_vehicle_requests r ON r.tenant_id = l.tenant_id AND r.domain_id = l.domain_id \
             WHERE l.tenant_id = $1 AND l.id = $2 AND r.id = $3 \
               AND l.status = 'active' AND r.status IN ('active', 'matched') \
               AND l.currency = r.currency AND l.currency_scale = r.currency_scale \
               AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp()) FOR SHARE OF l, r",
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
    ) -> Result<Vec<ViewingAppointment>, StorageError> {
        let mut transaction = self.pool().begin().await?;
        let deal = offline_deal_in(&mut transaction, offline_deal_id, false).await?;
        validate_deal_participant(&mut transaction, &deal, tenant_id, actor_party_id).await?;
        let rows = sqlx::query(
            "SELECT id, tenant_id, offline_deal_id, proposed_by, starts_at, ends_at, \
                    location_ciphertext, location_nonce, encryption_key_version, status, \
                    version, created_at, updated_at FROM viewing_appointments \
             WHERE tenant_id = $1 AND offline_deal_id = $2 ORDER BY starts_at, id",
        )
        .bind(tenant_id.into_uuid())
        .bind(offline_deal_id.into_uuid())
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
            "SELECT EXISTS(SELECT 1 FROM vehicle_listings WHERE tenant_id = $1 AND id = $2)",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.listing_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        if !exists {
            return Err(StorageError::NotFound("vehicle listing"));
        }
        let inserted = insert_exposure(&mut transaction, command).await?;
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
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
    })
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
    validate_exposure(command)?;
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
    Ok(result.rows_affected() == 1)
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
}
