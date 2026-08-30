use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    MarketplaceConversionRecoveryAction, MarketplaceConversionRecoveryOutcome, PgStore,
    StorageError, bounded_operator_text,
};

const SUPPORTED_SCHEMA_VERSION: i16 = 1;

/// Proof that the caller checked the host process effective UID before opening recovery config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedHostOperator {
    effective_uid: u32,
}

impl VerifiedHostOperator {
    /// Verifies that the current host process is running as the operating-system root identity.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Forbidden`] when the real effective UID is not zero.
    pub fn verify_current_process() -> Result<Self, StorageError> {
        Self::from_effective_uid(rustix::process::geteuid().as_raw())
    }

    fn from_effective_uid(effective_uid: u32) -> Result<Self, StorageError> {
        if effective_uid != 0 {
            return Err(StorageError::Forbidden(
                "conversion projection apply requires effective UID 0".to_owned(),
            ));
        }
        Ok(Self { effective_uid })
    }

    const fn effective_uid(self) -> u32 {
        self.effective_uid
    }
}

impl PgStore {
    /// Validates or applies one host-operator recovery action to a dead conversion aggregate head.
    ///
    /// Dry runs acquire the same row lock and perform the same eligibility checks as an applied
    /// action, but roll the transaction back without writing projection or audit state.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Conflict`] unless the row is an unclaimed dead letter with no
    /// unexpectedly active successor. Replay additionally requires a supported canonical source.
    pub async fn recover_marketplace_conversion(
        &self,
        job_id: Uuid,
        action: MarketplaceConversionRecoveryAction,
        apply: bool,
        host_operator: Option<VerifiedHostOperator>,
        operator_request_id: &str,
        reason: &str,
    ) -> Result<MarketplaceConversionRecoveryOutcome, StorageError> {
        let host_operator_uid = match (apply, host_operator) {
            (true, Some(operator)) => Some(operator.effective_uid()),
            (true, None) => {
                return Err(StorageError::Forbidden(
                    "conversion projection apply requires a verified root host operator".to_owned(),
                ));
            }
            (false, _) => None,
        };
        let operator_request_id = bounded_operator_text(operator_request_id, 200, "request id")?;
        let reason = bounded_operator_text(reason, 200, "recovery reason")?;
        let mut transaction = self.pool().begin().await?;
        let dead = sqlx::query(
            "SELECT tenant_id, schema_version, source_type, source_id, aggregate_type, \
                    aggregate_id, aggregate_version, status, claimed_at, claim_token, \
                    claim_expires_at \
               FROM marketplace_conversion_outbox \
              WHERE id = $1 \
              FOR UPDATE",
        )
        .bind(job_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("marketplace conversion job"))?;

        let status: String = dead.try_get("status")?;
        let claimed_at: Option<time::OffsetDateTime> = dead.try_get("claimed_at")?;
        let claim_token: Option<Uuid> = dead.try_get("claim_token")?;
        let claim_expires_at: Option<time::OffsetDateTime> = dead.try_get("claim_expires_at")?;
        if status != "dead"
            || claimed_at.is_some()
            || claim_token.is_some()
            || claim_expires_at.is_some()
        {
            return Err(StorageError::Conflict(
                "marketplace conversion recovery requires an unclaimed dead letter".to_owned(),
            ));
        }

        let tenant_id: Uuid = dead.try_get("tenant_id")?;
        let schema_version: i16 = dead.try_get("schema_version")?;
        let source_type: String = dead.try_get("source_type")?;
        let source_id: Uuid = dead.try_get("source_id")?;
        let aggregate_type: String = dead.try_get("aggregate_type")?;
        let aggregate_id: Uuid = dead.try_get("aggregate_id")?;
        let aggregate_version: i64 = dead.try_get("aggregate_version")?;
        if action == MarketplaceConversionRecoveryAction::Replay
            && schema_version != SUPPORTED_SCHEMA_VERSION
        {
            return Err(StorageError::Conflict(
                "marketplace conversion replay requires a supported schema version".to_owned(),
            ));
        }

        let canonical_scope = canonical_recovery_scope(
            &mut transaction,
            tenant_id,
            &source_type,
            source_id,
            aggregate_id,
        )
        .await?;
        let (domain_id, platform_path) = match (action, canonical_scope) {
            (_, Some((domain_id, platform_path))) => (Some(domain_id), platform_path),
            (MarketplaceConversionRecoveryAction::Replay, None) => {
                return Err(StorageError::Conflict(
                    "marketplace conversion canonical source is unavailable for replay".to_owned(),
                ));
            }
            (MarketplaceConversionRecoveryAction::Resolve, None) => (None, "/".to_owned()),
        };
        let active_successors: i64 = sqlx::query_scalar(
            "SELECT count(*) \
               FROM marketplace_conversion_outbox \
              WHERE tenant_id = $1 \
                AND aggregate_type = $2 \
                AND aggregate_id = $3 \
                AND aggregate_version > $4 \
                AND status = 'publishing'",
        )
        .bind(tenant_id)
        .bind(&aggregate_type)
        .bind(aggregate_id)
        .bind(aggregate_version)
        .fetch_one(&mut *transaction)
        .await?;
        if active_successors != 0 {
            return Err(StorageError::Conflict(
                "marketplace conversion recovery found an active aggregate successor".to_owned(),
            ));
        }
        let blocked_successors: i64 = sqlx::query_scalar(
            "SELECT count(*) \
               FROM marketplace_conversion_outbox \
              WHERE tenant_id = $1 \
                AND aggregate_type = $2 \
                AND aggregate_id = $3 \
                AND aggregate_version > $4 \
                AND status NOT IN ('published', 'resolved')",
        )
        .bind(tenant_id)
        .bind(&aggregate_type)
        .bind(aggregate_id)
        .bind(aggregate_version)
        .fetch_one(&mut *transaction)
        .await?;
        let resulting_status = match action {
            MarketplaceConversionRecoveryAction::Replay => "pending",
            MarketplaceConversionRecoveryAction::Resolve => "resolved",
        };

        if !apply {
            transaction.rollback().await?;
            return Ok(MarketplaceConversionRecoveryOutcome {
                job_id,
                tenant_id,
                aggregate_type,
                aggregate_id,
                aggregate_version,
                action,
                applied: false,
                previous_status: status,
                resulting_status: resulting_status.to_owned(),
                blocked_successors,
                operator_request_id,
            });
        }

        let updated_status: String = match action {
            MarketplaceConversionRecoveryAction::Replay => {
                sqlx::query_scalar(
                    "UPDATE marketplace_conversion_outbox \
                        SET status = 'pending', \
                            attempts = 0, \
                            available_at = clock_timestamp(), \
                            claimed_at = NULL, \
                            claim_token = NULL, \
                            claim_expires_at = NULL, \
                            published_at = NULL, \
                            last_error = NULL, \
                            last_attempt_at = NULL, \
                            dead_at = NULL, \
                            resolved_at = NULL \
                      WHERE id = $1 AND status = 'dead' AND claim_token IS NULL \
                     RETURNING status",
                )
                .bind(job_id)
                .fetch_optional(&mut *transaction)
                .await?
            }
            MarketplaceConversionRecoveryAction::Resolve => {
                sqlx::query_scalar(
                    "UPDATE marketplace_conversion_outbox \
                        SET status = 'resolved', \
                            claimed_at = NULL, \
                            claim_token = NULL, \
                            claim_expires_at = NULL, \
                            dead_at = NULL, \
                            resolved_at = clock_timestamp() \
                      WHERE id = $1 AND status = 'dead' AND claim_token IS NULL \
                     RETURNING status",
                )
                .bind(job_id)
                .fetch_optional(&mut *transaction)
                .await?
            }
        }
        .ok_or_else(|| {
            StorageError::Conflict(
                "marketplace conversion recovery lost its dead-letter fence".to_owned(),
            )
        })?;

        let event_type = match action {
            MarketplaceConversionRecoveryAction::Replay => {
                "marketplace.conversion.projection.replayed"
            }
            MarketplaceConversionRecoveryAction::Resolve => {
                "marketplace.conversion.projection.resolved"
            }
        };
        sqlx::query(
            "INSERT INTO platform_audit_events ( \
                 id, tenant_id, domain_id, platform_path, event_type, outcome, request_id, metadata \
             ) VALUES ($1, $2, $3, $4, $5, 'success', $6, $7)",
        )
        .bind(Uuid::now_v7())
        .bind(tenant_id)
        .bind(domain_id)
        .bind(&platform_path)
        .bind(event_type)
        .bind(&operator_request_id)
        .bind(json!({
            "job_id": job_id,
            "aggregate_type": aggregate_type,
            "aggregate_id": aggregate_id,
            "aggregate_version": aggregate_version,
            "action": action,
            "reason": reason,
            "host_operator": host_operator_uid == Some(0),
            "host_operator_uid": host_operator_uid
        }))
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;

        Ok(MarketplaceConversionRecoveryOutcome {
            job_id,
            tenant_id,
            aggregate_type,
            aggregate_id,
            aggregate_version,
            action,
            applied: true,
            previous_status: status,
            resulting_status: updated_status,
            blocked_successors,
            operator_request_id,
        })
    }
}

async fn canonical_recovery_scope(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: Uuid,
    source_type: &str,
    source_id: Uuid,
    aggregate_id: Uuid,
) -> Result<Option<(Uuid, String)>, StorageError> {
    let scope = match source_type {
        "introduction_contact_event" => {
            sqlx::query(
                "SELECT offer.domain_id, supply.platform_path \
                   FROM marketplace_introduction_contact_events AS event \
                   JOIN marketplace_introductions AS introduction \
                     ON introduction.tenant_id = event.tenant_id \
                    AND introduction.id = event.introduction_id \
                   JOIN marketplace_offers AS offer \
                     ON offer.tenant_id = introduction.tenant_id \
                    AND offer.id = introduction.supply_offer_id \
                   JOIN marketplace_parties AS supply \
                     ON supply.tenant_id = introduction.tenant_id \
                    AND supply.id = introduction.supply_party_id \
                  WHERE event.tenant_id = $1 \
                    AND event.id = $2 \
                    AND event.introduction_id = $3",
            )
            .bind(tenant_id)
            .bind(source_id)
            .bind(aggregate_id)
            .fetch_optional(&mut **transaction)
            .await?
        }
        "sales_handoff" => {
            sqlx::query(
                "SELECT handoff.domain_id, participant.platform_path \
                   FROM marketplace_sales_handoffs AS handoff \
                   JOIN marketplace_parties AS participant \
                     ON participant.tenant_id = handoff.tenant_id \
                    AND participant.id = handoff.participant_id \
                  WHERE handoff.tenant_id = $1 \
                    AND handoff.id = $2 \
                    AND handoff.id = $3",
            )
            .bind(tenant_id)
            .bind(source_id)
            .bind(aggregate_id)
            .fetch_optional(&mut **transaction)
            .await?
        }
        _ => {
            return Err(StorageError::InvalidData(
                "unsupported marketplace conversion recovery source type".to_owned(),
            ));
        }
    };
    scope
        .map(|scope| Ok((scope.try_get("domain_id")?, scope.try_get("platform_path")?)))
        .transpose()
}

#[cfg(test)]
mod tests {
    use crate::{StorageError, VerifiedHostOperator, bounded_operator_text};

    #[test]
    fn host_operator_proof_should_only_accept_root_in_the_private_test_seam() {
        assert!(VerifiedHostOperator::from_effective_uid(0).is_ok());
        assert!(matches!(
            VerifiedHostOperator::from_effective_uid(1_000),
            Err(StorageError::Forbidden(_))
        ));
    }

    #[test]
    fn recovery_reason_must_be_bounded_and_printable() {
        assert_eq!(
            bounded_operator_text("  canonical source repaired  ", 200, "reason").unwrap(),
            "canonical source repaired"
        );
        assert!(bounded_operator_text("", 200, "reason").is_err());
        assert!(bounded_operator_text("unsafe\nreason", 200, "reason").is_err());
        assert!(bounded_operator_text(&"x".repeat(201), 200, "reason").is_err());
    }
}
