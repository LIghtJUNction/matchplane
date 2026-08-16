//! Domain-neutral marketplace HTTP resources.
//!
//! These routes are the stable kernel contract for vertical subplatforms.  A vertical decides
//! what its JSON attributes and terms mean; the gateway only authenticates the party, enforces
//! tenant/domain scope, and persists an auditable intent, offer, match, or introduction.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use matchplane_domain::{
    AssetId, DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId,
    MatchIntroductionId, TenantId,
};
use matchplane_storage::{
    AcceptMarketplaceContact, CreateMarketplaceIntent, CreateMarketplaceIntroduction,
    CreateMarketplaceOffer, MarketplaceContactEnvelope, MarketplaceIntent, MarketplaceIntroduction,
    MarketplaceIntroductionOutcome, MarketplaceOfferCandidate, MarketplaceOfferOutcome,
    MatchMarketplaceOffers, RequestMarketplaceContact,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;

use crate::{ApiError, AppState, parse_id, require_operator};

#[derive(Debug, Deserialize)]
pub(super) struct CreateIntentRequest {
    intent_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    side: String,
    narrative: String,
    #[serde(default = "empty_object")]
    attributes: Value,
    #[serde(default = "empty_object")]
    terms: Value,
    idempotency_key: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PartyQuery {
    tenant_id: String,
    domain_id: Option<String>,
    participant_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct OfferQuery {
    tenant_id: String,
    domain_id: String,
    supply_party_id: String,
    limit: Option<u16>,
    offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(super) struct MatchOffersRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateOfferRequest {
    offer_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    supply_party_id: String,
    asset_id: Option<String>,
    external_key: String,
    display_name: String,
    #[serde(default = "empty_object")]
    attributes: Value,
    #[serde(default = "empty_object")]
    terms: Value,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ActivateOfferRequest {
    tenant_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateIntroductionRequest {
    introduction_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    intent_id: String,
    offer_id: String,
    participant_id: String,
    score: f64,
    #[serde(default)]
    reasons: Vec<String>,
    idempotency_key: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContactActionRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
}

#[derive(Debug, Serialize)]
pub(super) struct MatchOffersResponse {
    intent_id: MarketplaceIntentId,
    candidates: Vec<MarketplaceOfferCandidate>,
}

#[derive(Debug, Serialize)]
pub(super) struct IntroductionsResponse {
    introductions: Vec<MarketplaceIntroduction>,
}

#[derive(Debug, Serialize)]
pub(super) struct MarketplaceContactResponse {
    counterpart: GenericCounterpartContact,
    introduction: MarketplaceIntroduction,
}

#[derive(Debug, Serialize)]
pub(super) struct GenericCounterpartContact {
    party_id: MarketplacePartyId,
    display_name: String,
    contact: Value,
}

pub(super) async fn create_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateIntentRequest>,
) -> Result<
    (
        StatusCode,
        Json<matchplane_storage::MarketplaceIntentOutcome>,
    ),
    ApiError,
> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        participant_id,
        domain_id,
    )
    .await?;
    match request.side.as_str() {
        "demand" => super::marketplace::require_marketplace_side(&party, "demand")?,
        "supply" => super::marketplace::require_marketplace_side(&party, "supply")?,
        _ => {
            return Err(ApiError::bad_request(
                "side must be demand or supply".to_owned(),
            ));
        }
    }
    let command = CreateMarketplaceIntent {
        intent_id: request
            .intent_id
            .as_deref()
            .map(parse_id::<MarketplaceIntentId>)
            .transpose()?
            .unwrap_or_default(),
        tenant_id,
        domain_id,
        participant_id,
        side: request.side,
        narrative: request.narrative,
        attributes: request.attributes,
        terms: request.terms,
        idempotency_key: request.idempotency_key,
        expires_at: request.expires_at,
    };
    let outcome = state
        .store
        .create_marketplace_intent(&command)
        .await
        .map_err(ApiError::from)?;
    let status = if outcome.duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(outcome)))
}

pub(super) async fn intent(
    State(state): State<Arc<AppState>>,
    Path(intent_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<MarketplaceIntent>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&query.participant_id)?;
    if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        super::marketplace::authenticate_domain(
            &state,
            &headers,
            tenant_id,
            participant_id,
            domain_id,
        )
        .await?;
    } else {
        super::marketplace::authenticate(&state, &headers, tenant_id, participant_id).await?;
    }
    let intent_id = parse_id::<MarketplaceIntentId>(&intent_id)?;
    let intent = state
        .store
        .marketplace_intent(tenant_id, intent_id)
        .await
        .map_err(ApiError::from)?;
    if intent.participant_id != participant_id {
        return Err(ApiError::forbidden(
            "marketplace intent belongs to another participant".to_owned(),
        ));
    }
    Ok(Json(intent))
}

pub(super) async fn matches(
    State(state): State<Arc<AppState>>,
    Path(intent_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<MatchOffersRequest>,
) -> Result<Json<MatchOffersResponse>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        participant_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "demand")?;
    let intent_id = parse_id::<MarketplaceIntentId>(&intent_id)?;
    let candidates = state
        .store
        .match_marketplace_offers(&MatchMarketplaceOffers {
            tenant_id,
            intent_id,
            participant_id,
            limit: request.limit.unwrap_or(20),
        })
        .await
        .map_err(ApiError::from)?;
    Ok(Json(MatchOffersResponse {
        intent_id,
        candidates,
    }))
}

pub(super) async fn create_offer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateOfferRequest>,
) -> Result<(StatusCode, Json<MarketplaceOfferOutcome>), ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let supply_party_id = parse_id::<MarketplacePartyId>(&request.supply_party_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        supply_party_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "supply")?;
    let command = CreateMarketplaceOffer {
        offer_id: request
            .offer_id
            .as_deref()
            .map(parse_id::<MarketplaceOfferId>)
            .transpose()?
            .unwrap_or_default(),
        tenant_id,
        domain_id,
        supply_party_id,
        asset_id: request
            .asset_id
            .as_deref()
            .map(parse_id::<AssetId>)
            .transpose()?,
        external_key: request.external_key,
        display_name: request.display_name,
        attributes: request.attributes,
        terms: request.terms,
        expires_at: request.expires_at,
    };
    let outcome = state
        .store
        .create_marketplace_offer(&command)
        .await
        .map_err(ApiError::from)?;
    let status = if outcome.duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(outcome)))
}

pub(super) async fn offers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OfferQuery>,
) -> Result<(HeaderMap, Json<Vec<matchplane_storage::MarketplaceOffer>>), ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&query.domain_id)?;
    let supply_party_id = parse_id::<MarketplacePartyId>(&query.supply_party_id)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request(
            "marketplace offer limit must be between 1 and 100".to_owned(),
        ));
    }
    let offset = query.offset.unwrap_or(0);
    if offset > 10_000 {
        return Err(ApiError::bad_request(
            "marketplace offer offset must be between 0 and 10000".to_owned(),
        ));
    }
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        supply_party_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "supply")?;
    let offers = state
        .store
        .marketplace_offers_for_party(
            tenant_id,
            domain_id,
            supply_party_id,
            i64::from(limit),
            i64::from(offset),
        )
        .await
        .map_err(ApiError::from)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((response_headers, Json(offers)))
}

pub(super) async fn activate_offer(
    State(state): State<Arc<AppState>>,
    Path(offer_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ActivateOfferRequest>,
) -> Result<Json<matchplane_storage::MarketplaceOffer>, ApiError> {
    require_operator(&state, &headers)?;
    let offer = state
        .store
        .activate_marketplace_offer(
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<MarketplaceOfferId>(&offer_id)?,
        )
        .await
        .map_err(ApiError::from)?;
    Ok(Json(offer))
}

pub(super) async fn create_introduction(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateIntroductionRequest>,
) -> Result<(StatusCode, Json<MarketplaceIntroductionOutcome>), ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        participant_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "demand")?;
    let command = CreateMarketplaceIntroduction {
        introduction_id: request
            .introduction_id
            .as_deref()
            .map(parse_id::<MatchIntroductionId>)
            .transpose()?
            .unwrap_or_default(),
        tenant_id,
        intent_id: parse_id::<MarketplaceIntentId>(&request.intent_id)?,
        offer_id: parse_id::<MarketplaceOfferId>(&request.offer_id)?,
        participant_id,
        score: request.score,
        reasons: request.reasons,
        idempotency_key: request.idempotency_key,
        expires_at: request.expires_at,
    };
    let outcome = state
        .store
        .create_marketplace_introduction(&command)
        .await
        .map_err(ApiError::from)?;
    let status = if outcome.duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(outcome)))
}

pub(super) async fn introductions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<IntroductionsResponse>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&query.participant_id)?;
    if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        super::marketplace::authenticate_domain(
            &state,
            &headers,
            tenant_id,
            participant_id,
            domain_id,
        )
        .await?;
    } else {
        super::marketplace::authenticate(&state, &headers, tenant_id, participant_id).await?;
    }
    let introductions = state
        .store
        .marketplace_introductions_for_party(tenant_id, participant_id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(IntroductionsResponse { introductions }))
}

/// Opens the consent step for the demand participant without exposing either contact record.
pub(super) async fn request_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ContactActionRequest>,
) -> Result<Json<MarketplaceIntroduction>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        participant_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "demand")?;
    let introduction = state
        .store
        .request_marketplace_contact(&RequestMarketplaceContact {
            tenant_id,
            introduction_id: parse_id::<MatchIntroductionId>(&introduction_id)?,
            demand_party_id: participant_id,
            request_fingerprint: super::marketplace::request_fingerprint(&headers),
        })
        .await
        .map_err(ApiError::from)?;
    Ok(Json(introduction))
}

/// Records supply consent. Contact values remain encrypted until a participant requests release.
pub(super) async fn consent_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ContactActionRequest>,
) -> Result<Json<MarketplaceIntroduction>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let party = super::marketplace::authenticate_domain(
        &state,
        &headers,
        tenant_id,
        participant_id,
        domain_id,
    )
    .await?;
    super::marketplace::require_marketplace_side(&party, "supply")?;
    let introduction = state
        .store
        .accept_marketplace_contact(&AcceptMarketplaceContact {
            tenant_id,
            introduction_id: parse_id::<MatchIntroductionId>(&introduction_id)?,
            supply_party_id: participant_id,
        })
        .await
        .map_err(ApiError::from)?;
    Ok(Json(introduction))
}

/// Releases the counterpart's encrypted contact only after supply consent and participant checks.
pub(super) async fn release_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<MarketplaceContactResponse>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let actor_party_id = parse_id::<MarketplacePartyId>(&query.participant_id)?;
    if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        super::marketplace::authenticate_domain(
            &state,
            &headers,
            tenant_id,
            actor_party_id,
            domain_id,
        )
        .await?;
    } else {
        super::marketplace::authenticate(&state, &headers, tenant_id, actor_party_id).await?;
    }
    let envelope: MarketplaceContactEnvelope = state
        .store
        .release_marketplace_contact(
            tenant_id,
            parse_id::<MatchIntroductionId>(&introduction_id)?,
            actor_party_id,
            super::marketplace::request_fingerprint(&headers).as_deref(),
        )
        .await
        .map_err(ApiError::from)?;
    let plaintext = state
        .contact_cipher
        .decrypt(
            &envelope.ciphertext,
            &envelope.nonce,
            envelope.key_version,
            &super::marketplace::contact_aad(tenant_id, envelope.target_party_id),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let contact = serde_json::from_slice(&plaintext)
        .map_err(|error| ApiError::internal(format!("stored contact is invalid: {error}")))?;
    Ok(Json(MarketplaceContactResponse {
        counterpart: GenericCounterpartContact {
            party_id: envelope.target_party_id,
            display_name: envelope.display_name,
            contact,
        },
        introduction: envelope.introduction,
    }))
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}
