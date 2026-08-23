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
}
