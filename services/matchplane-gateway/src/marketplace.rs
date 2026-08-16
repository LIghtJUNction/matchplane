use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use matchplane_domain::{
    AssetId, AssetSchemaId, BuyerRequestId, DomainId, MarketplacePartyId, OfflineDealId,
    PromotionCampaignId, TenantId, VehicleListingId, ViewingAppointmentId,
};
use matchplane_storage::{
    AcceptContactExchange, ApproveMarketplaceListingSubmission, AuthenticatedParty,
    ConfirmOfflineDeal, CreateBuyerVehicleRequest, CreateMarketplaceListingSubmission,
    CreateMarketplaceParty, CreateOfflineDeal, CreateSellerPromotion, CreateVehicleListing,
    CreateViewingAppointment, EncryptedContact, EnsureMarketplaceParty, ExposureMetrics,
    FinalizeOfflineDeal, MarketplaceAssetAuthorization, MarketplaceListingSubmission,
    MarketplaceParty, OfflineDeal, OfflineDealOutcome, OfflineDealProgress,
    RecommendVehicleListings, RecommendedListing, RecordExposure, ReleaseContact,
    SellerPromotionCampaign, SetMarketplaceAssetAuthorization, SubplatformEmailConfig,
    TransitionViewingAppointment, UpsertSubplatformEmailConfig, VehicleListing, ViewingAppointment,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::{ApiError, AppState, parse_exact, parse_id, require_operator};

const PARTY_REGISTRATION_GLOBAL_LIMIT: u32 = 10_000;
const PARTY_REGISTRATION_TENANT_LIMIT: u32 = 100;
const PARTY_REGISTRATION_WINDOW_SECS: u32 = 60 * 60;
const PARTY_CAPABILITY_TTL: Duration = Duration::minutes(15);

#[derive(Deserialize)]
pub(super) struct CreatePartyRequest {
    party_id: Option<String>,
    tenant_id: String,
    domain_id: Option<String>,
    platform_path: Option<String>,
    external_key: String,
    display_name: String,
    /// Optional compatibility label. Generic callers should send `marketplace_sides` instead;
    /// the storage projection derives the old label only at this adapter boundary.
    role: Option<String>,
    /// Generic kernel capabilities. Omitted only for legacy callers; then derived from `role`.
    #[serde(default)]
    marketplace_sides: Option<Vec<String>>,
    contact: Value,
}

#[derive(Deserialize)]
pub(super) struct EnsurePartySessionRequest {
    auth_user_id: String,
    party_id: Option<String>,
    tenant_id: String,
    domain_id: Option<String>,
    platform_path: Option<String>,
    external_key: String,
    display_name: String,
    role: String,
    /// Generic kernel capabilities. Omitted only for legacy callers; then derived from `role`.
    #[serde(default)]
    marketplace_sides: Option<Vec<String>>,
    contact: Value,
    /// Normal session refreshes preserve user-configured contact channels. Set false only when
    /// the authenticated user intentionally saves a new contact profile.
    #[serde(default)]
    preserve_contact: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct CreatedPartyResponse {
    #[serde(flatten)]
    party: MarketplaceParty,
    /// Returned exactly once. Clients must store it as a secret.
    access_token: String,
    /// Hard expiry for the returned tenant-scoped capability.
    #[serde(with = "time::serde::rfc3339")]
    access_token_expires_at: OffsetDateTime,
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
pub(super) struct CreateListingSubmissionRequest {
    submission_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    seller_party_id: String,
    asset_schema_id: String,
    external_key: String,
    display_name: String,
    attributes: Value,
    asking_amount: String,
    currency: String,
    currency_scale: i16,
}

#[derive(Debug, Deserialize)]
pub(super) struct ListingSubmissionsQuery {
    tenant_id: String,
    domain_id: String,
    seller_party_id: String,
    /// Number of submissions returned in one page.
    limit: Option<u16>,
    /// Number of submissions to skip.
    offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ApproveListingSubmissionRequest {
    tenant_id: String,
    authorized_by: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct SubplatformEmailConfigRequest {
    tenant_id: String,
    party_id: String,
    provider_key: String,
    smtp_host: String,
    smtp_port: i32,
    tls_mode: String,
    username: String,
    credential_secret_ref: String,
    from_address: String,
    reply_to: Option<String>,
    mode: String,
    enabled: bool,
    expected_version: Option<i64>,
    updated_by: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct SubplatformEmailConfigQuery {
    tenant_id: String,
    party_id: String,
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
    domain_id: String,
    buyer_party_id: String,
    exposure_key: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateDealRequest {
    offline_deal_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    listing_id: String,
    buyer_request_id: String,
    buyer_party_id: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ConfirmDealRequest {
    tenant_id: String,
    domain_id: String,
    party_id: String,
    final_amount: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct FinalizeDealRequest {
    tenant_id: String,
    domain_id: String,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct AcceptContactRequest {
    tenant_id: String,
    domain_id: String,
    party_id: String,
}

#[derive(Deserialize)]
pub(super) struct CreateViewingRequest {
    viewing_id: Option<String>,
    tenant_id: String,
    domain_id: String,
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
    domain_id: String,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct PartyQuery {
    tenant_id: String,
    domain_id: Option<String>,
    party_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ViewingQuery {
    tenant_id: String,
    domain_id: Option<String>,
    party_id: String,
    /// Number of appointments returned in one page. The storage layer applies the same cap.
    limit: Option<u16>,
    /// Number of appointments to skip for the next page.
    offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ExposureRequest {
    tenant_id: String,
    domain_id: Option<String>,
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
    domain_id: Option<String>,
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
pub(super) struct ContactSettlement {
    /// How the participants settle outside the hosted checkout, when the vertical permits it.
    mode: &'static str,
    /// Where the platform fee is settled and audited.
    platform_fee: &'static str,
}

#[derive(Debug, Serialize)]
pub(super) struct ContactResponse {
    counterpart: CounterpartContact,
    deal: OfflineDeal,
    settlement: ContactSettlement,
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
    if let Some(role) = request.role.as_deref()
        && !matches!(role, "buyer" | "seller" | "both")
    {
        return Err(ApiError::bad_request(
            "role must be buyer, seller, or both".to_owned(),
        ));
    }
    let marketplace_sides =
        resolve_marketplace_sides(request.role.as_deref(), request.marketplace_sides)?;
    let compatibility_role = compatibility_role_for_sides(&marketplace_sides);
    let contact = normalize_contact(&request.contact, false)?;
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
    let scope_domain_id = request
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    let platform_path = normalize_platform_path(request.platform_path.as_deref().unwrap_or("/"))?;
    let global_allowed = state
        .cache
        .lock()
        .await
        .consume_fixed_window(
            "mp:rate:party-registration:global",
            PARTY_REGISTRATION_GLOBAL_LIMIT,
            PARTY_REGISTRATION_WINDOW_SECS,
        )
        .await
        .map_err(|error| ApiError::service_unavailable(error.to_string()))?;
    if !global_allowed {
        return Err(ApiError::too_many_requests(
            "party registration rate limit exceeded",
        ));
    }
    let tenant_allowed = state
        .cache
        .lock()
        .await
        .consume_fixed_window(
            &party_registration_tenant_key(tenant_id),
            PARTY_REGISTRATION_TENANT_LIMIT,
            PARTY_REGISTRATION_WINDOW_SECS,
        )
        .await
        .map_err(|error| ApiError::service_unavailable(error.to_string()))?;
    if !tenant_allowed {
        return Err(ApiError::too_many_requests(
            "party registration rate limit exceeded",
        ));
    }
    let access_token = format!("mp_{}_{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let access_token_hash = Sha256::digest(access_token.as_bytes()).to_vec();
    let access_token_expires_at = OffsetDateTime::now_utc() + PARTY_CAPABILITY_TTL;
    let protected = state
        .contact_cipher
        .encrypt(&contact_bytes, &contact_aad(tenant_id, party_id))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let party = state
        .store
        .create_marketplace_party(&CreateMarketplaceParty {
            party_id,
            tenant_id,
            scope_domain_id,
            platform_path,
            external_key: request.external_key,
            display_name: request.display_name,
            role: compatibility_role,
            marketplace_sides,
            access_token_hash,
            access_token_expires_at,
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
            access_token_expires_at,
        }),
    ))
}

/// Registers a participant through the domain-neutral surface.  Compatibility role labels are
/// deliberately not accepted here; only the stable kernel capabilities are part of this API.
pub(super) async fn create_participant(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreatePartyRequest>,
) -> Result<(StatusCode, Json<CreatedPartyResponse>), ApiError> {
    if request.marketplace_sides.is_none() {
        return Err(ApiError::bad_request(
            "marketplace_sides is required for generic participants".to_owned(),
        ));
    }
    if request.role.is_some() {
        return Err(ApiError::bad_request(
            "generic participants use marketplace_sides instead of role".to_owned(),
        ));
    }
    create_party(State(state), Json(request)).await
}

/// Bridges an authenticated Better Auth session to a tenant-scoped marketplace capability.
/// Only the Next server, holding the gateway operator secret, may call this endpoint.
pub(super) async fn ensure_party_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<EnsurePartySessionRequest>,
) -> Result<(StatusCode, Json<CreatedPartyResponse>), ApiError> {
    require_operator(&state, &headers)?;
    validate_text(&request.auth_user_id, "auth_user_id", 100)?;
    validate_text(&request.external_key, "external_key", 256)?;
    validate_text(&request.display_name, "display_name", 200)?;
    let auth_user_id: Uuid = parse_id(&request.auth_user_id)?;
    if !matches!(request.role.as_str(), "buyer" | "seller" | "both") {
        return Err(ApiError::bad_request(
            "role must be buyer, seller, or both".to_owned(),
        ));
    }
    let marketplace_sides =
        resolve_marketplace_sides(Some(request.role.as_str()), request.marketplace_sides)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let platform_path = normalize_platform_path(request.platform_path.as_deref().unwrap_or("/"))?;
    let scope_domain_id = request
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    if platform_path != "/" && scope_domain_id.is_none() {
        return Err(ApiError::bad_request(
            "child platform sessions require domain_id".to_owned(),
        ));
    }
    let party_id = if platform_path == "/" {
        request
            .party_id
            .as_deref()
            .map(parse_id::<MarketplacePartyId>)
            .transpose()?
            .unwrap_or_else(|| MarketplacePartyId::from_uuid(auth_user_id))
    } else {
        MarketplacePartyId::from_uuid(scoped_party_uuid(auth_user_id, &platform_path))
    };
    // Session refreshes may create the participant before a platform-owned contact form has
    // collected any channel.  An empty encrypted object is safer than publishing an implicit
    // account field; the configured package can save channels explicitly later.
    let contact = normalize_contact(&request.contact, true)?;
    let contact_bytes = serde_json::to_vec(&contact)
        .map_err(|error| ApiError::bad_request(format!("contact is invalid: {error}")))?;
    let access_token = format!("mp_{}_{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let access_token_expires_at = OffsetDateTime::now_utc() + PARTY_CAPABILITY_TTL;
    let protected = state
        .contact_cipher
        .encrypt(&contact_bytes, &contact_aad(tenant_id, party_id))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let party = state
        .store
        .ensure_marketplace_party(&EnsureMarketplaceParty {
            auth_user_id,
            party_id,
            tenant_id,
            scope_domain_id,
            platform_path,
            external_key: request.external_key,
            display_name: request.display_name,
            role: compatibility_role_for_sides(&marketplace_sides),
            marketplace_sides,
            access_token_hash: Sha256::digest(access_token.as_bytes()).to_vec(),
            access_token_expires_at,
            contact: EncryptedContact {
                ciphertext: protected.ciphertext,
                nonce: protected.nonce.to_vec(),
                key_version: protected.key_version,
            },
            preserve_contact: request.preserve_contact,
        })
        .await?;
    Ok((
        StatusCode::OK,
        Json(CreatedPartyResponse {
            party,
            access_token,
            access_token_expires_at,
        }),
    ))
}

/// Returns a subplatform admin's email routing metadata without secret material.
pub(super) async fn get_subplatform_email_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(domain_id): Path<String>,
    Query(query): Query<SubplatformEmailConfigQuery>,
) -> Result<Json<SubplatformEmailConfig>, ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let party_id = parse_id(&query.party_id)?;
    let domain_id = parse_id::<DomainId>(&domain_id)?;
    authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
    state
        .store
        .subplatform_email_config(tenant_id, domain_id, party_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

/// Updates one subplatform's SMTP route. Only an active `admin` membership can mutate it.
pub(super) async fn upsert_subplatform_email_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(domain_id): Path<String>,
    Json(request): Json<SubplatformEmailConfigRequest>,
) -> Result<Json<SubplatformEmailConfig>, ApiError> {
    validate_text(&request.provider_key, "provider_key", 100)?;
    validate_text(&request.smtp_host, "smtp_host", 255)?;
    validate_text(&request.username, "username", 320)?;
    validate_text(
        &request.credential_secret_ref,
        "credential_secret_ref",
        2048,
    )?;
    validate_text(&request.from_address, "from_address", 320)?;
    validate_text(&request.updated_by, "updated_by", 256)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let party_id = parse_id(&request.party_id)?;
    let domain_id = parse_id::<DomainId>(&domain_id)?;
    authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
    state
        .store
        .upsert_subplatform_email_config(&UpsertSubplatformEmailConfig {
            tenant_id,
            domain_id,
            actor_party_id: party_id,
            provider_key: request.provider_key,
            smtp_host: request.smtp_host,
            smtp_port: request.smtp_port,
            tls_mode: request.tls_mode,
            username: request.username,
            credential_secret_ref: request.credential_secret_ref,
            from_address: request.from_address,
            reply_to: request.reply_to,
            mode: request.mode,
            enabled: request.enabled,
            expected_version: request.expected_version,
            updated_by: request.updated_by,
        })
        .await
        .map(Json)
        .map_err(ApiError::from)
}

fn party_registration_tenant_key(tenant_id: TenantId) -> String {
    format!("mp:rate:party-registration:tenant:{tenant_id}")
}

pub(super) async fn create_listing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateListingRequest>,
) -> Result<(StatusCode, Json<VehicleListing>), ApiError> {
    validate_currency(&request.currency)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let seller_party_id = parse_id(&request.seller_party_id)?;
    authenticate_domain(&state, &headers, tenant_id, seller_party_id, domain_id).await?;
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
            domain_id,
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

/// Receives seller-owned supply without publishing it before root review.
pub(super) async fn create_listing_submission(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateListingSubmissionRequest>,
) -> Result<(StatusCode, Json<MarketplaceListingSubmission>), ApiError> {
    validate_text(&request.external_key, "external_key", 256)?;
    validate_text(&request.display_name, "display_name", 500)?;
    if !request.attributes.is_object() {
        return Err(ApiError::bad_request(
            "attributes must be a JSON object".to_owned(),
        ));
    }
    validate_currency(&request.currency)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let seller_party_id = parse_id(&request.seller_party_id)?;
    let party =
        authenticate_domain(&state, &headers, tenant_id, seller_party_id, domain_id).await?;
    require_role(&party, "seller")?;
    let submission = state
        .store
        .create_marketplace_listing_submission(&CreateMarketplaceListingSubmission {
            submission_id: request
                .submission_id
                .as_deref()
                .map(|value| {
                    value
                        .parse::<Uuid>()
                        .map_err(|error| ApiError::bad_request(format!("invalid UUID: {error}")))
                })
                .transpose()?
                .unwrap_or_else(Uuid::new_v4),
            tenant_id,
            domain_id,
            seller_party_id,
            asset_schema_id: parse_id::<AssetSchemaId>(&request.asset_schema_id)?,
            external_key: request.external_key,
            display_name: request.display_name,
            attributes: request.attributes,
            asking_amount: positive_exact(&request.asking_amount, "asking_amount")?,
            currency: request.currency,
            currency_scale: request.currency_scale,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(submission)))
}

/// Lists only the authenticated seller's own submissions for the exact child platform scope.
pub(super) async fn listing_submissions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ListingSubmissionsQuery>,
) -> Result<(HeaderMap, Json<Vec<MarketplaceListingSubmission>>), ApiError> {
    let tenant_id = parse_id(&query.tenant_id)?;
    let domain_id = parse_id::<DomainId>(&query.domain_id)?;
    let seller_party_id = parse_id(&query.seller_party_id)?;
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::bad_request(
            "listing submission limit must be between 1 and 100".to_owned(),
        ));
    }
    let offset = query.offset.unwrap_or(0);
    if offset > 10_000 {
        return Err(ApiError::bad_request(
            "listing submission offset must be between 0 and 10000".to_owned(),
        ));
    }
    let party =
        authenticate_domain(&state, &headers, tenant_id, seller_party_id, domain_id).await?;
    require_role(&party, "seller")?;
    let submissions = state
        .store
        .marketplace_listing_submissions(
            tenant_id,
            domain_id,
            seller_party_id,
            i64::from(limit),
            i64::from(offset),
        )
        .await?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((response_headers, Json(submissions)))
}

/// Publishes a seller submission after operator review.
pub(super) async fn approve_listing_submission(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(submission_id): Path<String>,
    Json(request): Json<ApproveListingSubmissionRequest>,
) -> Result<(StatusCode, Json<VehicleListing>), ApiError> {
    require_operator(&state, &headers)?;
    validate_text(&request.authorized_by, "authorized_by", 256)?;
    validate_text(&request.reason, "reason", 2_000)?;
    let listing = state
        .store
        .approve_marketplace_listing_submission(&ApproveMarketplaceListingSubmission {
            tenant_id: parse_id(&request.tenant_id)?,
            submission_id: submission_id
                .parse::<Uuid>()
                .map_err(|error| ApiError::bad_request(format!("invalid UUID: {error}")))?,
            authorized_by: request.authorized_by,
            reason: request.reason,
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate_domain(&state, &headers, tenant_id, buyer_party_id, domain_id).await?;
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
            domain_id,
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate_domain(&state, &headers, tenant_id, buyer_party_id, domain_id).await?;
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let buyer_party_id = parse_id(&request.buyer_party_id)?;
    authenticate_domain(&state, &headers, tenant_id, buyer_party_id, domain_id).await?;
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
    let scope_domain_id = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    if let Some(domain_id) = scope_domain_id {
        authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
    } else {
        authenticate(&state, &headers, tenant_id, party_id).await?;
    }
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
    let scope_domain_id = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?;
    if let Some(domain_id) = scope_domain_id {
        authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
    } else {
        authenticate(&state, &headers, tenant_id, party_id).await?;
    }
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let seller_party_id = parse_id(&request.party_id)?;
    let party =
        authenticate_domain(&state, &headers, tenant_id, seller_party_id, domain_id).await?;
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let offline_deal_id = parse_id(&offline_deal_id)?;
    let proposed_by = parse_id(&request.proposed_by)?;
    authenticate_domain(&state, &headers, tenant_id, proposed_by, domain_id).await?;
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
    if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
    } else {
        authenticate(&state, &headers, tenant_id, party_id).await?;
    }
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
    let domain_id = parse_id::<DomainId>(&request.domain_id)?;
    let party_id = parse_id(&request.party_id)?;
    authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?;
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
    if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, actor_party_id, domain_id).await?;
    } else {
        authenticate(&state, &headers, tenant_id, actor_party_id).await?;
    }
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
        settlement: ContactSettlement {
            mode: "direct_between_participants",
            platform_fee: "separate_payment_service",
        },
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
    let party = if let Some(domain_id) = request
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, viewer_party_id, domain_id).await?
    } else {
        authenticate(&state, &headers, tenant_id, viewer_party_id).await?
    };
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
    let party = if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, seller_party_id, domain_id).await?
    } else {
        authenticate(&state, &headers, tenant_id, seller_party_id).await?
    };
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
    let party = if let Some(domain_id) = request
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, sponsor_party_id, domain_id).await?
    } else {
        authenticate(&state, &headers, tenant_id, sponsor_party_id).await?
    };
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
    let party = if let Some(domain_id) = query
        .domain_id
        .as_deref()
        .map(parse_id::<DomainId>)
        .transpose()?
    {
        authenticate_domain(&state, &headers, tenant_id, party_id, domain_id).await?
    } else {
        authenticate(&state, &headers, tenant_id, party_id).await?
    };
    require_role(&party, "seller")?;
    state
        .store
        .seller_promotion(tenant_id, parse_id(&campaign_id)?, party_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn authenticate(
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
    let platform_path = platform_path_from_headers(headers, false)?;
    state
        .store
        .authenticate_marketplace_party(
            tenant_id,
            party_id,
            token_hash.as_slice(),
            None,
            platform_path.as_deref(),
        )
        .await
        .map_err(|error| match error {
            matchplane_storage::StorageError::Forbidden(_) => {
                ApiError::unauthorized("party bearer token is invalid")
            }
            other => ApiError::from(other),
        })
}

pub(super) async fn authenticate_domain(
    state: &AppState,
    headers: &HeaderMap,
    tenant_id: TenantId,
    party_id: MarketplacePartyId,
    domain_id: DomainId,
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
    // Domain alone is not enough in a recursive federation: sibling nodes may share a domain.
    // Require the exact path and let storage compare it with the capability's bound path.
    let platform_path = platform_path_from_headers(headers, true)?
        .expect("required platform path header must produce a value");
    state
        .store
        .authenticate_marketplace_party(
            tenant_id,
            party_id,
            token_hash.as_slice(),
            Some(domain_id),
            Some(&platform_path),
        )
        .await
        .map_err(|error| match error {
            matchplane_storage::StorageError::Forbidden(_) => {
                ApiError::unauthorized("party bearer token is invalid")
            }
            other => ApiError::from(other),
        })
}

fn platform_path_from_headers(
    headers: &HeaderMap,
    required: bool,
) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get("x-matchplane-platform-path") else {
        if required {
            return Err(ApiError::bad_request(
                "x-matchplane-platform-path is required for child platform capabilities".to_owned(),
            ));
        }
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::bad_request("platform path header is invalid".to_owned()))?;
    normalize_platform_path(value).map(Some)
}

pub(super) fn require_role(party: &AuthenticatedParty, role: &str) -> Result<(), ApiError> {
    if party.role == role || party.role == "both" {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!("{role} role is required")))
    }
}

/// Generic marketplace APIs use neutral demand/supply sides. The legacy party projection keeps
/// buyer/seller role codes for compatibility, so the mapping lives in this adapter boundary and
/// is not repeated throughout the domain-neutral handlers.
pub(super) fn require_marketplace_side(
    party: &AuthenticatedParty,
    side: &str,
) -> Result<(), ApiError> {
    let allowed = matches!(side, "demand" | "supply")
        && party
            .marketplace_sides
            .iter()
            .any(|capability| capability == side);
    if allowed {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "marketplace {side} capability is required"
        )))
    }
}

fn default_promotion_policy() -> String {
    "seller_promotion".to_owned()
}

fn resolve_marketplace_sides(
    role: Option<&str>,
    requested: Option<Vec<String>>,
) -> Result<Vec<String>, ApiError> {
    let sides = requested.unwrap_or_else(|| match role.unwrap_or("both") {
        "buyer" => vec!["demand".to_owned()],
        "seller" => vec!["supply".to_owned()],
        _ => vec!["demand".to_owned(), "supply".to_owned()],
    });
    if sides.is_empty()
        || sides.len() > 2
        || sides
            .iter()
            .any(|side| !matches!(side.as_str(), "demand" | "supply"))
        || sides
            .iter()
            .any(|side| sides.iter().filter(|candidate| *candidate == side).count() > 1)
    {
        return Err(ApiError::bad_request(
            "marketplace_sides must contain one or both unique kernel sides".to_owned(),
        ));
    }
    Ok(sides)
}

/// The SQL projection still carries the pre-generic role column for existing integrations.  New
/// callers never need to know those labels: generic sides are translated once at the HTTP/storage
/// boundary and all kernel authorization uses `marketplace_sides`.
fn compatibility_role_for_sides(sides: &[String]) -> String {
    match sides {
        [side] if side == "demand" => "buyer".to_owned(),
        [side] if side == "supply" => "seller".to_owned(),
        _ => "both".to_owned(),
    }
}

pub(super) fn contact_aad(tenant_id: TenantId, party_id: MarketplacePartyId) -> Vec<u8> {
    format!("matchplane:party-contact:v1:{tenant_id}:{party_id}").into_bytes()
}

fn normalize_platform_path(value: &str) -> Result<String, ApiError> {
    if value.len() > 512 {
        return Err(ApiError::bad_request(
            "platform_path is too long".to_owned(),
        ));
    }
    let normalized = format!(
        "/{}",
        value
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    );
    if normalized == "/"
        || normalized.strip_prefix('/').is_some_and(|path| {
            !path.is_empty()
                && path.split('/').all(|segment| {
                    !segment.is_empty()
                        && segment.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                        })
                })
        })
    {
        Ok(normalized)
    } else {
        Err(ApiError::bad_request("platform_path is invalid".to_owned()))
    }
}

fn scoped_party_uuid(auth_user_id: Uuid, platform_path: &str) -> Uuid {
    let digest = Sha256::digest(
        format!("matchplane:party-scope:v1:{auth_user_id}:{platform_path}").as_bytes(),
    );
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // UUIDv5-shaped deterministic identifiers avoid one Better Auth user colliding with another
    // platform-scoped party while keeping the bridge idempotent across logins.
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
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

pub(super) fn request_fingerprint(headers: &HeaderMap) -> Option<Vec<u8>> {
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

fn normalize_contact(contact: &Value, allow_empty: bool) -> Result<Value, ApiError> {
    let object = contact.as_object().ok_or_else(|| {
        ApiError::bad_request("contact must be an object of channel names and values".to_owned())
    })?;
    let mut normalized = serde_json::Map::new();
    for (field, raw_value) in object {
        if field.is_empty()
            || field.len() > 64
            || !field
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(ApiError::bad_request(
                "contact channel names must contain only letters, digits, '-', '_', or '.'"
                    .to_owned(),
            ));
        }
        let value = raw_value;
        let value = value
            .as_str()
            .ok_or_else(|| ApiError::bad_request(format!("contact.{field} must be a string")))?;
        let value = value.trim();
        if value.is_empty()
            || value.len() > 256
            || value.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(ApiError::bad_request(format!(
                "contact.{field} must contain 1..=256 printable bytes"
            )));
        }
        normalized.insert(field.to_owned(), Value::String(value.to_owned()));
    }
    if normalized.is_empty() && !allow_empty {
        return Err(ApiError::bad_request(
            "contact must include at least one channel".to_owned(),
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
    fn contact_exchange_keeps_configured_channels() {
        let normalized = normalize_contact(
            &json!({
                "channel_primary": " primary ",
                "channel_secondary": "secondary",
                "channel_optional": " optional ",
            }),
            false,
        )
        .expect("contact should be valid");

        assert_eq!(
            normalized,
            json!({
                "channel_primary": "primary",
                "channel_secondary": "secondary",
                "channel_optional": "optional",
            })
        );
    }

    #[test]
    fn contact_exchange_leaves_channel_validation_to_configuration() {
        let normalized = normalize_contact(&json!({"channel_primary": "opaque-value"}), false)
            .expect("configured channel value should be accepted");
        assert_eq!(normalized, json!({"channel_primary": "opaque-value"}));

        let empty = normalize_contact(&json!({}), true).expect("session bridge may be empty");
        assert_eq!(empty, json!({}));

        let error = normalize_contact(&json!({"channel_primary": 42}), false)
            .expect_err("channel values must remain strings");
        assert!(error.message.contains("must be a string"));
    }

    #[test]
    fn party_registration_rate_limit_key_is_tenant_scoped() {
        let tenant_id = TenantId::from_uuid(Uuid::from_u128(1));

        assert_eq!(
            party_registration_tenant_key(tenant_id),
            "mp:rate:party-registration:tenant:00000000-0000-0000-0000-000000000001"
        );
    }
}
