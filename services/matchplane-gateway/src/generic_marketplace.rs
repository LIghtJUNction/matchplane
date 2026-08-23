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
use matchplane_application::{ListOffersQuery, UpdateOfferCommand};
use matchplane_domain::{
    AssetId, DomainId, MarketplaceBehaviorEventId, MarketplaceIntentId, MarketplaceOfferId,
    MarketplacePartyId, MarketplaceSalesHandoffId, MatchIntroductionId, TenantId,
};
use matchplane_storage::{
    CreateMarketplaceIntent, CreateMarketplaceIntroduction, CreateMarketplaceOffer,
    CreateMarketplaceSalesHandoff, MarketplaceDemandCandidate, MarketplaceIntent,
    MarketplaceIntroduction, MarketplaceIntroductionOutcome, MarketplaceOfferCandidate,
    MarketplaceOfferOutcome, MarketplaceOfferPreference, MarketplaceSalesHandoff,
    RecordMarketplaceBehaviorEvent, SetMarketplaceOfferPreference,
    UpdateMarketplaceDemandDiscovery, UpdateMarketplaceIntent, UpsertMarketplaceIntentProfile,
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
    #[serde(default)]
    supply_discovery_enabled: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    supply_discovery_expires_at: Option<OffsetDateTime>,
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
    domain_wide: Option<bool>,
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
pub(super) struct MatchDemandsRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    offer_id: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateIntentRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    narrative: String,
    #[serde(default = "empty_object")]
    attributes: Value,
    #[serde(default = "empty_object")]
    terms: Value,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProfileRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    #[serde(default = "empty_object")]
    profile: Value,
}

#[derive(Debug, Deserialize)]
pub(super) struct BehaviorEventRequest {
    event_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    intent_id: Option<String>,
    offer_id: Option<String>,
    event_type: String,
    reason: Option<String>,
    #[serde(default = "empty_object")]
    metadata: Value,
    idempotency_key: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    occurred_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PreferenceRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    offer_id: String,
    state: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct SalesHandoffRequest {
    handoff_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    intent_id: Option<String>,
    summary: Value,
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateDemandDiscoveryRequest {
    tenant_id: String,
    domain_id: String,
    participant_id: String,
    enabled: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
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
pub(super) struct UpdateOfferRequest {
    tenant_id: String,
    domain_id: String,
    supply_party_id: String,
    display_name: String,
    attributes: Value,
    terms: Value,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct WithdrawOfferRequest {
    tenant_id: String,
    domain_id: String,
    supply_party_id: String,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
pub(super) struct ActivateOfferRequest {
    tenant_id: String,
    expected_version: i64,
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
    idempotency_key: String,
}

#[derive(Debug, Serialize)]
pub(super) struct MatchOffersResponse {
    intent_id: MarketplaceIntentId,
    candidates: Vec<MarketplaceOfferCandidate>,
}

#[derive(Debug, Serialize)]
pub(super) struct MatchDemandsResponse {
    offer_id: MarketplaceOfferId,
    candidates: Vec<MarketplaceDemandCandidate>,
}

#[derive(Debug, Serialize)]
pub(super) struct PreferencesResponse {
    preferences: Vec<MarketplaceOfferPreference>,
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
    match request.side.as_str() {
        "demand" | "supply" => {}
        _ => {
            return Err(ApiError::bad_request(
                "side must be demand or supply".to_owned(),
            ));
        }
    }
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let participant_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
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
        supply_discovery_enabled: request.supply_discovery_enabled,
        supply_discovery_expires_at: request.supply_discovery_expires_at,
        idempotency_key: request.idempotency_key,
        expires_at: request.expires_at,
    };
    let (outcome, duplicate) = state.marketplace.create_intent(&headers, &command).await?;
    let status = if duplicate {
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
    let domain_id = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    let intent_id = parse_id::<MarketplaceIntentId>(&intent_id)?;
    let intent = state
        .marketplace
        .intent(&headers, tenant_id, domain_id, participant_id, intent_id)
        .await?;
    Ok(Json(intent))
}

pub(super) async fn update_intent(
    State(state): State<Arc<AppState>>,
    Path(intent_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<UpdateIntentRequest>,
) -> Result<Json<MarketplaceIntent>, ApiError> {
    let intent = state
        .marketplace
        .update_intent(
            &headers,
            &UpdateMarketplaceIntent {
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                intent_id: parse_id::<MarketplaceIntentId>(&intent_id)?,
                narrative: request.narrative,
                attributes: request.attributes,
                terms: request.terms,
                expected_version: request.expected_version,
            },
        )
        .await?;
    Ok(Json(intent))
}

pub(super) async fn profile(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<Option<matchplane_storage::MarketplaceIntentProfile>>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let domain_id = parse_id::<DomainId>(
        query
            .domain_id
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("profile requires domain_id".to_owned()))?,
    )?;
    let participant_id = parse_id::<MarketplacePartyId>(&query.participant_id)?;
    let profile = state
        .marketplace
        .profile(&headers, tenant_id, domain_id, participant_id)
        .await?;
    Ok(Json(profile))
}

pub(super) async fn upsert_profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ProfileRequest>,
) -> Result<Json<matchplane_storage::MarketplaceIntentProfile>, ApiError> {
    let profile = state
        .marketplace
        .upsert_profile(
            &headers,
            &UpsertMarketplaceIntentProfile {
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                profile: request.profile,
            },
        )
        .await?;
    Ok(Json(profile))
}

pub(super) async fn behavior_event(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<BehaviorEventRequest>,
) -> Result<
    (
        StatusCode,
        Json<matchplane_storage::MarketplaceBehaviorEventOutcome>,
    ),
    ApiError,
> {
    let (outcome, duplicate) = state
        .marketplace
        .behavior_event(
            &headers,
            &RecordMarketplaceBehaviorEvent {
                event_id: request
                    .event_id
                    .as_deref()
                    .map(parse_id::<MarketplaceBehaviorEventId>)
                    .transpose()?
                    .unwrap_or_default(),
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                intent_id: request
                    .intent_id
                    .as_deref()
                    .map(parse_id::<MarketplaceIntentId>)
                    .transpose()?,
                offer_id: request
                    .offer_id
                    .as_deref()
                    .map(parse_id::<MarketplaceOfferId>)
                    .transpose()?,
                event_type: request.event_type,
                reason: request.reason,
                metadata: request.metadata,
                idempotency_key: request.idempotency_key,
                occurred_at: request.occurred_at,
            },
        )
        .await?;
    Ok((
        if duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(outcome),
    ))
}

pub(super) async fn preferences(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<PreferencesResponse>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&query.tenant_id)?;
    let domain_id = parse_id::<DomainId>(
        query
            .domain_id
            .as_deref()
            .ok_or_else(|| ApiError::bad_request("preferences requires domain_id".to_owned()))?,
    )?;
    let participant_id = parse_id::<MarketplacePartyId>(&query.participant_id)?;
    let preferences = state
        .marketplace
        .preferences(&headers, tenant_id, domain_id, participant_id)
        .await?;
    Ok(Json(PreferencesResponse { preferences }))
}

pub(super) async fn set_preference(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PreferenceRequest>,
) -> Result<Json<MarketplaceOfferPreference>, ApiError> {
    let preference = state
        .marketplace
        .set_preference(
            &headers,
            &SetMarketplaceOfferPreference {
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                offer_id: parse_id::<MarketplaceOfferId>(&request.offer_id)?,
                state: request.state,
                reason: request.reason,
            },
        )
        .await?;
    Ok(Json(preference))
}

pub(super) async fn create_sales_handoff(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SalesHandoffRequest>,
) -> Result<(StatusCode, Json<MarketplaceSalesHandoff>), ApiError> {
    let handoff = state
        .marketplace
        .create_sales_handoff(
            &headers,
            &CreateMarketplaceSalesHandoff {
                handoff_id: request
                    .handoff_id
                    .as_deref()
                    .map(parse_id::<MarketplaceSalesHandoffId>)
                    .transpose()?
                    .unwrap_or_default(),
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                intent_id: request
                    .intent_id
                    .as_deref()
                    .map(parse_id::<MarketplaceIntentId>)
                    .transpose()?,
                summary: request.summary,
                idempotency_key: request.idempotency_key,
            },
        )
        .await?;
    Ok((StatusCode::CREATED, Json(handoff)))
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
    let intent_id = parse_id::<MarketplaceIntentId>(&intent_id)?;
    let candidates = state
        .marketplace
        .match_offers(
            &headers,
            tenant_id,
            domain_id,
            participant_id,
            intent_id,
            request.limit.unwrap_or(20),
        )
        .await?;
    Ok(Json(MatchOffersResponse {
        intent_id,
        candidates,
    }))
}

pub(super) async fn demand_matches(
    State(state): State<Arc<AppState>>,
    Path(path_offer_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<MatchDemandsRequest>,
) -> Result<Json<MatchDemandsResponse>, ApiError> {
    let offer_id = parse_id::<MarketplaceOfferId>(&path_offer_id)?;
    if request.offer_id != path_offer_id {
        return Err(ApiError::bad_request(
            "offer_id in the path and request body must match".to_owned(),
        ));
    }
    let candidates = state
        .marketplace
        .match_demands(
            &headers,
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<DomainId>(&request.domain_id)?,
            parse_id::<MarketplacePartyId>(&request.participant_id)?,
            offer_id,
            request.limit.unwrap_or(20),
        )
        .await?;
    Ok(Json(MatchDemandsResponse {
        offer_id,
        candidates,
    }))
}

pub(super) async fn update_demand_discovery(
    State(state): State<Arc<AppState>>,
    Path(intent_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<UpdateDemandDiscoveryRequest>,
) -> Result<Json<MarketplaceIntent>, ApiError> {
    let intent = state
        .marketplace
        .update_demand_discovery(
            &headers,
            &UpdateMarketplaceDemandDiscovery {
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
                intent_id: parse_id::<MarketplaceIntentId>(&intent_id)?,
                enabled: request.enabled,
                expires_at: request.expires_at,
            },
        )
        .await?;
    Ok(Json(intent))
}

pub(super) async fn create_offer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateOfferRequest>,
) -> Result<(StatusCode, Json<MarketplaceOfferOutcome>), ApiError> {
    let command = CreateMarketplaceOffer {
        offer_id: request
            .offer_id
            .as_deref()
            .map(parse_id::<MarketplaceOfferId>)
            .transpose()?
            .unwrap_or_default(),
        tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
        domain_id: parse_id::<DomainId>(&request.domain_id)?,
        supply_party_id: parse_id::<MarketplacePartyId>(&request.supply_party_id)?,
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
    let (outcome, duplicate) = state.marketplace.create_offer(&headers, &command).await?;
    let status = if duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(outcome)))
}

pub(super) async fn update_offer(
    State(state): State<Arc<AppState>>,
    Path(offer_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<UpdateOfferRequest>,
) -> Result<Json<matchplane_storage::MarketplaceOffer>, ApiError> {
    let offer = state
        .marketplace
        .update_offer(
            &headers,
            UpdateOfferCommand {
                tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
                domain_id: parse_id::<DomainId>(&request.domain_id)?,
                actor_party_id: parse_id::<MarketplacePartyId>(&request.supply_party_id)?,
                offer_id: parse_id::<MarketplaceOfferId>(&offer_id)?,
                display_name: request.display_name,
                attributes: request.attributes,
                terms: request.terms,
                expected_version: request.expected_version,
            },
        )
        .await?;
    Ok(Json(offer))
}

pub(super) async fn withdraw_offer(
    State(state): State<Arc<AppState>>,
    Path(offer_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<WithdrawOfferRequest>,
) -> Result<Json<matchplane_storage::MarketplaceOffer>, ApiError> {
    let offer = state
        .marketplace
        .withdraw_offer(
            &headers,
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<DomainId>(&request.domain_id)?,
            parse_id::<MarketplacePartyId>(&request.supply_party_id)?,
            parse_id::<MarketplaceOfferId>(&offer_id)?,
            request.expected_version,
        )
        .await?;
    Ok(Json(offer))
}

pub(super) async fn offers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<OfferQuery>,
) -> Result<(HeaderMap, Json<Vec<matchplane_storage::MarketplaceOffer>>), ApiError> {
    let offers = state
        .marketplace
        .offers(
            &headers,
            ListOffersQuery {
                tenant_id: parse_id::<TenantId>(&query.tenant_id)?,
                domain_id: parse_id::<DomainId>(&query.domain_id)?,
                supply_party_id: parse_id::<MarketplacePartyId>(&query.supply_party_id)?,
                domain_wide: query.domain_wide.unwrap_or(false),
                limit: query.limit.unwrap_or(50),
                offset: query.offset.unwrap_or(0),
            },
        )
        .await?;
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
        .marketplace
        .activate_offer(
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<MarketplaceOfferId>(&offer_id)?,
            request.expected_version,
        )
        .await?;
    Ok(Json(offer))
}

pub(super) async fn reject_offer(
    State(state): State<Arc<AppState>>,
    Path(offer_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ActivateOfferRequest>,
) -> Result<Json<matchplane_storage::MarketplaceOffer>, ApiError> {
    require_operator(&state, &headers)?;
    let offer = state
        .marketplace
        .reject_offer(
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<MarketplaceOfferId>(&offer_id)?,
            request.expected_version,
        )
        .await?;
    Ok(Json(offer))
}

pub(super) async fn create_introduction(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateIntroductionRequest>,
) -> Result<(StatusCode, Json<MarketplaceIntroductionOutcome>), ApiError> {
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let command = CreateMarketplaceIntroduction {
        introduction_id: request
            .introduction_id
            .as_deref()
            .map(parse_id::<MatchIntroductionId>)
            .transpose()?
            .unwrap_or_default(),
        tenant_id: parse_id::<TenantId>(&request.tenant_id)?,
        intent_id: parse_id::<MarketplaceIntentId>(&request.intent_id)?,
        offer_id: parse_id::<MarketplaceOfferId>(&request.offer_id)?,
        participant_id: parse_id::<MarketplacePartyId>(&request.participant_id)?,
        score: request.score,
        reasons: request.reasons,
        idempotency_key: request.idempotency_key,
        expires_at: request.expires_at,
    };
    let (outcome, duplicate) = state
        .marketplace
        .create_introduction(&headers, domain_id, &command)
        .await?;
    let status = if duplicate {
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
    let domain_id = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    let introductions = state
        .marketplace
        .introductions(&headers, tenant_id, domain_id, participant_id)
        .await?;
    Ok(Json(IntroductionsResponse { introductions }))
}

pub(super) async fn request_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ContactActionRequest>,
) -> Result<Json<MarketplaceIntroduction>, ApiError> {
    let introduction = state
        .marketplace
        .request_contact(
            &headers,
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<DomainId>(&request.domain_id)?,
            parse_id::<MarketplacePartyId>(&request.participant_id)?,
            parse_id::<MatchIntroductionId>(&introduction_id)?,
            request.idempotency_key,
        )
        .await?;
    Ok(Json(introduction))
}

/// Records supply consent. Contact values remain encrypted until a participant requests release.
pub(super) async fn consent_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ContactActionRequest>,
) -> Result<Json<MarketplaceIntroduction>, ApiError> {
    let introduction = state
        .marketplace
        .consent_contact(
            &headers,
            parse_id::<TenantId>(&request.tenant_id)?,
            parse_id::<DomainId>(&request.domain_id)?,
            parse_id::<MarketplacePartyId>(&request.participant_id)?,
            parse_id::<MatchIntroductionId>(&introduction_id)?,
            request.idempotency_key,
        )
        .await?;
    Ok(Json(introduction))
}

/// Releases the counterpart's encrypted contact only after supply consent and participant checks.
pub(super) async fn release_contact(
    State(state): State<Arc<AppState>>,
    Path(introduction_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ContactActionRequest>,
) -> Result<Json<MarketplaceContactResponse>, ApiError> {
    let tenant_id = parse_id::<TenantId>(&request.tenant_id)?;
    let actor_party_id = parse_id::<MarketplacePartyId>(&request.participant_id)?;
    let envelope = state
        .marketplace
        .release_contact(
            &headers,
            tenant_id,
            parse_id::<DomainId>(&request.domain_id)?,
            actor_party_id,
            parse_id::<MatchIntroductionId>(&introduction_id)?,
            &request.idempotency_key,
        )
        .await?;
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
