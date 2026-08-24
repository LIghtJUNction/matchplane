use crate::{PgStore, StorageError, bounded_operator_text};
use serde::Serialize;
use serde_json::json;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

/// Secret-free aggregate state for the child catalog projection relay.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogProjectionStatus {
    /// Time at which PostgreSQL produced this report.
    #[serde(with = "time::serde::rfc3339")]
    pub generated_at: OffsetDateTime,
    /// Job counts by durable state.
    pub counts: CatalogProjectionCounts,
    /// Age of the oldest pending, retrying, or leased job.
    pub oldest_actionable_age_seconds: Option<i64>,
    /// Age of the oldest dead-lettered job.
    pub oldest_dead_age_seconds: Option<i64>,
    /// Bounded recent problem rows; canonical payloads and endpoint credentials are never stored.
    pub problems: Vec<CatalogProjectionProblem>,
}

/// Durable state counts for projection jobs.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogProjectionCounts {
    pub pending: i64,
    pub processing: i64,
    pub retry: i64,
    pub acked: i64,
    pub superseded: i64,
    pub dead: i64,
}

/// One bounded projection problem suitable for host operators and read-only MCP.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogProjectionProblem {
    pub job_id: Uuid,
    pub tenant_id: Uuid,
    pub domain_id: Uuid,
    pub store_id: Uuid,
    pub offer_id: Uuid,
    pub canonical_version: i64,
    pub registration_id: Option<Uuid>,
    pub platform_path: Option<String>,
    pub mcp_server_key: Option<String>,
    pub status: String,
    pub attempts: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub next_attempt_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub lease_expires_at: Option<OffsetDateTime>,
    pub last_error_code: Option<String>,
    pub last_error: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// Result of an explicit host-operator replay.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogProjectionReplayOutcome {
    pub requested_job_id: Uuid,
    pub replay_job_id: Uuid,
    pub replay_status: String,
    pub reused_request_id: bool,
    pub canonical_version: i64,
    pub registration_id: Uuid,
    pub platform_path: String,
    pub mcp_server_key: String,
    pub operator_request_id: String,
}

impl PgStore {
    /// Returns a bounded, secret-free projection relay report.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot read the durable job ledger.
    pub async fn catalog_projection_status(
        &self,
        problem_limit: u32,
    ) -> Result<CatalogProjectionStatus, StorageError> {
        let aggregate = sqlx::query(
            "SELECT clock_timestamp() AS generated_at,
                    count(*) FILTER (WHERE status = 'pending')::bigint AS pending,
                    count(*) FILTER (WHERE status = 'processing')::bigint AS processing,
                    count(*) FILTER (WHERE status = 'retry')::bigint AS retry,
                    count(*) FILTER (WHERE status = 'acked')::bigint AS acked,
                    count(*) FILTER (WHERE status = 'superseded')::bigint AS superseded,
                    count(*) FILTER (WHERE status = 'dead')::bigint AS dead,
                    extract(epoch FROM (
                      clock_timestamp() - min(created_at) FILTER (
                        WHERE status IN ('pending', 'processing', 'retry')
                      )
                    ))::bigint AS oldest_actionable_age_seconds,
                    extract(epoch FROM (
                      clock_timestamp() - min(updated_at) FILTER (WHERE status = 'dead')
                    ))::bigint AS oldest_dead_age_seconds
               FROM marketplace_offer_projection_jobs",
        )
        .fetch_one(self.pool())
        .await?;
        let problem_rows = sqlx::query(
            "SELECT id,
                    tenant_id,
                    domain_id,
                    store_id,
                    offer_id,
                    canonical_version,
                    registration_id,
                    platform_path,
                    mcp_server_key,
                    status,
                    attempts,
                    next_attempt_at,
                    lease_expires_at,
                    last_error_code,
                    last_error,
                    updated_at
               FROM marketplace_offer_projection_jobs
              WHERE status IN ('processing', 'retry', 'dead')
              ORDER BY CASE status WHEN 'dead' THEN 0 WHEN 'retry' THEN 1 ELSE 2 END,
                       updated_at DESC
              LIMIT $1",
        )
        .bind(i64::from(problem_limit.clamp(1, 100)))
        .fetch_all(self.pool())
        .await?;
        Ok(CatalogProjectionStatus {
            generated_at: aggregate.try_get("generated_at")?,
            counts: CatalogProjectionCounts {
                pending: aggregate.try_get("pending")?,
                processing: aggregate.try_get("processing")?,
                retry: aggregate.try_get("retry")?,
                acked: aggregate.try_get("acked")?,
                superseded: aggregate.try_get("superseded")?,
                dead: aggregate.try_get("dead")?,
            },
            oldest_actionable_age_seconds: aggregate.try_get("oldest_actionable_age_seconds")?,
            oldest_dead_age_seconds: aggregate.try_get("oldest_dead_age_seconds")?,
            problems: problem_rows
                .iter()
                .map(catalog_projection_problem_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }

    /// Replays exactly one dead-lettered job against the current canonical offer/destination.
    ///
    /// If the offer version or active registration changed, the dead job is superseded and a new
    /// destination-bound job is created. The original request id is reused only when the durable
    /// destination is unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Conflict`] unless the requested row is dead and the current store
    /// has an active `catalog.upsert` destination.
    pub async fn replay_catalog_projection_job(
        &self,
        job_id: Uuid,
        operator_request_id: &str,
        reason: &str,
    ) -> Result<CatalogProjectionReplayOutcome, StorageError> {
        let operator_request_id = bounded_operator_text(operator_request_id, 200, "request id")?;
        let reason = bounded_operator_text(reason, 200, "replay reason")?;
        let mut transaction = self.pool().begin().await?;
        let dead = sqlx::query(
            "SELECT id,
                    tenant_id,
                    domain_id,
                    store_id,
                    offer_id,
                    canonical_version,
                    registration_id,
                    platform_path,
                    mcp_server_key,
                    request_id
               FROM marketplace_offer_projection_jobs
              WHERE id = $1
                AND status = 'dead'
              FOR UPDATE",
        )
        .bind(job_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Conflict("catalog projection job is not dead-lettered".to_owned())
        })?;
        let tenant_id: Uuid = dead.try_get("tenant_id")?;
        let domain_id: Uuid = dead.try_get("domain_id")?;
        let store_id: Uuid = dead.try_get("store_id")?;
        let offer_id: Uuid = dead.try_get("offer_id")?;
        let destination = sqlx::query(
            r#"SELECT offer.version AS canonical_version,
                    registration.id AS registration_id,
                    alias.path AS platform_path,
                    COALESCE(
                      NULLIF(registration.manifest -> 'agent' ->> 'mcpServerKey', ''),
                      registration.slug
                    ) AS mcp_server_key
               FROM marketplace_offers offer
               JOIN stores store
                 ON store.tenant_id = offer.tenant_id
                AND store.domain_id = offer.domain_id
                AND store.id = offer.store_id
               JOIN store_path_aliases alias
                 ON alias.tenant_id = store.tenant_id
                AND alias.store_id = store.id
                AND alias.is_canonical
               JOIN subplatform_registrations registration
                 ON registration.id = store.current_registration_id
                AND registration.tenant_id = store.tenant_id
                AND registration.domain_id = store.domain_id
                AND registration.state = 'active'
              WHERE offer.tenant_id = $1
                AND offer.domain_id = $2
                AND offer.store_id = $3
                AND offer.id = $4
                AND store.status = 'active'
                AND store.integration_kind <> 'hosted'
                AND registration.manifest @>
                    '{"agent":{"mcpTools":["catalog.upsert"]}}'::jsonb
              LIMIT 1"#,
        )
        .bind(tenant_id)
        .bind(domain_id)
        .bind(store_id)
        .bind(offer_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Conflict(
                "canonical offer has no active catalog projection destination".to_owned(),
            )
        })?;
        let canonical_version: i64 = destination.try_get("canonical_version")?;
        let registration_id: Uuid = destination.try_get("registration_id")?;
        let platform_path: String = destination.try_get("platform_path")?;
        let mcp_server_key: String = destination.try_get("mcp_server_key")?;
        let same_destination = dead.try_get::<i64, _>("canonical_version")? == canonical_version
            && dead.try_get::<Option<Uuid>, _>("registration_id")? == Some(registration_id)
            && dead
                .try_get::<Option<String>, _>("platform_path")?
                .as_deref()
                == Some(platform_path.as_str())
            && dead
                .try_get::<Option<String>, _>("mcp_server_key")?
                .as_deref()
                == Some(mcp_server_key.as_str());
        let (replay_job_id, replay_status, replay_request_id): (Uuid, String, Uuid) =
            if same_destination {
                let replay = sqlx::query(
                    "UPDATE marketplace_offer_projection_jobs
                    SET status = 'retry',
                        attempts = 0,
                        next_attempt_at = clock_timestamp(),
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        last_error_code = NULL,
                        last_error = NULL,
                        acked_at = NULL,
                        updated_at = clock_timestamp()
                  WHERE id = $1
                  RETURNING id, status, request_id",
                )
                .bind(job_id)
                .fetch_one(&mut *transaction)
                .await?;
                (
                    replay.try_get("id")?,
                    replay.try_get("status")?,
                    replay.try_get("request_id")?,
                )
            } else {
                sqlx::query(
                    "UPDATE marketplace_offer_projection_jobs
                    SET status = 'superseded',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        last_error_code = NULL,
                        last_error = NULL,
                        acked_at = NULL,
                        updated_at = clock_timestamp()
                  WHERE id = $1",
                )
                .bind(job_id)
                .execute(&mut *transaction)
                .await?;
                let replay = sqlx::query(
                    "INSERT INTO marketplace_offer_projection_jobs (
                   tenant_id,
                   domain_id,
                   store_id,
                   offer_id,
                   canonical_version,
                   registration_id,
                   platform_path,
                   mcp_server_key
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (tenant_id, offer_id, canonical_version, registration_id)
                 DO UPDATE SET
                   status = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN 'retry'
                     ELSE marketplace_offer_projection_jobs.status
                   END,
                   attempts = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN 0
                     ELSE marketplace_offer_projection_jobs.attempts
                   END,
                   next_attempt_at = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN clock_timestamp()
                     ELSE marketplace_offer_projection_jobs.next_attempt_at
                   END,
                   lease_owner = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN NULL
                     ELSE marketplace_offer_projection_jobs.lease_owner
                   END,
                   lease_expires_at = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN NULL
                     ELSE marketplace_offer_projection_jobs.lease_expires_at
                   END,
                   last_error_code = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN NULL
                     ELSE marketplace_offer_projection_jobs.last_error_code
                   END,
                   last_error = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN NULL
                     ELSE marketplace_offer_projection_jobs.last_error
                   END,
                   acked_at = CASE
                     WHEN marketplace_offer_projection_jobs.status IN ('dead', 'superseded')
                     THEN NULL
                     ELSE marketplace_offer_projection_jobs.acked_at
                   END,
                   updated_at = clock_timestamp()
                 RETURNING id, status, request_id",
                )
                .bind(tenant_id)
                .bind(domain_id)
                .bind(store_id)
                .bind(offer_id)
                .bind(canonical_version)
                .bind(registration_id)
                .bind(&platform_path)
                .bind(&mcp_server_key)
                .fetch_one(&mut *transaction)
                .await?;
                (
                    replay.try_get("id")?,
                    replay.try_get("status")?,
                    replay.try_get("request_id")?,
                )
            };
        sqlx::query(
            "INSERT INTO platform_audit_events (
               id,
               tenant_id,
               domain_id,
               platform_path,
               event_type,
               outcome,
               request_id,
               metadata
             ) VALUES ($1, $2, $3, $4, $5, 'success', $6, $7)",
        )
        .bind(Uuid::now_v7())
        .bind(tenant_id)
        .bind(domain_id)
        .bind(&platform_path)
        .bind("marketplace.offer.projection.replayed")
        .bind(&operator_request_id)
        .bind(json!({
            "requested_job_id": job_id,
            "replay_job_id": replay_job_id,
            "reason": reason,
            "host_operator": true
        }))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(CatalogProjectionReplayOutcome {
            requested_job_id: job_id,
            replay_job_id,
            replay_status,
            reused_request_id: replay_request_id == dead.try_get::<Uuid, _>("request_id")?,
            canonical_version,
            registration_id,
            platform_path,
            mcp_server_key,
            operator_request_id,
        })
    }
}

fn catalog_projection_problem_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<CatalogProjectionProblem, sqlx::Error> {
    Ok(CatalogProjectionProblem {
        job_id: row.try_get("id")?,
        tenant_id: row.try_get("tenant_id")?,
        domain_id: row.try_get("domain_id")?,
        store_id: row.try_get("store_id")?,
        offer_id: row.try_get("offer_id")?,
        canonical_version: row.try_get("canonical_version")?,
        registration_id: row.try_get("registration_id")?,
        platform_path: row.try_get("platform_path")?,
        mcp_server_key: row.try_get("mcp_server_key")?,
        status: row.try_get("status")?,
        attempts: row.try_get("attempts")?,
        next_attempt_at: row.try_get("next_attempt_at")?,
        lease_expires_at: row.try_get("lease_expires_at")?,
        last_error_code: row.try_get("last_error_code")?,
        last_error: row.try_get("last_error")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use crate::bounded_operator_text;

    #[test]
    fn replay_reason_must_be_bounded_and_printable() {
        assert_eq!(
            bounded_operator_text("  adapter upgraded  ", 200, "reason").unwrap(),
            "adapter upgraded"
        );
        assert!(bounded_operator_text("", 200, "reason").is_err());
        assert!(bounded_operator_text("unsafe\nreason", 200, "reason").is_err());
        assert!(bounded_operator_text(&"x".repeat(201), 200, "reason").is_err());
    }
}
