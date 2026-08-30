mod health;
mod worker;
mod worker_metrics;

use std::{sync::Arc, time::Duration};

use anyhow::{Context, anyhow, bail};
use matchplane_config::AppConfig;
use matchplane_observability::{init, shutdown_signal};
use matchplane_storage::PgStore;
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};
use tracing::info;

use crate::{
    health::{HealthState, ReadinessState},
    worker::{WorkerSettings, run_worker},
    worker_metrics::WorkerMetrics,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("conversion projector configuration is invalid")?;
    if config.service_role != "conversion-projector" {
        bail!("MATCHPLANE_SERVICE_ROLE must be conversion-projector for this workload");
    }
    let telemetry = init(
        "matchplane-conversion-projector",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("conversion projector observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, config.conversion_projector_pool_size)
        .await
        .context("conversion projector could not connect to PostgreSQL")?;
    let listener = TcpListener::bind(config.http_addr)
        .await
        .context("conversion projector health listener bind failed")?;
    let metrics = Arc::new(WorkerMetrics::default());
    let health_state = HealthState {
        readiness: ReadinessState {
            store: store.clone(),
            metrics: Arc::clone(&metrics),
            enabled: config.conversion_projector_enabled,
            degraded_after_seconds: config.conversion_projector_degraded_after_seconds,
        },
        telemetry: telemetry.clone(),
    };
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let server_shutdown = shutdown_rx.clone();
    let mut server_handle = tokio::spawn(async move {
        axum::serve(listener, health::router(health_state))
            .with_graceful_shutdown(wait_until_shutdown(server_shutdown))
            .await
    });
    let enabled = config.conversion_projector_enabled;
    let worker_shutdown = shutdown_rx;
    let mut worker_handle = tokio::spawn(async move {
        if enabled {
            run_worker(
                &store,
                WorkerSettings {
                    poll_interval: Duration::from_millis(config.conversion_projector_poll_ms),
                    #[cfg(test)]
                    poll_observed: None,
                },
                metrics,
                worker_shutdown,
            )
            .await;
        } else {
            wait_until_shutdown(worker_shutdown).await;
        }
    });
    info!(
        enabled,
        batch_size = config.conversion_projector_batch_size,
        poll_ms = config.conversion_projector_poll_ms,
        pool_size = config.conversion_projector_pool_size,
        "conversion projector workload initialized"
    );

    let (mut terminal_error, worker_consumed, server_consumed) = tokio::select! {
        () = shutdown_signal() => (None, false, false),
        result = &mut worker_handle => (Some(match result {
            Ok(()) => anyhow!("conversion projector worker stopped unexpectedly"),
            Err(error) => anyhow!("conversion projector worker task failed: {error}"),
        }), true, false),
        result = &mut server_handle => (Some(match result {
            Ok(Ok(())) => anyhow!("conversion projector health server stopped unexpectedly"),
            Ok(Err(error)) => anyhow!("conversion projector health server failed: {error}"),
            Err(error) => anyhow!("conversion projector health task failed: {error}"),
        }), false, true),
    };
    let _ = shutdown_tx.send(true);
    if !worker_consumed {
        collect_worker_exit(&mut terminal_error, worker_handle).await;
    }
    if !server_consumed {
        collect_server_exit(&mut terminal_error, server_handle).await;
    }
    info!("conversion projector stopped cleanly");
    let telemetry_result = telemetry
        .shutdown()
        .context("conversion projector telemetry shutdown failed");
    if let Some(error) = terminal_error {
        return Err(error);
    }
    telemetry_result
}

async fn wait_until_shutdown(mut shutdown: watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

async fn collect_worker_exit(error: &mut Option<anyhow::Error>, handle: JoinHandle<()>) {
    if let Err(join_error) = handle.await {
        error.get_or_insert_with(|| {
            anyhow!("conversion projector worker task failed: {join_error}")
        });
    }
}

async fn collect_server_exit(
    error: &mut Option<anyhow::Error>,
    handle: JoinHandle<Result<(), std::io::Error>>,
) {
    match handle.await {
        Ok(Ok(())) => {}
        Ok(Err(server_error)) => {
            error.get_or_insert_with(|| {
                anyhow!("conversion projector health server failed: {server_error}")
            });
        }
        Err(join_error) => {
            error.get_or_insert_with(|| {
                anyhow!("conversion projector health task failed: {join_error}")
            });
        }
    }
}
