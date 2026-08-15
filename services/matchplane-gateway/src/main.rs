use std::{str::FromStr, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use matchplane_cache::{CachedBook, ValkeyCache};
use matchplane_config::{AppConfig, BearerToken, Environment};
use matchplane_domain::{
    AccountId, AssetId, CorrelationId, MarketId, OrderId, OrderIntent, OrderSide, Price, Quantity,
};
use matchplane_observability::{Telemetry, init};
use matchplane_storage::{
    CandidateMatch, DemoBootstrap, PgStore, StorageError, StoredOrder, StoredTrade, SubmitOrder,
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
use tracing::{error, info};

mod generic_marketplace;
mod marketplace;
mod privacy;

#[derive(Debug)]
struct AppState {
    store: PgStore,
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

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
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
    let cache = ValkeyCache::connect(&config.valkey_url)
        .await
        .context("gateway could not connect to Valkey")?;
    let state = Arc::new(AppState {
        store,
        cache: Mutex::new(cache),
        telemetry,
        node_id: config.node_id,
        contact_cipher,
        operator_auth,
    });
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .route("/v1/demo", get(demo))
        .route("/v1/orders", post(place_order))
        .route("/v1/orders/{order_id}", get(order))
        .route("/v1/accounts/{account_id}", get(account))
        .route("/v1/markets/{market_id}/book", get(book))
        .route("/v1/markets/{market_id}/trades", get(trades))
        .route("/v1/embeddings", post(upsert_embedding))
        .route("/v1/candidates/search", post(search_candidates))
        .route("/v1/marketplace/parties", post(marketplace::create_party))
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
            "/v1/admin/marketplace/asset-authorizations",
            post(marketplace::set_asset_authorization),
        )
        .route(
            "/v1/marketplace/listings",
            post(marketplace::create_listing),
        )
        .route(
            "/v1/marketplace/listing-submissions",
            post(marketplace::create_listing_submission),
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
        )
        .route(
            "/v1/marketplace/intents",
            post(generic_marketplace::create_intent),
        )
        .route(
            "/v1/marketplace/intents/{intent_id}",
            get(generic_marketplace::intent),
        )
        .route(
            "/v1/marketplace/intents/{intent_id}/matches",
            post(generic_marketplace::matches),
        )
        .route(
            "/v1/marketplace/offers",
            post(generic_marketplace::create_offer),
        )
        .route(
            "/v1/admin/marketplace/offers/{offer_id}/activate",
            post(generic_marketplace::activate_offer),
        )
        .route(
            "/v1/marketplace/introductions",
            get(generic_marketplace::introductions).post(generic_marketplace::create_introduction),
        )
        .with_state(state)
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

async fn demo(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<DemoBootstrap>, ApiError> {
    require_operator(&state, &headers)?;
    DemoBootstrap::local().map(Json).map_err(ApiError::from)
}

async fn place_order(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PlaceOrderRequest>,
) -> Result<(StatusCode, Json<AcceptedResponse>), ApiError> {
    require_operator(&state, &headers)?;
    let order_id = request
        .order_id
        .as_deref()
        .map(parse_id::<OrderId>)
        .transpose()?
        .unwrap_or_default();
    let side = parse_side(&request.side)?;
    let price = Price::new(parse_exact(&request.price)?)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let quantity = Quantity::new(parse_exact(&request.quantity)?)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let reservation_amount = match side {
        OrderSide::Buy => Quantity::new(
            price
                .checked_mul(quantity)
                .map_err(|error| ApiError::bad_request(error.to_string()))?
                .value(),
        ),
        OrderSide::Sell => Ok(quantity),
    }
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let submitted_at = request.submitted_at.unwrap_or_else(OffsetDateTime::now_utc);
    if request
        .expires_at
        .is_some_and(|expiry| expiry <= submitted_at)
    {
        return Err(ApiError::bad_request(
            "expires_at must be later than submitted_at".to_owned(),
        ));
    }
    let command = SubmitOrder {
        intent: OrderIntent {
            order_id,
            tenant_id: parse_id(&request.tenant_id)?,
            domain_id: parse_id(&request.domain_id)?,
            market_id: parse_id(&request.market_id)?,
            side,
            price,
            quantity,
            submitted_at,
            expires_at: request.expires_at,
        },
        idempotency_key: request.idempotency_key,
        reservation_account_id: parse_id(&request.reservation_account_id)?,
        settlement_account_id: parse_id(&request.settlement_account_id)?,
        reservation_amount,
        source_node_id: state.node_id,
        correlation_id: CorrelationId::new(),
    };
    let outcome = state
        .store
        .submit_order(&command)
        .await
        .map_err(ApiError::from)?;
    let status = if outcome.duplicate {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, Json(AcceptedResponse { outcome })))
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
    let _: MarketId = parse_id(&market_id)?;
    state
        .cache
        .lock()
        .await
        .book(&market_id)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("order book has not been projected yet"))
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

fn require_operator(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if state.operator_auth.verify_bearer(authorization) {
        Ok(())
    } else {
        Err(ApiError::unauthorized(
            "gateway operator bearer token is required",
        ))
    }
}

fn parse_id<T>(value: &str) -> Result<T, ApiError>
where
    T: FromStr<Err = uuid::Error>,
{
    value
        .parse()
        .map_err(|error: uuid::Error| ApiError::bad_request(format!("invalid UUID: {error}")))
}

fn parse_exact(value: &str) -> Result<i128, ApiError> {
    value.parse().map_err(|_| {
        ApiError::bad_request("exact values must be base-10 integer strings".to_owned())
    })
}

fn parse_side(value: &str) -> Result<OrderSide, ApiError> {
    match value {
        "buy" => Ok(OrderSide::Buy),
        "sell" => Ok(OrderSide::Sell),
        _ => Err(ApiError::bad_request(
            "side must be either buy or sell".to_owned(),
        )),
    }
}

impl ApiError {
    fn bad_request(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.to_owned(),
        }
    }

    fn unauthorized(message: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.to_owned(),
        }
    }

    fn forbidden(message: String) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message,
        }
    }

    fn internal(message: String) -> Self {
        error!(%message, "HTTP request failed internally");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "internal service error".to_owned(),
        }
    }

    fn service_unavailable(message: String) -> Self {
        error!(%message, "HTTP dependency unavailable");
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "service temporarily unavailable".to_owned(),
        }
    }

    fn too_many_requests(message: &str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.to_owned(),
        }
    }
}

impl From<StorageError> for ApiError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::IdempotencyConflict => Self {
                status: StatusCode::CONFLICT,
                message: error.to_string(),
            },
            StorageError::NotFound(_) => Self {
                status: StatusCode::NOT_FOUND,
                message: error.to_string(),
            },
            StorageError::Forbidden(_) => Self {
                status: StatusCode::FORBIDDEN,
                message: error.to_string(),
            },
            StorageError::Conflict(_) => Self {
                status: StatusCode::CONFLICT,
                message: error.to_string(),
            },
            StorageError::InsufficientBalance | StorageError::InvalidData(_) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                message: error.to_string(),
            },
            other => Self::internal(other.to_string()),
        }
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for shutdown signal");
    }
}
