use std::{path::Path as FsPath, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
};
use matchplane_application::{MarketplaceService, OrderService, PlaceOrderCommand};
use matchplane_cache::{CacheError, CachedBook, CachedLevel, ProjectionRepairOutcome, ValkeyCache};
use matchplane_config::{AppConfig, BearerToken, Environment};
use matchplane_domain::{AccountId, AssetId, MarketId, OrderId, OrderSide};
use matchplane_http::{parse_id, require_operator_bearer};
use matchplane_observability::{Telemetry, init, shutdown_signal};
use matchplane_storage::{
    BookProjection, BookProjectionLevel, CandidateMatch, PgStore, StoredOrder, StoredTrade,
    SubmitOrderOutcome, VectorRecord,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::{net::TcpListener, sync::Mutex};
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing::{info, warn};

mod generic_marketplace;
mod lexical_rank;
mod marketplace;
mod privacy;

pub(crate) use matchplane_http::ApiError;
pub(crate) use matchplane_http::parse_exact;

#[derive(Debug)]
struct AppState {
    store: PgStore,
    orders: OrderService<PgStore>,
    marketplace: MarketplaceService<PgStore>,
    cache: Mutex<ValkeyCache>,
    telemetry: Telemetry,
    node_id: matchplane_domain::FederationNodeId,
    contact_cipher: privacy::ContactCipher,
    operator_auth: BearerToken,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Deserialize)]
struct PlaceOrderRequest {
    order_id: Option<String>,
    tenant_id: String,
    domain_id: String,
    market_id: String,
    side: String,
    price: String,
    quantity: String,
    idempotency_key: String,
    reservation_account_id: String,
    settlement_account_id: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    submitted_at: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingRequest {
    tenant_id: String,
    domain_id: String,
    asset_id: String,
    embedding_model_id: String,
    values: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct CandidateRequest {
    tenant_id: String,
    domain_id: String,
    embedding_model_id: String,
    values: Vec<f32>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct AcceptedResponse {
    #[serde(flatten)]
    outcome: SubmitOrderOutcome,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("gateway configuration is invalid")?;
    let telemetry = init(
        "matchplane-gateway",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("gateway observability initialization failed")?;
    let contact_cipher = privacy::ContactCipher::load(config.environment)
        .context("marketplace contact encryption configuration is invalid")?;
    let operator_auth = BearerToken::load(
        config.environment,
        "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE",
        "MATCHPLANE_GATEWAY_ADMIN_TOKEN",
        "matchplane-development-gateway-admin",
    )
    .context("gateway operator authentication configuration is invalid")?;
    let shutdown_telemetry = telemetry.clone();
    let store = PgStore::connect(&config.database_url, 20)
        .await
        .context("gateway could not connect to PostgreSQL")?;
    store
        .ensure_local_node(
            config.node_id,
            &format!("http://{}", config.grpc_addr),
            config.environment != Environment::Production,
        )
        .await
        .context("gateway local federation node registration failed")?;
    let valkey_ca_file =
        (!config.valkey_ca_file.is_empty()).then(|| FsPath::new(config.valkey_ca_file.as_str()));
    let cache = ValkeyCache::connect_with_ca(&config.valkey_url, valkey_ca_file)
        .await
        .context("gateway could not connect to Valkey")?;
    let lexical_rank_router = lexical_rank::router(operator_auth.clone());
    let state = Arc::new(AppState {
        orders: OrderService::new(store.clone(), config.node_id),
        marketplace: MarketplaceService::new(store.clone()),
        store,
        cache: Mutex::new(cache),
        telemetry,
        node_id: config.node_id,
        contact_cipher,
        operator_auth,
    });
    let mut app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/v1/orders", post(place_order))
        .route("/v1/orders/{order_id}", get(order))
        .route("/v1/accounts/{account_id}", get(account))
        .route("/v1/markets/{market_id}/book", get(book))
        .route("/v1/markets/{market_id}/trades", get(trades))
        .route("/v1/embeddings", post(upsert_embedding))
        .route("/v1/candidates/search", post(search_candidates))
        .route("/v1/marketplace/parties", post(marketplace::create_party))
        // Generic callers use neutral participant terminology.  The legacy `/parties` route is
        // retained for existing clients; both handlers persist the same capability projection.
        .route(
            "/v1/marketplace/participants",
            post(marketplace::create_participant),
        )
        .route(
            "/v1/admin/marketplace/parties/session",
            post(marketplace::ensure_party_session),
        )
        .route(
            "/v1/subplatforms/{domain_id}/email-config",
            get(marketplace::get_subplatform_email_config)
                .put(marketplace::upsert_subplatform_email_config),
        )
        .route(
            "/v1/marketplace/intents",
            post(generic_marketplace::create_intent),
        )
        .route(
            "/v1/marketplace/intents/{intent_id}",
            get(generic_marketplace::intent).patch(generic_marketplace::update_intent),
        )
        .route(
            "/v1/marketplace/profile",
            get(generic_marketplace::profile).put(generic_marketplace::upsert_profile),
        )
        .route(
            "/v1/marketplace/events",
            post(generic_marketplace::behavior_event),
        )
        .route(
            "/v1/marketplace/preferences",
            get(generic_marketplace::preferences).put(generic_marketplace::set_preference),
        )
        .route(
            "/v1/marketplace/sales-handoffs",
            post(generic_marketplace::create_sales_handoff),
        )
        .route(
            "/v1/marketplace/intents/{intent_id}/matches",
            post(generic_marketplace::matches),
        )
        .route(
            "/v1/marketplace/intents/{intent_id}/discovery",
            patch(generic_marketplace::update_demand_discovery),
        )
        .route(
            "/v1/marketplace/offers/{offer_id}",
            patch(generic_marketplace::update_offer),
        )
        .route(
            "/v1/marketplace/offers/{offer_id}/withdraw",
            post(generic_marketplace::withdraw_offer),
        )
        .route(
            "/v1/marketplace/offers/{offer_id}/demand-matches",
            post(generic_marketplace::demand_matches),
        )
        .route(
            "/v1/marketplace/offers",
            get(generic_marketplace::offers).post(generic_marketplace::create_offer),
        )
        .route(
            "/v1/admin/marketplace/offers/{offer_id}/activate",
            post(generic_marketplace::activate_offer),
        )
        .route(
            "/v1/admin/marketplace/offers/{offer_id}/reject",
            post(generic_marketplace::reject_offer),
        )
        .route(
            "/v1/marketplace/introductions",
            get(generic_marketplace::introductions).post(generic_marketplace::create_introduction),
        )
        .route(
            "/v1/marketplace/introductions/{introduction_id}/contact/request",
            post(generic_marketplace::request_contact),
        )
        .route(
            "/v1/marketplace/introductions/{introduction_id}/contact/consent",
            post(generic_marketplace::consent_contact),
        )
        .route(
            "/v1/marketplace/introductions/{introduction_id}/contact",
            post(generic_marketplace::release_contact),
        );

    // The old listing/offline-deal surface is a compatibility adapter, not part of the
    // domain-neutral kernel.  It is never enabled by pricing, schema, or a URL; an operator must
    // opt in explicitly during a controlled migration window.
    if legacy_marketplace_adapter_enabled() {
        app = app
            .route(
                "/v1/admin/marketplace/asset-authorizations",
                post(marketplace::set_asset_authorization),
            )
            .route(
                "/v1/marketplace/listings",
                post(marketplace::create_listing),
            )
            .route(
                "/v1/marketplace/listing-submissions",
                get(marketplace::listing_submissions).post(marketplace::create_listing_submission),
            )
            .route(
                "/v1/admin/marketplace/listing-submissions/{submission_id}/approve",
                post(marketplace::approve_listing_submission),
            )
            .route(
                "/v1/marketplace/buyer-requests",
                post(marketplace::create_buyer_request),
            )
            .route(
                "/v1/marketplace/buyer-requests/{request_id}/recommendations",
                post(marketplace::recommendations),
            )
            .route(
                "/v1/marketplace/offline-deals",
                get(marketplace::offline_deals).post(marketplace::create_offline_deal),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}",
                get(marketplace::offline_deal),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}/contact/accept",
                post(marketplace::accept_contact_exchange),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}/contact",
                get(marketplace::contact),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}/confirm",
                post(marketplace::confirm_offline_deal),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}/finalize",
                post(marketplace::finalize_offline_deal),
            )
            .route(
                "/v1/marketplace/offline-deals/{offline_deal_id}/viewings",
                get(marketplace::viewings).post(marketplace::create_viewing),
            )
            .route(
                "/v1/marketplace/viewings/{viewing_id}/{action}",
                post(marketplace::transition_viewing),
            )
            .route(
                "/v1/marketplace/listings/{listing_id}/exposures",
                post(marketplace::record_exposure),
            )
            .route(
                "/v1/marketplace/listings/{listing_id}/exposure-metrics",
                get(marketplace::exposure_metrics),
            )
            .route(
                "/v1/marketplace/promotions",
                post(marketplace::create_seller_promotion),
            )
            .route(
                "/v1/marketplace/promotions/{campaign_id}",
                get(marketplace::seller_promotion),
            );
    }

    let app = app
        .with_state(state)
        .merge(lexical_rank_router)
        .layer(CatchPanicLayer::new())
        .layer(CompressionLayer::new())
        .layer(RequestBodyLimitLayer::new(1_048_576))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid));
    let listener = TcpListener::bind(config.http_addr)
        .await
        .context("gateway could not bind HTTP listener")?;
    info!(address = %config.http_addr, "gateway listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("gateway server failed")?;
    shutdown_telemetry
        .shutdown()
        .context("gateway telemetry shutdown failed")
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "matchplane-gateway",
    })
}

async fn ready(State(state): State<Arc<AppState>>) -> (StatusCode, Json<HealthResponse>) {
    let postgres_ready = state.store.ping().await.is_ok();
    let valkey_ready = state.cache.lock().await.ping().await.is_ok();
    let status = if postgres_ready && valkey_ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(HealthResponse {
            status: if status == StatusCode::OK {
                "ready"
            } else {
                "not_ready"
            },
            service: "matchplane-gateway",
        }),
    )
}

async fn metrics(State(state): State<Arc<AppState>>) -> String {
    state.telemetry.render_metrics()
}

async fn place_order(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PlaceOrderRequest>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    require_operator(&state, &headers)?;
    let command = PlaceOrderCommand {
        order_id: request
            .order_id
            .as_deref()
            .map(parse_id::<OrderId>)
            .transpose()?,
        tenant_id: parse_id(&request.tenant_id)?,
        domain_id: parse_id(&request.domain_id)?,
        market_id: parse_id(&request.market_id)?,
        side: parse_side(&request.side)?,
        price: request.price,
        quantity: request.quantity,
        idempotency_key: request.idempotency_key,
        reservation_account_id: parse_id(&request.reservation_account_id)?,
        settlement_account_id: parse_id(&request.settlement_account_id)?,
        submitted_at: request.submitted_at,
        expires_at: request.expires_at,
    };
    let result = state.orders.place_order(command).await?;
    let status = if result.duplicate {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((
        status,
        Json(AcceptedResponse {
            outcome: result.outcome,
        }),
    ))
}

async fn order(
    State(state): State<Arc<AppState>>,
    Path(order_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<StoredOrder>, ApiError> {
    require_operator(&state, &headers)?;
    state
        .store
        .order(parse_id(&order_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn account(
    State(state): State<Arc<AppState>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<matchplane_storage::StoredAccount>, ApiError> {
    require_operator(&state, &headers)?;
    state
        .store
        .account(parse_id::<AccountId>(&account_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn book(
    State(state): State<Arc<AppState>>,
    Path(market_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<CachedBook>, ApiError> {
    require_operator(&state, &headers)?;
    let market_id: MarketId = parse_id(&market_id)?;
    let cache_key = market_id.to_string();
    match state.cache.lock().await.book(&cache_key).await {
        Ok(Some(book)) => return Ok(Json(book)),
        Ok(None) => {}
        Err(
            error @ (CacheError::Json(_)
            | CacheError::InvalidProjectionData
            | CacheError::InvalidProjectionSequence
            | CacheError::IncompleteProjection),
        ) => {
            warn!(%market_id, %error, "unreadable order book cache entry will be repaired from PostgreSQL");
        }
        Err(CacheError::Valkey(error)) => {
            warn!(%market_id, %error, "Valkey book read failed; falling back to PostgreSQL");
        }
        Err(error) => return Err(ApiError::internal(error.to_string())),
    }

    let projection = state
        .store
        .latest_book_projection(market_id)
        .await?
        .ok_or_else(|| ApiError::not_found("order book has not been projected yet"))?;
    let durable_sequence = projection.sequence;
    let durable_book = cached_book(projection);
    let mut cache = state.cache.lock().await;
    match cache.repair_book(&durable_book).await {
        Ok(ProjectionRepairOutcome::Repaired) => {
            warn!(%market_id, durable_sequence, "order book cache miss repaired from PostgreSQL");
        }
        Ok(ProjectionRepairOutcome::Current) => {
            info!(%market_id, durable_sequence, "concurrent order book cache repair was already current");
        }
        Err(CacheError::Valkey(error)) => {
            warn!(%market_id, durable_sequence, %error, "Valkey book repair failed; serving the PostgreSQL projection");
            return Ok(Json(durable_book));
        }
        Err(error) => return Err(ApiError::internal(error.to_string())),
    }
    match cache.book(&cache_key).await {
        Ok(Some(book)) => Ok(Json(book)),
        Ok(None) => Err(ApiError::internal(
            "order book repair did not produce a readable projection",
        )),
        Err(
            error @ (CacheError::Valkey(_)
            | CacheError::Json(_)
            | CacheError::InvalidProjectionData
            | CacheError::InvalidProjectionSequence
            | CacheError::IncompleteProjection),
        ) => {
            warn!(%market_id, durable_sequence, %error, "Valkey verification read failed; serving the PostgreSQL projection");
            Ok(Json(durable_book))
        }
        Err(error) => Err(ApiError::internal(error.to_string())),
    }
}

fn cached_book(projection: BookProjection) -> CachedBook {
    CachedBook {
        market_id: projection.market_id.to_string(),
        sequence: projection.sequence,
        bids: cached_levels(projection.bids),
        asks: cached_levels(projection.asks),
        state_hash: projection.state_hash.to_hex(),
    }
}

fn cached_levels(levels: Vec<BookProjectionLevel>) -> Vec<CachedLevel> {
    levels
        .into_iter()
        .map(|level| CachedLevel {
            price: level.price,
            quantity: level.quantity,
        })
        .collect()
}

async fn trades(
    State(state): State<Arc<AppState>>,
    Path(market_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<StoredTrade>>, ApiError> {
    require_operator(&state, &headers)?;
    state
        .store
        .recent_trades(parse_id(&market_id)?, 100)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn upsert_embedding(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<EmbeddingRequest>,
) -> Result<StatusCode, ApiError> {
    require_operator(&state, &headers)?;
    let record = VectorRecord {
        tenant_id: parse_id(&request.tenant_id)?,
        domain_id: parse_id(&request.domain_id)?,
        asset_id: parse_id(&request.asset_id)?,
        embedding_model_id: parse_id(&request.embedding_model_id)?,
        values: request.values,
    };
    state
        .store
        .upsert_embedding(&record)
        .await
        .map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn search_candidates(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CandidateRequest>,
) -> Result<Json<Vec<CandidateMatch>>, ApiError> {
    require_operator(&state, &headers)?;
    let record = VectorRecord {
        tenant_id: parse_id(&request.tenant_id)?,
        domain_id: parse_id(&request.domain_id)?,
        asset_id: AssetId::new(),
        embedding_model_id: parse_id(&request.embedding_model_id)?,
        values: request.values,
    };
    state
        .store
        .search_candidates(&record, state.node_id, request.limit.unwrap_or(10))
        .await
        .map(Json)
        .map_err(ApiError::from)
}

/// Legacy listing/offline-deal routes are an explicit migration escape hatch. The generic
/// marketplace contract is always available and never falls back to this adapter implicitly.
fn legacy_marketplace_adapter_enabled() -> bool {
    matches!(
        std::env::var("MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER")
            .ok()
            .as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "on")
    )
}

fn require_operator(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    require_operator_bearer(&state.operator_auth, headers)
}

fn parse_side(value: &str) -> Result<OrderSide, ApiError> {
    match value {
        "buy" => Ok(OrderSide::Buy),
        "sell" => Ok(OrderSide::Sell),
        _ => Err(ApiError::bad_request("side must be either buy or sell")),
    }
}
