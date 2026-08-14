//! At-least-once Kafka transport for transactional outbox messages.

use std::time::Duration;

use rdkafka::{
    ClientConfig,
    consumer::{Consumer, StreamConsumer},
    error::KafkaError,
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
    pub fn new(brokers: &str, client_id: &str) -> Result<Self, EventTransportError> {
        let producer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("client.id", client_id)
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("message.timeout.ms", "30000")
            .create()?;
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
) -> Result<StreamConsumer, EventTransportError> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", brokers)
        .set("group.id", group_id)
        .set("client.id", client_id)
        .set("enable.auto.commit", "false")
        .set("enable.auto.offset.store", "false")
        .set("auto.offset.reset", "earliest")
        .create()?;
    consumer.subscribe(subscriptions)?;
    Ok(consumer)
}
