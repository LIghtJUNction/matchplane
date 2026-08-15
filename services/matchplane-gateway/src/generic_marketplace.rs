//! Domain-neutral marketplace HTTP resources.
//!
//! These routes are the stable kernel contract for vertical subplatforms.  A vertical decides
//! what its JSON attributes and terms mean; the gateway only authenticates the party, enforces
//! tenant/domain scope, and persists an auditable intent, offer, match, or introduction.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use matchplane_domain::{
    AssetId, DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId,
    MatchIntroductionId, TenantId,
};
use matchplane_storage::{
    CreateMarketplaceIntent, CreateMarketplaceIntroduction, CreateMarketplaceOffer,
    MarketplaceIntent, MarketplaceIntroduction, MarketplaceIntroductionOutcome,
    MarketplaceOfferCandidate, MarketplaceOfferOutcome, MatchMarketplaceOffers,
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

#[derive(Debug, Serialize)]
pub(super) struct MatchOffersResponse {
    intent_id: MarketplaceIntentId,
    candidates: Vec<MarketplaceOfferCandidate>,
}

#[derive(Debug, Serialize)]
pub(super) struct IntroductionsResponse {
    introductions: Vec<MarketplaceIntroduction>,
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
        "demand" => super::marketplace::require_role(&party, "buyer")?,
        "supply" => super::marketplace::require_role(&party, "seller")?,
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
    super::marketplace::require_role(&party, "buyer")?;
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
    super::marketplace::require_role(&party, "seller")?;
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
    super::marketplace::require_role(&party, "buyer")?;
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

fn empty_object() -> Value {
    Value::Object(Map::new())
}
