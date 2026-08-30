use matchplane_domain::EventId;
use sqlx::Row;
use uuid::Uuid;

use crate::{OutboxMessage, PgStore, StorageError, orders::positive_u64};

const MAX_DELIVERY_ATTEMPTS: i32 = 12;

impl PgStore {
    /// Claims at most one head-of-line record for each Kafka topic and message key.
    ///
    /// A failed or in-flight predecessor blocks later records for the same key. Stale publishing
    /// claims become eligible again, preserving ordered at-least-once delivery after a relay
    /// crash. Each batch receives a fresh token so a reclaimed stale worker cannot acknowledge or
    /// release the new owner's claim.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot claim the batch or stored sequence data is
    /// invalid.
    pub async fn claim_outbox(&self, limit: i64) -> Result<Vec<OutboxMessage>, StorageError> {
        let claim_token = Uuid::now_v7();
        let rows = sqlx::query(
            "WITH exhausted AS ( \
                 UPDATE outbox_events \
                    SET status = 'failed', claimed_at = NULL, claim_token = NULL, \
                        last_error = COALESCE(last_error, 'delivery claim lease expired after attempt limit') \
                  WHERE status = 'publishing' \
                    AND attempts >= $2 \
                    AND claimed_at < clock_timestamp() - INTERVAL '60 seconds' \
             ), candidates AS ( \
                 SELECT candidate.event_id FROM outbox_events AS candidate \
                 WHERE candidate.available_at <= clock_timestamp() \
                   AND candidate.attempts < $2 \
                   AND (candidate.status IN ('pending', 'failed') \
                        OR (candidate.status = 'publishing' \
                            AND candidate.claimed_at < clock_timestamp() - INTERVAL '60 seconds')) \
                   AND NOT EXISTS ( \
                       SELECT 1 FROM outbox_events AS predecessor \
                       WHERE predecessor.topic = candidate.topic \
                         AND predecessor.message_key = candidate.message_key \
                         AND predecessor.status <> 'published' \
                         AND (predecessor.shard_sequence, predecessor.created_at, predecessor.event_id) \
                             < (candidate.shard_sequence, candidate.created_at, candidate.event_id) \
                   ) \
                 ORDER BY candidate.created_at, candidate.event_id \
                 FOR UPDATE OF candidate SKIP LOCKED LIMIT $1 \
             ) \
             UPDATE outbox_events AS outbox \
             SET status = 'publishing', attempts = attempts + 1, claimed_at = clock_timestamp(), \
                 claim_token = $3, last_error = NULL \
             FROM candidates WHERE outbox.event_id = candidates.event_id \
             RETURNING outbox.event_id, outbox.topic, outbox.message_key, \
                       outbox.shard_sequence, outbox.payload, outbox.attempts, outbox.claim_token",
        )
        .bind(limit.clamp(1, 500))
        .bind(MAX_DELIVERY_ATTEMPTS)
        .bind(claim_token)
        .fetch_all(self.pool())
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(OutboxMessage {
                    event_id: EventId::from_uuid(row.try_get("event_id")?),
                    topic: row.try_get("topic")?,
                    message_key: row.try_get("message_key")?,
                    shard_sequence: positive_u64(row.try_get("shard_sequence")?)?,
                    payload: row.try_get("payload")?,
                    attempts: row.try_get("attempts")?,
                    claim_token: row.try_get("claim_token")?,
                })
            })
            .collect()
    }

    /// Marks a broker-acknowledged outbox record published.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the state transition fails.
    pub async fn mark_outbox_published(
        &self,
        event_id: EventId,
        claim_token: Uuid,
    ) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE outbox_events SET status = 'published', published_at = clock_timestamp(), \
                    claimed_at = NULL, claim_token = NULL, last_error = NULL \
             WHERE event_id = $1 AND status = 'publishing' AND claim_token = $2",
        )
        .bind(event_id.into_uuid())
        .bind(claim_token)
        .execute(self.pool())
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::Conflict(
                "outbox publication acknowledgement lost its claim".to_owned(),
            ));
        }
        Ok(())
    }

    /// Returns a failed outbox record to the retry queue with bounded exponential backoff.
    ///
    /// Once the durable attempt count reaches the delivery limit, the record remains failed but
    /// becomes ineligible for automatic claims. Keeping it unpublished deliberately preserves
    /// per-key ordering: operators can inspect the last error without silently skipping the poison
    /// record and publishing a later sequence.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the transition cannot be persisted.
    pub async fn mark_outbox_failed(
        &self,
        event_id: EventId,
        claim_token: Uuid,
        attempts: i32,
        error: &str,
    ) -> Result<(), StorageError> {
        let exponent = attempts.clamp(1, 10);
        let delay_seconds = 2_i32.pow(u32::try_from(exponent).unwrap_or(10)).min(300);
        let result = sqlx::query(
            "UPDATE outbox_events SET status = 'failed', claimed_at = NULL, claim_token = NULL, \
                    last_error = $3, \
                    available_at = clock_timestamp() + make_interval(secs => $4) \
             WHERE event_id = $1 AND status = 'publishing' AND claim_token = $2",
        )
        .bind(event_id.into_uuid())
        .bind(claim_token)
        .bind(truncate_error(error))
        .bind(f64::from(delay_seconds))
        .execute(self.pool())
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::Conflict(
                "outbox retry transition lost its claim".to_owned(),
            ));
        }
        Ok(())
    }

    /// Counts outbox records that have not yet received a broker acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot answer the query.
    pub async fn pending_outbox_count(&self) -> Result<i64, StorageError> {
        let count =
            sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE status <> 'published'")
                .fetch_one(self.pool())
                .await?;
        Ok(count)
    }
}

fn truncate_error(error: &str) -> String {
    error.chars().take(2_000).collect()
}
