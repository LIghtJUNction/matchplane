use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgStore, StorageError};

const CLAIM_LEASE_SECONDS: f64 = 60.0;
const MAX_DELIVERY_ATTEMPTS: i32 = 12;
const MAX_NOTIFICATION_TITLE_CHARS: usize = 200;
const MAX_PRODUCT_REFERENCES: usize = 12;
const SUPPORTED_SCHEMA_VERSION: i16 = 1;

/// One lease-protected marketplace conversion job.
#[derive(Debug, Clone)]
pub struct MarketplaceConversionJob {
    /// Conversion outbox identity.
    pub id: Uuid,
    /// Tenant authority scope.
    pub tenant_id: Uuid,
    /// Version of the conversion source contract.
    pub schema_version: i16,
    /// Canonical source table discriminator.
    pub source_type: String,
    /// Canonical source row identity.
    pub source_id: Uuid,
    /// Ordering aggregate discriminator.
    pub aggregate_type: String,
    /// Ordering aggregate identity.
    pub aggregate_id: Uuid,
    /// Monotonic version within the aggregate.
    pub aggregate_version: i64,
    /// Versioned application event name.
    pub event_type: String,
    /// Number of delivery attempts, including this claim.
    pub attempts: i32,
    /// Fencing token for this worker lease.
    pub claim_token: Uuid,
}

/// One atomically claimed conversion batch plus exhausted jobs dead-lettered by the watchdog.
#[derive(Debug, Clone)]
pub struct MarketplaceConversionClaimBatch {
    /// Aggregate-head jobs fenced to this worker claim.
    pub jobs: Vec<MarketplaceConversionJob>,
    /// Attempt-exhausted jobs moved to `dead` before this batch was claimed.
    pub exhausted_dead: u64,
}

/// Durable result of returning one failed projection claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketplaceConversionFailureDisposition {
    /// The job was scheduled for a bounded retry.
    Retry,
    /// The job reached a terminal or unsupported-schema dead letter.
    Dead,
}

/// Failure transition outcome for worker metrics and safe control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketplaceConversionFailureOutcome {
    /// Durable disposition written under the claim token fence.
    pub disposition: MarketplaceConversionFailureDisposition,
    /// Deterministic retry delay, absent for dead letters.
    pub retry_delay_ms: Option<u64>,
}

/// Host-operator action for one dead conversion aggregate head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceConversionRecoveryAction {
    /// Re-read current canonical source state on the next worker claim.
    Replay,
    /// Explicitly skip this event and unblock its aggregate successor.
    Resolve,
}

/// Secret-free result of validating or applying one host recovery action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MarketplaceConversionRecoveryOutcome {
    /// Durable conversion job identity.
    pub job_id: Uuid,
    /// Tenant authority scope.
    pub tenant_id: Uuid,
    /// Ordering aggregate discriminator.
    pub aggregate_type: String,
    /// Ordering aggregate identity.
    pub aggregate_id: Uuid,
    /// Ordered event version.
    pub aggregate_version: i64,
    /// Requested operator action.
    pub action: MarketplaceConversionRecoveryAction,
    /// Whether durable state and audit were committed.
    pub applied: bool,
    /// Status observed under `FOR UPDATE`.
    pub previous_status: String,
    /// Status that was or would be produced.
    pub resulting_status: String,
    /// Number of unresolved aggregate successors currently blocked by this head.
    pub blocked_successors: i64,
    /// Bounded operator request identity.
    pub operator_request_id: String,
}

/// Result of atomically applying one marketplace conversion job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketplaceConversionProjectionOutcome {
    /// Stable opportunity identity, absent for intentionally ignored denied audit events.
    pub opportunity_id: Option<Uuid>,
    /// Number of idempotent in-app notification rows written.
    pub notifications_written: u64,
}

/// Bounded operational summary for conversion projection readiness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketplaceConversionBacklog {
    /// Pending rows eligible now or in the future.
    pub pending: i64,
    /// Rows currently owned by worker leases.
    pub publishing: i64,
    /// Rows waiting for retry backoff.
    pub failed: i64,
    /// Rows requiring explicit operator resolution.
    pub dead: i64,
    /// Age in seconds of the oldest unresolved row.
    pub oldest_unresolved_seconds: Option<i64>,
}

impl PgStore {
    /// Claims aggregate heads while fencing concurrent workers with a renewable lease.
    ///
    /// A failed, in-flight, or dead predecessor blocks later versions of the same aggregate.
    /// Expired publishing leases are recoverable after worker crashes. Resolved rows explicitly
    /// release their successors without pretending that they were published.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot atomically claim the batch.
    pub async fn claim_marketplace_conversion_batch(
        &self,
        limit: i64,
    ) -> Result<MarketplaceConversionClaimBatch, StorageError> {
        let claim_token = Uuid::now_v7();
        let mut transaction = self.pool().begin().await?;
        let exhausted_dead = sqlx::query(
            "UPDATE marketplace_conversion_outbox \
                SET status = 'dead', \
                    claimed_at = NULL, \
                    claim_token = NULL, \
                    claim_expires_at = NULL, \
                    dead_at = clock_timestamp(), \
                    last_error = CASE \
                        WHEN status = 'publishing' \
                            THEN 'worker claim expired after maximum delivery attempts' \
                        ELSE 'worker dead-lettered row at or above maximum delivery attempts' \
                    END \
              WHERE attempts >= $1 \
                AND (status IN ('pending', 'failed') \
                     OR (status = 'publishing' \
                         AND claim_expires_at <= clock_timestamp()))",
        )
        .bind(MAX_DELIVERY_ATTEMPTS)
        .execute(&mut *transaction)
        .await?;

        let rows = sqlx::query(
            "WITH candidates AS ( \
                 SELECT candidate.id \
                   FROM marketplace_conversion_outbox AS candidate \
                  WHERE candidate.available_at <= clock_timestamp() \
                    AND candidate.attempts < $4 \
                    AND (candidate.status IN ('pending', 'failed') \
                         OR (candidate.status = 'publishing' \
                             AND candidate.claim_expires_at <= clock_timestamp())) \
                    AND NOT EXISTS ( \
                        SELECT 1 \
                          FROM marketplace_conversion_outbox AS predecessor \
                         WHERE predecessor.tenant_id = candidate.tenant_id \
                           AND predecessor.aggregate_type = candidate.aggregate_type \
                           AND predecessor.aggregate_id = candidate.aggregate_id \
                           AND predecessor.status NOT IN ('published', 'resolved') \
                           AND (predecessor.aggregate_version, predecessor.created_at, predecessor.id) \
                               < (candidate.aggregate_version, candidate.created_at, candidate.id) \
                    ) \
                  ORDER BY candidate.created_at, candidate.id \
                  FOR UPDATE OF candidate SKIP LOCKED \
                  LIMIT $1 \
             ) \
             UPDATE marketplace_conversion_outbox AS outbox \
                SET status = 'publishing', \
                    attempts = attempts + 1, \
                    claimed_at = clock_timestamp(), \
                    claim_expires_at = clock_timestamp() + make_interval(secs => $3), \
                    claim_token = $2, \
                    last_attempt_at = clock_timestamp(), \
                    last_error = NULL \
               FROM candidates \
              WHERE outbox.id = candidates.id \
             RETURNING outbox.id, outbox.tenant_id, outbox.schema_version, \
                       outbox.source_type, outbox.source_id, outbox.aggregate_type, \
                       outbox.aggregate_id, outbox.aggregate_version, outbox.event_type, \
                       outbox.attempts, outbox.claim_token",
        )
        .bind(limit.clamp(1, 100))
        .bind(claim_token)
        .bind(CLAIM_LEASE_SECONDS)
        .bind(MAX_DELIVERY_ATTEMPTS)
        .fetch_all(&mut *transaction)
        .await?;

        let jobs = rows
            .into_iter()
            .map(|row| {
                Ok(MarketplaceConversionJob {
                    id: row.try_get("id")?,
                    tenant_id: row.try_get("tenant_id")?,
                    schema_version: row.try_get("schema_version")?,
                    source_type: row.try_get("source_type")?,
                    source_id: row.try_get("source_id")?,
                    aggregate_type: row.try_get("aggregate_type")?,
                    aggregate_id: row.try_get("aggregate_id")?,
                    aggregate_version: row.try_get("aggregate_version")?,
                    event_type: row.try_get("event_type")?,
                    attempts: row.try_get("attempts")?,
                    claim_token: row.try_get("claim_token")?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        transaction.commit().await?;
        Ok(MarketplaceConversionClaimBatch {
            jobs,
            exhausted_dead: exhausted_dead.rows_affected(),
        })
    }

    /// Claims only the jobs from one conversion batch.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot atomically claim the batch.
    pub async fn claim_marketplace_conversions(
        &self,
        limit: i64,
    ) -> Result<Vec<MarketplaceConversionJob>, StorageError> {
        Ok(self.claim_marketplace_conversion_batch(limit).await?.jobs)
    }

    /// Applies one canonical conversion source, CRM projection, notifications, and acknowledgement
    /// in a single PostgreSQL transaction.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the claim is stale, canonical authority cannot be resolved, or
    /// any projection write fails. The caller should return a still-owned claim through
    /// [`PgStore::fail_marketplace_conversion`].
    pub async fn project_marketplace_conversion(
        &self,
        job: &MarketplaceConversionJob,
    ) -> Result<MarketplaceConversionProjectionOutcome, StorageError> {
        let mut transaction = self.pool().begin().await?;
        let source = sqlx::query(
            "UPDATE marketplace_conversion_outbox \
                SET claim_expires_at = clock_timestamp() + make_interval(secs => $3) \
              WHERE id = $1 \
                AND status = 'publishing' \
                AND claim_token = $2 \
             RETURNING tenant_id, schema_version, source_type, source_id, aggregate_type, \
                       aggregate_id, aggregate_version, event_type",
        )
        .bind(job.id)
        .bind(job.claim_token)
        .bind(CLAIM_LEASE_SECONDS)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StorageError::Conflict(
                "marketplace conversion projection lost its worker claim".to_owned(),
            )
        })?;

        let tenant_id: Uuid = source.try_get("tenant_id")?;
        let schema_version: i16 = source.try_get("schema_version")?;
        let source_type: String = source.try_get("source_type")?;
        let source_id: Uuid = source.try_get("source_id")?;
        let aggregate_type: String = source.try_get("aggregate_type")?;
        let aggregate_id: Uuid = source.try_get("aggregate_id")?;
        let aggregate_version: i64 = source.try_get("aggregate_version")?;
        let event_type: String = source.try_get("event_type")?;
        validate_claim_identity(
            job,
            tenant_id,
            schema_version,
            &source_type,
            source_id,
            &aggregate_type,
            aggregate_id,
            aggregate_version,
            &event_type,
        )?;
        if schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(StorageError::InvalidData(format!(
                "unsupported marketplace conversion schema version {schema_version}"
            )));
        }

        let outcome = match source_type.as_str() {
            "introduction_contact_event" => {
                project_contact_event(&mut transaction, tenant_id, source_id, aggregate_version)
                    .await?
            }
            "sales_handoff" => {
                project_sales_handoff(&mut transaction, tenant_id, source_id, aggregate_version)
                    .await?
            }
            other => {
                return Err(StorageError::InvalidData(format!(
                    "unsupported marketplace conversion source type {other}"
                )));
            }
        };

        let published = sqlx::query(
            "UPDATE marketplace_conversion_outbox \
                SET status = 'published', \
                    claimed_at = NULL, \
                    claim_token = NULL, \
                    claim_expires_at = NULL, \
                    published_at = clock_timestamp(), \
                    last_error = NULL \
              WHERE id = $1 AND status = 'publishing' AND claim_token = $2",
        )
        .bind(job.id)
        .bind(job.claim_token)
        .execute(&mut *transaction)
        .await?;
        if published.rows_affected() != 1 {
            return Err(StorageError::Conflict(
                "marketplace conversion acknowledgement lost its worker claim".to_owned(),
            ));
        }
        transaction.commit().await?;
        Ok(outcome)
    }

    /// Returns a failed conversion job to bounded exponential retry or marks it dead.
    ///
    /// Dead aggregate heads continue to block later versions until an operator explicitly marks
    /// the row resolved, preventing silent state gaps.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when this worker no longer owns the claim or PostgreSQL fails.
    pub async fn fail_marketplace_conversion(
        &self,
        job: &MarketplaceConversionJob,
        error: &str,
    ) -> Result<MarketplaceConversionFailureOutcome, StorageError> {
        let retry_delay_ms = deterministic_retry_delay_ms(job.id, job.attempts);
        let status = sqlx::query_scalar::<_, String>(
            "UPDATE marketplace_conversion_outbox \
                SET status = CASE \
                        WHEN attempts >= $4 OR schema_version <> $6 THEN 'dead' \
                        ELSE 'failed' \
                    END, \
                    claimed_at = NULL, \
                    claim_token = NULL, \
                    claim_expires_at = NULL, \
                    dead_at = CASE \
                        WHEN attempts >= $4 OR schema_version <> $6 THEN clock_timestamp() \
                        ELSE NULL \
                    END, \
                    available_at = CASE \
                        WHEN attempts >= $4 OR schema_version <> $6 THEN available_at \
                        ELSE clock_timestamp() + make_interval(secs => $5) \
                    END, \
                    last_error = $3 \
              WHERE id = $1 \
                AND status = 'publishing' \
                AND claim_token = $2 \
                AND attempts = $7 \
             RETURNING status",
        )
        .bind(job.id)
        .bind(job.claim_token)
        .bind(bounded_error(error))
        .bind(MAX_DELIVERY_ATTEMPTS)
        .bind(retry_delay_ms as f64 / 1_000.0)
        .bind(SUPPORTED_SCHEMA_VERSION)
        .bind(job.attempts)
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| {
            StorageError::Conflict(
                "marketplace conversion retry transition lost its worker claim".to_owned(),
            )
        })?;
        match status.as_str() {
            "failed" => Ok(MarketplaceConversionFailureOutcome {
                disposition: MarketplaceConversionFailureDisposition::Retry,
                retry_delay_ms: Some(retry_delay_ms),
            }),
            "dead" => Ok(MarketplaceConversionFailureOutcome {
                disposition: MarketplaceConversionFailureDisposition::Dead,
                retry_delay_ms: None,
            }),
            _ => Err(StorageError::InvalidData(
                "marketplace conversion failure transition returned an invalid status".to_owned(),
            )),
        }
    }

    /// Returns a low-cardinality conversion backlog snapshot for readiness and alerting.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL cannot read the backlog.
    pub async fn marketplace_conversion_backlog(
        &self,
    ) -> Result<MarketplaceConversionBacklog, StorageError> {
        let row = sqlx::query(
            "SELECT count(*) FILTER (WHERE status = 'pending')::bigint AS pending, \
                    count(*) FILTER (WHERE status = 'publishing')::bigint AS publishing, \
                    count(*) FILTER (WHERE status = 'failed')::bigint AS failed, \
                    count(*) FILTER (WHERE status = 'dead')::bigint AS dead, \
                    extract(epoch FROM (clock_timestamp() - min(created_at) \
                        FILTER (WHERE status NOT IN ('published', 'resolved'))))::bigint \
                        AS oldest_unresolved_seconds \
               FROM marketplace_conversion_outbox",
        )
        .fetch_one(self.pool())
        .await?;
        Ok(MarketplaceConversionBacklog {
            pending: row.try_get("pending")?,
            publishing: row.try_get("publishing")?,
            failed: row.try_get("failed")?,
            dead: row.try_get("dead")?,
            oldest_unresolved_seconds: row.try_get("oldest_unresolved_seconds")?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_claim_identity(
    job: &MarketplaceConversionJob,
    tenant_id: Uuid,
    schema_version: i16,
    source_type: &str,
    source_id: Uuid,
    aggregate_type: &str,
    aggregate_id: Uuid,
    aggregate_version: i64,
    event_type: &str,
) -> Result<(), StorageError> {
    if job.tenant_id == tenant_id
        && job.schema_version == schema_version
        && job.source_type == source_type
        && job.source_id == source_id
        && job.aggregate_type == aggregate_type
        && job.aggregate_id == aggregate_id
        && job.aggregate_version == aggregate_version
        && job.event_type == event_type
    {
        return Ok(());
    }
    Err(StorageError::Conflict(
        "marketplace conversion claim identity changed after claim".to_owned(),
    ))
}

async fn already_applied_opportunity(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    source_type: &str,
    source_id: Uuid,
    aggregate_version: i64,
) -> Result<Option<Uuid>, StorageError> {
    let existing = sqlx::query(
        "SELECT id, last_applied_version \
           FROM marketplace_sales_opportunities \
          WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3 \
          FOR UPDATE",
    )
    .bind(tenant_id)
    .bind(source_type)
    .bind(source_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(existing.and_then(|row| {
        let last_applied_version: i64 = row.get("last_applied_version");
        (aggregate_version <= last_applied_version).then(|| row.get("id"))
    }))
}

async fn project_contact_event(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    event_id: Uuid,
    aggregate_version: i64,
) -> Result<MarketplaceConversionProjectionOutcome, StorageError> {
    let row = sqlx::query(
        "SELECT event.introduction_id, event.event_type, event.decision, event.occurred_at, \
                introduction.demand_party_id, introduction.supply_offer_id, \
                introduction.status AS introduction_status, \
                introduction.supply_contact_consent_at, introduction.contact_released_at, \
                intent.domain_id, supply.store_id, store.organization_id, store.slug, \
                store.display_name, demand.platform_path AS demand_platform_path \
           FROM marketplace_introduction_contact_events AS event \
           JOIN marketplace_introductions AS introduction \
             ON introduction.tenant_id = event.tenant_id \
            AND introduction.id = event.introduction_id \
           JOIN marketplace_intents AS intent \
             ON intent.tenant_id = introduction.tenant_id \
            AND intent.id = introduction.demand_intent_id \
           JOIN marketplace_parties AS supply \
             ON supply.tenant_id = introduction.tenant_id \
            AND supply.id = introduction.supply_party_id \
           JOIN marketplace_parties AS demand \
             ON demand.tenant_id = introduction.tenant_id \
            AND demand.id = introduction.demand_party_id \
           JOIN stores AS store \
             ON store.tenant_id = supply.tenant_id \
            AND store.id = supply.store_id \
          WHERE event.tenant_id = $1 AND event.id = $2",
    )
    .bind(tenant_id)
    .bind(event_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound(
        "canonical marketplace contact conversion",
    ))?;

    let decision: String = row.try_get("decision")?;
    if decision != "allowed" {
        return Ok(MarketplaceConversionProjectionOutcome {
            opportunity_id: None,
            notifications_written: 0,
        });
    }

    let introduction_id: Uuid = row.try_get("introduction_id")?;
    if let Some(opportunity_id) = already_applied_opportunity(
        transaction,
        tenant_id,
        "marketplace_introduction",
        introduction_id,
        aggregate_version,
    )
    .await?
    {
        return Ok(MarketplaceConversionProjectionOutcome {
            opportunity_id: Some(opportunity_id),
            notifications_written: 0,
        });
    }
    let event_type: String = row.try_get("event_type")?;
    let occurred_at: OffsetDateTime = row.try_get("occurred_at")?;
    let demand_party_id: Uuid = row.try_get("demand_party_id")?;
    let offer_id: Uuid = row.try_get("supply_offer_id")?;
    let introduction_status: String = row.try_get("introduction_status")?;
    let supply_contact_consent_at: Option<OffsetDateTime> =
        row.try_get("supply_contact_consent_at")?;
    let contact_released_at: Option<OffsetDateTime> = row.try_get("contact_released_at")?;
    let domain_id: Uuid = row.try_get("domain_id")?;
    let store_id: Uuid = row.try_get("store_id")?;
    let organization_id: Uuid = row.try_get("organization_id")?;
    let store_slug: String = row.try_get("slug")?;
    let store_name: String = row.try_get("display_name")?;
    let demand_platform_path: String = row.try_get("demand_platform_path")?;

    let customer_id = upsert_store_customer(
        transaction,
        tenant_id,
        store_id,
        demand_party_id,
        occurred_at,
        occurred_at,
    )
    .await?;
    let lead_stage = if contact_released_at.is_some() {
        "contact_exchanged"
    } else {
        "contact_requested"
    };
    let contact_consent_status = if supply_contact_consent_at.is_some() {
        "accepted"
    } else {
        "pending"
    };
    let opportunity_id = upsert_opportunity(
        transaction,
        OpportunityUpsert {
            tenant_id,
            store_id,
            customer_id,
            domain_id,
            source_type: "marketplace_introduction",
            source_id: introduction_id,
            introduction_id: Some(introduction_id),
            handoff_id: None,
            source_status: &introduction_status,
            lead_stage,
            contact_consent_status,
            favorite: false,
            staff_notes: "",
            source_event_id: event_id,
            source_occurred_at: occurred_at,
            aggregate_version,
        },
    )
    .await?;

    sqlx::query(
        "INSERT INTO marketplace_sales_opportunity_offers \
             (tenant_id, opportunity_id, offer_id, ordinal) \
         VALUES ($1, $2, $3, 0) \
         ON CONFLICT (tenant_id, opportunity_id, offer_id) DO NOTHING",
    )
    .bind(tenant_id)
    .bind(opportunity_id)
    .bind(offer_id)
    .execute(&mut **transaction)
    .await?;

    let notifications_written = match event_type.as_str() {
        "contact_requested" => {
            let title = notification_title(&store_name, "收到新的联系申请");
            notify_store_members(
                transaction,
                tenant_id,
                organization_id,
                &format!("/{store_slug}"),
                "customer_intent",
                "marketplace_introduction",
                introduction_id,
                &title,
                "客户已明确请求联系，请及时处理。",
                &json!({
                    "storeId": store_id,
                    "opportunityId": opportunity_id,
                    "introductionId": introduction_id,
                    "offerId": offer_id,
                }),
                &format!(
                    "/?storeConsole={store_id}&storeConsoleSection=customers&opportunity={opportunity_id}"
                ),
            )
            .await?
        }
        "contact_consent" => {
            notify_party_users(
                transaction,
                tenant_id,
                demand_party_id,
                &demand_platform_path,
                "contact_status",
                "marketplace_introduction",
                introduction_id,
                "店家已同意联系申请",
                "你可以返回咨询页面，在确认后查看联系方式。",
                &json!({
                    "opportunityId": opportunity_id,
                    "introductionId": introduction_id,
                    "status": "accepted",
                }),
                &format!("{demand_platform_path}?introduction={introduction_id}"),
            )
            .await?
        }
        _ => 0,
    };

    Ok(MarketplaceConversionProjectionOutcome {
        opportunity_id: Some(opportunity_id),
        notifications_written,
    })
}

async fn project_sales_handoff(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    handoff_id: Uuid,
    aggregate_version: i64,
) -> Result<MarketplaceConversionProjectionOutcome, StorageError> {
    if let Some(opportunity_id) = already_applied_opportunity(
        transaction,
        tenant_id,
        "marketplace_sales_handoff",
        handoff_id,
        aggregate_version,
    )
    .await?
    {
        return Ok(MarketplaceConversionProjectionOutcome {
            opportunity_id: Some(opportunity_id),
            notifications_written: 0,
        });
    }
    let row = sqlx::query(
        "SELECT handoff.domain_id, handoff.participant_id, handoff.summary, handoff.status, \
                handoff.lead_stage, handoff.favorite, \
                COALESCE(handoff.staff_notes, '') AS staff_notes, \
                handoff.contact_consent_status, handoff.created_at, handoff.updated_at, \
                participant.store_id, store.organization_id, store.slug, store.display_name \
           FROM marketplace_sales_handoffs AS handoff \
           JOIN marketplace_parties AS participant \
             ON participant.tenant_id = handoff.tenant_id \
            AND participant.id = handoff.participant_id \
           JOIN stores AS store \
             ON store.tenant_id = participant.tenant_id \
            AND store.id = participant.store_id \
          WHERE handoff.tenant_id = $1 AND handoff.id = $2",
    )
    .bind(tenant_id)
    .bind(handoff_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound(
        "canonical marketplace sales handoff conversion",
    ))?;

    let domain_id: Uuid = row.try_get("domain_id")?;
    let participant_id: Uuid = row.try_get("participant_id")?;
    let summary: Value = row.try_get("summary")?;
    let status: String = row.try_get("status")?;
    let lead_stage: String = row.try_get("lead_stage")?;
    let favorite: bool = row.try_get("favorite")?;
    let staff_notes: String = row.try_get("staff_notes")?;
    let contact_consent_status: String = row.try_get("contact_consent_status")?;
    let created_at: OffsetDateTime = row.try_get("created_at")?;
    let updated_at: OffsetDateTime = row.try_get("updated_at")?;
    let store_id: Uuid = row.try_get("store_id")?;
    let organization_id: Uuid = row.try_get("organization_id")?;
    let store_slug: String = row.try_get("slug")?;
    let store_name: String = row.try_get("display_name")?;

    let customer_id = upsert_store_customer(
        transaction,
        tenant_id,
        store_id,
        participant_id,
        created_at,
        updated_at,
    )
    .await?;
    let opportunity_id = upsert_opportunity(
        transaction,
        OpportunityUpsert {
            tenant_id,
            store_id,
            customer_id,
            domain_id,
            source_type: "marketplace_sales_handoff",
            source_id: handoff_id,
            introduction_id: None,
            handoff_id: Some(handoff_id),
            source_status: &status,
            lead_stage: &lead_stage,
            contact_consent_status: &contact_consent_status,
            favorite,
            staff_notes: &staff_notes,
            source_event_id: handoff_id,
            source_occurred_at: updated_at,
            aggregate_version,
        },
    )
    .await?;

    let requested_offer_ids = canonical_uuid_list(summary.get("product_ids"));
    let canonical_offer_ids = replace_opportunity_offers(
        transaction,
        tenant_id,
        store_id,
        domain_id,
        opportunity_id,
        &requested_offer_ids,
    )
    .await?;
    let title = notification_title(&store_name, "有客户请求店员介入");
    let notifications_written = notify_store_members(
        transaction,
        tenant_id,
        organization_id,
        &format!("/{store_slug}"),
        "customer_intent",
        "store_ai_handoff",
        handoff_id,
        &title,
        "AI 店长识别到新的客户意向，请及时查看。",
        &json!({
            "storeId": store_id,
            "opportunityId": opportunity_id,
            "handoffId": handoff_id,
            "productIds": canonical_offer_ids,
        }),
        &format!(
            "/?storeConsole={store_id}&storeConsoleSection=customers&opportunity={opportunity_id}"
        ),
    )
    .await?;

    Ok(MarketplaceConversionProjectionOutcome {
        opportunity_id: Some(opportunity_id),
        notifications_written,
    })
}

async fn upsert_store_customer(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    store_id: Uuid,
    demand_party_id: Uuid,
    first_seen_at: OffsetDateTime,
    activity_at: OffsetDateTime,
) -> Result<Uuid, StorageError> {
    let customer_id = sqlx::query_scalar(
        "INSERT INTO marketplace_store_customers \
             (id, tenant_id, store_id, demand_party_id, first_seen_at, last_activity_at) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (tenant_id, store_id, demand_party_id) \
         DO UPDATE SET first_seen_at = least( \
                           marketplace_store_customers.first_seen_at, \
                           EXCLUDED.first_seen_at), \
                       last_activity_at = greatest( \
                           marketplace_store_customers.last_activity_at, \
                           EXCLUDED.last_activity_at), \
                       version = marketplace_store_customers.version + CASE \
                           WHEN EXCLUDED.first_seen_at < marketplace_store_customers.first_seen_at \
                             OR EXCLUDED.last_activity_at > marketplace_store_customers.last_activity_at \
                           THEN 1 ELSE 0 END, \
                       updated_at = CASE \
                           WHEN EXCLUDED.first_seen_at < marketplace_store_customers.first_seen_at \
                             OR EXCLUDED.last_activity_at > marketplace_store_customers.last_activity_at \
                           THEN clock_timestamp() \
                           ELSE marketplace_store_customers.updated_at END \
         RETURNING id",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id)
    .bind(store_id)
    .bind(demand_party_id)
    .bind(first_seen_at)
    .bind(activity_at)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(customer_id)
}

struct OpportunityUpsert<'a> {
    tenant_id: Uuid,
    store_id: Uuid,
    customer_id: Uuid,
    domain_id: Uuid,
    source_type: &'a str,
    source_id: Uuid,
    introduction_id: Option<Uuid>,
    handoff_id: Option<Uuid>,
    source_status: &'a str,
    lead_stage: &'a str,
    contact_consent_status: &'a str,
    favorite: bool,
    staff_notes: &'a str,
    source_event_id: Uuid,
    source_occurred_at: OffsetDateTime,
    aggregate_version: i64,
}

async fn upsert_opportunity(
    transaction: &mut Transaction<'_, Postgres>,
    input: OpportunityUpsert<'_>,
) -> Result<Uuid, StorageError> {
    let opportunity_id = sqlx::query_scalar(
        "INSERT INTO marketplace_sales_opportunities \
             (id, tenant_id, store_id, customer_id, domain_id, source_type, source_id, \
              introduction_id, handoff_id, source_status, lead_stage, contact_consent_status, \
              favorite, staff_notes, last_source_event_id, last_source_occurred_at, \
              last_applied_version) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) \
         ON CONFLICT (tenant_id, source_type, source_id) \
         DO UPDATE SET customer_id = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.customer_id ELSE marketplace_sales_opportunities.customer_id END, \
                       store_id = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.store_id ELSE marketplace_sales_opportunities.store_id END, \
                       domain_id = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.domain_id ELSE marketplace_sales_opportunities.domain_id END, \
                       source_status = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.source_status ELSE marketplace_sales_opportunities.source_status END, \
                       lead_stage = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.lead_stage ELSE marketplace_sales_opportunities.lead_stage END, \
                       contact_consent_status = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.contact_consent_status \
                           ELSE marketplace_sales_opportunities.contact_consent_status END, \
                       favorite = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.favorite ELSE marketplace_sales_opportunities.favorite END, \
                       staff_notes = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.staff_notes ELSE marketplace_sales_opportunities.staff_notes END, \
                       last_source_event_id = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN EXCLUDED.last_source_event_id \
                           ELSE marketplace_sales_opportunities.last_source_event_id END, \
                       last_source_occurred_at = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN greatest(marketplace_sales_opportunities.last_source_occurred_at, \
                                         EXCLUDED.last_source_occurred_at) \
                           ELSE marketplace_sales_opportunities.last_source_occurred_at END, \
                       last_applied_version = greatest( \
                           marketplace_sales_opportunities.last_applied_version, \
                           EXCLUDED.last_applied_version), \
                       updated_at = CASE \
                           WHEN EXCLUDED.last_applied_version > marketplace_sales_opportunities.last_applied_version \
                           THEN clock_timestamp() \
                           ELSE marketplace_sales_opportunities.updated_at END \
         RETURNING id",
    )
    .bind(Uuid::now_v7())
    .bind(input.tenant_id)
    .bind(input.store_id)
    .bind(input.customer_id)
    .bind(input.domain_id)
    .bind(input.source_type)
    .bind(input.source_id)
    .bind(input.introduction_id)
    .bind(input.handoff_id)
    .bind(input.source_status)
    .bind(input.lead_stage)
    .bind(input.contact_consent_status)
    .bind(input.favorite)
    .bind(input.staff_notes)
    .bind(input.source_event_id)
    .bind(input.source_occurred_at)
    .bind(input.aggregate_version)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(opportunity_id)
}

async fn replace_opportunity_offers(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    store_id: Uuid,
    domain_id: Uuid,
    opportunity_id: Uuid,
    requested_offer_ids: &[Uuid],
) -> Result<Vec<Uuid>, StorageError> {
    sqlx::query(
        "DELETE FROM marketplace_sales_opportunity_offers \
          WHERE tenant_id = $1 AND opportunity_id = $2",
    )
    .bind(tenant_id)
    .bind(opportunity_id)
    .execute(&mut **transaction)
    .await?;
    if requested_offer_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "WITH requested AS ( \
             SELECT offer_id, (ordinality - 1)::smallint AS ordinal \
               FROM unnest($5::uuid[]) WITH ORDINALITY AS item(offer_id, ordinality) \
         ) \
         INSERT INTO marketplace_sales_opportunity_offers \
             (tenant_id, opportunity_id, offer_id, ordinal) \
         SELECT $1, $2, offer.id, requested.ordinal \
           FROM requested \
           JOIN marketplace_offers AS offer \
             ON offer.tenant_id = $1 \
            AND offer.domain_id = $3 \
            AND offer.id = requested.offer_id \
           JOIN marketplace_parties AS supply \
             ON supply.tenant_id = offer.tenant_id \
            AND supply.id = offer.supply_party_id \
            AND supply.store_id = $4 \
          ORDER BY requested.ordinal \
         ON CONFLICT (tenant_id, opportunity_id, offer_id) DO NOTHING \
         RETURNING offer_id",
    )
    .bind(tenant_id)
    .bind(opportunity_id)
    .bind(domain_id)
    .bind(store_id)
    .bind(requested_offer_ids)
    .fetch_all(&mut **transaction)
    .await?;
    rows.into_iter()
        .map(|row| row.try_get("offer_id").map_err(StorageError::from))
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn notify_store_members(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    organization_id: Uuid,
    platform_path: &str,
    kind: &str,
    source_type: &str,
    source_id: Uuid,
    title: &str,
    body: &str,
    payload: &Value,
    action_path: &str,
) -> Result<u64, StorageError> {
    let result = sqlx::query(
        "INSERT INTO user_notifications \
             (id, recipient_auth_user_id, tenant_id, platform_path, kind, source_type, source_id, \
              title, body, payload, action_path) \
         SELECT pg_catalog.gen_random_uuid(), member.\"userId\", $2, $3, $4, $5, $6, $7, $8, $9, $10 \
           FROM \"member\" AS member \
          WHERE member.\"organizationId\" = $1 \
            AND member.role IN ('owner', 'admin', 'subplatform_admin') \
         ON CONFLICT (recipient_auth_user_id, source_type, source_id, kind) DO NOTHING",
    )
    .bind(organization_id)
    .bind(tenant_id)
    .bind(platform_path)
    .bind(kind)
    .bind(source_type)
    .bind(source_id.to_string())
    .bind(title)
    .bind(body)
    .bind(payload)
    .bind(action_path)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

#[allow(clippy::too_many_arguments)]
async fn notify_party_users(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: Uuid,
    party_id: Uuid,
    platform_path: &str,
    kind: &str,
    source_type: &str,
    source_id: Uuid,
    title: &str,
    body: &str,
    payload: &Value,
    action_path: &str,
) -> Result<u64, StorageError> {
    let result = sqlx::query(
        "INSERT INTO user_notifications \
             (id, recipient_auth_user_id, tenant_id, platform_path, kind, source_type, source_id, \
              title, body, payload, action_path) \
         SELECT pg_catalog.gen_random_uuid(), link.auth_user_id, $1, $3, $4, $5, $6, $7, $8, $9, $10 \
           FROM marketplace_party_auth_links AS link \
          WHERE link.tenant_id = $1 AND link.party_id = $2 \
         ON CONFLICT (recipient_auth_user_id, source_type, source_id, kind) DO NOTHING",
    )
    .bind(tenant_id)
    .bind(party_id)
    .bind(platform_path)
    .bind(kind)
    .bind(source_type)
    .bind(source_id.to_string())
    .bind(title)
    .bind(body)
    .bind(payload)
    .bind(action_path)
    .execute(&mut **transaction)
    .await?;
    Ok(result.rows_affected())
}

fn canonical_uuid_list(value: Option<&Value>) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|value| Uuid::parse_str(value).ok())
        .filter(|value| seen.insert(*value))
        .take(MAX_PRODUCT_REFERENCES)
        .collect()
}

fn notification_title(store_name: &str, suffix: &str) -> String {
    let fixed_chars = suffix.chars().count() + 2;
    let store_name_chars = MAX_NOTIFICATION_TITLE_CHARS.saturating_sub(fixed_chars);
    let bounded_store_name: String = store_name.chars().take(store_name_chars).collect();
    format!("“{bounded_store_name}”{suffix}")
}

fn bounded_error(error: &str) -> String {
    error.chars().take(2_000).collect()
}

fn deterministic_retry_delay_ms(job_id: Uuid, attempts: i32) -> u64 {
    let exponent = u32::try_from(attempts.clamp(1, 10)).unwrap_or(10);
    let base_delay_ms = u64::from(2_u32.pow(exponent).min(300)) * 1_000;
    let sample = job_id
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    apply_retry_jitter(base_delay_ms, sample)
}

fn apply_retry_jitter(base_delay_ms: u64, sample: u64) -> u64 {
    let spread = base_delay_ms / 5;
    base_delay_ms - spread + sample % (spread * 2 + 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{apply_retry_jitter, canonical_uuid_list, deterministic_retry_delay_ms};

    #[test]
    fn canonical_uuid_list_rejects_invalid_and_duplicate_references() {
        let first = Uuid::now_v7();
        let second = Uuid::now_v7();
        let value = json!([first, "not-a-uuid", first, second]);

        assert_eq!(canonical_uuid_list(Some(&value)), vec![first, second]);
    }

    #[test]
    fn retry_jitter_should_include_exact_twenty_percent_boundaries() {
        assert_eq!(apply_retry_jitter(2_000, 0), 1_600);
        assert_eq!(apply_retry_jitter(2_000, 800), 2_400);
    }

    #[test]
    fn retry_jitter_should_be_deterministic_and_bounded() {
        let job_id = Uuid::now_v7();
        for attempts in 1..=12 {
            let delay = deterministic_retry_delay_ms(job_id, attempts);
            let exponent = attempts.clamp(1, 10).unsigned_abs();
            let base = u64::from(2_u32.pow(exponent).min(300)) * 1_000;
            assert!((base * 4 / 5..=base * 6 / 5).contains(&delay));
            assert_eq!(delay, deterministic_retry_delay_ms(job_id, attempts));
        }
    }
}
