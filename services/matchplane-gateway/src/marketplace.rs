use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
};
use matchplane_domain::{
    AssetId, BuyerRequestId, DomainId, MarketplacePartyId, OfflineDealId, PromotionCampaignId,
    TenantId, VehicleListingId, ViewingAppointmentId,
};
use matchplane_storage::{
    AcceptContactExchange, AuthenticatedParty, ConfirmOfflineDeal, CreateBuyerVehicleRequest,
    CreateMarketplaceParty, CreateOfflineDeal, CreateSellerPromotion, CreateVehicleListing,
    CreateViewingAppointment, EncryptedContact, ExposureMetrics, FinalizeOfflineDeal,
    MarketplaceAssetAuthorization, MarketplaceParty, OfflineDeal, OfflineDealOutcome,
    OfflineDealProgress, RecommendVehicleListings, RecommendedListing, RecordExposure,
    ReleaseContact, SellerPromotionCampaign, SetMarketplaceAssetAuthorization,
    TransitionViewingAppointment, VehicleListing, ViewingAppointment,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{ApiError, AppState, parse_exact, parse_id, require_operator};

#[derive(Deserialize)]
pub(super) struct CreatePartyRequest {
    party_id: Option<String>,
    tenant_id: String,
    external_key: String,
    display_name: String,
    role: String,
    contact: Value,
}

#[derive(Debug, Serialize)]
pub(super) struct CreatedPartyResponse {
    #[serde(flatten)]
    party: MarketplaceParty,
    /// Returned exactly once. Clients must store it as a secret.
    access_token: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateListingRequest {
    listing_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    asset_id: String,
    seller_party_id: String,
    asking_amount: String,
    currency: String,
    currency_scale: i16,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AssetAuthorizationRequest {
    tenant_id: String,
    domain_id: String,
    asset_id: String,
    seller_party_id: String,
    enabled: bool,
    authorized_by: String,
    reason: String,
}

#[derive(Deserialize)]
pub(super) struct CreateBuyerRequest {
    request_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    buyer_party_id: String,
    narrative: String,
    requirements: Value,
    budget_min: Option<String>,
    budget_max: Option<String>,
    currency: String,
    currency_scale: i16,
}

#[derive(Debug, Deserialize)]
pub(super) struct RecommendationRequest {
    tenant_id: String,
    buyer_party_id: String,
    exposure_key: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateDealRequest {
    offline_deal_id: Option<String>,
    tenant_id: String,
    listing_id: String,
    buyer_request_id: String,
    buyer_party_id: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ConfirmDealRequest {
    tenant_id: String,
    party_id: String,
    final_amount: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct FinalizeDealRequest {
    tenant_id: String,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct AcceptContactRequest {
    tenant_id: String,
    party_id: String,
}

#[derive(Deserialize)]
pub(super) struct CreateViewingRequest {
    viewing_id: Option<String>,
    tenant_id: String,
    proposed_by: String,
    #[serde(with = "time::serde::rfc3339")]
    starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    ends_at: OffsetDateTime,
    location: Value,
}

#[derive(Debug, Deserialize)]
pub(super) struct TransitionViewingRequest {
    tenant_id: String,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PartyQuery {
    tenant_id: String,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ViewingQuery {
    tenant_id: String,
    party_id: String,
    /// Number of appointments returned in one page. The storage layer applies the same cap.
    limit: Option<u16>,
    /// Number of appointments to skip for the next page.
    offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ExposureRequest {
    tenant_id: String,
    viewer_party_id: String,
    event_type: String,
}

#[derive(Debug, Serialize)]
pub(super) struct ExposureResponse {
    duplicate: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreatePromotionRequest {
    campaign_id: Option<String>,
    tenant_id: String,
    sponsor_party_id: String,
    target_kind: String,
    target_key: String,
    #[serde(default = "default_promotion_policy")]
    policy: String,
    pricing_model: String,
    currency: String,
    currency_scale: i16,
    unit_price: String,
    budget_amount: String,
    #[serde(default)]
    settings: Value,
    #[serde(default, with = "time::serde::rfc3339::option")]
    starts_at: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    ends_at: Option<OffsetDateTime>,
}

#[derive(Debug, Serialize)]
pub(super) struct CounterpartContact {
    party_id: MarketplacePartyId,
    display_name: String,
    contact: Value,
}

#[derive(Debug, Serialize)]
pub(super) struct ContactResponse {
    counterpart: CounterpartContact,
    deal: OfflineDeal,
    /// Vehicle funds are exchanged directly by buyer and seller outside the payment service.
    vehicle_settlement: &'static str,
    /// The platform fee remains independently auditable and payable through the payment service.
    platform_commission_settlement: &'static str,
}

#[derive(Debug, Serialize)]
pub(super) struct ViewingResponse {
    #[serde(flatten)]
    viewing: ViewingAppointment,
    location: Value,
}

pub(super) async fn create_party(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreatePartyRequest>,
) -> Result<(StatusCode, Json<CreatedPartyResponse>), ApiError> {
    validate_text(&request.external_key, "external_key", 256)?;
    validate_text(&request.display_name, "display_name", 200)?;
    if !matches!(request.role.as_str(), "buyer" | "seller" | "both") {
        return Err(ApiError::bad_request(
            "role must be buyer, seller, or both".to_owned(),
        ));
    }
    let contact = normalize_contact(&request.contact)?;
    let contact_bytes = serde_json::to_vec(&contact)
        .map_err(|error| ApiError::bad_request(format!("contact is invalid: {error}")))?;
    if contact_bytes.len() > 16 * 1024 {
        return Err(ApiError::bad_request(
            "contact must not exceed 16 KiB".to_owned(),
        ));
    }
    let party_id = request
        .party_id
        .as_deref()
        .map(parse_id::<MarketplacePartyId>)
        .transpose()?
        .unwrap_or_default();
    let tenant_id = parse_id(&request.tenant_id)?;
    let access_token = format!("mp_{}_{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let access_token_hash = Sha256::digest(access_token.as_bytes()).to_vec();
    let protected = state
        .contact_cipher
        .encrypt(&contact_bytes, &contact_aad(tenant_id, party_id))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let party = state
        .store
        .create_marketplace_party(&CreateMarketplaceParty {
            party_id,
            tenant_id,
            external_key: request.external_key,
            display_name: request.display_name,
            role: request.role,
            access_token_hash,
            contact: EncryptedContact {
                ciphertext: protected.ciphertext,
                nonce: protected.nonce.to_vec(),
                key_version: protected.key_version,
            },
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedPartyResponse {
            party,
            access_token,
        }),
    ))
}

pub(super) async fn create_listing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateListingRequest>,
) -> Result<(StatusCode, Json<VehicleListing>), ApiError> {
    validate_currency(&request.currency)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let seller_party_id = parse_id(&request.seller_party_id)?;
    authenticate(&state, &headers, tenant_id, seller_party_id).await?;
    let listing = state
        .store
        .create_vehicle_listing(&CreateVehicleListing {
            listing_id: request
                .listing_id
                .as_deref()
                .map(parse_id::<VehicleListingId>)
                .transpose()?
                .unwrap_or_default(),
            tenant_id,
            domain_id: parse_id::<DomainId>(&request.domain_id)?,
            asset_id: parse_id::<AssetId>(&request.asset_id)?,
            seller_party_id,
            asking_amount: positive_exact(&request.asking_amount, "asking_amount")?,
            currency: request.currency,
            currency_scale: request.currency_scale,
            expires_at: request.expires_at,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(listing)))
}

pub(super) async fn set_asset_authorization(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<AssetAuthorizationRequest>,
) -> Result<(StatusCode, Json<MarketplaceAssetAuthorization>), ApiError> {
    require_operator(&state, &headers)?;
    let authorization = state
        .store
        .set_marketplace_asset_authorization(&SetMarketplaceAssetAuthorization {
            tenant_id: parse_id(&request.tenant_id)?,
            domain_id: parse_id(&request.domain_id)?,
            asset_id: parse_id(&request.asset_id)?,
            seller_party_id: parse_id(&request.seller_party_id)?,
            enabled: request.enabled,
            authorized_by: request.authorized_by,
            reason: request.reason,
        })
        .await?;
    Ok((StatusCode::OK, Json(authorization)))
}

pub(super) async fn create_buyer_request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateBuyerRequest>,
) -> Result<(StatusCode, Json<matchplane_storage::BuyerVehicleRequest>), ApiError> {
    validate_text(&request.narrative, "narrative", 10_000)?;
    validate_currency(&request.currency)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate(&state, &headers, tenant_id, buyer_party_id).await?;
    let buyer_request = state
        .store
        .create_buyer_vehicle_request(&CreateBuyerVehicleRequest {
            request_id: request
                .request_id
                .as_deref()
                .map(parse_id::<BuyerRequestId>)
                .transpose()?
                .unwrap_or_default(),
            tenant_id,
            domain_id: parse_id::<DomainId>(&request.domain_id)?,
            buyer_party_id,
            narrative: request.narrative,
            requirements: request.requirements,
            budget_min: request
                .budget_min
                .as_deref()
                .map(|value| non_negative_exact(value, "budget_min"))
                .transpose()?,
            budget_max: request
                .budget_max
                .as_deref()
                .map(|value| positive_exact(value, "budget_max"))
                .transpose()?,
            currency: request.currency,
            currency_scale: request.currency_scale,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(buyer_request)))
}

pub(super) async fn recommendations(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RecommendationRequest>,
) -> Result<Json<Vec<RecommendedListing>>, ApiError> {
    let tenant_id = parse_id(&request.tenant_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate(&state, &headers, tenant_id, buyer_party_id).await?;
    state
        .store
        .recommend_vehicle_listings(&RecommendVehicleListings {
            tenant_id,
            request_id: parse_id(&request_id)?,
            buyer_party_id,
            exposure_key: request.exposure_key,
            limit: request.limit.unwrap_or(20),
        })
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn create_offline_deal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateDealRequest>,
) -> Result<(StatusCode, Json<OfflineDealOutcome>), ApiError> {
    let tenant_id = parse_id(&request.tenant_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate(&state, &headers, tenant_id, buyer_party_id).await?;
    let outcome = state
        .store
        .create_offline_deal(&CreateOfflineDeal {
            offline_deal_id: request
                .offline_deal_id
                .as_deref()
                .map(parse_id::<OfflineDealId>)
                .transpose()?
                .unwrap_or_default(),
            tenant_id,
            listing_id: parse_id(&request.listing_id)?,
            buyer_request_id: parse_id(&request.buyer_request_id)?,
            buyer_party_id,
            expires_at: request
                .expires_at
                .unwrap_or_else(|| OffsetDateTime::now_utc() + Duration::days(7)),
        })
        .await?;
    let status = if outcome.duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(outcome)))
}

pub(super) async fn offline_deals(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<OfflineDeal>>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let party_id = parse_id(&query.party_id)?;
    authenticate(&state, &headers, tenant_id, party_id).await?;
    state
        .store
        .offline_deals_for_party(tenant_id, party_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn offline_deal(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<OfflineDeal>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let party_id = parse_id(&query.party_id)?;
    authenticate(&state, &headers, tenant_id, party_id).await?;
    let deal = state
        .store
        .offline_deal(parse_id(&offline_deal_id)?)
        .await?;
    if deal.tenant_id != tenant_id
        || (deal.buyer_party_id != party_id && deal.seller_party_id != party_id)
    {
        return Err(ApiError::not_found("offline deal was not found"));
    }
    Ok(Json(deal))
}

pub(super) async fn accept_contact_exchange(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<AcceptContactRequest>,
) -> Result<Json<OfflineDeal>, ApiError> {
    let tenant_id = parse_id(&request.tenant_id)?;
    let seller_party_id = parse_id(&request.party_id)?;
    let party = authenticate(&state, &headers, tenant_id, seller_party_id).await?;
    require_role(&party, "seller")?;
    state
        .store
        .accept_contact_exchange(&AcceptContactExchange {
            tenant_id,
            offline_deal_id: parse_id(&offline_deal_id)?,
            seller_party_id,
        })
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn confirm_offline_deal(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ConfirmDealRequest>,
) -> Result<Json<OfflineDealProgress>, ApiError> {
    let tenant_id = parse_id(&request.tenant_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate(&state, &headers, tenant_id, party_id).await?;
    state
        .store
        .confirm_offline_deal(&ConfirmOfflineDeal {
            tenant_id,
            offline_deal_id: parse_id(&offline_deal_id)?,
            actor_party_id: party_id,
            final_amount: positive_exact(&request.final_amount, "final_amount")?,
        })
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn finalize_offline_deal(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<FinalizeDealRequest>,
) -> Result<Json<OfflineDealProgress>, ApiError> {
    let tenant_id = parse_id(&request.tenant_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate(&state, &headers, tenant_id, party_id).await?;
    state
        .store
        .finalize_offline_deal(&FinalizeOfflineDeal {
            tenant_id,
            offline_deal_id: parse_id(&offline_deal_id)?,
            actor_party_id: party_id,
        })
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn create_viewing(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CreateViewingRequest>,
) -> Result<(StatusCode, Json<ViewingResponse>), ApiError> {
    if !request.location.is_object()
        || request
            .location
            .as_object()
            .is_some_and(|map| map.is_empty())
    {
        return Err(ApiError::bad_request(
            "location must be a non-empty JSON object".to_owned(),
        ));
    }
    let location_bytes = serde_json::to_vec(&request.location)
        .map_err(|error| ApiError::bad_request(format!("location is invalid: {error}")))?;
    if location_bytes.len() > 16 * 1024 {
        return Err(ApiError::bad_request(
            "location must not exceed 16 KiB".to_owned(),
        ));
    }
    let tenant_id = parse_id(&request.tenant_id)?;
    let offline_deal_id = parse_id(&offline_deal_id)?;
    let proposed_by = parse_id(&request.proposed_by)?;
    authenticate(&state, &headers, tenant_id, proposed_by).await?;
    let viewing_id = request
        .viewing_id
        .as_deref()
        .map(parse_id::<ViewingAppointmentId>)
        .transpose()?
        .unwrap_or_default();
    let protected = state
        .contact_cipher
        .encrypt(
            &location_bytes,
            &viewing_aad(tenant_id, offline_deal_id, viewing_id),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let viewing = state
        .store
        .create_viewing_appointment(&CreateViewingAppointment {
            viewing_id,
            tenant_id,
            offline_deal_id,
            proposed_by,
            starts_at: request.starts_at,
            ends_at: request.ends_at,
            location: EncryptedContact {
                ciphertext: protected.ciphertext,
                nonce: protected.nonce.to_vec(),
                key_version: protected.key_version,
            },
        })
        .await?;
    Ok((StatusCode::CREATED, Json(decrypt_viewing(&state, viewing)?)))
}

pub(super) async fn viewings(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    Query(query): Query<ViewingQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<ViewingResponse>>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let offline_deal_id = parse_id(&offline_deal_id)?;
    let party_id = parse_id(&query.party_id)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=50).contains(&limit) {
        return Err(ApiError::bad_request(
            "viewing limit must be between 1 and 50".to_owned(),
        ));
    }
    let offset = query.offset.unwrap_or(0);
    if offset > 32 {
        return Err(ApiError::bad_request(
            "viewing offset must be between 0 and 32".to_owned(),
        ));
    }
    authenticate(&state, &headers, tenant_id, party_id).await?;
    let viewings = state
        .store
        .viewing_appointments(
            tenant_id,
            offline_deal_id,
            party_id,
            i64::from(limit),
            i64::from(offset),
        )
        .await?;
    let viewings = viewings
        .into_iter()
        .map(|viewing| decrypt_viewing(&state, viewing))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(viewings))
}

pub(super) async fn transition_viewing(
    State(state): State<Arc<AppState>>,
    Path((viewing_id, action)): Path<(String, String)>,
    headers: HeaderMap,
    Json(request): Json<TransitionViewingRequest>,
) -> Result<Json<ViewingResponse>, ApiError> {
    if !matches!(action.as_str(), "confirm" | "complete" | "cancel") {
        return Err(ApiError::bad_request(
            "viewing action must be confirm, complete, or cancel".to_owned(),
        ));
    }
    let tenant_id = parse_id(&request.tenant_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate(&state, &headers, tenant_id, party_id).await?;
    let viewing = state
        .store
        .transition_viewing_appointment(&TransitionViewingAppointment {
            tenant_id,
            viewing_id: parse_id(&viewing_id)?,
            actor_party_id: party_id,
            action,
        })
        .await?;
    Ok(Json(decrypt_viewing(&state, viewing)?))
}

pub(super) async fn contact(
    State(state): State<Arc<AppState>>,
    Path(offline_deal_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<ContactResponse>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let actor_party_id = parse_id(&query.party_id)?;
    authenticate(&state, &headers, tenant_id, actor_party_id).await?;
    let fingerprint = request_fingerprint(&headers);
    let envelope = state
        .store
        .release_offline_contact(&ReleaseContact {
            tenant_id,
            offline_deal_id: parse_id(&offline_deal_id)?,
            actor_party_id,
            request_fingerprint: fingerprint,
        })
        .await?;
    let plaintext = state
        .contact_cipher
        .decrypt(
            &envelope.ciphertext,
            &envelope.nonce,
            envelope.key_version,
            &contact_aad(tenant_id, envelope.target_party_id),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let contact = serde_json::from_slice(&plaintext)
        .map_err(|error| ApiError::internal(format!("stored contact is invalid: {error}")))?;
    Ok(Json(ContactResponse {
        counterpart: CounterpartContact {
            party_id: envelope.target_party_id,
            display_name: envelope.display_name,
            contact,
        },
        deal: envelope.deal,
        vehicle_settlement: "offline_direct_between_buyer_and_seller",
        platform_commission_settlement: "separate_payment_service",
    }))
}

pub(super) async fn record_exposure(
    State(state): State<Arc<AppState>>,
    Path(listing_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ExposureRequest>,
) -> Result<(StatusCode, Json<ExposureResponse>), ApiError> {
    if !matches!(request.event_type.as_str(), "detail_view" | "favorite") {
        return Err(ApiError::bad_request(
            "public exposure endpoint accepts only detail_view or favorite".to_owned(),
        ));
    }
    let tenant_id = parse_id(&request.tenant_id)?;
    let viewer_party_id = parse_id(&request.viewer_party_id)?;
    let party = authenticate(&state, &headers, tenant_id, viewer_party_id).await?;
    require_role(&party, "buyer")?;
    let listing_id = parse_id(&listing_id)?;
    let occurred_at = OffsetDateTime::now_utc();
    let deduplication_key = format!(
        "public:{}:{}:{}:{}",
        viewer_party_id,
        listing_id,
        request.event_type,
        occurred_at.date()
    );
    let inserted = state
        .store
        .record_seller_exposure(&RecordExposure {
            tenant_id,
            listing_id,
            viewer_party_id: Some(viewer_party_id),
            event_type: request.event_type,
            source: "buyer_client".to_owned(),
            deduplication_key,
            occurred_at,
        })
        .await?;
    Ok((
        if inserted {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(ExposureResponse {
            duplicate: !inserted,
        }),
    ))
}

pub(super) async fn exposure_metrics(
    State(state): State<Arc<AppState>>,
    Path(listing_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<ExposureMetrics>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let seller_party_id = parse_id(&query.party_id)?;
    let party = authenticate(&state, &headers, tenant_id, seller_party_id).await?;
    require_role(&party, "seller")?;
    state
        .store
        .seller_exposure_metrics(tenant_id, parse_id(&listing_id)?, seller_party_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn create_seller_promotion(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreatePromotionRequest>,
) -> Result<(StatusCode, Json<SellerPromotionCampaign>), ApiError> {
    validate_text(&request.target_kind, "target_kind", 64)?;
    validate_text(&request.target_key, "target_key", 256)?;
    validate_currency(&request.currency)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let sponsor_party_id = parse_id(&request.sponsor_party_id)?;
    let party = authenticate(&state, &headers, tenant_id, sponsor_party_id).await?;
    require_role(&party, "seller")?;
    let settings = if request.settings.is_null() {
        serde_json::json!({})
    } else {
        request.settings
    };
    if !settings.is_object() {
        return Err(ApiError::bad_request(
            "settings must be a JSON object".to_owned(),
        ));
    }
    let campaign = state
        .store
        .create_seller_promotion(&CreateSellerPromotion {
            campaign_id: request
                .campaign_id
                .as_deref()
                .map(parse_id::<PromotionCampaignId>)
                .transpose()?
                .unwrap_or_default(),
            tenant_id,
            sponsor_party_id,
            target_kind: request.target_kind,
            target_key: request.target_key,
            policy: request.policy,
            pricing_model: request.pricing_model,
            currency: request.currency,
            currency_scale: request.currency_scale,
            unit_price: non_negative_exact(&request.unit_price, "unit_price")?,
            budget_amount: positive_exact(&request.budget_amount, "budget_amount")?,
            settings,
            starts_at: request.starts_at.unwrap_or_else(OffsetDateTime::now_utc),
            ends_at: request.ends_at,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(campaign)))
}

pub(super) async fn seller_promotion(
    State(state): State<Arc<AppState>>,
    Path(campaign_id): Path<String>,
    Query(query): Query<PartyQuery>,
    headers: HeaderMap,
) -> Result<Json<SellerPromotionCampaign>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let party_id = parse_id(&query.party_id)?;
    let party = authenticate(&state, &headers, tenant_id, party_id).await?;
    require_role(&party, "seller")?;
    state
        .store
        .seller_promotion(tenant_id, parse_id(&campaign_id)?, party_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    tenant_id: TenantId,
    party_id: MarketplacePartyId,
) -> Result<AuthenticatedParty, ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("party bearer token is required"))?;
    let token = authorization
        .strip_prefix("Bearer ")
        .filter(|token| token.len() >= 64)
        .ok_or_else(|| ApiError::unauthorized("party bearer token is invalid"))?;
    let token_hash = Sha256::digest(token.as_bytes());
    state
        .store
        .authenticate_marketplace_party(tenant_id, party_id, token_hash.as_slice())
        .await
        .map_err(|error| match error {
            matchplane_storage::StorageError::Forbidden(_) => {
                ApiError::unauthorized("party bearer token is invalid")
            }
            other => ApiError::from(other),
        })
}

fn require_role(party: &AuthenticatedParty, role: &str) -> Result<(), ApiError> {
    if party.role == role || party.role == "both" {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!("{role} role is required")))
    }
}

fn default_promotion_policy() -> String {
    "seller_promotion".to_owned()
}

fn contact_aad(tenant_id: TenantId, party_id: MarketplacePartyId) -> Vec<u8> {
    format!("matchplane:party-contact:v1:{tenant_id}:{party_id}").into_bytes()
}

fn viewing_aad(
    tenant_id: TenantId,
    offline_deal_id: OfflineDealId,
    viewing_id: ViewingAppointmentId,
) -> Vec<u8> {
    format!("matchplane:viewing-location:v1:{tenant_id}:{offline_deal_id}:{viewing_id}")
        .into_bytes()
}

fn decrypt_viewing(
    state: &AppState,
    viewing: ViewingAppointment,
) -> Result<ViewingResponse, ApiError> {
    let plaintext = state
        .contact_cipher
        .decrypt(
            &viewing.location_ciphertext,
            &viewing.location_nonce,
            viewing.encryption_key_version,
            &viewing_aad(
                viewing.tenant_id,
                viewing.offline_deal_id,
                viewing.viewing_id,
            ),
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let location = serde_json::from_slice(&plaintext)
        .map_err(|error| ApiError::internal(format!("stored location is invalid: {error}")))?;
    Ok(ViewingResponse { viewing, location })
}

fn request_fingerprint(headers: &HeaderMap) -> Option<Vec<u8>> {
    let request_id = headers.get("x-request-id")?.to_str().ok()?;
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    Some(Sha256::digest(format!("{request_id}\n{user_agent}").as_bytes()).to_vec())
}

fn validate_text(value: &str, field: &str, maximum: usize) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.len() > maximum {
        return Err(ApiError::bad_request(format!(
            "{field} must contain 1..={maximum} bytes"
        )));
    }
    Ok(())
}

fn normalize_contact(contact: &Value) -> Result<Value, ApiError> {
    let object = contact.as_object().ok_or_else(|| {
        ApiError::bad_request("contact must contain phone and/or wechat".to_owned())
    })?;
    let mut normalized = serde_json::Map::new();
    for field in ["phone", "wechat"] {
        let Some(value) = object.get(field) else {
            continue;
        };
        let value = value
            .as_str()
            .ok_or_else(|| ApiError::bad_request(format!("contact.{field} must be a string")))?;
        let value = value.trim();
        if value.is_empty() || value.len() > 64 || value.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(ApiError::bad_request(format!(
                "contact.{field} must contain 1..=64 printable bytes"
            )));
        }
        if field == "phone" {
            let digit_count = value.bytes().filter(u8::is_ascii_digit).count();
            if !(6..=20).contains(&digit_count)
                || !value.bytes().all(|byte| {
                    byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b' ' | b'(' | b')')
                })
            {
                return Err(ApiError::bad_request(
                    "contact.phone must be a valid phone number".to_owned(),
                ));
            }
        }
        normalized.insert(field.to_owned(), Value::String(value.to_owned()));
    }
    if normalized.is_empty() {
        return Err(ApiError::bad_request(
            "contact must include at least one of phone or wechat".to_owned(),
        ));
    }
    Ok(Value::Object(normalized))
}

fn validate_currency(currency: &str) -> Result<(), ApiError> {
    if currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "currency must be a three-letter uppercase ISO code".to_owned(),
        ))
    }
}

fn positive_exact(value: &str, field: &str) -> Result<i128, ApiError> {
    let value = parse_exact(value)?;
    if value <= 0 {
        return Err(ApiError::bad_request(format!("{field} must be positive")));
    }
    Ok(value)
}

fn non_negative_exact(value: &str, field: &str) -> Result<i128, ApiError> {
    let value = parse_exact(value)?;
    if value < 0 {
        return Err(ApiError::bad_request(format!(
            "{field} must be non-negative"
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contact_exchange_keeps_only_phone_and_wechat() {
        let normalized = normalize_contact(&json!({
            "phone": " +86 138 0000 0000 ",
            "wechat": "seller_mp",
            "private_note": "must not be shared",
        }))
        .expect("contact should be valid");

        assert_eq!(
            normalized,
            json!({
                "phone": "+86 138 0000 0000",
                "wechat": "seller_mp",
            })
        );
    }

    #[test]
    fn contact_exchange_requires_a_supported_channel() {
        let error = normalize_contact(&json!({"email": "seller@example.invalid"}))
            .expect_err("email-only contact must be rejected");
        assert!(error.message.contains("phone or wechat"));
    }
}
