use std::{sync::Arc, time::Duration};

use anyhow::Context;
use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use matchplane_config::{AppConfig, BearerToken, Environment};
use matchplane_observability::{Telemetry, init};
use serde::Serialize;
use sqlx::PgPool;
use tokio::{net::TcpListener, signal};
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    limit::RequestBodyLimitLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing::info;
use url::Url;

mod admin;
mod api;
mod crypto;
mod gateways;
mod invoices;
mod store;

use admin::AdminStore;
use invoices::InvoiceStore;
use store::PaymentStore;

#[derive(Debug)]
struct AppState {
    store: PaymentStore,
    telemetry: Telemetry,
    invoice_cipher: crypto::InvoiceCipher,
    invoices: InvoiceStore,
    admin_auth: BearerToken,
    admin: AdminStore,
    environment: Environment,
    payment_callback_origin: Option<Url>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("payment service configuration is invalid")?;
    let telemetry = init(
        "matchplane-payment-service",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("payment service observability initialization failed")?;
    let shutdown_telemetry = telemetry.clone();
    let invoice_cipher = crypto::InvoiceCipher::load(config.environment)
        .context("invoice encryption configuration is invalid")?;
    let admin_auth = BearerToken::load(
        config.environment,
        "MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE",
        "MATCHPLANE_PAYMENT_ADMIN_TOKEN",
        "matchplane-development-admin",
    )
    .context("payment administrator authentication is invalid")?;
    let payment_callback_origin = if config.payment_callback_origin.is_empty() {
        None
    } else {
        Some(
            Url::parse(&config.payment_callback_origin)
                .context("payment callback origin is invalid")?,
        )
    };
    let pool = PgPool::connect(&config.database_url)
        .await
        .context("payment service could not connect to PostgreSQL")?;
    let state = Arc::new(AppState {
        store: PaymentStore::new(pool.clone(), config.environment),
        invoices: InvoiceStore::new(pool.clone(), config.environment),
        admin: AdminStore::new(pool, config.environment),
        telemetry,
        invoice_cipher,
        admin_auth,
        environment: config.environment,
        payment_callback_origin,
    });
    let invoice_reaper = state.invoices.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            if let Err(error) = invoice_reaper
                .reap_stale_operations(Duration::from_secs(15 * 60))
                .await
            {
                tracing::error!(%error, "invoice operation reaper failed");
            }
        }
    });
    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .route(
            "/v1/payments/authorize",
            axum::routing::post(api::authorize),
        )
        .route(
            "/v1/payment-webhooks/{gateway_id}",
            axum::routing::post(api::payment_webhook),
        )
        .route("/v1/payments/{payment_id}", get(api::payment))
        .route(
            "/v1/payments/{payment_id}/reconcile",
            axum::routing::post(api::reconcile),
        )
        .route(
            "/v1/payments/{payment_id}/capture",
            axum::routing::post(api::capture),
        )
        .route(
            "/v1/payments/{payment_id}/refunds",
            axum::routing::post(api::refund),
        )
        .route("/v1/refunds/{refund_id}", get(api::get_refund))
        .route("/v1/invoices", axum::routing::post(api::create_invoice))
        .route("/v1/invoices/{invoice_id}", get(api::get_invoice))
        .route(
            "/v1/invoices/{invoice_id}/corrections",
            get(api::invoice_corrections),
        )
        .route(
            "/v1/invoices/{invoice_id}/issue",
            axum::routing::post(api::issue_invoice),
        )
        .route(
            "/v1/invoices/{invoice_id}/void",
            axum::routing::post(api::void_invoice),
        )
        .route(
            "/v1/invoices/{invoice_id}/red-letter",
            axum::routing::post(api::red_letter_invoice),
        )
        .route(
            "/v1/invoices/{invoice_id}/download",
            get(api::download_invoice),
        )
        .route(
            "/v1/admin/payment-gateways",
            get(api::admin_gateways).post(api::mutate_gateway),
        )
        .route("/v1/admin/payments", get(api::admin_payments))
        .route(
            "/v1/admin/refunds",
            get(api::admin_refunds).post(api::admin_refund),
        )
        .route("/v1/admin/invoices", get(api::admin_invoices))
        .route(
            "/v1/admin/payment-routes",
            get(api::admin_routes).post(api::mutate_route),
        )
        .route(
            "/v1/admin/payment-mode",
            get(api::payment_setting).post(api::switch_payment_mode),
        )
        .route(
            "/v1/admin/invoice-providers",
            get(api::admin_invoice_providers).post(api::mutate_invoice_provider),
        )
        .route(
            "/v1/admin/invoice-mode",
            get(api::invoice_setting).post(api::switch_invoice_mode),
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
        .context("payment service could not bind HTTP listener")?;
    info!(address = %config.http_addr, "payment service listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("payment service failed")?;
    shutdown_telemetry
        .shutdown()
        .context("payment service telemetry shutdown failed")
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "matchplane-payment-service",
    })
}

async fn ready(State(state): State<Arc<AppState>>) -> (StatusCode, Json<HealthResponse>) {
    let ready = state.store.ping().await.is_ok();
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(HealthResponse {
            status: if ready { "ready" } else { "not_ready" },
            service: "matchplane-payment-service",
        }),
    )
}

async fn metrics(State(state): State<Arc<AppState>>) -> String {
    state.telemetry.render_metrics()
}

async fn shutdown_signal() {
    let control_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = control_c => {},
        () = terminate => {},
    }
}
