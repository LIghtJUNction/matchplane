//! At-least-once Kafka transport for transactional outbox messages.

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use rdkafka::{
    ClientConfig, Message, Offset, TopicPartitionList,
    consumer::{Consumer, StreamConsumer},
    error::KafkaError,
    message::BorrowedMessage,
    producer::{FutureProducer, FutureRecord},
    util::Timeout,
};
use thiserror::Error;

/// Durable Kafka topic names used by the first protocol version.
pub mod topics {
    /// Commands entering a market shard.
    pub const COMMANDS: &str = "matchplane.commands.v1";
    /// Authoritative domain facts.
    pub const DOMAIN_EVENTS: &str = "matchplane.domain-events.v1";
    /// Rebuildable order-book deltas.
    pub const ORDER_BOOK_DELTAS: &str = "matchplane.order-book-deltas.v1";
    /// Rebuildable market summaries.
    pub const MARKET_SUMMARIES: &str = "matchplane.market-summaries.v1";
    /// Federation health facts.
    pub const NODE_HEALTH: &str = "matchplane.node-health.v1";
}

/// Kafka adapter failures.
#[derive(Debug, Error)]
pub enum EventTransportError {
    /// Kafka client construction or operation failed.
    #[error("Kafka operation failed: {0}")]
    Kafka(#[from] KafkaError),
    /// Delivery did not complete before the configured timeout.
    #[error("Kafka delivery failed: {0}")]
    Delivery(String),
}

/// Stable Kafka record coordinates used for retries and durable incident records.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KafkaRecordLocation {
    /// Source topic.
    pub topic: String,
    /// Source partition.
    pub partition: i32,
    /// Source offset.
    pub offset: i64,
}

impl KafkaRecordLocation {
    /// Captures the coordinates of one borrowed Kafka record.
    #[must_use]
    pub fn from_message(message: &BorrowedMessage<'_>) -> Self {
        Self {
            topic: message.topic().to_owned(),
            partition: message.partition(),
            offset: message.offset(),
        }
    }

    fn partition_key(&self) -> KafkaPartition {
        KafkaPartition {
            topic: self.topic.clone(),
            partition: self.partition,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct KafkaPartition {
    topic: String,
    partition: i32,
}

#[derive(Debug, Clone)]
struct RetryState {
    location: KafkaRecordLocation,
    attempts: u32,
    resume_at: Option<Instant>,
}

/// One partition-local retry decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduledRetry {
    /// Number of failures observed for the current offset.
    pub attempts: u32,
    /// Capped exponential delay before seeking back to the failed offset.
    pub delay: Duration,
}

/// Keeps poison or transient failures from restarting an entire Kafka consumer.
///
/// A transient failure pauses only its partition, then seeks back to the failed offset after a
/// capped exponential delay. A permanent failure remains paused until an explicit terminal policy
/// has durably handled the record. Offsets are never advanced by this controller.
#[derive(Debug)]
pub struct PartitionFailureController {
    retrying: HashMap<KafkaPartition, RetryState>,
    blocked: HashSet<KafkaPartition>,
    initial_backoff: Duration,
    max_backoff: Duration,
}

impl Default for PartitionFailureController {
    fn default() -> Self {
        Self::new(Duration::from_secs(1), Duration::from_secs(30))
    }
}

impl PartitionFailureController {
    /// Creates a controller with explicit retry bounds.
    ///
    /// Zero durations are raised to one millisecond so a dependency outage cannot create a hot
    /// loop.
    #[must_use]
    pub fn new(initial_backoff: Duration, max_backoff: Duration) -> Self {
        let floor = Duration::from_millis(1);
        let initial_backoff = initial_backoff.max(floor);
        let max_backoff = max_backoff.max(initial_backoff);
        Self {
            retrying: HashMap::new(),
            blocked: HashSet::new(),
            initial_backoff,
            max_backoff,
        }
    }

    /// Returns whether this partition is already paused for a failed earlier offset.
    #[must_use]
    pub fn should_defer(&self, message: &BorrowedMessage<'_>) -> bool {
        let partition = KafkaPartition {
            topic: message.topic().to_owned(),
            partition: message.partition(),
        };
        self.retrying
            .get(&partition)
            .is_some_and(|state| state.resume_at.is_some())
            || self.blocked.contains(&partition)
    }

    /// Pauses a transiently failing partition and schedules the failed offset for redelivery.
    ///
    /// # Errors
    ///
    /// Returns [`EventTransportError`] when librdkafka cannot pause the partition.
    pub fn retry_later(
        &mut self,
        consumer: &StreamConsumer,
        message: &BorrowedMessage<'_>,
    ) -> Result<ScheduledRetry, EventTransportError> {
        let location = KafkaRecordLocation::from_message(message);
        pause_partition(consumer, &location)?;
        Ok(self.register_retry(location, Instant::now()))
    }

    /// Permanently pauses one partition after its record has been durably quarantined.
    ///
    /// This method deliberately provides no implicit resume operation. The service must first
    /// apply and audit an explicit terminal policy, then restart or use an operator repair path.
    ///
    /// # Errors
    ///
    /// Returns [`EventTransportError`] when librdkafka cannot pause the partition.
    pub fn block(
        &mut self,
        consumer: &StreamConsumer,
        message: &BorrowedMessage<'_>,
    ) -> Result<(), EventTransportError> {
        let location = KafkaRecordLocation::from_message(message);
        pause_partition(consumer, &location)?;
        let partition = location.partition_key();
        self.retrying.remove(&partition);
        self.blocked.insert(partition);
        Ok(())
    }

    /// Lists retries whose delay has elapsed.
    #[must_use]
    pub fn due_retries(&self) -> Vec<KafkaRecordLocation> {
        let now = Instant::now();
        self.retrying
            .values()
            .filter(|state| state.resume_at.is_some_and(|resume_at| resume_at <= now))
            .map(|state| state.location.clone())
            .collect()
    }

    /// Seeks a paused partition back to its failed offset and resumes it.
    ///
    /// A failed seek or resume leaves the retry registered for a later timer tick.
    ///
    /// # Errors
    ///
    /// Returns [`EventTransportError`] when librdkafka cannot seek or resume the partition.
    pub fn resume_retry(
        &mut self,
        consumer: &StreamConsumer,
        location: &KafkaRecordLocation,
    ) -> Result<(), EventTransportError> {
        let result = (|| {
            consumer.seek(
                &location.topic,
                location.partition,
                Offset::Offset(location.offset),
                Duration::from_secs(1),
            )?;
            resume_partition(consumer, location)
        })();
        let partition = location.partition_key();
        if let Err(error) = result {
            if let Some(state) = self.retrying.get_mut(&partition) {
                state.resume_at = Some(Instant::now() + self.initial_backoff);
            }
            return Err(error);
        }
        self.mark_resumed(location);
        Ok(())
    }

    /// Clears retry history only after the failed offset has committed successfully.
    pub fn complete(&mut self, message: &BorrowedMessage<'_>) {
        let location = KafkaRecordLocation::from_message(message);
        let partition = location.partition_key();
        if self
            .retrying
            .get(&partition)
            .is_some_and(|state| state.location.offset == location.offset)
        {
            self.retrying.remove(&partition);
        }
    }

    fn mark_resumed(&mut self, location: &KafkaRecordLocation) {
        if let Some(state) = self.retrying.get_mut(&location.partition_key())
            && state.location.offset == location.offset
        {
            state.resume_at = None;
        }
    }

    fn register_retry(&mut self, location: KafkaRecordLocation, now: Instant) -> ScheduledRetry {
        let partition = location.partition_key();
        self.blocked.remove(&partition);
        let attempts = self
            .retrying
            .get(&partition)
            .filter(|state| state.location.offset == location.offset)
            .map_or(1, |state| state.attempts.saturating_add(1));
        let delay = retry_delay(self.initial_backoff, self.max_backoff, attempts, &location);
        self.retrying.insert(
            partition,
            RetryState {
                location,
                attempts,
                resume_at: Some(now + delay),
            },
        );
        ScheduledRetry { attempts, delay }
    }
}

fn retry_delay(
    initial: Duration,
    maximum: Duration,
    attempts: u32,
    location: &KafkaRecordLocation,
) -> Duration {
    let shift = attempts.saturating_sub(1).min(16);
    let multiplier = 1_u32 << shift;
    let base = initial.saturating_mul(multiplier).min(maximum);
    let seed = location.offset.unsigned_abs()
        ^ u64::from(location.partition.unsigned_abs())
        ^ u64::from(attempts).wrapping_mul(0x9e37_79b9);
    let jitter = Duration::from_millis(seed % 251);
    base.saturating_add(jitter).min(maximum)
}

fn partition_list(location: &KafkaRecordLocation) -> TopicPartitionList {
    let mut partitions = TopicPartitionList::new();
    partitions.add_partition(&location.topic, location.partition);
    partitions
}

fn pause_partition(
    consumer: &StreamConsumer,
    location: &KafkaRecordLocation,
) -> Result<(), EventTransportError> {
    consumer.pause(&partition_list(location))?;
    Ok(())
}

fn resume_partition(
    consumer: &StreamConsumer,
    location: &KafkaRecordLocation,
) -> Result<(), EventTransportError> {
    consumer.resume(&partition_list(location))?;
    Ok(())
}

/// TLS settings shared by MatchPlane's Kafka producers and consumers.
///
/// Development and the explicitly loopback-only test profile may use `PLAINTEXT`. Production
/// callers must provide a verified mTLS profile through `matchplane-config`.
#[derive(Debug, Clone, Default)]
pub struct KafkaSecurityConfig {
    /// librdkafka security protocol, normally `PLAINTEXT` or `SSL`.
    pub protocol: String,
    /// CA bundle used to verify the broker certificate.
    pub ca_location: Option<String>,
    /// Client certificate used for broker mTLS authentication.
    pub certificate_location: Option<String>,
    /// Client private key used for broker mTLS authentication.
    pub key_location: Option<String>,
}

impl KafkaSecurityConfig {
    fn apply(&self, config: &mut ClientConfig) {
        if !self.protocol.is_empty() {
            config.set("security.protocol", &self.protocol);
        }
        if let Some(value) = self.ca_location.as_deref() {
            config.set("ssl.ca.location", value);
        }
        if let Some(value) = self.certificate_location.as_deref() {
            config.set("ssl.certificate.location", value);
        }
        if let Some(value) = self.key_location.as_deref() {
            config.set("ssl.key.location", value);
        }
    }
}

/// Idempotency-friendly producer used by the outbox relay.
#[derive(Clone)]
pub struct KafkaPublisher {
    producer: FutureProducer,
    delivery_timeout: Duration,
}

impl std::fmt::Debug for KafkaPublisher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KafkaPublisher")
            .field("delivery_timeout", &self.delivery_timeout)
            .finish_non_exhaustive()
    }
}

impl KafkaPublisher {
    /// Creates a producer with idempotent broker delivery enabled.
    ///
    /// This does not turn database-to-Kafka publication into exactly-once delivery; the outbox and
    /// consumer inbox remain the correctness mechanisms.
    ///
    /// # Errors
    ///
    /// Returns [`EventTransportError`] when librdkafka rejects the configuration.
    pub fn new(
        brokers: &str,
        client_id: &str,
        security: &KafkaSecurityConfig,
    ) -> Result<Self, EventTransportError> {
        let mut config = ClientConfig::new();
        config
            .set("bootstrap.servers", brokers)
            .set("client.id", client_id)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("message.timeout.ms", "30000");
        security.apply(&mut config);
        let producer = config.create()?;
        Ok(Self {
            producer,
            delivery_timeout: Duration::from_secs(30),
        })
    }

    /// Publishes bytes using the market ID as the Kafka key.
    ///
    /// # Errors
    ///
    /// Returns [`EventTransportError`] when Kafka rejects or times out the record.
    pub async fn publish(
        &self,
        topic: &str,
        market_key: &str,
        payload: &[u8],
    ) -> Result<(), EventTransportError> {
        self.producer
            .send(
                FutureRecord::to(topic).key(market_key).payload(payload),
                Timeout::After(self.delivery_timeout),
            )
            .await
            .map_err(|(error, _)| EventTransportError::Delivery(error.to_string()))?;
        Ok(())
    }
}

/// Creates a stream consumer with automatic offset commits disabled.
///
/// # Errors
///
/// Returns [`EventTransportError`] when construction or subscription fails.
pub fn consumer(
    brokers: &str,
    group_id: &str,
    client_id: &str,
    subscriptions: &[&str],
    security: &KafkaSecurityConfig,
) -> Result<StreamConsumer, EventTransportError> {
    let mut config = ClientConfig::new();
    config
        .set("bootstrap.servers", brokers)
        .set("group.id", group_id)
        .set("client.id", client_id)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "earliest");
    security.apply(&mut config);
    let consumer: StreamConsumer = config.create()?;
    consumer.subscribe(subscriptions)?;
    Ok(consumer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_librdkafka_accepts_ssl_protocol() {
        let result = KafkaPublisher::new(
            "localhost:9092",
            "matchplane-events-tls-feature-test",
            &KafkaSecurityConfig {
                protocol: "SSL".to_owned(),
                ..KafkaSecurityConfig::default()
            },
        );

        assert!(result.is_ok(), "SSL Kafka client failed: {result:?}");
    }

    #[test]
    fn retry_backoff_should_grow_cap_and_reset_for_a_new_offset() {
        let mut controller =
            PartitionFailureController::new(Duration::from_secs(1), Duration::from_secs(4));
        let first_location = KafkaRecordLocation {
            topic: topics::COMMANDS.to_owned(),
            partition: 2,
            offset: 17,
        };
        let now = Instant::now();

        let first = controller.register_retry(first_location.clone(), now);
        let second = controller.register_retry(first_location.clone(), now);
        let third = controller.register_retry(first_location, now);
        let reset = controller.register_retry(
            KafkaRecordLocation {
                topic: topics::COMMANDS.to_owned(),
                partition: 2,
                offset: 18,
            },
            now,
        );

        assert_eq!(first.attempts, 1);
        assert_eq!(second.attempts, 2);
        assert_eq!(third.attempts, 3);
        assert!(first.delay >= Duration::from_secs(1));
        assert!(second.delay >= Duration::from_secs(2));
        assert_eq!(third.delay, Duration::from_secs(4));
        assert_eq!(reset.attempts, 1);
    }

    #[test]
    fn retry_backoff_should_survive_resume_until_the_offset_commits() {
        let mut controller =
            PartitionFailureController::new(Duration::from_secs(1), Duration::from_secs(8));
        let location = KafkaRecordLocation {
            topic: topics::COMMANDS.to_owned(),
            partition: 1,
            offset: 42,
        };
        let first = controller.register_retry(location.clone(), Instant::now());
        controller.mark_resumed(&location);
        let second = controller.register_retry(location, Instant::now());

        assert_eq!(first.attempts, 1);
        assert_eq!(second.attempts, 2);
        assert!(second.delay >= Duration::from_secs(2));
    }

    #[test]
    fn retry_configuration_should_prevent_zero_delay_hot_loops() {
        let mut controller = PartitionFailureController::new(Duration::ZERO, Duration::ZERO);
        let retry = controller.register_retry(
            KafkaRecordLocation {
                topic: topics::ORDER_BOOK_DELTAS.to_owned(),
                partition: 0,
                offset: 0,
            },
            Instant::now(),
        );

        assert!(retry.delay >= Duration::from_millis(1));
    }
}
