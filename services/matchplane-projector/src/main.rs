use std::{path::Path, time::Duration};

use anyhow::Context;
use matchplane_cache::{
    CacheError, CachedBook, CachedLevel, ProjectionOutcome, ProjectionRepairOutcome, ValkeyCache,
};
use matchplane_config::AppConfig;
use matchplane_domain::{MarketId, StreamKind};
use matchplane_events::{
    KafkaRecordLocation, KafkaSecurityConfig, PartitionFailureController, consumer, topics,
};
use matchplane_observability::{init, shutdown_signal};
use matchplane_protocol::{decode_event_envelope_as, v1};
use matchplane_storage::{
    BookProjection, BookProjectionLevel, KafkaFailureClass, KafkaFailureDisposition, PgStore,
    QuarantineKafkaRecord, StorageError,
};
use prost::Message;
use rdkafka::{
    Message as KafkaMessage,
    consumer::{CommitMode, Consumer, StreamConsumer},
    error::KafkaError,
    message::BorrowedMessage,
};
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

const CONSUMER_NAME: &str = "matchplane-projector-v1";
const ORDER_BOOK_MESSAGE_TYPE: &str = "matchplane.v1.OrderBookDelta";

#[derive(Debug)]
struct ProjectedBook {
    market_id: String,
    sequence: u64,
    outcome: &'static str,
}

#[derive(Debug)]
struct PermanentRecordFailure {
    class: KafkaFailureClass,
    message: String,
}

#[derive(Debug)]
enum ProjectorRecordError {
    Permanent(PermanentRecordFailure),
    Transient(String),
}

#[derive(Debug)]
enum PoisonResolution {
    Resolved(KafkaFailureDisposition),
    Retry(String),
    Block(String),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("projector configuration is invalid")?;
    let telemetry = init(
        "matchplane-projector",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("projector observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 5)
        .await
        .context("projector could not connect to PostgreSQL")?;
    store
        .ping()
        .await
        .context("projector PostgreSQL readiness failed")?;
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
        CONSUMER_NAME,
        "matchplane-projector",
        &[topics::ORDER_BOOK_DELTAS],
        &kafka_security,
    )
    .context("projector could not subscribe to Kafka")?;
    let mut failures = PartitionFailureController::default();
    let mut retry_tick = interval(Duration::from_millis(250));
    retry_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut transport_failures = 0_u32;
    info!(node_id = %config.node_id, "projector ready");
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
                    return Err(error).context("projector Kafka consumer became unusable");
                }
                Err(error) => {
                    transport_failures = transport_failures.saturating_add(1);
                    let delay = transport_retry_delay(transport_failures);
                    warn!(
                        %error,
                        attempts = transport_failures,
                        retry_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        "projector Kafka transport failed; retrying without exiting"
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            },
        };
        if failures.should_defer(&message) {
            continue;
        }
        match process_record(&message, &store, &mut cache).await {
            Ok(projected) => {
                if let Err(error) = consumer.commit_message(&message, CommitMode::Sync) {
                    schedule_retry(&consumer, &mut failures, &message, &error.to_string())?;
                    continue;
                }
                failures.complete(&message);
                info!(
                    market_id = %projected.market_id,
                    sequence = projected.sequence,
                    outcome = projected.outcome,
                    "book projection offset committed"
                );
            }
            Err(ProjectorRecordError::Transient(error)) => {
                schedule_retry(&consumer, &mut failures, &message, &error)?;
            }
            Err(ProjectorRecordError::Permanent(failure)) => {
                handle_poison_record(
                    &consumer,
                    &mut failures,
                    &message,
                    &store,
                    &mut cache,
                    failure,
                )
                .await?;
            }
        }
    }
    info!("projector stopped cleanly");
    telemetry
        .shutdown()
        .context("projector telemetry shutdown failed")?;
    Ok(())
}

async fn process_record(
    message: &BorrowedMessage<'_>,
    store: &PgStore,
    cache: &mut ValkeyCache,
) -> Result<ProjectedBook, ProjectorRecordError> {
    let (market_id, book) = decode_book(message)?;
    let outcome = match cache.apply_book(&book).await {
        Ok(ProjectionOutcome::Applied) => "applied",
        Ok(ProjectionOutcome::Duplicate) => "duplicate",
        Ok(ProjectionOutcome::Gap) | Err(CacheError::InvalidProjectionSequence) => {
            repair_projection(store, cache, market_id, book.sequence).await?;
            "repaired"
        }
        Ok(ProjectionOutcome::Conflict) => {
            return Err(permanent_failure(
                KafkaFailureClass::ProcessingInvariant,
                "order-book sequence conflicts with a different cached state hash",
            ));
        }
        Err(error) => return Err(classify_incoming_cache_error(error)),
    };
    Ok(ProjectedBook {
        market_id: book.market_id,
        sequence: book.sequence,
        outcome,
    })
}

fn decode_book(
    message: &BorrowedMessage<'_>,
) -> Result<(MarketId, CachedBook), ProjectorRecordError> {
    let payload = message.payload().ok_or_else(|| {
        permanent_failure(
            KafkaFailureClass::InvalidPayload,
            "order-book Kafka record has no payload",
        )
    })?;
    let envelope = decode_event_envelope_as(payload, ORDER_BOOK_MESSAGE_TYPE).map_err(|error| {
        permanent_failure(
            KafkaFailureClass::InvalidPayload,
            format!("order-book envelope is invalid: {error}"),
        )
    })?;
    if message.topic() != topics::ORDER_BOOK_DELTAS
        || envelope.stream_kind != StreamKind::OrderBookDelta
        || envelope.schema_version != 1
        || envelope.shard_sequence == 0
    {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "order-book topic, stream kind, schema version, or sequence is invalid",
        ));
    }
    let expected_key = envelope.market_id.to_string();
    if message.key() != Some(expected_key.as_bytes()) {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "order-book Kafka key does not match its envelope market ID",
        ));
    }
    let delta = v1::OrderBookDelta::decode(envelope.payload.as_slice()).map_err(|error| {
        permanent_failure(
            KafkaFailureClass::InvalidPayload,
            format!("order-book delta is invalid: {error}"),
        )
    })?;
    if delta.command_sequence != envelope.shard_sequence
        || delta.market_id != expected_key
        || delta.state_hash.len() != 32
    {
        return Err(permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            "order-book delta identity, sequence, or state hash disagrees with its envelope",
        ));
    }
    let bids = validated_levels(delta.bids, true)?;
    let asks = validated_levels(delta.asks, false)?;
    Ok((
        envelope.market_id,
        CachedBook {
            market_id: delta.market_id,
            sequence: delta.command_sequence,
            bids,
            asks,
            state_hash: hex::encode(delta.state_hash),
        },
    ))
}

fn validated_levels(
    levels: Vec<v1::PriceLevel>,
    descending: bool,
) -> Result<Vec<CachedLevel>, ProjectorRecordError> {
    let mut previous_price = None;
    let mut validated = Vec::with_capacity(levels.len());
    for level in levels {
        let price = exact_positive_value(&level.price).ok_or_else(|| {
            permanent_failure(
                KafkaFailureClass::ProtocolViolation,
                "order-book price is not a canonical positive exact integer",
            )
        })?;
        if previous_price.is_some_and(|previous| {
            if descending {
                price >= previous
            } else {
                price <= previous
            }
        }) {
            return Err(permanent_failure(
                KafkaFailureClass::ProtocolViolation,
                "order-book levels are duplicated or out of price order",
            ));
        }
        exact_positive_value(&level.quantity).ok_or_else(|| {
            permanent_failure(
                KafkaFailureClass::ProtocolViolation,
                "order-book quantity is not a canonical positive exact integer",
            )
        })?;
        previous_price = Some(price);
        validated.push(CachedLevel {
            price: level.price,
            quantity: level.quantity,
        });
    }
    Ok(validated)
}

fn exact_positive_value(value: &str) -> Option<i128> {
    if value.is_empty()
        || value.len() > 38
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse::<i128>().ok().filter(|number| *number > 0)
}

async fn repair_projection(
    store: &PgStore,
    cache: &mut ValkeyCache,
    market_id: MarketId,
    observed_sequence: u64,
) -> Result<(), ProjectorRecordError> {
    let projection = store
        .latest_book_projection(market_id)
        .await
        .map_err(classify_projection_storage_error)?
        .ok_or_else(|| {
            permanent_failure(
                KafkaFailureClass::ProcessingInvariant,
                format!("no durable book projection exists for market {market_id}"),
            )
        })?;
    if projection.sequence < observed_sequence {
        return Err(permanent_failure(
            KafkaFailureClass::ProcessingInvariant,
            format!(
                "durable projection for {market_id} is behind Kafka: durable {}, observed {observed_sequence}",
                projection.sequence
            ),
        ));
    }
    let durable_sequence = projection.sequence;
    let book = cached_book(projection);
    match cache
        .repair_book(&book)
        .await
        .map_err(classify_repair_cache_error)?
    {
        ProjectionRepairOutcome::Repaired => warn!(
            %market_id,
            observed_sequence,
            durable_sequence,
            "book projection repaired from PostgreSQL"
        ),
        ProjectionRepairOutcome::Current => info!(
            %market_id,
            observed_sequence,
            durable_sequence,
            "concurrent book projection repair was already current"
        ),
    }
    Ok(())
}

async fn handle_poison_record(
    consumer: &StreamConsumer,
    failures: &mut PartitionFailureController,
    message: &BorrowedMessage<'_>,
    store: &PgStore,
    cache: &mut ValkeyCache,
    failure: PermanentRecordFailure,
) -> anyhow::Result<()> {
    let location = KafkaRecordLocation::from_message(message);
    match resolve_poison_record(message, store, cache).await {
        PoisonResolution::Retry(error) => {
            schedule_retry(consumer, failures, message, &error)?;
        }
        PoisonResolution::Block(reconciliation_error) => {
            let error_message = format!(
                "{}; PostgreSQL reconciliation failed: {reconciliation_error}",
                failure.message
            );
            match store
                .quarantine_kafka_record(QuarantineKafkaRecord {
                    consumer_name: CONSUMER_NAME,
                    location: &location,
                    message_key: message.key(),
                    payload: message.payload(),
                    failure_class: KafkaFailureClass::ProcessingInvariant,
                    error_message: &error_message,
                    disposition: KafkaFailureDisposition::Blocked,
                })
                .await
            {
                Ok(quarantine) => {
                    failures
                        .block(consumer, message)
                        .context("projector could not pause poisoned Kafka partition")?;
                    warn!(
                        quarantine_id = %quarantine.id,
                        topic = %location.topic,
                        partition = location.partition,
                        offset = location.offset,
                        reason = %error_message,
                        "order-book record quarantined; partition remains paused and uncommitted"
                    );
                }
                Err(error) => schedule_retry(consumer, failures, message, &error.to_string())?,
            }
        }
        PoisonResolution::Resolved(disposition) => {
            match store
                .quarantine_kafka_record(QuarantineKafkaRecord {
                    consumer_name: CONSUMER_NAME,
                    location: &location,
                    message_key: message.key(),
                    payload: message.payload(),
                    failure_class: failure.class,
                    error_message: &failure.message,
                    disposition,
                })
                .await
            {
                Ok(quarantine) => {
                    if let Err(error) = consumer.commit_message(message, CommitMode::Sync) {
                        schedule_retry(consumer, failures, message, &error.to_string())?;
                        return Ok(());
                    }
                    failures.complete(message);
                    warn!(
                        quarantine_id = %quarantine.id,
                        topic = %location.topic,
                        partition = location.partition,
                        offset = location.offset,
                        ?disposition,
                        reason = %failure.message,
                        "poisoned projection record handled by explicit terminal policy"
                    );
                }
                Err(error) => schedule_retry(consumer, failures, message, &error.to_string())?,
            }
        }
    }
    Ok(())
}

async fn resolve_poison_record(
    message: &BorrowedMessage<'_>,
    store: &PgStore,
    cache: &mut ValkeyCache,
) -> PoisonResolution {
    let Some((market_id, poisoned_sequence)) = poison_projection_identity(message) else {
        return PoisonResolution::Block(
            "poisoned projection has no verifiable envelope identity or sequence".to_owned(),
        );
    };
    let projection = match store.latest_book_projection(market_id).await {
        Ok(Some(projection)) => projection,
        Ok(None) => {
            return PoisonResolution::Block(
                "no durable projection proves the poisoned offset is covered".to_owned(),
            );
        }
        Err(StorageError::Sqlx(error)) => return PoisonResolution::Retry(error.to_string()),
        Err(StorageError::Migration(error)) => return PoisonResolution::Retry(error.to_string()),
        Err(error) => return PoisonResolution::Block(error.to_string()),
    };
    let sequence = projection.sequence;
    if !durable_projection_covers(poisoned_sequence, sequence) {
        return PoisonResolution::Block(format!(
            "durable projection sequence {sequence} is behind poisoned sequence {poisoned_sequence}"
        ));
    }
    match cache.repair_book(&cached_book(projection)).await {
        Ok(ProjectionRepairOutcome::Repaired) => warn!(
            %market_id,
            sequence,
            "poisoned projection offset reconciled from PostgreSQL"
        ),
        Ok(ProjectionRepairOutcome::Current) => info!(
            %market_id,
            sequence,
            "projection was already current while isolating poison record"
        ),
        Err(CacheError::Valkey(error)) => return PoisonResolution::Retry(error.to_string()),
        Err(error) => return PoisonResolution::Block(error.to_string()),
    }
    PoisonResolution::Resolved(KafkaFailureDisposition::Reconciled)
}

const fn durable_projection_covers(poisoned_sequence: u64, durable_sequence: u64) -> bool {
    durable_sequence >= poisoned_sequence
}

fn poison_projection_identity(message: &BorrowedMessage<'_>) -> Option<(MarketId, u64)> {
    message
        .payload()
        .and_then(|payload| decode_event_envelope_as(payload, ORDER_BOOK_MESSAGE_TYPE).ok())
        .filter(|envelope| {
            envelope.stream_kind == StreamKind::OrderBookDelta
                && envelope.schema_version == 1
                && envelope.shard_sequence > 0
        })
        .map(|envelope| (envelope.market_id, envelope.shard_sequence))
}

fn cached_book(projection: BookProjection) -> CachedBook {
    CachedBook {
        market_id: projection.market_id.to_string(),
        sequence: projection.sequence,
        bids: stored_levels(projection.bids),
        asks: stored_levels(projection.asks),
        state_hash: projection.state_hash.to_hex(),
    }
}

fn stored_levels(levels: Vec<BookProjectionLevel>) -> Vec<CachedLevel> {
    levels
        .into_iter()
        .map(|level| CachedLevel {
            price: level.price,
            quantity: level.quantity,
        })
        .collect()
}

fn classify_projection_storage_error(error: StorageError) -> ProjectorRecordError {
    match error {
        StorageError::Sqlx(error) => ProjectorRecordError::Transient(error.to_string()),
        StorageError::Migration(error) => ProjectorRecordError::Transient(error.to_string()),
        permanent => permanent_failure(
            KafkaFailureClass::ProcessingInvariant,
            format!("durable book projection is invalid: {permanent}"),
        ),
    }
}

fn classify_incoming_cache_error(error: CacheError) -> ProjectorRecordError {
    match error {
        CacheError::Valkey(error) => ProjectorRecordError::Transient(error.to_string()),
        permanent => permanent_failure(
            KafkaFailureClass::ProtocolViolation,
            format!("order-book delta cannot be projected: {permanent}"),
        ),
    }
}

fn classify_repair_cache_error(error: CacheError) -> ProjectorRecordError {
    match error {
        CacheError::Valkey(error) => ProjectorRecordError::Transient(error.to_string()),
        permanent => permanent_failure(
            KafkaFailureClass::ProcessingInvariant,
            format!("durable book projection cannot repair Valkey: {permanent}"),
        ),
    }
}

fn permanent_failure(class: KafkaFailureClass, message: impl Into<String>) -> ProjectorRecordError {
    ProjectorRecordError::Permanent(PermanentRecordFailure {
        class,
        message: message.into(),
    })
}

fn transport_retry_delay(attempts: u32) -> Duration {
    Duration::from_secs(1_u64 << attempts.saturating_sub(1).min(5))
}

fn schedule_retry(
    consumer: &StreamConsumer,
    failures: &mut PartitionFailureController,
    message: &BorrowedMessage<'_>,
    reason: &str,
) -> anyhow::Result<()> {
    let location = KafkaRecordLocation::from_message(message);
    let retry = failures
        .retry_later(consumer, message)
        .context("projector could not pause failing Kafka partition")?;
    warn!(
        topic = %location.topic,
        partition = location.partition,
        offset = location.offset,
        attempts = retry.attempts,
        retry_ms = u64::try_from(retry.delay.as_millis()).unwrap_or(u64::MAX),
        reason,
        "projection retry scheduled without blocking other partitions"
    );
    Ok(())
}

fn resume_due_partitions(consumer: &StreamConsumer, failures: &mut PartitionFailureController) {
    for location in failures.due_retries() {
        match failures.resume_retry(consumer, &location) {
            Ok(()) => info!(
                topic = %location.topic,
                partition = location.partition,
                offset = location.offset,
                "resumed projection partition at failed offset"
            ),
            Err(error) => warn!(
                topic = %location.topic,
                partition = location.partition,
                offset = location.offset,
                %error,
                "projection partition retry could not resume"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_projection_must_cover_the_poisoned_sequence_before_terminal_commit() {
        assert!(!durable_projection_covers(10, 9));
        assert!(durable_projection_covers(10, 10));
        assert!(durable_projection_covers(10, 11));
    }

    #[test]
    fn exact_projection_values_should_reject_zero_padding_and_non_positive_values() {
        assert_eq!(exact_positive_value("1"), Some(1));
        assert_eq!(
            exact_positive_value("99999999999999999999999999999999999999"),
            Some(99999999999999999999999999999999999999)
        );
        assert_eq!(exact_positive_value("01"), None);
        assert_eq!(exact_positive_value("0"), None);
        assert_eq!(exact_positive_value("-1"), None);
    }

    #[test]
    fn book_levels_should_be_strictly_ordered() {
        let bids = vec![
            v1::PriceLevel {
                price: "2".to_owned(),
                quantity: "1".to_owned(),
            },
            v1::PriceLevel {
                price: "1".to_owned(),
                quantity: "1".to_owned(),
            },
        ];
        let duplicated = vec![
            v1::PriceLevel {
                price: "2".to_owned(),
                quantity: "1".to_owned(),
            },
            v1::PriceLevel {
                price: "2".to_owned(),
                quantity: "1".to_owned(),
            },
        ];

        assert!(validated_levels(bids, true).is_ok());
        assert!(validated_levels(duplicated, true).is_err());
    }
}
