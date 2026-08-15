use anyhow::Context;
use matchplane_config::{AppConfig, Environment};
use matchplane_events::{KafkaPublisher, KafkaSecurityConfig};
use matchplane_observability::init;
use matchplane_storage::PgStore;
use tokio::time::{Duration, sleep};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("relay configuration is invalid")?;
    let telemetry = init(
        "matchplane-event-relay",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("relay observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 10)
        .await
        .context("relay could not connect to PostgreSQL")?;
    store.ping().await.context("relay readiness failed")?;
    store
        .ensure_local_node(
            config.node_id,
            &format!("http://{}", config.grpc_addr),
            config.environment != Environment::Production,
        )
        .await
        .context("relay local federation node registration failed")?;
    let kafka_security = KafkaSecurityConfig {
        protocol: config.kafka_security_protocol.clone(),
        ca_location: Some(config.kafka_ssl_ca_location.clone()).filter(|path| !path.is_empty()),
        certificate_location: Some(config.kafka_ssl_certificate_location.clone())
            .filter(|path| !path.is_empty()),
        key_location: Some(config.kafka_ssl_key_location.clone()).filter(|path| !path.is_empty()),
    };
    let publisher = KafkaPublisher::new(
        &config.kafka_brokers,
        "matchplane-event-relay",
        &kafka_security,
    )
    .context("relay could not configure Kafka")?;
    info!(node_id = %config.node_id, "outbox relay ready");
    loop {
        tokio::select! {
            () = shutdown_signal() => break,
            result = relay_once(&store, &publisher) => result?,
        }
    }
    info!("outbox relay stopped cleanly");
    telemetry
        .shutdown()
        .context("relay telemetry shutdown failed")?;
    Ok(())
}

async fn relay_once(store: &PgStore, publisher: &KafkaPublisher) -> anyhow::Result<()> {
    let messages = store
        .claim_outbox(100)
        .await
        .context("outbox claim failed")?;
    if messages.is_empty() {
        sleep(Duration::from_millis(100)).await;
        return Ok(());
    }
    for message in messages {
        match publisher
            .publish(&message.topic, &message.message_key, &message.payload)
            .await
        {
            Ok(()) => store
                .mark_outbox_published(message.event_id)
                .await
                .context("outbox acknowledgement failed")?,
            Err(error) => {
                warn!(event_id = %message.event_id, %error, "Kafka publication will be retried");
                store
                    .mark_outbox_failed(message.event_id, message.attempts, &error.to_string())
                    .await
                    .context("outbox retry transition failed")?;
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for shutdown signal");
    }
}
