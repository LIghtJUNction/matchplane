use std::collections::HashMap;

use anyhow::Context;
use matchplane_config::{AppConfig, Environment};
use matchplane_engine::OrderBook;
use matchplane_events::{KafkaSecurityConfig, consumer, topics};
use matchplane_observability::{init, shutdown_signal};
use matchplane_protocol::decode_command_envelope;
use matchplane_storage::{MatchCommitOutcome, PgStore};
use rdkafka::{
    Message,
    consumer::{CommitMode, Consumer},
};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("matcher configuration is invalid")?;
    let telemetry = init(
        "matchplane-matcher",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("matcher observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 10)
        .await
        .context("matcher could not connect to PostgreSQL")?;
    store.ping().await.context("matcher readiness failed")?;
    store
        .ensure_local_node(
            config.node_id,
            &format!("http://{}", config.grpc_addr),
            config.environment != Environment::Production,
        )
        .await
        .context("matcher local federation node registration failed")?;
    let kafka_security = KafkaSecurityConfig {
        protocol: config.kafka_security_protocol.clone(),
        ca_location: Some(config.kafka_ssl_ca_location.clone()).filter(|path| !path.is_empty()),
        certificate_location: Some(config.kafka_ssl_certificate_location.clone())
            .filter(|path| !path.is_empty()),
        key_location: Some(config.kafka_ssl_key_location.clone()).filter(|path| !path.is_empty()),
    };
    let consumer = consumer(
        &config.kafka_brokers,
        "matchplane-matcher-v1",
        "matchplane-matcher",
        &[topics::COMMANDS],
        &kafka_security,
    )
    .context("matcher could not subscribe to Kafka")?;
    let owner_instance_id = format!("{}-{}", config.node_id, std::process::id());
    let mut books: HashMap<matchplane_domain::MarketId, OrderBook> = HashMap::new();
    info!(node_id = %config.node_id, "matcher ready for shard assignment");
    loop {
        let message = tokio::select! {
            () = shutdown_signal() => break,
            result = consumer.recv() => result.context("matcher Kafka receive failed")?,
        };
        let Some(payload) = message.payload() else {
            warn!("ignoring Kafka command without a payload");
            consumer
                .commit_message(&message, CommitMode::Sync)
                .context("matcher could not commit empty record offset")?;
            continue;
        };
        let decoded =
            decode_command_envelope(payload).context("invalid matching command envelope")?;
        let market_id = decoded.envelope.market_id;
        if let std::collections::hash_map::Entry::Vacant(entry) = books.entry(market_id) {
            let (book, replay_sequence) = store
                .recover_order_book(market_id)
                .await
                .context("matcher recovery failed")?;
            info!(%market_id, replay_sequence, command_sequence = book.last_command_sequence(), "market shard recovered");
            entry.insert(book);
        }
        let current = books
            .get(&market_id)
            .context("recovered market book disappeared")?;
        let mut candidate = current.clone();
        let events = candidate
            .process(&decoded.engine_command)
            .context("deterministic command rejected")?;
        let outcome = store
            .commit_matching(
                "matchplane-matcher-v1",
                &owner_instance_id,
                config.node_id,
                &decoded,
                &candidate,
                &events,
            )
            .await
            .context("matching transaction failed")?;
        if outcome == MatchCommitOutcome::Applied {
            books.insert(market_id, candidate);
        }
        consumer
            .commit_message(&message, CommitMode::Sync)
            .context("matcher could not commit Kafka offset")?;
        info!(%market_id, command_id = %decoded.envelope.event_id, ?outcome, "matching command committed");
    }
    info!("matcher stopped cleanly");
    telemetry
        .shutdown()
        .context("matcher telemetry shutdown failed")?;
    Ok(())
}
