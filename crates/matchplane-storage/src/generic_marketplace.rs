//! Domain-neutral demand/supply persistence.
//!
//! This module is the stable kernel used by vertical adapters.  It deliberately does not know
//! whether an offer is a vehicle, a service, a rental, a property, or something else.  The
//! vertical owns the JSON schema and any retrieval/Agent implementation; the kernel owns scope,
//! idempotency, lifecycle and introduction invariants.

use matchplane_domain::{
    AssetId, DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId,
    MatchIntroductionId, TenantId,
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
    /// Public name supplied by the vertical/seller.
    pub display_name: String,
    /// Schema-validated domain attributes.
    pub attributes: Value,
    /// Domain-owned terms such as price, availability, or delivery constraints.
    pub terms: Value,
    /// Optional expiry.
    pub expires_at: Option<OffsetDateTime>,
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
    /// Seller-owned key.
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
              idempotency_key, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, tenant_id, domain_id, participant_id, side, narrative, attributes,
                       terms, idempotency_key, status, expires_at, version, created_at, updated_at",
        )
        .bind(command.intent_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .bind(&command.side)
        .bind(&command.narrative)
        .bind(&command.attributes)
        .bind(&command.terms)
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

    /// Creates a seller-owned offer in `draft` state.  Only an operator or a vertical-owned
    /// moderation workflow may activate it for discovery.
    pub async fn create_marketplace_offer(
        &self,
        command: &CreateMarketplaceOffer,
    ) -> Result<MarketplaceOfferOutcome, StorageError> {
        validate_offer(command)?;
        if let Some(row) = sqlx::query(OFFER_SELECT)
            .bind(command.tenant_id.into_uuid())
            .bind(command.domain_id.into_uuid())
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
                    "seller is not authorized to publish this asset".to_owned(),
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
    /// This is intentionally separate from the active matching query: a seller must be able to
    /// see draft and withdrawn offers before moderation publishes them, without exposing another
    /// seller's private inventory.
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

    /// Activates one draft offer after an authenticated operator/moderation decision.
    pub async fn activate_marketplace_offer(
        &self,
        tenant_id: TenantId,
        offer_id: MarketplaceOfferId,
    ) -> Result<MarketplaceOffer, StorageError> {
        let row = sqlx::query(
            "UPDATE marketplace_offers
             SET status = 'active', published_at = coalesce(published_at, clock_timestamp()),
                 version = version + 1
             WHERE tenant_id = $1 AND id = $2 AND status IN ('draft', 'withdrawn')
             RETURNING id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                       display_name, attributes, terms, status, published_at, expires_at,
                       version, created_at, updated_at",
        )
        .bind(tenant_id.into_uuid())
        .bind(offer_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::Conflict(
            "marketplace offer is not awaiting activation".to_owned(),
        ))?;
        offer_from_row(&row)
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
            "SELECT id, tenant_id, domain_id, supply_party_id, asset_id, external_key,
                    display_name, attributes, terms, status, published_at, expires_at,
                    version, created_at, updated_at
             FROM marketplace_offers
             WHERE tenant_id = $1 AND domain_id = $2 AND status = 'active'
               AND supply_party_id <> $3
               AND (expires_at IS NULL OR expires_at > clock_timestamp())
             ORDER BY published_at DESC NULLS LAST, id
             LIMIT 500",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(intent.domain_id.into_uuid())
        .bind(command.participant_id.into_uuid())
        .fetch_all(self.pool())
        .await?;

        let mut candidates = rows
            .iter()
            .map(|row| {
                let offer = offer_from_row(row)?;
                let (score, reasons) =
                    generic_attribute_score(&intent.attributes, &offer.attributes);
                Ok(MarketplaceOfferCandidate {
                    offer,
                    score,
                    reasons,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
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
        candidates.truncate(command.limit.clamp(1, 100));
        Ok(candidates)
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
                    o.supply_party_id, o.status AS offer_status, o.expires_at AS offer_expires_at
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
        let now = OffsetDateTime::now_utc();
        if intent_status != "active" && intent_status != "matched"
            || offer_status != "active"
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
        request_fingerprint: Option<&[u8]>,
    ) -> Result<MarketplaceContactEnvelope, StorageError> {
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
                    version = version + 1
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

fn generic_attribute_score(demand: &Value, supply: &Value) -> (f64, Vec<String>) {
    let Some(demand) = demand.as_object() else {
        return (0.0, Vec::new());
    };
    if demand.is_empty() {
        return (0.5, vec!["no structured constraints supplied".to_owned()]);
    }
    let Some(supply) = supply.as_object() else {
        return (0.0, Vec::new());
    };
    let mut matched = 0usize;
    let mut reasons = Vec::new();
    for (key, value) in demand {
        if supply.get(key) == Some(value) {
            matched += 1;
            if reasons.len() < 8 {
                reasons.push(format!("shared attribute: {key}"));
            }
        }
    }
    (matched as f64 / demand.len() as f64, reasons)
}

const INTENT_SELECT: &str = "SELECT id, tenant_id, domain_id, participant_id, side, narrative,
    attributes, terms, idempotency_key, status, expires_at, version, created_at, updated_at
    FROM marketplace_intents WHERE tenant_id = $1 AND participant_id = $2
      AND idempotency_key = $3";

const INTENT_SELECT_BY_ID: &str =
    "SELECT id, tenant_id, domain_id, participant_id, side, narrative,
    attributes, terms, idempotency_key, status, expires_at, version, created_at, updated_at
    FROM marketplace_intents WHERE tenant_id = $1 AND id = $2";

const OFFER_SELECT: &str = "SELECT id, tenant_id, domain_id, supply_party_id, asset_id,
    external_key, display_name, attributes, terms, status, published_at, expires_at, version,
    created_at, updated_at FROM marketplace_offers
    WHERE tenant_id = $1 AND domain_id = $2 AND external_key = $3";

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
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO marketplace_introduction_contact_events
            (id, tenant_id, introduction_id, actor_party_id, target_party_id,
             event_type, decision, request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(introduction_id.into_uuid())
    .bind(actor_party_id.into_uuid())
    .bind(target_party_id.into_uuid())
    .bind(event_type)
    .bind(decision)
    .bind(request_fingerprint)
    .execute(&mut **transaction)
    .await?;
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
    use super::generic_attribute_score;
    use serde_json::json;

    #[test]
    fn generic_attribute_score_is_explainable_and_bounded() {
        let (score, reasons) = generic_attribute_score(
            &json!({"kind": "service", "region": "cn", "capacity": 4}),
            &json!({"kind": "service", "region": "cn", "capacity": 2}),
        );

        assert_eq!(score, 2.0 / 3.0);
        assert_eq!(
            reasons,
            vec!["shared attribute: kind", "shared attribute: region"]
        );
    }

    #[test]
    fn empty_constraints_are_neutral_instead_of_matching_everything() {
        let (score, reasons) = generic_attribute_score(&json!({}), &json!({"kind": "anything"}));

        assert_eq!(score, 0.5);
        assert_eq!(reasons, vec!["no structured constraints supplied"]);
    }
}
