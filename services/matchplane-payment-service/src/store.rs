use matchplane_domain::{
    MarketplacePartyId, OfflineDealId, PaymentGatewayId, PaymentId, RefundId, TenantId,
};
use matchplane_payments::{
    PaymentError, PaymentOutcome, PaymentStatus, RefundOutcome, calculate_commission_reversal,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::gateways::GatewayConfig;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("{0} was not found")]
    NotFound(&'static str),
    #[error("idempotency key was reused with different data")]
    IdempotencyConflict,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid payment operation: {0}")]
    Invalid(String),
    #[error(transparent)]
    Payment(#[from] PaymentError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentRecord {
    pub payment_id: PaymentId,
    pub tenant_id: TenantId,
    pub gateway_id: PaymentGatewayId,
    pub offline_deal_id: Option<OfflineDealId>,
    pub payer_party_id: Option<MarketplacePartyId>,
    pub merchant_order_id: String,
    pub transaction_channel: String,
    pub purpose: String,
    pub gateway_kind: String,
    pub gateway_mode: String,
    pub payment_method: String,
    pub amount: String,
    pub captured_amount: String,
    pub refunded_amount: String,
    pub commission_amount: String,
    pub commission_refunded_amount: String,
    pub currency: String,
    pub currency_scale: i16,
    pub status: String,
    pub provider_reference: Option<String>,
    pub redirect_url: Option<String>,
    pub provider_status: String,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefundRecord {
    pub refund_id: RefundId,
    pub tenant_id: TenantId,
    pub payment_id: PaymentId,
    pub amount: String,
    pub commission_reversal_amount: String,
    pub currency: String,
    pub currency_scale: i16,
    pub reason: String,
    pub status: String,
    pub provider_reference: Option<String>,
    pub provider_status: Option<String>,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug)]
pub struct NewPayment {
    pub payment_id: PaymentId,
    pub tenant_id: TenantId,
    pub offline_deal_id: Option<OfflineDealId>,
    pub payer_party_id: Option<MarketplacePartyId>,
    pub merchant_order_id: String,
    pub idempotency_key: String,
    pub request_hash: Vec<u8>,
    pub transaction_channel: String,
    pub purpose: String,
    pub payment_method: String,
    pub amount: i128,
    pub commission_amount: i128,
    pub currency: String,
    pub currency_scale: i16,
}

#[derive(Debug)]
pub struct PreparedPayment {
    pub payment: PaymentRecord,
    pub gateway: GatewayConfig,
    pub duplicate: bool,
}

#[derive(Debug)]
pub struct PreparedOperation {
    pub payment: PaymentRecord,
    pub gateway: GatewayConfig,
    pub execute: bool,
}

#[derive(Debug)]
pub struct NewRefund {
    pub refund_id: RefundId,
    pub tenant_id: TenantId,
    pub payment_id: PaymentId,
    pub idempotency_key: String,
    pub request_hash: Vec<u8>,
    pub amount: i128,
    pub reason: String,
}

#[derive(Debug)]
pub struct PreparedRefund {
    pub payment: PaymentRecord,
    pub refund: RefundRecord,
    pub gateway: GatewayConfig,
    pub execute: bool,
}

#[derive(Debug, Clone)]
pub struct PaymentStore {
    pool: PgPool,
}

impl PaymentStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn ping(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn marketplace_party_token_valid(
        &self,
        tenant_id: TenantId,
        party_id: MarketplacePartyId,
        token_hash: &[u8],
    ) -> Result<bool, StoreError> {
        if token_hash.len() != 32 {
            return Ok(false);
        }
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM marketplace_parties \
             WHERE tenant_id = $1 AND id = $2 AND access_token_hash = $3 AND status = 'active')",
        )
        .bind(tenant_id.into_uuid())
        .bind(party_id.into_uuid())
        .bind(token_hash)
        .fetch_one(&self.pool)
        .await
        .map_err(StoreError::from)
    }

    pub async fn prepare_authorization(
        &self,
        command: &NewPayment,
    ) -> Result<PreparedPayment, StoreError> {
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        if let Some(row) = sqlx::query(
            "SELECT id, request_hash FROM payment_intents \
             WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(&command.idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let request_hash: Vec<u8> = row.try_get("request_hash")?;
            if request_hash != command.request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let payment_id = PaymentId::from_uuid(row.try_get("id")?);
            let payment = payment_in(&mut transaction, payment_id).await?;
            let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
            transaction.commit().await?;
            return Ok(PreparedPayment {
                payment,
                gateway,
                duplicate: true,
            });
        }

        if let Some(offline_deal_id) = command.offline_deal_id {
            let seller_party_id: Uuid = sqlx::query_scalar(
                "SELECT seller_party_id FROM offline_deals \
                 WHERE tenant_id = $1 AND id = $2 FOR SHARE",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(offline_deal_id.into_uuid())
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or(StoreError::NotFound("offline deal"))?;
            if command.payer_party_id.map(MarketplacePartyId::into_uuid) != Some(seller_party_id) {
                return Err(StoreError::Invalid(
                    "offline commission must be paid or authorized by the matched seller".into(),
                ));
            }
        }

        let active_mode: String = sqlx::query_scalar(
            "SELECT active_mode FROM payment_settings WHERE tenant_id = $1 FOR SHARE",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("payment settings"))?;
        let route = sqlx::query(
            "SELECT g.id, g.name, g.gateway_kind, g.mode, g.settings, g.credential_secret_ref \
             FROM payment_routes r JOIN payment_gateway_configs g ON g.id = r.gateway_id \
             WHERE r.tenant_id = $1 AND r.enabled AND g.enabled AND g.mode = $2 \
               AND r.method_code IN ($3, '*') AND r.currency IN ($4, '*') \
             ORDER BY (r.method_code = $3) DESC, (r.currency = $4) DESC, r.priority, r.id \
             LIMIT 1 FOR SHARE OF g",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(&active_mode)
        .bind(&command.payment_method)
        .bind(&command.currency)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("active payment route"))?;
        let gateway = gateway_from_row(&route)?;
        let gateway_kind = gateway.kind.as_str();

        sqlx::query(
            "INSERT INTO payment_intents \
             (id, tenant_id, gateway_id, offline_deal_id, payer_party_id, merchant_order_id, idempotency_key, \
              request_hash, transaction_channel, purpose, gateway_kind, gateway_mode, \
              payment_method, amount, commission_amount, currency, currency_scale, status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, \
                     $14::numeric, $15::numeric, $16, $17, 'requested')",
        )
        .bind(command.payment_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(gateway.gateway_id.into_uuid())
        .bind(command.offline_deal_id.map(OfflineDealId::into_uuid))
        .bind(command.payer_party_id.map(MarketplacePartyId::into_uuid))
        .bind(&command.merchant_order_id)
        .bind(&command.idempotency_key)
        .bind(&command.request_hash)
        .bind(&command.transaction_channel)
        .bind(&command.purpose)
        .bind(gateway_kind)
        .bind(&active_mode)
        .bind(&command.payment_method)
        .bind(command.amount.to_string())
        .bind(command.commission_amount.to_string())
        .bind(&command.currency)
        .bind(command.currency_scale)
        .execute(&mut *transaction)
        .await?;
        insert_payment_event(
            &mut transaction,
            command.tenant_id,
            command.payment_id,
            "authorization_requested",
            None,
            "requested",
            None,
        )
        .await?;
        let payment = payment_in(&mut transaction, command.payment_id).await?;
        transaction.commit().await?;
        Ok(PreparedPayment {
            payment,
            gateway,
            duplicate: false,
        })
    }

    pub async fn complete_authorization(
        &self,
        outcome: &PaymentOutcome,
    ) -> Result<PaymentRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let current = payment_in_for_update(&mut transaction, outcome.payment_id).await?;
        let target = outcome.status.as_str();
        if !matches!(current.status.as_str(), "requested" | "unknown" | "pending")
            && current.status != target
        {
            return Err(StoreError::Conflict(format!(
                "authorization cannot move {} to {target}",
                current.status
            )));
        }
        let captured_amount = if outcome.status == PaymentStatus::Captured {
            current.amount.clone()
        } else {
            current.captured_amount.clone()
        };
        sqlx::query(
            "UPDATE payment_intents SET status = $2, provider_reference = $3, redirect_url = $4, \
                 provider_status = $5, captured_amount = $6::numeric, version = version + 1 \
             WHERE id = $1",
        )
        .bind(outcome.payment_id.into_uuid())
        .bind(target)
        .bind(&outcome.provider_reference)
        .bind(&outcome.redirect_url)
        .bind(&outcome.provider_status)
        .bind(captured_amount)
        .execute(&mut *transaction)
        .await?;
        insert_payment_event(
            &mut transaction,
            current.tenant_id,
            outcome.payment_id,
            "authorization_result",
            Some(&current.status),
            target,
            Some(&outcome.provider_status),
        )
        .await?;
        let payment = payment_in(&mut transaction, outcome.payment_id).await?;
        transaction.commit().await?;
        Ok(payment)
    }

    pub async fn fail_authorization(
        &self,
        payment_id: PaymentId,
        unknown: bool,
        provider_status: &str,
    ) -> Result<PaymentRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let current = payment_in_for_update(&mut transaction, payment_id).await?;
        let target = if unknown { "unknown" } else { "failed" };
        if current.status == "requested" || current.status == "pending" {
            sqlx::query(
                "UPDATE payment_intents SET status = $2, provider_status = $3, version = version + 1 \
                 WHERE id = $1",
            )
            .bind(payment_id.into_uuid())
            .bind(target)
            .bind(provider_status)
            .execute(&mut *transaction)
            .await?;
            insert_payment_event(
                &mut transaction,
                current.tenant_id,
                payment_id,
                "authorization_failed",
                Some(&current.status),
                target,
                Some(provider_status),
            )
            .await?;
        }
        let payment = payment_in(&mut transaction, payment_id).await?;
        transaction.commit().await?;
        Ok(payment)
    }

    pub async fn payment(&self, payment_id: PaymentId) -> Result<PaymentRecord, StoreError> {
        payment_from_pool(&self.pool, payment_id).await
    }

    pub async fn prepare_query(
        &self,
        tenant_id: TenantId,
        payment_id: PaymentId,
        idempotency_key: &str,
        request_hash: &[u8],
    ) -> Result<PreparedOperation, StoreError> {
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        if let Some(row) = sqlx::query(
            "SELECT payment_id, operation, request_hash, status FROM payment_operations \
             WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE",
        )
        .bind(tenant_id.into_uuid())
        .bind(idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_payment_id: Uuid = row.try_get("payment_id")?;
            let operation: String = row.try_get("operation")?;
            let stored_hash: Vec<u8> = row.try_get("request_hash")?;
            if stored_payment_id != payment_id.into_uuid()
                || operation != "query"
                || stored_hash != request_hash
            {
                return Err(StoreError::IdempotencyConflict);
            }
            let operation_status: String = row.try_get("status")?;
            let payment = payment_in(&mut transaction, payment_id).await?;
            let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
            transaction.commit().await?;
            return Ok(PreparedOperation {
                payment,
                gateway,
                execute: matches!(operation_status.as_str(), "started" | "unknown"),
            });
        }

        let payment = payment_in_for_update(&mut transaction, payment_id).await?;
        if payment.tenant_id != tenant_id {
            return Err(StoreError::NotFound("payment"));
        }
        sqlx::query(
            "INSERT INTO payment_operations \
             (id, tenant_id, payment_id, operation, idempotency_key, request_hash, amount, status) \
             VALUES ($1, $2, $3, 'query', $4, $5, NULL, 'started')",
        )
        .bind(Uuid::now_v7())
        .bind(tenant_id.into_uuid())
        .bind(payment_id.into_uuid())
        .bind(idempotency_key)
        .bind(request_hash)
        .execute(&mut *transaction)
        .await?;
        let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
        transaction.commit().await?;
        Ok(PreparedOperation {
            payment,
            gateway,
            execute: true,
        })
    }

    pub async fn complete_query(
        &self,
        payment_id: PaymentId,
        idempotency_key: &str,
        outcome: Result<&PaymentOutcome, &PaymentError>,
    ) -> Result<PaymentRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let payment = payment_in_for_update(&mut transaction, payment_id).await?;
        let (operation_status, provider_status) = match outcome {
            Ok(result) => ("succeeded", result.provider_status.as_str()),
            Err(error) if is_unknown(error) => ("unknown", "transport_unknown"),
            Err(_) => ("failed", "query_failed"),
        };
        let operation = sqlx::query(
            "UPDATE payment_operations SET status = $4, provider_status = $5 \
             WHERE tenant_id = $1 AND payment_id = $2 AND idempotency_key = $3 \
               AND operation = 'query'",
        )
        .bind(payment.tenant_id.into_uuid())
        .bind(payment_id.into_uuid())
        .bind(idempotency_key)
        .bind(operation_status)
        .bind(provider_status)
        .execute(&mut *transaction)
        .await?;
        if operation.rows_affected() != 1 {
            return Err(StoreError::NotFound("payment reconciliation operation"));
        }

        match outcome {
            Ok(result) => {
                let target = result.status.as_str();
                if reconciliation_transition_allowed(&payment.status, target) {
                    let captured_amount = if target == "captured" && payment.status != "captured" {
                        sqlx::query_scalar::<_, String>(
                            "SELECT amount::text FROM payment_operations \
                             WHERE payment_id = $1 AND operation = 'capture' AND amount IS NOT NULL \
                             ORDER BY created_at DESC LIMIT 1",
                        )
                        .bind(payment_id.into_uuid())
                        .fetch_optional(&mut *transaction)
                        .await?
                        .unwrap_or_else(|| payment.amount.clone())
                    } else {
                        payment.captured_amount.clone()
                    };
                    sqlx::query(
                        "UPDATE payment_intents SET status = $2, \
                             provider_reference = COALESCE(NULLIF($3, ''), provider_reference), \
                             redirect_url = COALESCE($4, redirect_url), provider_status = $5, \
                             captured_amount = $6::numeric, \
                             commission_amount = CASE \
                                 WHEN $2 = 'captured' AND purpose = 'platform_commission' \
                                 THEN $6::numeric ELSE commission_amount END, \
                             version = version + 1 WHERE id = $1",
                    )
                    .bind(payment_id.into_uuid())
                    .bind(target)
                    .bind(&result.provider_reference)
                    .bind(&result.redirect_url)
                    .bind(&result.provider_status)
                    .bind(captured_amount)
                    .execute(&mut *transaction)
                    .await?;
                    insert_payment_event(
                        &mut transaction,
                        payment.tenant_id,
                        payment_id,
                        "reconciliation_result",
                        Some(&payment.status),
                        target,
                        Some(&result.provider_status),
                    )
                    .await?;
                } else {
                    insert_payment_event(
                        &mut transaction,
                        payment.tenant_id,
                        payment_id,
                        "reconciliation_stale_ignored",
                        Some(&payment.status),
                        &payment.status,
                        Some(&result.provider_status),
                    )
                    .await?;
                }
            }
            Err(error)
                if is_unknown(error) && reconciliation_can_become_unknown(&payment.status) =>
            {
                sqlx::query(
                    "UPDATE payment_intents SET status = 'unknown', provider_status = $2, \
                     version = version + 1 WHERE id = $1",
                )
                .bind(payment_id.into_uuid())
                .bind(provider_status)
                .execute(&mut *transaction)
                .await?;
                insert_payment_event(
                    &mut transaction,
                    payment.tenant_id,
                    payment_id,
                    "reconciliation_unknown",
                    Some(&payment.status),
                    "unknown",
                    Some(provider_status),
                )
                .await?;
            }
            Err(_) => {
                insert_payment_event(
                    &mut transaction,
                    payment.tenant_id,
                    payment_id,
                    "reconciliation_failed",
                    Some(&payment.status),
                    &payment.status,
                    Some(provider_status),
                )
                .await?;
            }
        }

        let payment = payment_in(&mut transaction, payment_id).await?;
        transaction.commit().await?;
        Ok(payment)
    }

    pub async fn prepare_capture(
        &self,
        tenant_id: TenantId,
        payment_id: PaymentId,
        idempotency_key: &str,
        request_hash: &[u8],
        amount: i128,
    ) -> Result<PreparedOperation, StoreError> {
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        if let Some(row) = sqlx::query(
            "SELECT request_hash, status FROM payment_operations \
             WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE",
        )
        .bind(tenant_id.into_uuid())
        .bind(idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash: Vec<u8> = row.try_get("request_hash")?;
            if stored_hash != request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let operation_status: String = row.try_get("status")?;
            let payment = payment_in(&mut transaction, payment_id).await?;
            let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
            transaction.commit().await?;
            return Ok(PreparedOperation {
                payment,
                gateway,
                execute: matches!(operation_status.as_str(), "started" | "unknown"),
            });
        }
        let payment = payment_in_for_update(&mut transaction, payment_id).await?;
        if payment.tenant_id != tenant_id {
            return Err(StoreError::NotFound("payment"));
        }
        if payment.status != "authorized" {
            return Err(StoreError::Conflict(format!(
                "payment status {} cannot be captured",
                payment.status
            )));
        }
        let authorized = exact(&payment.amount)?;
        if amount <= 0 || amount > authorized {
            return Err(StoreError::Invalid(
                "capture must be positive and not exceed authorization".to_owned(),
            ));
        }
        sqlx::query(
            "INSERT INTO payment_operations \
             (id, tenant_id, payment_id, operation, idempotency_key, request_hash, amount, status) \
             VALUES ($1, $2, $3, 'capture', $4, $5, $6::numeric, 'started')",
        )
        .bind(Uuid::now_v7())
        .bind(tenant_id.into_uuid())
        .bind(payment_id.into_uuid())
        .bind(idempotency_key)
        .bind(request_hash)
        .bind(amount.to_string())
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE payment_intents SET status = 'capture_pending', version = version + 1 WHERE id = $1",
        )
        .bind(payment_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        insert_payment_event(
            &mut transaction,
            tenant_id,
            payment_id,
            "capture_requested",
            Some("authorized"),
            "capture_pending",
            None,
        )
        .await?;
        let payment = payment_in(&mut transaction, payment_id).await?;
        let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
        transaction.commit().await?;
        Ok(PreparedOperation {
            payment,
            gateway,
            execute: true,
        })
    }

    pub async fn complete_capture(
        &self,
        payment_id: PaymentId,
        idempotency_key: &str,
        amount: i128,
        outcome: Result<&PaymentOutcome, &PaymentError>,
    ) -> Result<PaymentRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let payment = payment_in_for_update(&mut transaction, payment_id).await?;
        let (operation_status, payment_status, provider_status) = match outcome {
            Ok(result) if result.status == PaymentStatus::Captured => {
                ("succeeded", "captured", result.provider_status.as_str())
            }
            Ok(result) if result.status == PaymentStatus::Pending => {
                ("unknown", "unknown", result.provider_status.as_str())
            }
            Ok(result) => ("failed", "failed", result.provider_status.as_str()),
            Err(PaymentError::UnknownOutcome | PaymentError::Transport(_)) => {
                ("unknown", "unknown", "transport_unknown")
            }
            Err(_) => ("failed", "authorized", "provider_rejected"),
        };
        sqlx::query(
            "UPDATE payment_operations SET status = $3, provider_status = $4 \
             WHERE tenant_id = $1 AND idempotency_key = $2",
        )
        .bind(payment.tenant_id.into_uuid())
        .bind(idempotency_key)
        .bind(operation_status)
        .bind(provider_status)
        .execute(&mut *transaction)
        .await?;
        let captured = if payment_status == "captured" {
            amount.to_string()
        } else {
            payment.captured_amount.clone()
        };
        sqlx::query(
            "UPDATE payment_intents SET status = $2, captured_amount = $3::numeric, \
                 commission_amount = CASE \
                     WHEN $2 = 'captured' AND purpose = 'platform_commission' THEN $3::numeric \
                     ELSE commission_amount END, \
                 provider_status = $4, version = version + 1 WHERE id = $1",
        )
        .bind(payment_id.into_uuid())
        .bind(payment_status)
        .bind(captured)
        .bind(provider_status)
        .execute(&mut *transaction)
        .await?;
        insert_payment_event(
            &mut transaction,
            payment.tenant_id,
            payment_id,
            "capture_result",
            Some(&payment.status),
            payment_status,
            Some(provider_status),
        )
        .await?;
        let result = payment_in(&mut transaction, payment_id).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn prepare_refund(&self, command: &NewRefund) -> Result<PreparedRefund, StoreError> {
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        if let Some(row) = sqlx::query(
            "SELECT id, request_hash, status FROM payment_refunds \
             WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(&command.idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash: Vec<u8> = row.try_get("request_hash")?;
            if stored_hash != command.request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let status: String = row.try_get("status")?;
            let refund_id = RefundId::from_uuid(row.try_get("id")?);
            let payment = payment_in(&mut transaction, command.payment_id).await?;
            let refund = refund_in(&mut transaction, refund_id).await?;
            let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
            transaction.commit().await?;
            return Ok(PreparedRefund {
                payment,
                refund,
                gateway,
                execute: matches!(status.as_str(), "requested" | "unknown"),
            });
        }
        let payment = payment_in_for_update(&mut transaction, command.payment_id).await?;
        if payment.tenant_id != command.tenant_id {
            return Err(StoreError::NotFound("payment"));
        }
        if payment.status != "captured" {
            return Err(StoreError::Conflict(format!(
                "payment status {} cannot be refunded",
                payment.status
            )));
        }
        let totals = sqlx::query(
            "SELECT COALESCE(SUM(amount), 0)::text AS amount, \
                    COALESCE(SUM(commission_reversal_amount), 0)::text AS reversal \
             FROM payment_refunds WHERE payment_id = $1 \
               AND status IN ('requested', 'pending', 'succeeded', 'unknown')",
        )
        .bind(command.payment_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        let reserved_refund = exact(&totals.try_get::<String, _>("amount")?)?;
        let reserved_reversal = exact(&totals.try_get::<String, _>("reversal")?)?;
        let captured = exact(&payment.captured_amount)?;
        let total_commission = exact(&payment.commission_amount)?;
        let reversal = calculate_commission_reversal(
            total_commission,
            captured,
            reserved_refund,
            reserved_reversal,
            command.amount,
        )?;
        sqlx::query(
            "INSERT INTO payment_refunds \
             (id, tenant_id, payment_id, idempotency_key, request_hash, amount, \
              commission_reversal_amount, currency, currency_scale, reason, status) \
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, 'requested')",
        )
        .bind(command.refund_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.payment_id.into_uuid())
        .bind(&command.idempotency_key)
        .bind(&command.request_hash)
        .bind(command.amount.to_string())
        .bind(reversal.to_string())
        .bind(&payment.currency)
        .bind(payment.currency_scale)
        .bind(&command.reason)
        .execute(&mut *transaction)
        .await?;
        let refund = refund_in(&mut transaction, command.refund_id).await?;
        let gateway = gateway_in(&mut transaction, payment.gateway_id).await?;
        transaction.commit().await?;
        Ok(PreparedRefund {
            payment,
            refund,
            gateway,
            execute: true,
        })
    }

    pub async fn complete_refund(
        &self,
        refund_id: RefundId,
        outcome: Result<&RefundOutcome, &PaymentError>,
    ) -> Result<RefundRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let refund = refund_in_for_update(&mut transaction, refund_id).await?;
        let (status, provider_reference, provider_status) = match outcome {
            Ok(value) => (
                value.status.as_str(),
                Some(value.provider_reference.as_str()),
                value.provider_status.as_str(),
            ),
            Err(PaymentError::UnknownOutcome | PaymentError::Transport(_)) => {
                ("unknown", None, "transport_unknown")
            }
            Err(_) => ("failed", None, "provider_rejected"),
        };
        sqlx::query(
            "UPDATE payment_refunds SET status = $2, \
                 provider_reference = COALESCE($3, provider_reference), provider_status = $4, \
                 version = version + 1 \
             WHERE id = $1",
        )
        .bind(refund_id.into_uuid())
        .bind(status)
        .bind(provider_reference)
        .bind(provider_status)
        .execute(&mut *transaction)
        .await?;
        if status == "succeeded" && refund.status != "succeeded" {
            sqlx::query(
                "UPDATE payment_intents SET \
                     refunded_amount = refunded_amount + $2::numeric, \
                     commission_refunded_amount = commission_refunded_amount + $3::numeric, \
                     version = version + 1 WHERE id = $1",
            )
            .bind(refund.payment_id.into_uuid())
            .bind(&refund.amount)
            .bind(&refund.commission_reversal_amount)
            .execute(&mut *transaction)
            .await?;
            let invoices = sqlx::query(
                "SELECT id, tenant_id, offline_deal_id, kind, currency, currency_scale, \
                        billing_details_ciphertext, billing_details_nonce, encryption_key_version, \
                        provider_key, provider_mode, invoice_number \
                 FROM invoice_requests WHERE payment_id = $1 AND status = 'issued' \
                   AND correction_of_invoice_id IS NULL FOR SHARE",
            )
            .bind(refund.payment_id.into_uuid())
            .fetch_all(&mut *transaction)
            .await?;
            for invoice in invoices {
                let kind: String = invoice.try_get("kind")?;
                let correction_amount = if kind == "vehicle_sale" {
                    refund.amount.clone()
                } else {
                    refund.commission_reversal_amount.clone()
                };
                if exact(&correction_amount)? == 0 {
                    continue;
                }
                let original_id: Uuid = invoice.try_get("id")?;
                let correction_id = Uuid::now_v7();
                let idempotency_key = format!("refund:{refund_id}:invoice:{original_id}");
                let request_hash = Sha256::digest(idempotency_key.as_bytes()).to_vec();
                let invoice_number: Option<String> = invoice.try_get("invoice_number")?;
                sqlx::query(
                    "INSERT INTO invoice_requests \
                     (id, tenant_id, payment_id, offline_deal_id, correction_of_invoice_id, kind, \
                      idempotency_key, request_hash, amount, currency, currency_scale, description, \
                      billing_details_ciphertext, billing_details_nonce, encryption_key_version, \
                      status, provider_key, provider_mode, requested_by) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11, $12, \
                             $13, $14, $15, 'red_letter_pending', $16, $17, 'system:refund')",
                )
                .bind(correction_id)
                .bind(invoice.try_get::<Uuid, _>("tenant_id")?)
                .bind(refund.payment_id.into_uuid())
                .bind(invoice.try_get::<Option<Uuid>, _>("offline_deal_id")?)
                .bind(original_id)
                .bind(&kind)
                .bind(&idempotency_key)
                .bind(request_hash)
                .bind(&correction_amount)
                .bind(invoice.try_get::<String, _>("currency")?)
                .bind(invoice.try_get::<i16, _>("currency_scale")?)
                .bind(format!(
                    "Refund correction for invoice {}",
                    invoice_number.as_deref().unwrap_or("unknown")
                ))
                .bind(invoice.try_get::<Vec<u8>, _>("billing_details_ciphertext")?)
                .bind(invoice.try_get::<Vec<u8>, _>("billing_details_nonce")?)
                .bind(invoice.try_get::<i32, _>("encryption_key_version")?)
                .bind(invoice.try_get::<String, _>("provider_key")?)
                .bind(invoice.try_get::<String, _>("provider_mode")?)
                .execute(&mut *transaction)
                .await?;
                sqlx::query(
                    "INSERT INTO invoice_events \
                     (id, tenant_id, invoice_id, event_type, from_status, to_status, actor) \
                     VALUES ($1, $2, $3, 'refund_correction_required', NULL, \
                             'red_letter_pending', 'system:refund')",
                )
                .bind(Uuid::now_v7())
                .bind(invoice.try_get::<Uuid, _>("tenant_id")?)
                .bind(correction_id)
                .execute(&mut *transaction)
                .await?;
            }
        }
        insert_payment_event(
            &mut transaction,
            refund.tenant_id,
            refund.payment_id,
            "refund_result",
            None,
            status,
            Some(provider_status),
        )
        .await?;
        let result = refund_in(&mut transaction, refund_id).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn refund(&self, refund_id: RefundId) -> Result<RefundRecord, StoreError> {
        let row = sqlx::query(REFUND_SELECT)
            .bind(refund_id.into_uuid())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound("refund"))?;
        refund_from_row(&row)
    }
}

const PAYMENT_SELECT: &str = "SELECT id, tenant_id, gateway_id, offline_deal_id, payer_party_id, merchant_order_id, transaction_channel, \
            purpose, gateway_kind, gateway_mode, payment_method, amount::text AS amount, \
            captured_amount::text AS captured_amount, refunded_amount::text AS refunded_amount, \
            commission_amount::text AS commission_amount, \
            commission_refunded_amount::text AS commission_refunded_amount, currency, \
            currency_scale, status, provider_reference, redirect_url, provider_status, version, \
            created_at, updated_at FROM payment_intents WHERE id = $1";

const REFUND_SELECT: &str = "SELECT id, tenant_id, payment_id, amount::text AS amount, \
            commission_reversal_amount::text AS commission_reversal_amount, currency, \
            currency_scale, reason, status, provider_reference, provider_status, version, \
            created_at, updated_at FROM payment_refunds WHERE id = $1";

async fn payment_from_pool(
    pool: &PgPool,
    payment_id: PaymentId,
) -> Result<PaymentRecord, StoreError> {
    let row = sqlx::query(PAYMENT_SELECT)
        .bind(payment_id.into_uuid())
        .fetch_optional(pool)
        .await?
        .ok_or(StoreError::NotFound("payment"))?;
    payment_from_row(&row)
}

async fn payment_in(
    transaction: &mut Transaction<'_, Postgres>,
    payment_id: PaymentId,
) -> Result<PaymentRecord, StoreError> {
    let row = sqlx::query(PAYMENT_SELECT)
        .bind(payment_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StoreError::NotFound("payment"))?;
    payment_from_row(&row)
}

async fn payment_in_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    payment_id: PaymentId,
) -> Result<PaymentRecord, StoreError> {
    let statement = format!("{PAYMENT_SELECT} FOR UPDATE");
    let row = sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(payment_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StoreError::NotFound("payment"))?;
    payment_from_row(&row)
}

fn payment_from_row(row: &sqlx::postgres::PgRow) -> Result<PaymentRecord, StoreError> {
    Ok(PaymentRecord {
        payment_id: PaymentId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        gateway_id: PaymentGatewayId::from_uuid(row.try_get("gateway_id")?),
        offline_deal_id: row
            .try_get::<Option<Uuid>, _>("offline_deal_id")?
            .map(OfflineDealId::from_uuid),
        payer_party_id: row
            .try_get::<Option<Uuid>, _>("payer_party_id")?
            .map(MarketplacePartyId::from_uuid),
        merchant_order_id: row.try_get("merchant_order_id")?,
        transaction_channel: row.try_get("transaction_channel")?,
        purpose: row.try_get("purpose")?,
        gateway_kind: row.try_get("gateway_kind")?,
        gateway_mode: row.try_get("gateway_mode")?,
        payment_method: row.try_get("payment_method")?,
        amount: row.try_get("amount")?,
        captured_amount: row.try_get("captured_amount")?,
        refunded_amount: row.try_get("refunded_amount")?,
        commission_amount: row.try_get("commission_amount")?,
        commission_refunded_amount: row.try_get("commission_refunded_amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        status: row.try_get("status")?,
        provider_reference: row.try_get("provider_reference")?,
        redirect_url: row.try_get("redirect_url")?,
        provider_status: row.try_get("provider_status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn refund_in(
    transaction: &mut Transaction<'_, Postgres>,
    refund_id: RefundId,
) -> Result<RefundRecord, StoreError> {
    let row = sqlx::query(REFUND_SELECT)
        .bind(refund_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StoreError::NotFound("refund"))?;
    refund_from_row(&row)
}

async fn refund_in_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    refund_id: RefundId,
) -> Result<RefundRecord, StoreError> {
    let statement = format!("{REFUND_SELECT} FOR UPDATE");
    let row = sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(refund_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StoreError::NotFound("refund"))?;
    refund_from_row(&row)
}

fn refund_from_row(row: &sqlx::postgres::PgRow) -> Result<RefundRecord, StoreError> {
    Ok(RefundRecord {
        refund_id: RefundId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        payment_id: PaymentId::from_uuid(row.try_get("payment_id")?),
        amount: row.try_get("amount")?,
        commission_reversal_amount: row.try_get("commission_reversal_amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        reason: row.try_get("reason")?,
        status: row.try_get("status")?,
        provider_reference: row.try_get("provider_reference")?,
        provider_status: row.try_get("provider_status")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn gateway_in(
    transaction: &mut Transaction<'_, Postgres>,
    gateway_id: PaymentGatewayId,
) -> Result<GatewayConfig, StoreError> {
    let row = sqlx::query(
        "SELECT id, name, gateway_kind, mode, settings, credential_secret_ref \
         FROM payment_gateway_configs WHERE id = $1 AND enabled",
    )
    .bind(gateway_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StoreError::NotFound("enabled payment gateway"))?;
    gateway_from_row(&row).map_err(StoreError::from)
}

fn gateway_from_row(row: &sqlx::postgres::PgRow) -> Result<GatewayConfig, PaymentError> {
    GatewayConfig::from_parts(
        PaymentGatewayId::from_uuid(
            row.try_get("id")
                .map_err(|error| PaymentError::Invalid(error.to_string()))?,
        ),
        row.try_get("name")
            .map_err(|error| PaymentError::Invalid(error.to_string()))?,
        &row.try_get::<String, _>("gateway_kind")
            .map_err(|error| PaymentError::Invalid(error.to_string()))?,
        &row.try_get::<String, _>("mode")
            .map_err(|error| PaymentError::Invalid(error.to_string()))?,
        row.try_get::<Value, _>("settings")
            .map_err(|error| PaymentError::Invalid(error.to_string()))?,
        row.try_get("credential_secret_ref")
            .map_err(|error| PaymentError::Invalid(error.to_string()))?,
    )
}

async fn serializable(transaction: &mut Transaction<'_, Postgres>) -> Result<(), StoreError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_payment_event(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    payment_id: PaymentId,
    event_type: &str,
    from_status: Option<&str>,
    to_status: &str,
    provider_status: Option<&str>,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO payment_events \
         (id, tenant_id, payment_id, event_type, from_status, to_status, provider_status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(payment_id.into_uuid())
    .bind(event_type)
    .bind(from_status)
    .bind(to_status)
    .bind(provider_status)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn exact(value: &str) -> Result<i128, StoreError> {
    value
        .parse()
        .map_err(|_| StoreError::Invalid("database amount exceeds exact i128".to_owned()))
}

fn reconciliation_transition_allowed(from: &str, to: &str) -> bool {
    from == to
        || match from {
            "requested" | "requires_action" | "pending" | "unknown" => matches!(
                to,
                "requires_action"
                    | "authorized"
                    | "captured"
                    | "voided"
                    | "pending"
                    | "failed"
                    | "unknown"
            ),
            "authorized" => matches!(
                to,
                "authorized" | "captured" | "voided" | "pending" | "failed" | "unknown"
            ),
            "capture_pending" => {
                matches!(
                    to,
                    "authorized" | "captured" | "pending" | "failed" | "unknown"
                )
            }
            "void_pending" => {
                matches!(
                    to,
                    "authorized" | "voided" | "pending" | "failed" | "unknown"
                )
            }
            "captured" | "voided" | "failed" => false,
            _ => false,
        }
}

fn reconciliation_can_become_unknown(status: &str) -> bool {
    matches!(
        status,
        "requested"
            | "requires_action"
            | "authorized"
            | "pending"
            | "capture_pending"
            | "void_pending"
            | "unknown"
    )
}

pub fn is_unknown(error: &PaymentError) -> bool {
    matches!(
        error,
        PaymentError::UnknownOutcome | PaymentError::Transport(_)
    )
}

#[cfg(test)]
mod tests {
    use super::{reconciliation_can_become_unknown, reconciliation_transition_allowed};

    #[test]
    fn reconciliation_never_downgrades_terminal_payments() {
        assert!(reconciliation_transition_allowed("captured", "captured"));
        assert!(!reconciliation_transition_allowed("captured", "pending"));
        assert!(!reconciliation_transition_allowed("voided", "authorized"));
        assert!(!reconciliation_transition_allowed("failed", "captured"));
        assert!(!reconciliation_can_become_unknown("captured"));
    }

    #[test]
    fn reconciliation_can_resolve_ambiguous_payments() {
        assert!(reconciliation_transition_allowed("unknown", "captured"));
        assert!(reconciliation_transition_allowed(
            "capture_pending",
            "authorized"
        ));
        assert!(reconciliation_can_become_unknown("authorized"));
    }
}
