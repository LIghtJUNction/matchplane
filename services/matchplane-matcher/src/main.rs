use std::{collections::HashMap, time::Duration};

use anyhow::Context;
use matchplane_config::{AppConfig, Environment};
use matchplane_domain::{EngineCommandKind, MarketId, StreamKind};
use matchplane_engine::OrderBook;
use matchplane_events::{
    KafkaRecordLocation, KafkaSecurityConfig, PartitionFailureController, consumer, topics,
};
use matchplane_observability::{init, shutdown_signal};
use matchplane_protocol::{DecodedCommand, decode_command_envelope};
use matchplane_storage::{
    KafkaFailureClass, KafkaFailureDisposition, MatchCommitOutcome, PgStore, QuarantineKafkaRecord,
    StorageError,
};
use rdkafka::{
    Message,
    consumer::{CommitMode, Consumer},
    error::KafkaError,
    message::BorrowedMessage,
};
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

const CONSUMER_NAME: &str = "matchplane-matcher-v1";

#[derive(Debug)]
struct ProcessedCommand {
    market_id: MarketId,
    command_id: matchplane_domain::EventId,
    outcome: MatchCommitOutcome,
}

#[derive(Debug)]
struct PermanentRecordFailure {
    class: KafkaFailureClass,
    message: String,
}

#[derive(Debug)]
enum MatcherRecordError {
    Permanent(PermanentRecordFailure),
    Transient(StorageError),
}

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
        CONSUMER_NAME,
        "matchplane-matcher",
        &[topics::COMMANDS],
        &kafka_security,
    )
    .context("matcher could not subscribe to Kafka")?;
    let owner_instance_id = format!("{}-{}", config.node_id, std::process::id());
    let mut books: HashMap<MarketId, OrderBook> = HashMap::new();
    let mut failures = PartitionFailureController::default();
    let mut retry_tick = interval(Duration::from_millis(250));
    retry_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut transport_failures = 0_u32;
    info!(node_id = %config.node_id, "matcher ready for shard assignment");
    loop {
        let message = tokio::select! {
            () = shutdown_signal() => break,
            _ = retry_tick.tick() => {
                resume_due_partitions(&consumer, &mut failures);
                continue;
            }
            result = consumer.recv() => match result {
                Ok(message) => {
                    transport_failures = 0;
                    message
                }
                Err(error @ KafkaError::MessageConsumptionFatal(_)) => {
                    return Err(error).context("matcher Kafka consumer became unusable");
                }
                Err(error) => {
                    transport_failures = transport_failures.saturating_add(1);
                    let delay = transport_retry_delay(transport_failures);
                    warn!(
                        %error,
                        attempts = transport_failures,
                        retry_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        "matcher Kafka transport failed; retrying without exiting"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            },
        };
        if failures.should_defer(&message) {
            continue;
        }
        match process_record(
            &message,
            &store,
            &mut books,
            &owner_instance_id,
            config.node_id,
        )
        .await
        {
            Ok(processed) => {
                if let Err(error) = consumer.commit_message(&message, CommitMode::Sync) {
                    schedule_retry(&consumer, &mut failures, &message, &error.to_string())?;
                    continue;
                }
                failures.complete(&message);
                info!(
                    market_id = %processed.market_id,
                    command_id = %processed.command_id,
                    outcome = ?processed.outcome,
                    "matching command committed"
                );
            }
            Err(MatcherRecordError::Transient(error)) => {
                schedule_retry(&consumer, &mut failures, &message, &error.to_string())?;
            }
            Err(MatcherRecordError::Permanent(failure)) => {
                let location = KafkaRecordLocation::from_message(&message);
                match store
                    .quarantine_kafka_record(QuarantineKafkaRecord {
                        consumer_name: CONSUMER_NAME,
                        location: &location,
                        message_key: message.key(),
                        payload: message.payload(),
                        failure_class: failure.class,
                        error_message: &failure.message,
                        disposition: KafkaFailureDisposition::Blocked,
                    })
                    .await
                {
                    Ok(quarantine) => {
                        failures
                            .block(&consumer, &message)
                            .context("matcher could not pause poisoned Kafka partition")?;
                        warn!(
                            quarantine_id = %quarantine.id,
                            topic = %location.topic,
                            partition = location.partition,
                            offset = location.offset,
                            reason = %failure.message,
                            "Kafka command quarantined; partition remains paused and uncommitted"
                        );
                    }
                    Err(error) => {
                        schedule_retry(&consumer, &mut failures, &message, &error.to_string())?;
                    }
                }
            }
        }
    }
    info!("matcher stopped cleanly");
    telemetry
        .shutdown()
        .context("matcher telemetry shutdown failed")?;
    Ok(())
}

async fn process_record(
    message: &BorrowedMessage<'_>,
    store: &PgStore,
    books: &mut HashMap<MarketId, OrderBook>,
    owner_instance_id: &str,
    owner_node_id: matchplane_domain::FederationNodeId,
) -> Result<ProcessedCommand, MatcherRecordError> {
    let decoded = validate_command(message)?;
    let market_id = decoded.envelope.market_id;
    if let std::collections::hash_map::Entry::Vacant(entry) = books.entry(market_id) {
        let (book, replay_sequence) = store
            .recover_order_book(market_id)
            .await
            .map_err(classify_storage_error)?;
        info!(%market_id, replay_sequence, command_sequence = book.last_command_sequence(), "market shard recovered");
        entry.insert(book);
    }

    let current = books.get(&market_id).ok_or_else(|| {
        MatcherRecordError::Permanent(PermanentRecordFailure {
            class: KafkaFailureClass::ProcessingInvariant,
            message: "recovered market book disappeared".to_owned(),
        })
    })?;
    let mut candidate = current.clone();
    let events = match candidate.process(&decoded.engine_command) {
        Ok(events) => events,
        Err(first_error) => {
            let (recovered, replay_sequence) = store
                .recover_order_book(market_id)
                .await
                .map_err(classify_storage_error)?;
            info!(
                %market_id,
                replay_sequence,
                reason = %first_error,
                "retrying command after canonical book recovery"
            );
            books.insert(market_id, recovered.clone());
            candidate = recovered;
            candidate.process(&decoded.engine_command).map_err(|error| {
                MatcherRecordError::Permanent(PermanentRecordFailure {
                    class: KafkaFailureClass::ProcessingInvariant,
                    message: format!(
                        "deterministic command remained invalid after canonical recovery: {error}"
                    ),
                })
            })?
        }
    };
    let advanced = !events.is_empty();
    let outcome = store
        .commit_matching(
            CONSUMER_NAME,
            owner_instance_id,
            owner_node_id,
            &decoded,
            &candidate,
            &events,
        )
        .await
        .map_err(classify_storage_error)?;
    if advanced {
        books.insert(market_id, candidate);
    }
    Ok(ProcessedCommand {
        market_id,
        command_id: decoded.envelope.event_id,
        outcome,
    })
}

fn validate_command(message: &BorrowedMessage<'_>) -> Result<DecodedCommand, MatcherRecordError> {
    let payload = message.payload().ok_or_else(|| {
        permanent_failure(
            KafkaFailureClass::InvalidPayload,
            "Kafka command has no payload",
        )
    })?;
    let decoded = decode_command_envelope(payload).map_err(|error| {
        permanent_failure(
            KafkaFailureClass::InvalidPayload,
            format!("matching command envelope is invalid: {error}"),
        )
    })?;
    if message.topic() != topics::COMMANDS
        || decoded.envelope.stream_kind != StreamKind::Command
        || decoded.envelope.schema_version != 1
    {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "matching command topic, stream kind, or schema version is invalid",
        ));
    }
    let expected_key = decoded.envelope.market_id.to_string();
    if message.key() != Some(expected_key.as_bytes()) {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "Kafka command key does not match its envelope market ID",
        ));
    }
    if let EngineCommandKind::PlaceLimitOrder { intent } = &decoded.engine_command.kind
        && (intent.tenant_id != decoded.envelope.tenant_id
            || intent.domain_id != decoded.envelope.domain_id
            || intent.market_id != decoded.envelope.market_id)
    {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "matching command scope does not match its envelope",
        ));
    }
    Ok(decoded)
}

fn classify_storage_error(error: StorageError) -> MatcherRecordError {
    match error {
        transient @ (StorageError::Sqlx(_)
        | StorageError::Migration(_)
        | StorageError::LeaseUnavailable) => MatcherRecordError::Transient(transient),
        permanent => MatcherRecordError::Permanent(PermanentRecordFailure {
            class: KafkaFailureClass::ProcessingInvariant,
            message: format!("canonical matching state rejected Kafka command: {permanent}"),
        }),
    }
}

fn permanent_failure(class: KafkaFailureClass, message: impl Into<String>) -> MatcherRecordError {
    MatcherRecordError::Permanent(PermanentRecordFailure {
        class,
        message: message.into(),
    })
}

fn transport_retry_delay(attempts: u32) -> Duration {
    Duration::from_secs(1_u64 << attempts.saturating_sub(1).min(5))
}

fn schedule_retry(
    consumer: &rdkafka::consumer::StreamConsumer,
    failures: &mut PartitionFailureController,
    message: &BorrowedMessage<'_>,
    reason: &str,
) -> anyhow::Result<()> {
    let location = KafkaRecordLocation::from_message(message);
    let retry = failures
        .retry_later(consumer, message)
        .context("matcher could not pause failing Kafka partition")?;
    warn!(
        topic = %location.topic,
        partition = location.partition,
        offset = location.offset,
        attempts = retry.attempts,
        retry_ms = u64::try_from(retry.delay.as_millis()).unwrap_or(u64::MAX),
        reason,
        "Kafka command retry scheduled without blocking other partitions"
    );
    Ok(())
}

fn resume_due_partitions(
    consumer: &rdkafka::consumer::StreamConsumer,
    failures: &mut PartitionFailureController,
) {
    for location in failures.due_retries() {
        match failures.resume_retry(consumer, &location) {
            Ok(()) => info!(
                topic = %location.topic,
                partition = location.partition,
                offset = location.offset,
                "resumed Kafka partition at failed offset"
            ),
            Err(error) => warn!(
                topic = %location.topic,
                partition = location.partition,
                offset = location.offset,
                %error,
                "Kafka partition retry could not resume"
            ),
        }
    }
}
