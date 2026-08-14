use matchplane_domain::EventId;
use sqlx::Row;

use crate::{OutboxMessage, PgStore, StorageError};

impl PgStore {
    /// Claims an ordered batch of unpublished outbox records using `SKIP LOCKED`.
    ///
    /// Stale publishing claims become eligible again, preserving at-least-once delivery after a
    /// relay crash.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot claim the batch.
    pub async fn claim_outbox(&self, limit: i64) -> Result<Vec<OutboxMessage>, StorageError> {
        let rows = sqlx::query(
            "WITH candidates AS ( \
                 SELECT event_id FROM outbox_events \
                 WHERE available_at <= clock_timestamp() \
                   AND (status IN ('pending', 'failed') \
                        OR (status = 'publishing' AND claimed_at < clock_timestamp() - INTERVAL '60 seconds')) \
                 ORDER BY created_at, event_id \
                 FOR UPDATE SKIP LOCKED LIMIT $1 \
             ) \
             UPDATE outbox_events AS outbox \
             SET status = 'publishing', attempts = attempts + 1, claimed_at = clock_timestamp(), \
                 last_error = NULL \
             FROM candidates WHERE outbox.event_id = candidates.event_id \
             RETURNING outbox.event_id, outbox.topic, outbox.message_key, outbox.payload, outbox.attempts",
        )
        .bind(limit.clamp(1, 500))
        .fetch_all(self.pool())
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(OutboxMessage {
                    event_id: EventId::from_uuid(row.try_get("event_id")?),
                    topic: row.try_get("topic")?,
                    message_key: row.try_get("message_key")?,
                    payload: row.try_get("payload")?,
                    attempts: row.try_get("attempts")?,
                })
            })
            .collect()
    }

    /// Marks a broker-acknowledged outbox record published.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the state transition fails.
    pub async fn mark_outbox_published(&self, event_id: EventId) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE outbox_events SET status = 'published', published_at = clock_timestamp(), \
                    claimed_at = NULL, last_error = NULL \
             WHERE event_id = $1 AND status = 'publishing'",
        )
        .bind(event_id.into_uuid())
        .execute(self.pool())
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::InvalidData(
                "outbox publication acknowledgement lost its claim".to_owned(),
            ));
        }
        Ok(())
    }

    /// Returns a failed outbox record to the retry queue with bounded exponential backoff.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the transition cannot be persisted.
    pub async fn mark_outbox_failed(
        &self,
        event_id: EventId,
        attempts: i32,
        error: &str,
    ) -> Result<(), StorageError> {
        let exponent = attempts.clamp(1, 10);
        let delay_seconds = 2_i32.pow(u32::try_from(exponent).unwrap_or(10)).min(300);
        sqlx::query(
            "UPDATE outbox_events SET status = 'failed', claimed_at = NULL, last_error = $2, \
                    available_at = clock_timestamp() + make_interval(secs => $3) \
             WHERE event_id = $1 AND status = 'publishing'",
        )
        .bind(event_id.into_uuid())
        .bind(truncate_error(error))
        .bind(f64::from(delay_seconds))
        .execute(self.pool())
        .await?;
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
