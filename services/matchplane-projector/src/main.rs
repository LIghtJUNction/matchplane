use std::path::Path;

use anyhow::Context;
use matchplane_cache::{CachedBook, CachedLevel, ProjectionOutcome, ValkeyCache};
use matchplane_config::AppConfig;
use matchplane_domain::StreamKind;
use matchplane_events::{KafkaSecurityConfig, consumer, topics};
use matchplane_observability::init;
use matchplane_protocol::{decode_event_envelope, v1};
use prost::Message;
use rdkafka::{
    Message as KafkaMessage,
    consumer::{CommitMode, Consumer},
};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("projector configuration is invalid")?;
    let telemetry = init(
        "matchplane-projector",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("projector observability initialization failed")?;
    let valkey_ca_file =
        (!config.valkey_ca_file.is_empty()).then(|| Path::new(config.valkey_ca_file.as_str()));
    let mut cache = ValkeyCache::connect_with_ca(&config.valkey_url, valkey_ca_file)
        .await
        .context("projector could not connect to Valkey")?;
    cache.ping().await.context("projector readiness failed")?;
    let kafka_security = KafkaSecurityConfig {
        protocol: config.kafka_security_protocol.clone(),
        ca_location: Some(config.kafka_ssl_ca_location.clone()).filter(|path| !path.is_empty()),
        certificate_location: Some(config.kafka_ssl_certificate_location.clone())
            .filter(|path| !path.is_empty()),
        key_location: Some(config.kafka_ssl_key_location.clone()).filter(|path| !path.is_empty()),
    };
    let consumer = consumer(
        &config.kafka_brokers,
        "matchplane-projector-v1",
        "matchplane-projector",
        &[topics::ORDER_BOOK_DELTAS],
        &kafka_security,
    )
    .context("projector could not subscribe to Kafka")?;
    info!(node_id = %config.node_id, "projector ready");
    loop {
        let message = tokio::select! {
            () = shutdown_signal() => break,
            result = consumer.recv() => result.context("projector Kafka receive failed")?,
        };
        let Some(payload) = message.payload() else {
            warn!("ignoring order-book delta without a payload");
            consumer
                .commit_message(&message, CommitMode::Sync)
                .context("projector could not commit empty record offset")?;
            continue;
        };
        let envelope = decode_event_envelope(payload).context("invalid order-book envelope")?;
        anyhow::ensure!(
            envelope.stream_kind == StreamKind::OrderBookDelta,
            "projector received a non-book stream"
        );
        let delta = v1::OrderBookDelta::decode(envelope.payload.as_slice())
            .context("invalid order-book delta")?;
        anyhow::ensure!(
            delta.command_sequence == envelope.shard_sequence,
            "delta and envelope sequences disagree"
        );
        let book = CachedBook {
            market_id: delta.market_id,
            sequence: delta.command_sequence,
            bids: levels(delta.bids),
            asks: levels(delta.asks),
            state_hash: hex::encode(delta.state_hash),
        };
        match cache
            .apply_book(&book)
            .await
            .context("Valkey projection failed")?
        {
            ProjectionOutcome::Applied => {
                info!(market_id = %book.market_id, sequence = book.sequence, "book projection advanced");
            }
            ProjectionOutcome::Duplicate => {
                info!(market_id = %book.market_id, sequence = book.sequence, "duplicate book delta ignored");
            }
            ProjectionOutcome::Gap => {
                anyhow::bail!(
                    "book delta gap for {} at sequence {}; replay is required",
                    book.market_id,
                    book.sequence
                );
            }
        }
        consumer
            .commit_message(&message, CommitMode::Sync)
            .context("projector could not commit Kafka offset")?;
    }
    info!("projector stopped cleanly");
    telemetry
        .shutdown()
        .context("projector telemetry shutdown failed")?;
    Ok(())
}

fn levels(levels: Vec<v1::PriceLevel>) -> Vec<CachedLevel> {
    levels
        .into_iter()
        .map(|level| CachedLevel {
            price: level.price,
            quantity: level.quantity,
        })
        .collect()
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for shutdown signal");
    }
}
