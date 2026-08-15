use anyhow::Context;
use matchplane_config::{AppConfig, Environment};
use matchplane_observability::init;
use matchplane_storage::PgStore;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("vector worker configuration is invalid")?;
    let telemetry = init(
        "matchplane-vector-worker",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("vector worker observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 10)
        .await
        .context("vector worker could not connect to PostgreSQL")?;
    store
        .ping()
        .await
        .context("vector worker readiness failed")?;
    store
        .ensure_local_node(
            config.node_id,
            &format!("http://{}", config.grpc_addr),
            config.environment != Environment::Production,
        )
        .await
        .context("vector worker local federation node registration failed")?;
    info!(node_id = %config.node_id, "vector worker ready for caller embeddings");
    shutdown_signal().await;
    telemetry
        .shutdown()
        .context("vector worker telemetry shutdown failed")?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for shutdown signal");
    }
}
