//! Domain-neutral demand/supply persistence.
//!
//! This module is the stable kernel used by vertical adapters.  It deliberately does not know
//! whether an offer is a vehicle, a service, a rental, a property, or something else.  The
//! vertical owns the JSON schema and any retrieval/Agent implementation; the kernel owns scope,
//! idempotency, lifecycle and introduction invariants.

use matchplane_domain::{
    AssetId, DomainId, MarketplaceBehaviorEventId, MarketplaceIntentId, MarketplaceOfferId,
    MarketplacePartyId, MarketplaceSalesHandoffId, MatchIntroductionId, TenantId,
};
use matchplane_matching::{
    StructuredDataBudget, StructuredScorePolicy, TokenPolicy, score_structured,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgStore, StorageError};

const MAX_NARRATIVE_BYTES: usize = 10_000;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 240;
const MAX_EXTERNAL_KEY_BYTES: usize = 256;
const MAX_DISPLAY_NAME_BYTES: usize = 500;
// The storage adapter refuses unbounded rank work: SQL admits at most 500 rows per side and the
// public API returns at most 100 after deterministic scoring.
const MARKETPLACE_MATCH_MAX_INPUT_CANDIDATES: i64 = 500;
const MARKETPLACE_MATCH_MAX_RESULTS: usize = 100;
// Preserve the legacy 256 raw-token/sorted-token behavior while bounding direct storage callers
// to production request-sized structured data and introduction-compatible explanations.
const MARKETPLACE_MATCH_POLICY: StructuredScorePolicy = StructuredScorePolicy::new(
    TokenPolicy::storage_compatible(256),
    StructuredDataBudget::new(256, 500, 128 * 1_024, 16 * 1_024, 32),
    8,
    8,
    500,
);

/// A domain-neutral demand or supply intent submitted by one participant.
#[derive(Debug)]
pub struct CreateMarketplaceIntent {
    /// Stable id supplied by the caller for retries.
    pub intent_id: MarketplaceIntentId,
    /// Tenant authority scope.
    pub tenant_id: TenantId,
    /// Vertical/domain schema scope.
    pub domain_id: DomainId,
    /// Participant owning the intent.
    pub participant_id: MarketplacePartyId,
    /// `demand` or `supply`; labels such as buyer/seller remain vertical-owned.
    pub side: String,
    /// Human narrative forwarded to retrieval/Agent tooling.
    pub narrative: String,
    /// Schema-validated, domain-owned attributes.
    pub attributes: Value,
    /// Domain-owned non-price terms and constraints.
    pub terms: Value,
    /// Explicit opt-in for contact-free discovery by supply-side Agents.
    pub supply_discovery_enabled: bool,
    /// Optional deadline for the discovery opt-in.
    pub supply_discovery_expires_at: Option<OffsetDateTime>,
    /// Caller retry key.
    pub idempotency_key: String,
    /// Optional expiry for a time-bounded intent.
    pub expires_at: Option<OffsetDateTime>,
}

/// Persisted intent plus duplicate status for idempotent callers.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceIntentOutcome {
    /// Durable intent.
    #[serde(flatten)]
    pub intent: MarketplaceIntent,
    /// `true` when an identical prior request was returned.
    pub duplicate: bool,
}

/// Public domain-neutral intent projection.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceIntent {
    /// Intent identifier.
    pub intent_id: MarketplaceIntentId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Participant owning the intent.
    pub participant_id: MarketplacePartyId,
    /// `demand` or `supply`.
    pub side: String,
    /// Human narrative.
    pub narrative: String,
    /// Domain-owned structured attributes.
    pub attributes: Value,
    /// Domain-owned terms.
    pub terms: Value,
    /// Whether a bounded, contact-free summary may be ranked for supply-side Agents.
    pub supply_discovery_enabled: bool,
    /// Optional deadline for the discovery opt-in.
    #[serde(with = "time::serde::rfc3339::option")]
    pub supply_discovery_expires_at: Option<OffsetDateTime>,
    /// Idempotency key retained for audit/replay.
    pub idempotency_key: String,
    /// `active`, `matched`, `closed`, or `expired`.
    pub status: String,
    /// Optional expiry.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Replaces the latest durable state for one open intent.  The caller supplies the prior
/// version so a second tab or Agent cannot silently overwrite newer requirements.
#[derive(Debug)]
pub struct UpdateMarketplaceIntent {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub intent_id: MarketplaceIntentId,
    pub narrative: String,
    pub attributes: Value,
    pub terms: Value,
    pub expected_version: i64,
}

/// Domain-neutral latest user understanding.  The JSON profile is owned by the active
/// subplatform/Agent; the root only versions and scopes it.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceIntentProfile {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub profile: Value,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug)]
pub struct UpsertMarketplaceIntentProfile {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub profile: Value,
}

#[derive(Debug)]
pub struct RecordMarketplaceBehaviorEvent {
    pub event_id: MarketplaceBehaviorEventId,
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub intent_id: Option<MarketplaceIntentId>,
    pub offer_id: Option<MarketplaceOfferId>,
    pub event_type: String,
    pub reason: Option<String>,
    pub metadata: Value,
    pub idempotency_key: String,
    pub occurred_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceBehaviorEventOutcome {
    pub event_id: MarketplaceBehaviorEventId,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceOfferPreference {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub offer_id: MarketplaceOfferId,
    pub state: String,
    pub reason: Option<String>,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug)]
pub struct SetMarketplaceOfferPreference {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub offer_id: MarketplaceOfferId,
    pub state: String,
    pub reason: Option<String>,
}

#[derive(Debug)]
pub struct CreateMarketplaceSalesHandoff {
    pub handoff_id: MarketplaceSalesHandoffId,
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub intent_id: Option<MarketplaceIntentId>,
    pub summary: Value,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceSalesHandoff {
    pub handoff_id: MarketplaceSalesHandoffId,
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub participant_id: MarketplacePartyId,
    pub intent_id: Option<MarketplaceIntentId>,
    pub summary: Value,
    pub status: String,
    pub idempotency_key: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// A supply-side offer.  `asset_id` is optional so a vertical may represent a service or other
/// non-catalogue supply while still reusing the same introduction kernel.
#[derive(Debug)]
pub struct CreateMarketplaceOffer {
    /// Stable id supplied by the caller for retries.
    pub offer_id: MarketplaceOfferId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Supply participant.
    pub supply_party_id: MarketplacePartyId,
    /// Optional root-catalogue asset reference.
    pub asset_id: Option<AssetId>,
    /// Seller-owned idempotency/catalogue key.
    pub external_key: String,
    /// Public name supplied by the vertical/supply participant.
    pub display_name: String,
    /// Schema-validated domain attributes.
    pub attributes: Value,
    /// Domain-owned terms such as price, availability, or delivery constraints.
    pub terms: Value,
    /// Optional expiry.
    pub expires_at: Option<OffsetDateTime>,
}

/// Replaces the seller-owned public fields for one editable offer. The authenticated gateway
/// derives `actor_party_id`, `can_manage_domain`, and `platform_path`; clients never grant those
/// fields to themselves.
#[derive(Debug)]
pub struct UpdateMarketplaceOffer {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub actor_party_id: MarketplacePartyId,
    pub can_manage_domain: bool,
    pub platform_path: String,
    pub request_id: Option<String>,
    pub offer_id: MarketplaceOfferId,
    pub display_name: String,
    pub attributes: Value,
    pub terms: Value,
    pub expected_version: i64,
}

/// Withdraws one draft or active offer without deleting its audit history.
#[derive(Debug)]
pub struct WithdrawMarketplaceOffer {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub actor_party_id: MarketplacePartyId,
    pub can_manage_domain: bool,
    pub platform_path: String,
    pub request_id: Option<String>,
    pub offer_id: MarketplaceOfferId,
    pub expected_version: i64,
}

/// Persisted offer plus duplicate status for idempotent callers.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceOfferOutcome {
    /// Durable offer.
    #[serde(flatten)]
    pub offer: MarketplaceOffer,
    /// `true` when an identical prior request was returned.
    pub duplicate: bool,
}

/// Public domain-neutral supply offer projection.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceOffer {
    /// Offer identifier.
    pub offer_id: MarketplaceOfferId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Supply participant.
    pub supply_party_id: MarketplacePartyId,
    /// Optional catalogue asset.
    pub asset_id: Option<AssetId>,
    /// Supply-participant-owned key.
    pub external_key: String,
    /// Public name.
    pub display_name: String,
    /// Structured attributes.
    pub attributes: Value,
    /// Structured terms.
    pub terms: Value,
    /// `draft`, `active`, `reserved`, `sold`, `withdrawn`, or `expired`.
    pub status: String,
    /// Publication time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub published_at: Option<OffsetDateTime>,
    /// Optional expiry.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Candidate returned by a deterministic fallback matcher.  A subplatform Agent/retrieval
/// provider may produce the same shape with its own score and reasons before introduction.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceOfferCandidate {
    /// Canonical offer.
    #[serde(flatten)]
    pub offer: MarketplaceOffer,
    /// Advisory score captured at selection time.
    pub score: f64,
    /// Bounded explainable reasons.
    pub reasons: Vec<String>,
    /// Bounded risk/trade-off notes supplied by the vertical or retrieval Agent.
    pub risks: Vec<String>,
}

/// Contact-free demand projection returned to a supply-side Agent after explicit opt-in.
///
/// The participant identifier and idempotency key are intentionally omitted.  A seller may rank
/// an interested demand, but must not use discovery as a way to enumerate identities or bypass
/// the introduction/contact-consent state machine.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceDemandCandidate {
    /// Canonical demand intent identifier.
    pub intent_id: MarketplaceIntentId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Demand narrative supplied by the participant.
    pub narrative: String,
    /// Domain-owned structured attributes.
    pub attributes: Value,
    /// Domain-owned terms.
    pub terms: Value,
    /// Advisory score captured at query time.
    pub score: f64,
    /// Bounded, explainable reasons.
    pub reasons: Vec<String>,
    /// Demand expiry, if any.
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Authenticated candidate query for one demand intent.
#[derive(Debug)]
pub struct MatchMarketplaceOffers {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Demand intent.
    pub intent_id: MarketplaceIntentId,
    /// Authenticated demand participant.
    pub participant_id: MarketplacePartyId,
    /// Maximum candidates.
    pub limit: usize,
}

/// Authenticated candidate query for one active supply offer.
#[derive(Debug)]
pub struct MatchMarketplaceDemands {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Active offer used as the supply-side ranking reference.
    pub offer_id: MarketplaceOfferId,
    /// Authenticated supply participant.
    pub participant_id: MarketplacePartyId,
    /// Maximum candidates.
    pub limit: usize,
}

/// Owner-only change to the contact-free demand discovery choice.
#[derive(Debug)]
pub struct UpdateMarketplaceDemandDiscovery {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Demand participant that owns the intent.
    pub participant_id: MarketplacePartyId,
    /// Intent being changed.
    pub intent_id: MarketplaceIntentId,
    /// New explicit discovery choice.
    pub enabled: bool,
    /// Optional deadline for the new choice.
    pub expires_at: Option<OffsetDateTime>,
}

/// Command to create a consent-controlled introduction between an intent and an offer.
#[derive(Debug)]
pub struct CreateMarketplaceIntroduction {
    /// Stable id supplied by the caller for retries.
    pub introduction_id: MatchIntroductionId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Demand intent selected by the Agent.
    pub intent_id: MarketplaceIntentId,
    /// Supply offer selected by the Agent.
    pub offer_id: MarketplaceOfferId,
    /// Authenticated demand participant.
    pub participant_id: MarketplacePartyId,
    /// Advisory score returned by the selecting Agent/provider.
    pub score: f64,
    /// Advisory explainable reasons returned by the selecting Agent/provider.
    pub reasons: Vec<String>,
    /// Caller retry key.
    pub idempotency_key: String,
    /// Hard introduction expiry.
    pub expires_at: OffsetDateTime,
}

/// Demand-side request to open the contact-consent step for an introduction.
#[derive(Debug)]
pub struct RequestMarketplaceContact {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Introduction selected by the demand participant.
    pub introduction_id: MatchIntroductionId,
    /// Authenticated demand participant.
    pub demand_party_id: MarketplacePartyId,
    /// Caller-stable key used to make the transition and audit event retry-safe.
    pub idempotency_key: String,
    /// Non-secret request fingerprint used for audit correlation.
    pub request_fingerprint: Option<Vec<u8>>,
}

/// Supply-side consent to exchange the two participants' protected contact records.
#[derive(Debug)]
pub struct AcceptMarketplaceContact {
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Introduction awaiting consent.
    pub introduction_id: MatchIntroductionId,
    /// Authenticated supply participant.
    pub supply_party_id: MarketplacePartyId,
    /// Caller-stable key used to make the transition and audit event retry-safe.
    pub idempotency_key: String,
}

/// Encrypted counterpart contact returned only after the generic consent checks pass.
#[derive(Debug)]
pub struct MarketplaceContactEnvelope {
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
    /// Durable introduction state after the release decision.
    pub introduction: MarketplaceIntroduction,
}

/// Persisted introduction plus duplicate status.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceIntroductionOutcome {
    /// Durable introduction.
    #[serde(flatten)]
    pub introduction: MarketplaceIntroduction,
    /// `true` when an identical prior request was returned.
    pub duplicate: bool,
}

/// Public introduction projection.  Contact values are intentionally absent; a separate consent
/// operation must release encrypted participant contact data.
#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceIntroduction {
    /// Introduction identifier.
    pub introduction_id: MatchIntroductionId,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Demand intent.
    pub intent_id: MarketplaceIntentId,
    /// Supply offer.
    pub offer_id: MarketplaceOfferId,
    /// Demand participant.
    pub demand_party_id: MarketplacePartyId,
    /// Supply participant.
    pub supply_party_id: MarketplacePartyId,
    /// Advisory score captured at introduction time.
    pub score: f64,
    /// Frozen explanation.
    pub reasons: Value,
    /// Introduction lifecycle state.
    pub status: String,
    /// Supply-side contact consent timestamp.
    #[serde(with = "time::serde::rfc3339::option")]
    pub supply_contact_consent_at: Option<OffsetDateTime>,
    /// Contact release timestamp.
    #[serde(with = "time::serde::rfc3339::option")]
    pub contact_released_at: Option<OffsetDateTime>,
    /// Caller retry key.
    pub idempotency_key: String,
    /// Hard expiry.
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    /// Optimistic version.
    pub version: i64,
    /// Creation time.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Last update time.
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

impl PgStore {
    /// Creates a domain-neutral demand/supply intent idempotently.
    pub async fn create_marketplace_intent(
        &self,
        command: &CreateMarketplaceIntent,
    ) -> Result<MarketplaceIntentOutcome, StorageError> {
        validate_intent(command)?;
        if let Some(row) = sqlx::query(INTENT_SELECT)
            .bind(command.tenant_id.into_uuid())
            .bind(command.participant_id.into_uuid())
            .bind(&command.idempotency_key)
            .fetch_optional(self.pool())
            .await?
        {
            let intent = intent_from_row(&row)?;
            ensure_same_intent(&intent, command)?;
            return Ok(MarketplaceIntentOutcome {
                intent,
                duplicate: true,
            });
        }

        let row = sqlx::query(
            "INSERT INTO marketplace_intents
             (id, tenant_id, domain_id, participant_id, side, narrative, attributes, terms,
              supply_discovery_enabled, supply_discovery_expires_at, idempotency_key, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id, tenant_id, domain_id, participant_id, side, narrative, attributes,
                       terms, supply_discovery_enabled, supply_discovery_expires_at,
                       idempotency_key, status, expires_at, version, created_at, updated_at",
        )
        .bind(command.intent_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(&command.side)
        .bind(&command.narrative)
        .bind(&command.attributes)
        .bind(&command.terms)
        .bind(command.supply_discovery_enabled)
        .bind(command.supply_discovery_expires_at)
        .bind(&command.idempotency_key)
        .bind(command.expires_at)
        .fetch_one(self.pool())
        .await?;
        Ok(MarketplaceIntentOutcome {
            intent: intent_from_row(&row)?,
            duplicate: false,
        })
    }

    /// Returns one intent in its tenant scope.
    pub async fn marketplace_intent(
        &self,
        tenant_id: TenantId,
        intent_id: MarketplaceIntentId,
    ) -> Result<MarketplaceIntent, StorageError> {
        let row = sqlx::query(INTENT_SELECT_BY_ID)
            .bind(tenant_id.into_uuid())
            .bind(intent_id.into_uuid())
            .fetch_optional(self.pool())
            .await?
            .ok_or(StorageError::NotFound("marketplace intent"))?;
        intent_from_row(&row)
    }

    /// Creates a supply-owned offer in `draft` state.  Only an operator or a vertical-owned
    /// moderation workflow may activate it for discovery.
    pub async fn create_marketplace_offer(
        &self,
        command: &CreateMarketplaceOffer,
    ) -> Result<MarketplaceOfferOutcome, StorageError> {
        validate_offer(command)?;
        if let Some(row) = sqlx::query(OFFER_SELECT)
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(command.supply_party_id.into_uuid())
            .bind(&command.external_key)
            .fetch_optional(self.pool())
            .await?
        {
            let offer = offer_from_row(&row)?;
            ensure_same_offer(&offer, command)?;
            return Ok(MarketplaceOfferOutcome {
                offer,
                duplicate: true,
            });
        }

        if let Some(asset_id) = command.asset_id {
            let authorized: bool = sqlx::query_scalar(
                "SELECT EXISTS(
                    SELECT 1 FROM marketplace_asset_authorizations
                    WHERE tenant_id = $1 AND domain_id = $2 AND asset_id = $3
                      AND seller_party_id = $4 AND status = 'active'
                )",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(asset_id.into_uuid())
            .bind(command.supply_party_id.into_uuid())
            .fetch_one(self.pool())
            .await?;
            if !authorized {
                return Err(StorageError::Forbidden(
                    "supply participant is not authorized to publish this asset".to_owned(),
                ));
            }
        }

        let row = sqlx::query(
            "INSERT INTO marketplace_offers
             (id, tenant_id, domain_id, supply_party_id, asset_id, external_key, display_name,
              attributes, terms, status, published_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', NULL, $10)
             RETURNING id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                       display_name, attributes, terms, status, published_at, expires_at,
                       version, created_at, updated_at",
        )
        .bind(command.offer_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.supply_party_id.into_uuid())
        .bind(command.asset_id.map(AssetId::into_uuid))
        .bind(&command.external_key)
        .bind(&command.display_name)
        .bind(&command.attributes)
        .bind(&command.terms)
        .bind(command.expires_at)
        .fetch_one(self.pool())
        .await?;
        Ok(MarketplaceOfferOutcome {
            offer: offer_from_row(&row)?,
            duplicate: false,
        })
    }

    /// Lists a supply participant's own offers in one tenant/domain scope.
    ///
    /// This is intentionally separate from the active matching query: a supply participant must
    /// be able to see draft and withdrawn offers before moderation publishes them, without
    /// exposing another participant's private inventory.
    pub async fn marketplace_offers_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        supply_party_id: MarketplacePartyId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError> {
        if !(1..=100).contains(&limit) || !(0..=10_000).contains(&offset) {
            return Err(StorageError::InvalidData(
                "marketplace offer page must use limit 1..=100 and offset 0..=10000".to_owned(),
            ));
        }
        let rows = sqlx::query(
            "SELECT id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                    display_name, attributes, terms, status, published_at, expires_at,
                    version, created_at, updated_at
             FROM marketplace_offers
             WHERE tenant_id = $1 AND domain_id = $2 AND supply_party_id = $3
             ORDER BY updated_at DESC, id DESC LIMIT $4 OFFSET $5",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(supply_party_id.into_uuid())
        .bind(limit)
        .bind(offset)
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(offer_from_row).collect()
    }

    /// Lists all offers in one domain for an authenticated store operator.
    pub async fn marketplace_offers_for_domain(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<MarketplaceOffer>, StorageError> {
        if !(1..=100).contains(&limit) || !(0..=10_000).contains(&offset) {
            return Err(StorageError::InvalidData(
                "marketplace offer page must use limit 1..=100 and offset 0..=10000".to_owned(),
            ));
        }
        let rows = sqlx::query(
            "SELECT id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                    display_name, attributes, terms, status, published_at, expires_at,
                    version, created_at, updated_at
             FROM marketplace_offers
             WHERE tenant_id = $1 AND domain_id = $2
             ORDER BY updated_at DESC, id DESC LIMIT $3 OFFSET $4",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(limit)
        .bind(offset)
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(offer_from_row).collect()
    }

    /// Replaces editable offer content. Published or withdrawn offers return to `draft` so new
    /// content cannot bypass moderation; a concurrent writer is rejected by optimistic version.
    pub async fn update_marketplace_offer(
        &self,
        command: &UpdateMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError> {
        validate_offer_update(command)?;
        let mut transaction = self.pool().begin().await?;
        let current = lock_marketplace_offer(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.offer_id,
        )
        .await?;
        authorize_offer_management(&current, command.actor_party_id, command.can_manage_domain)?;
        ensure_offer_version(&current, command.expected_version)?;
        if !matches!(current.status.as_str(), "draft" | "active" | "withdrawn") {
            return Err(StorageError::Conflict(
                "marketplace offer cannot be edited in its current status".to_owned(),
            ));
        }

        let row = sqlx::query(
            "UPDATE marketplace_offers
                SET display_name = $4, attributes = $5, terms = $6, status = 'draft',
                    published_at = NULL, version = version + 1,
                    updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND domain_id = $2 AND id = $3
              RETURNING id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                        display_name, attributes, terms, status, published_at, expires_at,
                        version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .bind(&command.display_name)
        .bind(&command.attributes)
        .bind(&command.terms)
        .fetch_one(&mut *transaction)
        .await?;
        let offer = offer_from_row(&row)?;
        record_offer_audit(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.actor_party_id,
            &command.platform_path,
            command.request_id.as_deref(),
            "marketplace.offer.updated",
            &current,
            &offer,
        )
        .await?;
        enqueue_marketplace_offer_projection(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.offer_id,
            offer.version,
        )
        .await?;
        transaction.commit().await?;
        Ok(offer)
    }

    /// Withdraws one draft or active offer while retaining the canonical record and history.
    pub async fn withdraw_marketplace_offer(
        &self,
        command: &WithdrawMarketplaceOffer,
    ) -> Result<MarketplaceOffer, StorageError> {
        let mut transaction = self.pool().begin().await?;
        let current = lock_marketplace_offer(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.offer_id,
        )
        .await?;
        authorize_offer_management(&current, command.actor_party_id, command.can_manage_domain)?;
        ensure_offer_version(&current, command.expected_version)?;
        if !matches!(current.status.as_str(), "draft" | "active") {
            return Err(StorageError::Conflict(
                "marketplace offer cannot be withdrawn in its current status".to_owned(),
            ));
        }

        let row = sqlx::query(
            "UPDATE marketplace_offers
                SET status = 'withdrawn', version = version + 1,
                    updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND domain_id = $2 AND id = $3
              RETURNING id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                        display_name, attributes, terms, status, published_at, expires_at,
                        version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        let offer = offer_from_row(&row)?;
        record_offer_audit(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.actor_party_id,
            &command.platform_path,
            command.request_id.as_deref(),
            "marketplace.offer.withdrawn",
            &current,
            &offer,
        )
        .await?;
        enqueue_marketplace_offer_projection(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.offer_id,
            offer.version,
        )
        .await?;
        transaction.commit().await?;
        Ok(offer)
    }

    /// Activates one reviewed offer when the moderator still holds its latest version.
    pub async fn activate_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError> {
        if expected_version < 1 {
            return Err(StorageError::InvalidData(
                "marketplace offer version must be positive".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        let row = sqlx::query(
            "UPDATE marketplace_offers offer
             SET status = 'active', published_at = coalesce(published_at, clock_timestamp()),
                 version = version + 1, updated_at = clock_timestamp()
             WHERE offer.tenant_id = $1
               AND offer.id = $2
               AND offer.version = $3
               AND offer.status IN ('draft', 'withdrawn')
               AND (
                 offer.store_id IS NULL
                 OR EXISTS (
                   SELECT 1
                     FROM stores store
                    WHERE store.tenant_id = offer.tenant_id
                      AND store.id = offer.store_id
                      AND store.domain_id = offer.domain_id
                      AND store.status = 'active'
                      AND store.visibility = 'public'
                      AND length(trim(offer.display_name)) > 0
                      AND length(trim(coalesce(offer.attributes ->> 'description', ''))) > 0
                      AND offer.terms ->> 'pricing_mode' = 'fixed'
                      AND CASE
                            WHEN offer.terms ->> 'amount_minor' ~ '^[0-9]{1,38}$'
                            THEN (offer.terms ->> 'amount_minor')::numeric
                            ELSE 0
                          END > 0
                      AND offer.terms ->> 'currency' ~ '^[A-Z]{3}$'
                      AND offer.terms ->> 'currency_scale' ~ '^(0|[1-9]|1[0-8])$'
                      AND EXISTS (
                        SELECT 1
                          FROM jsonb_array_elements(
                            CASE WHEN jsonb_typeof(offer.attributes -> 'attachments') = 'array'
                                 THEN offer.attributes -> 'attachments' ELSE '[]'::jsonb END
                          ) attachment
                         WHERE attachment ->> 'kind' = 'image'
                           AND (
                             EXISTS (
                               SELECT 1
                                 FROM hosted_store_media media
                                WHERE media.tenant_id = offer.tenant_id
                                  AND media.store_id = offer.store_id
                                  AND media.status IN ('pending', 'published')
                                  AND attachment ->> 'attachment_ref' = 'media://hosted/' || media.id::text
                             )
                             OR (
                               store.integration_kind <> 'hosted'
                               AND attachment #>> '{metadata,public_url}' ~ '^https://'
                             )
                           )
                      )
                 )
               )
             RETURNING offer.id, offer.tenant_id, offer.domain_id, offer.supply_party_id,
                       offer.asset_id, offer.external_key, offer.display_name, offer.attributes,
                       offer.terms, offer.status, offer.published_at, offer.expires_at,
                       offer.version, offer.created_at, offer.updated_at",
        )
        .bind(tenant_id.into_uuid())
        .bind(offer_id.into_uuid())
        .bind(expected_version)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::Conflict(
            "marketplace offer is not awaiting activation or is incomplete for publication"
                .to_owned(),
        ))?;
        let offer = offer_from_row(&row)?;
        enqueue_marketplace_offer_projection(
            &mut transaction,
            tenant_id,
            offer.domain_id,
            offer_id,
            offer.version,
        )
        .await?;
        transaction.commit().await?;
        Ok(offer)
    }

    /// Rejects one draft offer without deleting its moderation or projection history.
    pub async fn reject_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
        expected_version: i64,
    ) -> Result<MarketplaceOffer, StorageError> {
        if expected_version < 1 {
            return Err(StorageError::InvalidData(
                "marketplace offer version must be positive".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        let row = sqlx::query(
            "UPDATE marketplace_offers offer
             SET status = 'withdrawn', version = version + 1,
                 updated_at = clock_timestamp()
             WHERE offer.tenant_id = $1
               AND offer.id = $2
               AND offer.version = $3
               AND offer.status = 'draft'
             RETURNING offer.id, offer.tenant_id, offer.domain_id, offer.supply_party_id,
                       offer.asset_id, offer.external_key, offer.display_name, offer.attributes,
                       offer.terms, offer.status, offer.published_at, offer.expires_at,
                       offer.version, offer.created_at, offer.updated_at",
        )
        .bind(tenant_id.into_uuid())
        .bind(offer_id.into_uuid())
        .bind(expected_version)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::Conflict(
            "marketplace offer is not awaiting moderation".to_owned(),
        ))?;
        let offer = offer_from_row(&row)?;
        enqueue_marketplace_offer_projection(
            &mut transaction,
            tenant_id,
            offer.domain_id,
            offer_id,
            offer.version,
        )
        .await?;
        transaction.commit().await?;
        Ok(offer)
    }

    /// Searches active offers with a deterministic, domain-neutral attribute fallback.  A
    /// subplatform retrieval Agent can use the same canonical offer IDs and bypass this method;
    /// this fallback exists so the kernel remains useful without a model or vector database.
    pub async fn match_marketplace_offers(
        &self,
        command: &MatchMarketplaceOffers,
    ) -> Result<Vec<MarketplaceOfferCandidate>, StorageError> {
        let intent = self
            .marketplace_intent(command.tenant_id, command.intent_id)
            .await?;
        if intent.participant_id != command.participant_id {
            return Err(StorageError::Forbidden(
                "marketplace intent does not belong to the authenticated participant".to_owned(),
            ));
        }
        if intent.side != "demand" {
            return Err(StorageError::Conflict(
                "only a demand intent can select supply offers".to_owned(),
            ));
        }
        if intent.status != "active" && intent.status != "matched" {
            return Err(StorageError::Conflict(
                "marketplace intent is not open for matching".to_owned(),
            ));
        }
        if intent
            .expires_at
            .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
        {
            return Err(StorageError::Conflict(
                "marketplace intent has expired".to_owned(),
            ));
        }

        let rows = sqlx::query(
            "SELECT offer.id, offer.tenant_id, offer.domain_id, offer.supply_party_id,
                    offer.asset_id, offer.external_key, offer.display_name, offer.attributes,
                    offer.terms, offer.status, offer.published_at, offer.expires_at,
                    offer.version, offer.created_at, offer.updated_at
             FROM marketplace_offers offer
             WHERE offer.tenant_id = $1 AND offer.domain_id = $2 AND offer.status = 'active'
               AND offer.supply_party_id <> $3
               AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
               AND (
                 offer.store_id IS NULL
                 OR EXISTS (
                   SELECT 1
                     FROM stores store
                     JOIN domains domain
                       ON domain.tenant_id = store.tenant_id
                      AND domain.id = store.domain_id
                      AND domain.status = 'active'
                    WHERE store.tenant_id = offer.tenant_id
                      AND store.id = offer.store_id
                      AND store.domain_id = offer.domain_id
                      AND store.status = 'active'
                      AND store.visibility = 'public'
                 )
               )
             ORDER BY offer.published_at DESC NULLS LAST, offer.id
             LIMIT $4",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(intent.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(MARKETPLACE_MATCH_MAX_INPUT_CANDIDATES)
        .fetch_all(self.pool())
        .await?;

        let mut candidates: Vec<MarketplaceOfferCandidate> = rows
            .iter()
            .map(|row| {
                let offer = offer_from_row(row)?;
                let recommendation = score_structured(
                    &intent.narrative,
                    &intent.attributes,
                    &offer.display_name,
                    &offer.attributes,
                    MARKETPLACE_MATCH_POLICY,
                );
                // An empty/unsupported request must not be presented as a real match. The
                // caller can still hand the narrative to its own retrieval provider, but the
                // kernel should not manufacture a neutral 50% recommendation.
                if recommendation.score <= 0.0 {
                    return Ok(None);
                }
                Ok(Some(MarketplaceOfferCandidate {
                    offer,
                    score: recommendation.score,
                    reasons: recommendation.reasons,
                    risks: Vec::new(),
                }))
            })
            .collect::<Result<Vec<_>, StorageError>>()?
            .into_iter()
            .flatten()
            .collect();
        candidates.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| right.offer.created_at.cmp(&left.offer.created_at))
                .then_with(|| {
                    left.offer
                        .offer_id
                        .as_uuid()
                        .cmp(right.offer.offer_id.as_uuid())
                })
        });
        candidates.truncate(command.limit.clamp(1, MARKETPLACE_MATCH_MAX_RESULTS));
        Ok(candidates)
    }

    /// Ranks explicitly discoverable demand summaries against one active supply offer.
    ///
    /// This query never returns the demand participant id or contact data.  It is a discovery
    /// surface for a seller Agent, not an alternate introduction path.
    pub async fn match_marketplace_demands(
        &self,
        command: &MatchMarketplaceDemands,
    ) -> Result<Vec<MarketplaceDemandCandidate>, StorageError> {
        let row = sqlx::query(OFFER_SELECT_BY_ID)
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(command.offer_id.into_uuid())
            .fetch_optional(self.pool())
            .await?
            .ok_or(StorageError::NotFound("marketplace offer"))?;
        let storefront_is_discoverable: bool = row.try_get("storefront_is_discoverable")?;
        let offer = offer_from_row(&row)?;
        if offer.supply_party_id != command.participant_id {
            return Err(StorageError::Forbidden(
                "marketplace offer does not belong to the authenticated participant".to_owned(),
            ));
        }
        if offer.status != "active"
            || !storefront_is_discoverable
            || offer
                .expires_at
                .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
        {
            return Err(StorageError::Conflict(
                "marketplace offer is not open for demand discovery".to_owned(),
            ));
        }

        let rows = sqlx::query(INTENT_SELECT_DISCOVERABLE_DEMANDS)
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(command.participant_id.into_uuid())
            .bind(MARKETPLACE_MATCH_MAX_INPUT_CANDIDATES)
            .fetch_all(self.pool())
            .await?;
        let mut candidates: Vec<MarketplaceDemandCandidate> = rows
            .iter()
            .map(|row| {
                let intent = intent_from_row(row)?;
                let recommendation = score_structured(
                    &intent.narrative,
                    &intent.attributes,
                    &offer.display_name,
                    &offer.attributes,
                    MARKETPLACE_MATCH_POLICY,
                );
                if recommendation.score <= 0.0 {
                    return Ok(None);
                }
                Ok(Some(MarketplaceDemandCandidate {
                    intent_id: intent.intent_id,
                    tenant_id: intent.tenant_id,
                    domain_id: intent.domain_id,
                    narrative: intent.narrative,
                    attributes: intent.attributes,
                    terms: intent.terms,
                    score: recommendation.score,
                    reasons: recommendation.reasons,
                    expires_at: intent.expires_at,
                    created_at: intent.created_at,
                    updated_at: intent.updated_at,
                }))
            })
            .collect::<Result<Vec<_>, StorageError>>()?
            .into_iter()
            .flatten()
            .collect();
        candidates.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.intent_id.as_uuid().cmp(right.intent_id.as_uuid()))
        });
        candidates.truncate(command.limit.clamp(1, MARKETPLACE_MATCH_MAX_RESULTS));
        Ok(candidates)
    }

    /// Changes the owner-controlled discovery choice without changing the demand narrative.
    pub async fn update_marketplace_demand_discovery(
        &self,
        command: &UpdateMarketplaceDemandDiscovery,
    ) -> Result<MarketplaceIntent, StorageError> {
        if command
            .expires_at
            .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
        {
            return Err(StorageError::InvalidData(
                "supply discovery expiry must be in the future".to_owned(),
            ));
        }
        if command.expires_at.is_some() && !command.enabled {
            return Err(StorageError::InvalidData(
                "supply discovery expiry requires explicit discovery opt-in".to_owned(),
            ));
        }
        let row = sqlx::query(
            "UPDATE marketplace_intents
             SET supply_discovery_enabled = $4,
                 supply_discovery_expires_at = $5,
                 version = version + 1
             WHERE tenant_id = $1 AND domain_id = $2 AND id = $3
               AND participant_id = $6 AND side = 'demand'
               AND status IN ('active', 'matched')
             RETURNING id, tenant_id, domain_id, participant_id, side, narrative, attributes,
                       terms, supply_discovery_enabled, supply_discovery_expires_at,
                       idempotency_key, status, expires_at, version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.intent_id.into_uuid())
        .bind(command.enabled)
        .bind(command.expires_at)
        .bind(command.participant_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::NotFound("marketplace demand intent"))?;
        intent_from_row(&row)
    }

    /// Creates an introduction from canonical Agent-selected references idempotently.
    pub async fn create_marketplace_introduction(
        &self,
        command: &CreateMarketplaceIntroduction,
    ) -> Result<MarketplaceIntroductionOutcome, StorageError> {
        validate_introduction(command)?;
        let mut transaction = self.pool().begin().await?;

        if let Some(row) = sqlx::query(INTRODUCTION_SELECT_BY_KEY)
            .bind(command.tenant_id.into_uuid())
            .bind(command.participant_id.into_uuid())
            .bind(&command.idempotency_key)
            .fetch_optional(&mut *transaction)
            .await?
        {
            let introduction = introduction_from_row(&row)?;
            if introduction.intent_id != command.intent_id
                || introduction.offer_id != command.offer_id
            {
                return Err(StorageError::IdempotencyConflict);
            }
            transaction.commit().await?;
            return Ok(MarketplaceIntroductionOutcome {
                introduction,
                duplicate: true,
            });
        }

        let row = sqlx::query(
            "SELECT i.domain_id, i.participant_id, i.side, i.status AS intent_status,
                    i.expires_at AS intent_expires_at,
                    o.supply_party_id, o.store_id AS offer_store_id,
                    o.status AS offer_status, o.expires_at AS offer_expires_at
             FROM marketplace_intents i
             JOIN marketplace_offers o
               ON o.tenant_id = i.tenant_id AND o.domain_id = i.domain_id
             WHERE i.tenant_id = $1 AND i.id = $2 AND o.id = $3
             FOR UPDATE OF i, o",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.intent_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("marketplace intent or offer"))?;
        let demand_party_id: MarketplacePartyId =
            MarketplacePartyId::from_uuid(row.try_get("participant_id")?);
        let side: String = row.try_get("side")?;
        let intent_status: String = row.try_get("intent_status")?;
        let supply_party_id: MarketplacePartyId =
            MarketplacePartyId::from_uuid(row.try_get("supply_party_id")?);
        let offer_store_id: Option<Uuid> = row.try_get("offer_store_id")?;
        let offer_status: String = row.try_get("offer_status")?;
        let intent_expiry: Option<OffsetDateTime> = row.try_get("intent_expires_at")?;
        let offer_expiry: Option<OffsetDateTime> = row.try_get("offer_expires_at")?;
        if demand_party_id != command.participant_id {
            return Err(StorageError::Forbidden(
                "marketplace intent does not belong to the authenticated participant".to_owned(),
            ));
        }
        if side != "demand" {
            return Err(StorageError::Conflict(
                "introduction requires a demand intent".to_owned(),
            ));
        }
        if demand_party_id == supply_party_id {
            return Err(StorageError::InvalidData(
                "demand and supply participants must differ".to_owned(),
            ));
        }
        // A store can be closed, suspended, made private, or disabled after an offer was
        // published. Lock the current lifecycle rows so a concurrent transition linearizes
        // either before this introduction (and blocks it) or after the transaction commits.
        let storefront_is_discoverable = match offer_store_id {
            None => true,
            Some(store_id) => sqlx::query_scalar::<_, bool>(
                "SELECT store.status = 'active'
                        AND store.visibility = 'public'
                        AND domain.status = 'active'
                   FROM stores store
                   JOIN domains domain
                     ON domain.tenant_id = store.tenant_id
                    AND domain.id = store.domain_id
                  WHERE store.tenant_id = $1
                    AND store.id = $2
                    AND store.domain_id = $3
                  FOR SHARE OF store, domain",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(store_id)
            .bind(row.try_get::<Uuid, _>("domain_id")?)
            .fetch_optional(&mut *transaction)
            .await?
            .unwrap_or(false),
        };
        let now = OffsetDateTime::now_utc();
        if intent_status != "active" && intent_status != "matched"
            || offer_status != "active"
            || !storefront_is_discoverable
            || intent_expiry.is_some_and(|expiry| expiry <= now)
            || offer_expiry.is_some_and(|expiry| expiry <= now)
        {
            return Err(StorageError::Conflict(
                "intent or offer is no longer active".to_owned(),
            ));
        }
        if command.expires_at > intent_expiry.unwrap_or(command.expires_at)
            || command.expires_at > offer_expiry.unwrap_or(command.expires_at)
        {
            return Err(StorageError::Conflict(
                "introduction expiry cannot outlive its intent or offer".to_owned(),
            ));
        }

        let existing = sqlx::query(INTRODUCTION_SELECT_BY_PAIR)
            .bind(command.tenant_id.into_uuid())
            .bind(command.intent_id.into_uuid())
            .bind(command.offer_id.into_uuid())
            .fetch_optional(&mut *transaction)
            .await?;
        if let Some(row) = existing {
            let introduction = introduction_from_row(&row)?;
            if introduction.demand_party_id != command.participant_id {
                return Err(StorageError::Forbidden(
                    "existing introduction belongs to another participant".to_owned(),
                ));
            }
            transaction.commit().await?;
            return Ok(MarketplaceIntroductionOutcome {
                introduction,
                duplicate: true,
            });
        }

        let reasons = Value::Array(
            command
                .reasons
                .iter()
                .map(|reason| Value::String(reason.clone()))
                .collect(),
        );
        let row = sqlx::query(
            "INSERT INTO marketplace_introductions
             (id, tenant_id, demand_intent_id, supply_offer_id, demand_party_id, supply_party_id,
              score, reasons, idempotency_key, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, tenant_id, demand_intent_id, supply_offer_id, demand_party_id,
                       supply_party_id, score, reasons, status, supply_contact_consent_at,
                       contact_released_at, idempotency_key, expires_at, version, created_at,
                       updated_at",
        )
        .bind(command.introduction_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.intent_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .bind(demand_party_id.into_uuid())
        .bind(supply_party_id.into_uuid())
        .bind(command.score)
        .bind(reasons)
        .bind(&command.idempotency_key)
        .bind(command.expires_at)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE marketplace_intents SET status = 'matched', version = version + 1
             WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.intent_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        let introduction = introduction_from_row(&row)?;
        transaction.commit().await?;
        Ok(MarketplaceIntroductionOutcome {
            introduction,
            duplicate: false,
        })
    }

    /// Moves a proposed introduction into the explicit contact-request state.
    pub async fn request_marketplace_contact(
        &self,
        command: &RequestMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError> {
        validate_text(
            &command.idempotency_key,
            MAX_IDEMPOTENCY_KEY_BYTES,
            "contact request idempotency key",
        )?;
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let row = sqlx::query(INTRODUCTION_SELECT_BY_ID_FOR_UPDATE)
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StorageError::NotFound("marketplace introduction"))?;
        let current = introduction_from_row(&row)?;
        if current.demand_party_id != command.demand_party_id {
            return Err(StorageError::Forbidden(
                "only the demand participant can request contact".to_owned(),
            ));
        }
        if current.expires_at <= OffsetDateTime::now_utc()
            || matches!(current.status.as_str(), "declined" | "expired" | "disputed")
        {
            insert_marketplace_contact_event(
                &mut transaction,
                command.tenant_id,
                command.introduction_id,
                command.demand_party_id,
                current.supply_party_id,
                "contact_requested",
                "denied",
                command.request_fingerprint.as_deref(),
                &command.idempotency_key,
            )
            .await?;
            transaction.commit().await?;
            return Err(StorageError::Conflict(
                "marketplace introduction is no longer available".to_owned(),
            ));
        }
        if current.status == "proposed" {
            sqlx::query(
                "UPDATE marketplace_introductions
                    SET status = 'contact_requested', version = version + 1
                  WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
        }
        insert_marketplace_contact_event(
            &mut transaction,
            command.tenant_id,
            command.introduction_id,
            command.demand_party_id,
            current.supply_party_id,
            "contact_requested",
            "allowed",
            command.request_fingerprint.as_deref(),
            &command.idempotency_key,
        )
        .await?;
        let updated = sqlx::query(INTRODUCTION_SELECT_BY_ID)
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .fetch_one(&mut *transaction)
            .await?;
        let introduction = introduction_from_row(&updated)?;
        transaction.commit().await?;
        Ok(introduction)
    }

    /// Records supply consent before any counterpart contact value can be released.
    pub async fn accept_marketplace_contact(
        &self,
        command: &AcceptMarketplaceContact,
    ) -> Result<MarketplaceIntroduction, StorageError> {
        validate_text(
            &command.idempotency_key,
            MAX_IDEMPOTENCY_KEY_BYTES,
            "contact consent idempotency key",
        )?;
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let row = sqlx::query(INTRODUCTION_SELECT_BY_ID_FOR_UPDATE)
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StorageError::NotFound("marketplace introduction"))?;
        let current = introduction_from_row(&row)?;
        if current.supply_party_id != command.supply_party_id {
            return Err(StorageError::Forbidden(
                "only the supply participant can consent to contact".to_owned(),
            ));
        }
        if current.expires_at <= OffsetDateTime::now_utc()
            || !matches!(
                current.status.as_str(),
                "contact_requested" | "contact_released"
            )
        {
            insert_marketplace_contact_event(
                &mut transaction,
                command.tenant_id,
                command.introduction_id,
                command.supply_party_id,
                current.demand_party_id,
                "contact_consent",
                "denied",
                None,
                &command.idempotency_key,
            )
            .await?;
            transaction.commit().await?;
            return Err(StorageError::Conflict(
                "marketplace introduction is not awaiting supply consent".to_owned(),
            ));
        }
        if current.supply_contact_consent_at.is_none() {
            sqlx::query(
                "UPDATE marketplace_introductions
                    SET supply_contact_consent_at = clock_timestamp(),
                        status = 'contact_released', version = version + 1
                  WHERE tenant_id = $1 AND id = $2
                    AND supply_contact_consent_at IS NULL",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .execute(&mut *transaction)
            .await?;
        }
        insert_marketplace_contact_event(
            &mut transaction,
            command.tenant_id,
            command.introduction_id,
            command.supply_party_id,
            current.demand_party_id,
            "contact_consent",
            "allowed",
            None,
            &command.idempotency_key,
        )
        .await?;
        let updated = sqlx::query(INTRODUCTION_SELECT_BY_ID)
            .bind(command.tenant_id.into_uuid())
            .bind(command.introduction_id.into_uuid())
            .fetch_one(&mut *transaction)
            .await?;
        let introduction = introduction_from_row(&updated)?;
        transaction.commit().await?;
        Ok(introduction)
    }

    /// Releases only the other participant's encrypted contact after supply consent.
    pub async fn release_marketplace_contact(
        &self,
        tenant_id: TenantId,
        introduction_id: MatchIntroductionId,
        actor_party_id: MarketplacePartyId,
        idempotency_key: &str,
        request_fingerprint: Option<&[u8]>,
    ) -> Result<MarketplaceContactEnvelope, StorageError> {
        validate_text(
            idempotency_key,
            MAX_IDEMPOTENCY_KEY_BYTES,
            "contact release idempotency key",
        )?;
        let mut transaction = self.pool().begin().await?;
        serializable(&mut transaction).await?;
        let row = sqlx::query(INTRODUCTION_SELECT_BY_ID_FOR_UPDATE)
            .bind(tenant_id.into_uuid())
            .bind(introduction_id.into_uuid())
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StorageError::NotFound("marketplace introduction"))?;
        let current = introduction_from_row(&row)?;
        let target_party_id = if current.demand_party_id == actor_party_id {
            current.supply_party_id
        } else if current.supply_party_id == actor_party_id {
            current.demand_party_id
        } else {
            return Err(StorageError::Forbidden(
                "contact is available only to the matched participants".to_owned(),
            ));
        };
        if current.expires_at <= OffsetDateTime::now_utc()
            || !matches!(current.status.as_str(), "contact_released" | "completed")
            || current.supply_contact_consent_at.is_none()
        {
            insert_marketplace_contact_event(
                &mut transaction,
                tenant_id,
                introduction_id,
                actor_party_id,
                target_party_id,
                "contact_release",
                "denied",
                request_fingerprint,
                idempotency_key,
            )
            .await?;
            transaction.commit().await?;
            return Err(StorageError::Conflict(
                "supply consent is required before contact release".to_owned(),
            ));
        }
        sqlx::query(
            "UPDATE marketplace_introductions
                SET contact_released_at = COALESCE(contact_released_at, clock_timestamp()),
                    version = CASE WHEN contact_released_at IS NULL THEN version + 1 ELSE version END
              WHERE tenant_id = $1 AND id = $2",
        )
        .bind(tenant_id.into_uuid())
        .bind(introduction_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        insert_marketplace_contact_event(
            &mut transaction,
            tenant_id,
            introduction_id,
            actor_party_id,
            target_party_id,
            "contact_release",
            "allowed",
            request_fingerprint,
            idempotency_key,
        )
        .await?;
        let contact = sqlx::query(
            "SELECT display_name, contact_ciphertext, contact_nonce, contact_key_version
               FROM marketplace_parties
              WHERE tenant_id = $1 AND id = $2 AND status = 'active'
              FOR SHARE",
        )
        .bind(tenant_id.into_uuid())
        .bind(target_party_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("active counterpart"))?;
        let updated = sqlx::query(INTRODUCTION_SELECT_BY_ID)
            .bind(tenant_id.into_uuid())
            .bind(introduction_id.into_uuid())
            .fetch_one(&mut *transaction)
            .await?;
        let introduction = introduction_from_row(&updated)?;
        let envelope = MarketplaceContactEnvelope {
            target_party_id,
            display_name: contact.try_get("display_name")?,
            ciphertext: contact.try_get("contact_ciphertext")?,
            nonce: contact.try_get("contact_nonce")?,
            key_version: contact.try_get("contact_key_version")?,
            introduction,
        };
        transaction.commit().await?;
        Ok(envelope)
    }

    /// Lists introductions visible to one participant without exposing contact values.
    pub async fn marketplace_introductions_for_party(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceIntroduction>, StorageError> {
        let rows = sqlx::query(INTRODUCTION_SELECT_FOR_PARTY)
            .bind(tenant_id.into_uuid())
            .bind(party_id.into_uuid())
            .fetch_all(self.pool())
            .await?;
        rows.iter().map(introduction_from_row).collect()
    }

    /// Returns the latest domain-owned understanding for one participant.
    pub async fn marketplace_intent_profile(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Option<MarketplaceIntentProfile>, StorageError> {
        let row = sqlx::query(
            "SELECT tenant_id, domain_id, participant_id, profile, version, created_at, updated_at
               FROM marketplace_intent_profiles
              WHERE tenant_id = $1 AND domain_id = $2 AND participant_id = $3",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(participant_id.into_uuid())
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| profile_from_row(&row)).transpose()
    }

    /// Upserts the latest profile state.  The profile is intentionally opaque to the root.
    pub async fn upsert_marketplace_intent_profile(
        &self,
        command: &UpsertMarketplaceIntentProfile,
    ) -> Result<MarketplaceIntentProfile, StorageError> {
        validate_object(&command.profile, "intent profile")?;
        validate_json_bytes(&command.profile, 64 * 1024, "intent profile")?;
        let row = sqlx::query(
            "INSERT INTO marketplace_intent_profiles
                (tenant_id, domain_id, participant_id, profile)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, domain_id, participant_id)
             DO UPDATE SET profile = EXCLUDED.profile,
                           version = marketplace_intent_profiles.version + 1
             RETURNING tenant_id, domain_id, participant_id, profile, version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(&command.profile)
        .fetch_one(self.pool())
        .await?;
        profile_from_row(&row)
    }

    /// Updates one open demand or supply intent with a caller-supplied optimistic version.
    pub async fn update_marketplace_intent(
        &self,
        command: &UpdateMarketplaceIntent,
    ) -> Result<MarketplaceIntent, StorageError> {
        validate_text(&command.narrative, MAX_NARRATIVE_BYTES, "intent narrative")?;
        validate_object(&command.attributes, "intent attributes")?;
        validate_object(&command.terms, "intent terms")?;
        if command.expected_version < 1 {
            return Err(StorageError::InvalidData(
                "intent expected version must be positive".to_owned(),
            ));
        }
        let row = sqlx::query(
            "UPDATE marketplace_intents
                SET narrative = $5, attributes = $6, terms = $7,
                    version = version + 1
              WHERE tenant_id = $1 AND domain_id = $2 AND id = $3
                AND participant_id = $4
                AND status IN ('active', 'matched') AND version = $8
             RETURNING id, tenant_id, domain_id, participant_id, side, narrative,
                       attributes, terms, supply_discovery_enabled,
                       supply_discovery_expires_at, idempotency_key, status, expires_at,
                       version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.intent_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(&command.narrative)
        .bind(&command.attributes)
        .bind(&command.terms)
        .bind(command.expected_version)
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::Conflict(
            "intent is stale, closed, or not owned by this participant".to_owned(),
        ))?;
        intent_from_row(&row)
    }

    /// Records a bounded behavior signal idempotently.  Signals are evidence for ranking, not
    /// an immediate rewrite of the participant profile.
    pub async fn record_marketplace_behavior_event(
        &self,
        command: &RecordMarketplaceBehaviorEvent,
    ) -> Result<MarketplaceBehaviorEventOutcome, StorageError> {
        validate_behavior_event(command)?;
        if let Some(intent_id) = command.intent_id {
            let owned = sqlx::query(
                "SELECT domain_id, participant_id FROM marketplace_intents
                  WHERE tenant_id = $1 AND id = $2",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(intent_id.into_uuid())
            .fetch_optional(self.pool())
            .await?;
            let Some(row) = owned else {
                return Err(StorageError::Forbidden(
                    "behavior event intent is not available in this tenant".to_owned(),
                ));
            };
            if row.try_get::<Uuid, _>("domain_id")? != command.domain_id.into_uuid()
                || row.try_get::<Uuid, _>("participant_id")? != command.participant_id.into_uuid()
            {
                return Err(StorageError::Forbidden(
                    "behavior event intent is outside the participant scope".to_owned(),
                ));
            }
        }
        if let Some(offer_id) = command.offer_id {
            let scoped = sqlx::query(
                "SELECT domain_id FROM marketplace_offers
                  WHERE tenant_id = $1 AND id = $2",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(offer_id.into_uuid())
            .fetch_optional(self.pool())
            .await?;
            let Some(row) = scoped else {
                return Err(StorageError::Forbidden(
                    "behavior event offer is not available in this tenant".to_owned(),
                ));
            };
            if row.try_get::<Uuid, _>("domain_id")? != command.domain_id.into_uuid() {
                return Err(StorageError::Forbidden(
                    "behavior event offer is outside the domain scope".to_owned(),
                ));
            }
        }
        let existing = sqlx::query(
            "SELECT id, domain_id, event_type, reason, metadata, intent_id, offer_id
               FROM marketplace_behavior_events
              WHERE tenant_id = $1 AND participant_id = $2 AND idempotency_key = $3",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(&command.idempotency_key)
        .fetch_optional(self.pool())
        .await?;
        if let Some(row) = existing {
            let same = row.try_get::<Uuid, _>("domain_id")? == command.domain_id.into_uuid()
                && row.try_get::<String, _>("event_type")? == command.event_type
                && row.try_get::<Option<String>, _>("reason")? == command.reason
                && row.try_get::<Value, _>("metadata")? == command.metadata
                && row.try_get::<Option<Uuid>, _>("intent_id")?
                    == command.intent_id.map(MarketplaceIntentId::into_uuid)
                && row.try_get::<Option<Uuid>, _>("offer_id")?
                    == command.offer_id.map(MarketplaceOfferId::into_uuid);
            if !same {
                return Err(StorageError::IdempotencyConflict);
            }
            return Ok(MarketplaceBehaviorEventOutcome {
                event_id: MarketplaceBehaviorEventId::from_uuid(row.try_get("id")?),
                duplicate: true,
            });
        }
        let row = sqlx::query(
            "INSERT INTO marketplace_behavior_events
                (id, tenant_id, domain_id, participant_id, intent_id, offer_id,
                 event_type, reason, metadata, idempotency_key, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, clock_timestamp()))
             RETURNING id",
        )
        .bind(command.event_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(command.intent_id.map(MarketplaceIntentId::into_uuid))
        .bind(command.offer_id.map(MarketplaceOfferId::into_uuid))
        .bind(&command.event_type)
        .bind(&command.reason)
        .bind(&command.metadata)
        .bind(&command.idempotency_key)
        .bind(command.occurred_at)
        .fetch_one(self.pool())
        .await?;
        Ok(MarketplaceBehaviorEventOutcome {
            event_id: MarketplaceBehaviorEventId::from_uuid(row.try_get("id")?),
            duplicate: false,
        })
    }

    /// Saves or dismisses one canonical offer for the authenticated participant.
    pub async fn set_marketplace_offer_preference(
        &self,
        command: &SetMarketplaceOfferPreference,
    ) -> Result<MarketplaceOfferPreference, StorageError> {
        if !matches!(command.state.as_str(), "saved" | "dismissed" | "neutral") {
            return Err(StorageError::InvalidData(
                "offer preference state must be saved, dismissed, or neutral".to_owned(),
            ));
        }
        if let Some(reason) = &command.reason {
            validate_text(reason, 500, "offer preference reason")?;
        }
        let offer_domain: Option<Uuid> = sqlx::query_scalar(
            "SELECT domain_id FROM marketplace_offers
              WHERE tenant_id = $1 AND id = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .fetch_optional(self.pool())
        .await?;
        if offer_domain != Some(command.domain_id.into_uuid()) {
            return Err(StorageError::Forbidden(
                "offer preference is outside the domain scope".to_owned(),
            ));
        }
        let row = sqlx::query(
            "INSERT INTO marketplace_offer_preferences
                (tenant_id, domain_id, participant_id, offer_id, state, reason)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, domain_id, participant_id, offer_id)
             DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason,
                           version = marketplace_offer_preferences.version + 1
             RETURNING tenant_id, domain_id, participant_id, offer_id, state, reason,
                       version, created_at, updated_at",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(command.offer_id.into_uuid())
        .bind(&command.state)
        .bind(&command.reason)
        .fetch_one(self.pool())
        .await?;
        preference_from_row(&row)
    }

    /// Reads saved/dismissed state for one participant; offer payloads are re-read through the
    /// canonical matching query so stale preference rows cannot expose removed data.
    pub async fn marketplace_offer_preferences_for_party(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        participant_id: MarketplacePartyId,
    ) -> Result<Vec<MarketplaceOfferPreference>, StorageError> {
        let rows = sqlx::query(
            "SELECT tenant_id, domain_id, participant_id, offer_id, state, reason,
                    version, created_at, updated_at
               FROM marketplace_offer_preferences
              WHERE tenant_id = $1 AND domain_id = $2 AND participant_id = $3
              ORDER BY updated_at DESC, offer_id",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(participant_id.into_uuid())
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(preference_from_row).collect()
    }

    /// Creates a durable, contact-free sales handoff snapshot idempotently.
    pub async fn create_marketplace_sales_handoff(
        &self,
        command: &CreateMarketplaceSalesHandoff,
    ) -> Result<MarketplaceSalesHandoff, StorageError> {
        validate_text(
            &command.idempotency_key,
            MAX_IDEMPOTENCY_KEY_BYTES,
            "sales handoff idempotency key",
        )?;
        validate_object(&command.summary, "sales handoff summary")?;
        validate_json_bytes(&command.summary, 128 * 1024, "sales handoff summary")?;
        if let Some(intent_id) = command.intent_id {
            let owner: Option<Uuid> = sqlx::query_scalar(
                "SELECT participant_id FROM marketplace_intents
                  WHERE tenant_id = $1 AND domain_id = $2 AND id = $3",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
            .bind(intent_id.into_uuid())
            .fetch_optional(self.pool())
            .await?;
            if owner != Some(command.participant_id.into_uuid()) {
                return Err(StorageError::Forbidden(
                    "sales handoff intent is not owned by this participant".to_owned(),
                ));
            }
        }
        if let Some(row) = sqlx::query(HANDOFF_SELECT_BY_KEY)
            .bind(command.tenant_id.into_uuid())
            .bind(command.participant_id.into_uuid())
            .bind(&command.idempotency_key)
            .fetch_optional(self.pool())
            .await?
        {
            let handoff = handoff_from_row(&row)?;
            if handoff.domain_id != command.domain_id
                || handoff.intent_id != command.intent_id
                || handoff.summary != command.summary
            {
                return Err(StorageError::IdempotencyConflict);
            }
            return Ok(handoff);
        }
        let row = sqlx::query(
            "INSERT INTO marketplace_sales_handoffs
                (id, tenant_id, domain_id, participant_id, intent_id, summary, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, tenant_id, domain_id, participant_id, intent_id, summary, status,
                       idempotency_key, created_at, updated_at",
        )
        .bind(command.handoff_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(command.intent_id.map(MarketplaceIntentId::into_uuid))
        .bind(&command.summary)
        .bind(&command.idempotency_key)
        .fetch_one(self.pool())
        .await?;
        handoff_from_row(&row)
    }
}

fn validate_intent(command: &CreateMarketplaceIntent) -> Result<(), StorageError> {
    if !matches!(command.side.as_str(), "demand" | "supply") {
        return Err(StorageError::InvalidData(
            "intent side must be demand or supply".to_owned(),
        ));
    }
    validate_text(&command.narrative, MAX_NARRATIVE_BYTES, "intent narrative")?;
    validate_text(
        &command.idempotency_key,
        MAX_IDEMPOTENCY_KEY_BYTES,
        "intent idempotency key",
    )?;
    validate_object(&command.attributes, "intent attributes")?;
    validate_object(&command.terms, "intent terms")?;
    if command
        .expires_at
        .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
    {
        return Err(StorageError::InvalidData(
            "intent expiry must be in the future".to_owned(),
        ));
    }
    if command
        .supply_discovery_expires_at
        .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
    {
        return Err(StorageError::InvalidData(
            "supply discovery expiry must be in the future".to_owned(),
        ));
    }
    if command.supply_discovery_expires_at.is_some() && !command.supply_discovery_enabled {
        return Err(StorageError::InvalidData(
            "supply discovery expiry requires explicit discovery opt-in".to_owned(),
        ));
    }
    if command.supply_discovery_enabled && command.side != "demand" {
        return Err(StorageError::InvalidData(
            "supply discovery is available only for demand intents".to_owned(),
        ));
    }
    Ok(())
}

struct LockedMarketplaceOffer {
    supply_party_id: MarketplacePartyId,
    status: String,
    version: i64,
}

async fn lock_marketplace_offer(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    domain_id: DomainId,
    offer_id: MarketplaceOfferId,
) -> Result<LockedMarketplaceOffer, StorageError> {
    let row = sqlx::query(
        "SELECT supply_party_id, status, version
           FROM marketplace_offers
          WHERE tenant_id = $1 AND domain_id = $2 AND id = $3
          FOR UPDATE",
    )
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(offer_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("marketplace offer"))?;
    Ok(LockedMarketplaceOffer {
        supply_party_id: MarketplacePartyId::from_uuid(row.try_get("supply_party_id")?),
        status: row.try_get("status")?,
        version: row.try_get("version")?,
    })
}

fn authorize_offer_management(
    offer: &LockedMarketplaceOffer,
    actor_party_id: MarketplacePartyId,
    can_manage_domain: bool,
) -> Result<(), StorageError> {
    if offer.supply_party_id == actor_party_id || can_manage_domain {
        Ok(())
    } else {
        Err(StorageError::Forbidden(
            "marketplace offer belongs to another supply participant".to_owned(),
        ))
    }
}

fn ensure_offer_version(
    offer: &LockedMarketplaceOffer,
    expected_version: i64,
) -> Result<(), StorageError> {
    if expected_version < 1 {
        return Err(StorageError::InvalidData(
            "marketplace offer version must be positive".to_owned(),
        ));
    }
    if offer.version == expected_version {
        Ok(())
    } else {
        Err(StorageError::Conflict(
            "marketplace offer version is stale".to_owned(),
        ))
    }
}

async fn enqueue_marketplace_offer_projection(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    domain_id: DomainId,
    offer_id: MarketplaceOfferId,
    canonical_version: i64,
) -> Result<(), StorageError> {
    sqlx::query(
        r#"WITH target AS (
           SELECT offer.tenant_id,
                  offer.domain_id,
                  offer.store_id,
                  offer.id,
                  offer.version,
                  registration.id AS registration_id,
                  alias.path AS platform_path,
                  COALESCE(
                    NULLIF(registration.manifest -> 'agent' ->> 'mcpServerKey', ''),
                    registration.slug
                  ) AS mcp_server_key
             FROM marketplace_offers offer
             JOIN stores store
               ON store.tenant_id = offer.tenant_id
              AND store.domain_id = offer.domain_id
              AND store.id = offer.store_id
             JOIN store_path_aliases alias
               ON alias.tenant_id = store.tenant_id
              AND alias.store_id = store.id
              AND alias.is_canonical
             JOIN subplatform_registrations registration
               ON registration.id = store.current_registration_id
              AND registration.tenant_id = store.tenant_id
              AND registration.domain_id = store.domain_id
              AND registration.state = 'active'
            WHERE offer.tenant_id = $1
              AND offer.domain_id = $2
              AND offer.id = $3
              AND offer.version = $4
              AND store.integration_kind <> 'hosted'
              AND registration.manifest @> '{"agent":{"mcpTools":["catalog.upsert"]}}'::jsonb
         ), superseded AS (
           UPDATE marketplace_offer_projection_jobs job
              SET status = 'superseded',
                  next_attempt_at = clock_timestamp(),
                  last_error_code = NULL,
                  last_error = NULL,
                  updated_at = clock_timestamp()
             FROM target
            WHERE job.tenant_id = target.tenant_id
              AND job.offer_id = target.id
              AND job.canonical_version < target.version
              AND job.status IN ('pending', 'retry')
           RETURNING job.id
         )
         INSERT INTO marketplace_offer_projection_jobs (
           tenant_id,
           domain_id,
           store_id,
           offer_id,
           canonical_version,
           registration_id,
           platform_path,
           mcp_server_key
         )
         SELECT tenant_id,
                domain_id,
                store_id,
                id,
                version,
                registration_id,
                platform_path,
                mcp_server_key
           FROM target
         ON CONFLICT (tenant_id, offer_id, canonical_version, registration_id) DO NOTHING"#,
    )
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(offer_id.into_uuid())
    .bind(canonical_version)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn record_offer_audit(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    domain_id: DomainId,
    actor_party_id: MarketplacePartyId,
    platform_path: &str,
    request_id: Option<&str>,
    event_type: &str,
    previous: &LockedMarketplaceOffer,
    offer: &MarketplaceOffer,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO platform_audit_events
         (id, tenant_id, domain_id, platform_path, actor_party_id, event_type, outcome,
          request_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'success', $7, $8)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(platform_path)
    .bind(actor_party_id.into_uuid())
    .bind(event_type)
    .bind(request_id)
    .bind(serde_json::json!({
        "offer_id": offer.offer_id.to_string(),
        "previous_status": previous.status,
        "status": offer.status,
        "previous_version": previous.version,
        "version": offer.version,
    }))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn validate_offer(command: &CreateMarketplaceOffer) -> Result<(), StorageError> {
    validate_text(
        &command.external_key,
        MAX_EXTERNAL_KEY_BYTES,
        "offer external key",
    )?;
    validate_text(
        &command.display_name,
        MAX_DISPLAY_NAME_BYTES,
        "offer display name",
    )?;
    validate_object(&command.attributes, "offer attributes")?;
    validate_object(&command.terms, "offer terms")?;
    if command
        .expires_at
        .is_some_and(|expiry| expiry <= OffsetDateTime::now_utc())
    {
        return Err(StorageError::InvalidData(
            "offer expiry must be in the future".to_owned(),
        ));
    }
    Ok(())
}

fn validate_offer_update(command: &UpdateMarketplaceOffer) -> Result<(), StorageError> {
    validate_text(
        &command.display_name,
        MAX_DISPLAY_NAME_BYTES,
        "offer display name",
    )?;
    validate_object(&command.attributes, "offer attributes")?;
    validate_object(&command.terms, "offer terms")?;
    if command.expected_version < 1 {
        return Err(StorageError::InvalidData(
            "marketplace offer version must be positive".to_owned(),
        ));
    }
    Ok(())
}

fn validate_introduction(command: &CreateMarketplaceIntroduction) -> Result<(), StorageError> {
    if !command.score.is_finite() || !(0.0..=1.0).contains(&command.score) {
        return Err(StorageError::InvalidData(
            "introduction score must be finite and between 0 and 1".to_owned(),
        ));
    }
    if command.reasons.len() > 24 || command.reasons.iter().any(|reason| reason.len() > 500) {
        return Err(StorageError::InvalidData(
            "introduction reasons are too large".to_owned(),
        ));
    }
    validate_text(
        &command.idempotency_key,
        MAX_IDEMPOTENCY_KEY_BYTES,
        "introduction idempotency key",
    )?;
    if command.expires_at <= OffsetDateTime::now_utc() {
        return Err(StorageError::InvalidData(
            "introduction expiry must be in the future".to_owned(),
        ));
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize, field: &str) -> Result<(), StorageError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(StorageError::InvalidData(format!(
            "{field} must contain 1..={maximum} printable bytes"
        )));
    }
    Ok(())
}

fn validate_object(value: &Value, field: &str) -> Result<(), StorageError> {
    if value.is_object() {
        Ok(())
    } else {
        Err(StorageError::InvalidData(format!(
            "{field} must be a JSON object"
        )))
    }
}

fn validate_json_bytes(value: &Value, maximum: usize, field: &str) -> Result<(), StorageError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > maximum {
        return Err(StorageError::InvalidData(format!(
            "{field} must be at most {maximum} bytes"
        )));
    }
    Ok(())
}

fn validate_behavior_event(command: &RecordMarketplaceBehaviorEvent) -> Result<(), StorageError> {
    validate_text(&command.event_type, 64, "behavior event type")?;
    if !command.event_type.bytes().enumerate().all(|(index, byte)| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'.' | b'_' | b':' | b'-') && index > 0
    }) || !command.event_type.as_bytes()[0].is_ascii_lowercase()
    {
        return Err(StorageError::InvalidData(
            "behavior event type must use the lowercase event taxonomy".to_owned(),
        ));
    }
    validate_object(&command.metadata, "behavior event metadata")?;
    validate_json_bytes(&command.metadata, 32 * 1024, "behavior event metadata")?;
    validate_text(
        &command.idempotency_key,
        MAX_IDEMPOTENCY_KEY_BYTES,
        "behavior event idempotency key",
    )?;
    if let Some(reason) = &command.reason {
        validate_text(reason, 500, "behavior event reason")?;
    }
    Ok(())
}

fn ensure_same_intent(
    existing: &MarketplaceIntent,
    command: &CreateMarketplaceIntent,
) -> Result<(), StorageError> {
    if existing.intent_id != command.intent_id
        || existing.domain_id != command.domain_id
        || existing.participant_id != command.participant_id
        || existing.side != command.side
        || existing.narrative != command.narrative
        || existing.attributes != command.attributes
        || existing.terms != command.terms
        || existing.supply_discovery_enabled != command.supply_discovery_enabled
        || existing.supply_discovery_expires_at != command.supply_discovery_expires_at
        || existing.expires_at != command.expires_at
    {
        return Err(StorageError::IdempotencyConflict);
    }
    Ok(())
}

fn ensure_same_offer(
    existing: &MarketplaceOffer,
    command: &CreateMarketplaceOffer,
) -> Result<(), StorageError> {
    if existing.offer_id != command.offer_id
        || existing.supply_party_id != command.supply_party_id
        || existing.asset_id != command.asset_id
        || existing.display_name != command.display_name
        || existing.attributes != command.attributes
        || existing.terms != command.terms
        || existing.expires_at != command.expires_at
    {
        return Err(StorageError::IdempotencyConflict);
    }
    Ok(())
}

const INTENT_SELECT: &str = "SELECT id, tenant_id, domain_id, participant_id, side, narrative,
    attributes, terms, supply_discovery_enabled, supply_discovery_expires_at,
    idempotency_key, status, expires_at, version, created_at, updated_at
    FROM marketplace_intents WHERE tenant_id = $1 AND participant_id = $2
      AND idempotency_key = $3";

const INTENT_SELECT_BY_ID: &str =
    "SELECT id, tenant_id, domain_id, participant_id, side, narrative,
    attributes, terms, supply_discovery_enabled, supply_discovery_expires_at,
    idempotency_key, status, expires_at, version, created_at, updated_at
    FROM marketplace_intents WHERE tenant_id = $1 AND id = $2";

const INTENT_SELECT_DISCOVERABLE_DEMANDS: &str =
    "SELECT id, tenant_id, domain_id, participant_id, side, narrative,
    attributes, terms, supply_discovery_enabled, supply_discovery_expires_at,
    idempotency_key, status, expires_at, version, created_at, updated_at
    FROM marketplace_intents
    WHERE tenant_id = $1 AND domain_id = $2 AND side = 'demand' AND status = 'active'
      AND supply_discovery_enabled = true
      AND (supply_discovery_expires_at IS NULL OR supply_discovery_expires_at > clock_timestamp())
      AND (expires_at IS NULL OR expires_at > clock_timestamp())
      AND participant_id <> $3
    ORDER BY created_at DESC
    LIMIT $4";

const OFFER_SELECT: &str = "SELECT id, tenant_id, domain_id, supply_party_id, asset_id,
    external_key, display_name, attributes, terms, status, published_at, expires_at, version,
    created_at, updated_at FROM marketplace_offers
    WHERE tenant_id = $1 AND domain_id = $2 AND external_key = $4
      AND store_id IS NOT DISTINCT FROM (
          SELECT store_id FROM marketplace_parties
          WHERE tenant_id = $1 AND id = $3
      )";

const OFFER_SELECT_BY_ID: &str = "SELECT offer.id, offer.tenant_id, offer.domain_id,
    offer.supply_party_id, offer.asset_id, offer.external_key, offer.display_name,
    offer.attributes, offer.terms, offer.status, offer.published_at, offer.expires_at,
    offer.version, offer.created_at, offer.updated_at,
    (offer.store_id IS NULL OR EXISTS (
        SELECT 1
          FROM stores store
          JOIN domains domain
            ON domain.tenant_id = store.tenant_id
           AND domain.id = store.domain_id
           AND domain.status = 'active'
         WHERE store.tenant_id = offer.tenant_id
           AND store.id = offer.store_id
           AND store.domain_id = offer.domain_id
           AND store.status = 'active'
           AND store.visibility = 'public'
    )) AS storefront_is_discoverable
    FROM marketplace_offers offer
    WHERE offer.tenant_id = $1 AND offer.domain_id = $2 AND offer.id = $3";

const INTRODUCTION_SELECT_BY_KEY: &str = "SELECT id, tenant_id, demand_intent_id, supply_offer_id,
    demand_party_id, supply_party_id, score, reasons, status, supply_contact_consent_at,
    contact_released_at, idempotency_key, expires_at, version, created_at, updated_at
    FROM marketplace_introductions WHERE tenant_id = $1 AND demand_party_id = $2
      AND idempotency_key = $3";

const INTRODUCTION_SELECT_BY_PAIR: &str = "SELECT id, tenant_id, demand_intent_id, supply_offer_id,
    demand_party_id, supply_party_id, score, reasons, status, supply_contact_consent_at,
    contact_released_at, idempotency_key, expires_at, version, created_at, updated_at
    FROM marketplace_introductions WHERE tenant_id = $1 AND demand_intent_id = $2
      AND supply_offer_id = $3";

const INTRODUCTION_SELECT_BY_ID: &str = "SELECT id, tenant_id, demand_intent_id, supply_offer_id,
    demand_party_id, supply_party_id, score, reasons, status, supply_contact_consent_at,
    contact_released_at, idempotency_key, expires_at, version, created_at, updated_at
    FROM marketplace_introductions WHERE tenant_id = $1 AND id = $2";

const INTRODUCTION_SELECT_BY_ID_FOR_UPDATE: &str = "SELECT id, tenant_id, demand_intent_id,
    supply_offer_id, demand_party_id, supply_party_id, score, reasons, status,
    supply_contact_consent_at, contact_released_at, idempotency_key, expires_at, version,
    created_at, updated_at FROM marketplace_introductions
    WHERE tenant_id = $1 AND id = $2 FOR UPDATE";

const INTRODUCTION_SELECT_FOR_PARTY: &str = "SELECT id, tenant_id, demand_intent_id,
    supply_offer_id, demand_party_id, supply_party_id, score, reasons, status,
    supply_contact_consent_at, contact_released_at, idempotency_key, expires_at, version,
    created_at, updated_at FROM marketplace_introductions
    WHERE tenant_id = $1 AND (demand_party_id = $2 OR supply_party_id = $2)
    ORDER BY created_at DESC LIMIT 100";

const HANDOFF_SELECT_BY_KEY: &str = "SELECT id, tenant_id, domain_id, participant_id, intent_id,
    summary, status, idempotency_key, created_at, updated_at
    FROM marketplace_sales_handoffs WHERE tenant_id = $1 AND participant_id = $2
      AND idempotency_key = $3";

fn intent_from_row(row: &PgRow) -> Result<MarketplaceIntent, StorageError> {
    Ok(MarketplaceIntent {
        intent_id: MarketplaceIntentId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        participant_id: MarketplacePartyId::from_uuid(row.try_get("participant_id")?),
        side: row.try_get("side")?,
        narrative: row.try_get("narrative")?,
        attributes: row.try_get("attributes")?,
        terms: row.try_get("terms")?,
        supply_discovery_enabled: row.try_get("supply_discovery_enabled")?,
        supply_discovery_expires_at: row.try_get("supply_discovery_expires_at")?,
        idempotency_key: row.try_get("idempotency_key")?,
        status: row.try_get("status")?,
        expires_at: row.try_get("expires_at")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn offer_from_row(row: &PgRow) -> Result<MarketplaceOffer, StorageError> {
    Ok(MarketplaceOffer {
        offer_id: MarketplaceOfferId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        supply_party_id: MarketplacePartyId::from_uuid(row.try_get("supply_party_id")?),
        asset_id: row
            .try_get::<Option<Uuid>, _>("asset_id")?
            .map(AssetId::from_uuid),
        external_key: row.try_get("external_key")?,
        display_name: row.try_get("display_name")?,
        attributes: row.try_get("attributes")?,
        terms: row.try_get("terms")?,
        status: row.try_get("status")?,
        published_at: row.try_get("published_at")?,
        expires_at: row.try_get("expires_at")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn introduction_from_row(row: &PgRow) -> Result<MarketplaceIntroduction, StorageError> {
    Ok(MarketplaceIntroduction {
        introduction_id: MatchIntroductionId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        intent_id: MarketplaceIntentId::from_uuid(row.try_get("demand_intent_id")?),
        offer_id: MarketplaceOfferId::from_uuid(row.try_get("supply_offer_id")?),
        demand_party_id: MarketplacePartyId::from_uuid(row.try_get("demand_party_id")?),
        supply_party_id: MarketplacePartyId::from_uuid(row.try_get("supply_party_id")?),
        score: row.try_get("score")?,
        reasons: row.try_get("reasons")?,
        status: row.try_get("status")?,
        supply_contact_consent_at: row.try_get("supply_contact_consent_at")?,
        contact_released_at: row.try_get("contact_released_at")?,
        idempotency_key: row.try_get("idempotency_key")?,
        expires_at: row.try_get("expires_at")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn profile_from_row(row: &PgRow) -> Result<MarketplaceIntentProfile, StorageError> {
    Ok(MarketplaceIntentProfile {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        participant_id: MarketplacePartyId::from_uuid(row.try_get("participant_id")?),
        profile: row.try_get("profile")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn preference_from_row(row: &PgRow) -> Result<MarketplaceOfferPreference, StorageError> {
    Ok(MarketplaceOfferPreference {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        participant_id: MarketplacePartyId::from_uuid(row.try_get("participant_id")?),
        offer_id: MarketplaceOfferId::from_uuid(row.try_get("offer_id")?),
        state: row.try_get("state")?,
        reason: row.try_get("reason")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn handoff_from_row(row: &PgRow) -> Result<MarketplaceSalesHandoff, StorageError> {
    Ok(MarketplaceSalesHandoff {
        handoff_id: MarketplaceSalesHandoffId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        participant_id: MarketplacePartyId::from_uuid(row.try_get("participant_id")?),
        intent_id: row
            .try_get::<Option<Uuid>, _>("intent_id")?
            .map(MarketplaceIntentId::from_uuid),
        summary: row.try_get("summary")?,
        status: row.try_get("status")?,
        idempotency_key: row.try_get("idempotency_key")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_marketplace_contact_event(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: TenantId,
    introduction_id: MatchIntroductionId,
    actor_party_id: MarketplacePartyId,
    target_party_id: MarketplacePartyId,
    event_type: &str,
    decision: &str,
    request_fingerprint: Option<&[u8]>,
    idempotency_key: &str,
) -> Result<(), StorageError> {
    let inserted = sqlx::query(
        "INSERT INTO marketplace_introduction_contact_events
            (id, tenant_id, introduction_id, actor_party_id, target_party_id,
             event_type, decision, request_fingerprint, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, introduction_id, actor_party_id, event_type, idempotency_key)
         DO UPDATE
            SET request_fingerprint = marketplace_introduction_contact_events.request_fingerprint
          WHERE marketplace_introduction_contact_events.request_fingerprint
                IS NOT DISTINCT FROM EXCLUDED.request_fingerprint
            AND marketplace_introduction_contact_events.target_party_id = EXCLUDED.target_party_id
            AND marketplace_introduction_contact_events.decision = EXCLUDED.decision
         RETURNING id",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(introduction_id.into_uuid())
    .bind(actor_party_id.into_uuid())
    .bind(target_party_id.into_uuid())
    .bind(event_type)
    .bind(decision)
    .bind(request_fingerprint)
    .bind(idempotency_key)
    .fetch_optional(&mut **transaction)
    .await?;
    if inserted.is_none() {
        return Err(StorageError::Conflict(
            "contact action idempotency key was reused with a different payload".to_owned(),
        ));
    }
    Ok(())
}

async fn serializable(transaction: &mut Transaction<'_, Postgres>) -> Result<(), StorageError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        LockedMarketplaceOffer, MARKETPLACE_MATCH_POLICY, authorize_offer_management,
        ensure_offer_version,
    };
    use crate::StorageError;
    use matchplane_domain::MarketplacePartyId;
    use matchplane_matching::score_structured;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn generic_match_score_keeps_exact_attributes_explainable() {
        let recommendation = score_structured(
            "service",
            &json!({"kind": "service", "region": "cn", "capacity": 4}),
            "service offer",
            &json!({"kind": "service", "region": "cn", "capacity": 2}),
            MARKETPLACE_MATCH_POLICY,
        );

        assert!(recommendation.score > 0.6);
        assert_eq!(
            recommendation
                .reasons
                .iter()
                .take(2)
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["shared attribute: kind", "shared attribute: region"]
        );
    }

    #[test]
    fn empty_constraints_without_narrative_do_not_match_everything() {
        let recommendation = score_structured(
            "",
            &json!({}),
            "anything",
            &json!({"kind": "anything"}),
            MARKETPLACE_MATCH_POLICY,
        );

        assert_eq!(recommendation.score, 0.0);
        assert!(recommendation.reasons.is_empty());
    }

    #[test]
    fn narrative_overlap_produces_a_bounded_explanation_without_schema_fields() {
        let recommendation = score_structured(
            "新能源服务",
            &json!({}),
            "城市新能源服务",
            &json!({"kind": "service"}),
            MARKETPLACE_MATCH_POLICY,
        );

        assert!(recommendation.score > 0.0);
        assert!(
            recommendation
                .reasons
                .iter()
                .any(|reason| reason == "narrative_match:新")
        );
    }

    #[test]
    fn offer_management_allows_the_owner_or_same_domain_admin_only() {
        let owner = party_id(0x11111111_1111_4111_8111_111111111111);
        let collaborator = party_id(0x22222222_2222_4222_8222_222222222222);
        let offer = LockedMarketplaceOffer {
            supply_party_id: owner,
            status: "active".to_owned(),
            version: 4,
        };

        assert!(authorize_offer_management(&offer, owner, false).is_ok());
        assert!(authorize_offer_management(&offer, collaborator, true).is_ok());
        assert!(matches!(
            authorize_offer_management(&offer, collaborator, false),
            Err(StorageError::Forbidden(_))
        ));
    }

    #[test]
    fn offer_management_rejects_stale_versions() {
        let offer = LockedMarketplaceOffer {
            supply_party_id: party_id(0x11111111_1111_4111_8111_111111111111),
            status: "draft".to_owned(),
            version: 5,
        };

        assert!(ensure_offer_version(&offer, 5).is_ok());
        assert!(matches!(
            ensure_offer_version(&offer, 4),
            Err(StorageError::Conflict(_))
        ));
        assert!(matches!(
            ensure_offer_version(&offer, 0),
            Err(StorageError::InvalidData(_))
        ));
    }

    fn party_id(value: u128) -> MarketplacePartyId {
        MarketplacePartyId::from_uuid(Uuid::from_u128(value))
    }
}
