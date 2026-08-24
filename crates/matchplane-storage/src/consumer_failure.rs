use matchplane_events::KafkaRecordLocation;
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{PgStore, StorageError};

/// Stable classification for a permanently failing Kafka record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KafkaFailureClass {
    /// Bytes could not be decoded as the subscribed protocol.
    InvalidPayload,
    /// A decoded envelope violated topic, key, version, or identity invariants.
    ProtocolViolation,
    /// Deterministic processing still failed after canonical-state recovery.
    ProcessingInvariant,
}

impl KafkaFailureClass {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPayload => "invalid_payload",
            Self::ProtocolViolation => "protocol_violation",
            Self::ProcessingInvariant => "processing_invariant",
        }
    }
}

/// Explicit terminal policy recorded before a poisoned offset may advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KafkaFailureDisposition {
    /// The partition remains paused and its source offset remains uncommitted.
    Blocked,
    /// PostgreSQL canonical state was replayed before the source offset was committed.
    Reconciled,
    /// The record was proven not to originate from MatchPlane's authoritative outbox.
    DiscardedNonAuthoritative,
}

impl KafkaFailureDisposition {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Reconciled => "reconciled",
            Self::DiscardedNonAuthoritative => "discarded_non_authoritative",
        }
    }
}

/// Borrowed record data persisted for operator inspection and replay evidence.
#[derive(Debug, Clone, Copy)]
pub struct QuarantineKafkaRecord<'a> {
    /// Stable consumer group or logical consumer name.
    pub consumer_name: &'a str,
    /// Immutable source topic, partition, and offset.
    pub location: &'a KafkaRecordLocation,
    /// Original Kafka key, when present. Persistence retains only a bounded prefix plus its hash.
    pub message_key: Option<&'a [u8]>,
    /// Original Kafka payload, when present. Persistence retains only a bounded prefix plus its hash.
    pub payload: Option<&'a [u8]>,
    /// Permanent failure class.
    pub failure_class: KafkaFailureClass,
    /// Secret-free bounded diagnostic suitable for an operator.
    pub error_message: &'a str,
    /// Audited terminal policy. `Blocked` never permits an offset commit.
    pub disposition: KafkaFailureDisposition,
}

/// Durable identity and current disposition of one quarantined Kafka offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuarantinedKafkaRecord {
    /// Stable quarantine UUID.
    pub id: Uuid,
    /// Current terminal or blocked disposition.
    pub disposition: String,
}

impl PgStore {
    /// Durably records a poisoned Kafka offset before any terminal offset commit.
    ///
    /// Re-observing the same immutable record increments its sighting count. A terminal disposition
    /// may resolve a previously blocked row, but a later retry cannot regress a resolved audit row.
    /// Reuse of the same topic/partition/offset with different bytes is rejected as corruption.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for invalid metadata, PostgreSQL failures, or immutable-offset
    /// conflicts.
    pub async fn quarantine_kafka_record(
        &self,
        record: QuarantineKafkaRecord<'_>,
    ) -> Result<QuarantinedKafkaRecord, StorageError> {
        validate_record(&record)?;
        let message_key_present = record.message_key.is_some();
        let message_key: Option<&[u8]> = None;
        let message_key_truncated = record.message_key.is_some_and(|value| !value.is_empty());
        let message_key_hash = Sha256::digest(record.message_key.unwrap_or_default()).to_vec();
        let payload_present = record.payload.is_some();
        let payload: Option<&[u8]> = None;
        let payload_truncated = record.payload.is_some_and(|value| !value.is_empty());
        let payload_hash = Sha256::digest(record.payload.unwrap_or_default()).to_vec();
        let error_message = bounded_error(record.error_message);
        sqlx::query(
            "DELETE FROM kafka_consumer_quarantine
              WHERE consumer_name = $1
                AND resolved_at IS NOT NULL
                AND expires_at < clock_timestamp()",
        )
        .bind(record.consumer_name)
        .execute(self.pool())
        .await?;
        let row = sqlx::query(
            r#"INSERT INTO kafka_consumer_quarantine (
                   id, consumer_name, source_topic, source_partition, source_offset, message_key,
                   message_key_present, message_key_truncated, message_key_sha256, payload,
                   payload_present, payload_truncated, payload_sha256, failure_class, error_message,
                   disposition, resolved_at, expires_at
               ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                   CASE WHEN $16 = 'blocked' THEN NULL ELSE clock_timestamp() END,
                   CASE WHEN $16 = 'blocked' THEN NULL
                        ELSE clock_timestamp() + interval '30 days' END
               )
               ON CONFLICT (consumer_name, source_topic, source_partition, source_offset)
               DO UPDATE SET
                   sightings = kafka_consumer_quarantine.sightings + 1,
                   last_seen_at = clock_timestamp(),
                   failure_class = EXCLUDED.failure_class,
                   error_message = EXCLUDED.error_message,
                   disposition = CASE
                       WHEN kafka_consumer_quarantine.disposition = 'blocked'
                       THEN EXCLUDED.disposition
                       ELSE kafka_consumer_quarantine.disposition
                   END,
                   resolved_at = CASE
                       WHEN kafka_consumer_quarantine.disposition = 'blocked'
                            AND EXCLUDED.disposition <> 'blocked'
                       THEN clock_timestamp()
                       ELSE kafka_consumer_quarantine.resolved_at
                   END,
                   expires_at = CASE
                       WHEN kafka_consumer_quarantine.disposition = 'blocked'
                            AND EXCLUDED.disposition <> 'blocked'
                       THEN clock_timestamp() + interval '30 days'
                       ELSE kafka_consumer_quarantine.expires_at
                   END
               WHERE kafka_consumer_quarantine.payload_sha256 = EXCLUDED.payload_sha256
                 AND kafka_consumer_quarantine.payload_present = EXCLUDED.payload_present
                 AND kafka_consumer_quarantine.message_key_sha256 = EXCLUDED.message_key_sha256
                 AND kafka_consumer_quarantine.message_key_present = EXCLUDED.message_key_present
               RETURNING id, disposition"#,
        )
        .bind(Uuid::now_v7())
        .bind(record.consumer_name)
        .bind(&record.location.topic)
        .bind(record.location.partition)
        .bind(record.location.offset)
        .bind(message_key)
        .bind(message_key_present)
        .bind(message_key_truncated)
        .bind(message_key_hash)
        .bind(payload)
        .bind(payload_present)
        .bind(payload_truncated)
        .bind(payload_hash)
        .bind(record.failure_class.as_str())
        .bind(error_message)
        .bind(record.disposition.as_str())
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| {
            StorageError::Conflict(
                "Kafka source offset was reused with a different key or payload".to_owned(),
            )
        })?;
        Ok(QuarantinedKafkaRecord {
            id: row.try_get("id")?,
            disposition: row.try_get("disposition")?,
        })
    }
}

fn validate_record(record: &QuarantineKafkaRecord<'_>) -> Result<(), StorageError> {
    if record.consumer_name.is_empty() || record.consumer_name.len() > 128 {
        return Err(StorageError::InvalidData(
            "Kafka consumer name length must be in 1..=128".to_owned(),
        ));
    }
    if record.location.topic.is_empty() || record.location.topic.len() > 249 {
        return Err(StorageError::InvalidData(
            "Kafka topic length must be in 1..=249".to_owned(),
        ));
    }
    if record.location.partition < 0 || record.location.offset < 0 {
        return Err(StorageError::InvalidData(
            "Kafka partition and offset must be non-negative".to_owned(),
        ));
    }
    if record.error_message.trim().is_empty() {
        return Err(StorageError::InvalidData(
            "Kafka quarantine error must not be empty".to_owned(),
        ));
    }
    Ok(())
}

fn bounded_error(error: &str) -> &str {
    const MAX_BYTES: usize = 2000;
    if error.len() <= MAX_BYTES {
        return error;
    }
    let mut end = MAX_BYTES;
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    &error[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_error_should_preserve_utf8_boundaries() {
        let error = "坏".repeat(1000);
        let bounded = bounded_error(&error);

        assert!(bounded.len() <= 2000);
        assert!(bounded.chars().all(|character| character == '坏'));
    }

    #[test]
    fn invalid_record_coordinates_should_be_rejected() {
        let location = KafkaRecordLocation {
            topic: "topic".to_owned(),
            partition: -1,
            offset: 0,
        };
        let record = QuarantineKafkaRecord {
            consumer_name: "consumer",
            location: &location,
            message_key: None,
            payload: None,
            failure_class: KafkaFailureClass::InvalidPayload,
            error_message: "invalid payload",
            disposition: KafkaFailureDisposition::Blocked,
        };

        assert!(matches!(
            validate_record(&record),
            Err(StorageError::InvalidData(_))
        ));
    }
}
