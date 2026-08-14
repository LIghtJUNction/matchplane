use matchplane_domain::{InvoiceId, OfflineDealId, PaymentId, TenantId};
use matchplane_payments::{InvoiceKind, InvoiceOutcome, PaymentError};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::store::StoreError;

#[derive(Debug, Clone, Serialize)]
pub struct InvoiceRecord {
    pub invoice_id: InvoiceId,
    pub tenant_id: TenantId,
    pub payment_id: Option<PaymentId>,
    pub offline_deal_id: Option<OfflineDealId>,
    pub correction_of_invoice_id: Option<InvoiceId>,
    pub kind: String,
    pub amount: String,
    pub currency: String,
    pub currency_scale: i16,
    pub description: String,
    pub status: String,
    pub provider_key: String,
    pub provider_mode: String,
    pub provider_reference: Option<String>,
    pub invoice_number: Option<String>,
    pub failure_reason: Option<String>,
    pub requested_by: String,
    pub reviewed_by: Option<String>,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub requested_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub issued_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(skip)]
    pub billing_details_ciphertext: Vec<u8>,
    #[serde(skip)]
    pub billing_details_nonce: Vec<u8>,
    #[serde(skip)]
    pub encryption_key_version: i32,
}

#[derive(Debug)]
pub struct NewInvoice {
    pub invoice_id: InvoiceId,
    pub tenant_id: TenantId,
    pub payment_id: Option<PaymentId>,
    pub offline_deal_id: Option<OfflineDealId>,
    pub kind: InvoiceKind,
    pub idempotency_key: String,
    pub request_hash: Vec<u8>,
    pub amount: i128,
    pub currency: String,
    pub currency_scale: i16,
    pub description: String,
    pub billing_details_ciphertext: Vec<u8>,
    pub billing_details_nonce: Vec<u8>,
    pub encryption_key_version: i32,
    pub requested_by: String,
}

#[derive(Debug)]
pub struct PreparedInvoice {
    pub invoice: InvoiceRecord,
    pub duplicate: bool,
}

#[derive(Debug, Clone)]
pub struct InvoiceProviderConfig {
    pub provider_key: String,
    pub settings: Value,
    pub credential_secret_ref: String,
}

#[derive(Debug)]
pub struct EncryptedArtifact {
    pub media_type: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i32,
    pub content_hash: Vec<u8>,
}

#[derive(Debug)]
pub struct StoredArtifact {
    pub invoice_id: InvoiceId,
    pub media_type: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i32,
    pub content_hash: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct InvoiceStore {
    pool: PgPool,
}

impl InvoiceStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn request(&self, command: &NewInvoice) -> Result<PreparedInvoice, StoreError> {
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        if let Some(row) = sqlx::query(
            "SELECT id, request_hash FROM invoice_requests \
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
            let invoice = invoice_in(
                &mut transaction,
                InvoiceId::from_uuid(row.try_get("id")?),
                false,
            )
            .await?;
            transaction.commit().await?;
            return Ok(PreparedInvoice {
                invoice,
                duplicate: true,
            });
        }
        validate_invoice_source(&mut transaction, command).await?;
        let provider = sqlx::query(
            "SELECT c.provider_key, c.mode FROM invoice_settings s \
             JOIN invoice_provider_configs c ON c.id = s.active_provider_id \
             WHERE s.tenant_id = $1 AND c.enabled AND c.mode = s.active_mode FOR SHARE OF c",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("active invoice provider"))?;
        let provider_key: String = provider.try_get("provider_key")?;
        let provider_mode: String = provider.try_get("mode")?;
        sqlx::query(
            "INSERT INTO invoice_requests \
             (id, tenant_id, payment_id, offline_deal_id, kind, idempotency_key, request_hash, \
              amount, currency, currency_scale, description, billing_details_ciphertext, billing_details_nonce, \
              encryption_key_version, provider_key, provider_mode, requested_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
        )
        .bind(command.invoice_id.into_uuid())
        .bind(command.tenant_id.into_uuid())
        .bind(command.payment_id.map(PaymentId::into_uuid))
        .bind(command.offline_deal_id.map(OfflineDealId::into_uuid))
        .bind(invoice_kind_text(command.kind))
        .bind(&command.idempotency_key)
        .bind(&command.request_hash)
        .bind(command.amount.to_string())
        .bind(&command.currency)
        .bind(command.currency_scale)
        .bind(&command.description)
        .bind(&command.billing_details_ciphertext)
        .bind(&command.billing_details_nonce)
        .bind(command.encryption_key_version)
        .bind(provider_key)
        .bind(provider_mode)
        .bind(&command.requested_by)
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            command.tenant_id,
            command.invoice_id,
            "invoice_requested",
            None,
            "requested",
            &command.requested_by,
        )
        .await?;
        let invoice = invoice_in(&mut transaction, command.invoice_id, false).await?;
        transaction.commit().await?;
        Ok(PreparedInvoice {
            invoice,
            duplicate: false,
        })
    }

    pub async fn invoice(&self, invoice_id: InvoiceId) -> Result<InvoiceRecord, StoreError> {
        let row = sqlx::query(INVOICE_SELECT)
            .bind(invoice_id.into_uuid())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound("invoice"))?;
        invoice_from_row(&row)
    }

    pub async fn provider_config(
        &self,
        invoice: &InvoiceRecord,
    ) -> Result<InvoiceProviderConfig, StoreError> {
        let row = sqlx::query(
            "SELECT provider_key, mode, settings, credential_secret_ref \
             FROM invoice_provider_configs \
             WHERE tenant_id = $1 AND provider_key = $2 AND mode = $3 AND enabled",
        )
        .bind(invoice.tenant_id.into_uuid())
        .bind(&invoice.provider_key)
        .bind(&invoice.provider_mode)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound("invoice provider configuration"))?;
        let credential_secret_ref = row
            .try_get::<Option<String>, _>("credential_secret_ref")?
            .ok_or_else(|| {
                StoreError::Invalid("invoice provider credential is missing".to_owned())
            })?;
        Ok(InvoiceProviderConfig {
            provider_key: row.try_get("provider_key")?,
            settings: row.try_get("settings")?,
            credential_secret_ref,
        })
    }

    pub async fn corrections(
        &self,
        invoice_id: InvoiceId,
    ) -> Result<Vec<InvoiceRecord>, StoreError> {
        let statement = INVOICE_SELECT.replacen(
            "WHERE id = $1",
            "WHERE correction_of_invoice_id = $1 ORDER BY requested_at",
            1,
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(invoice_id.into_uuid())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(invoice_from_row).collect()
    }

    pub async fn begin_issue(
        &self,
        invoice_id: InvoiceId,
        actor: &str,
    ) -> Result<InvoiceRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, invoice_id, true).await?;
        if !matches!(
            invoice.status.as_str(),
            "requested" | "reviewing" | "failed"
        ) {
            return Err(StoreError::Conflict(format!(
                "invoice status {} cannot be issued",
                invoice.status
            )));
        }
        sqlx::query(
            "UPDATE invoice_requests SET status = 'issuing', reviewed_by = $2, \
                 failure_reason = NULL, version = version + 1 WHERE id = $1",
        )
        .bind(invoice_id.into_uuid())
        .bind(actor)
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            invoice.tenant_id,
            invoice_id,
            "invoice_issue_started",
            Some(&invoice.status),
            "issuing",
            actor,
        )
        .await?;
        let result = invoice_in(&mut transaction, invoice_id, false).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn complete_issue(
        &self,
        outcome: &InvoiceOutcome,
        artifact: Option<&EncryptedArtifact>,
        actor: &str,
    ) -> Result<InvoiceRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, outcome.invoice_id, true).await?;
        if invoice.status != "issuing" {
            return Err(StoreError::Conflict(format!(
                "invoice status {} cannot accept issuance",
                invoice.status
            )));
        }
        sqlx::query(
            "UPDATE invoice_requests SET status = $2, provider_reference = $3, invoice_number = $4, \
                 issued_at = CASE WHEN $2 = 'issued' THEN clock_timestamp() ELSE issued_at END, \
                 version = version + 1 WHERE id = $1",
        )
        .bind(outcome.invoice_id.into_uuid())
        .bind(outcome.status.as_str())
        .bind(&outcome.provider_reference)
        .bind(&outcome.invoice_number)
        .execute(&mut *transaction)
        .await?;
        if let Some(artifact) = artifact {
            insert_artifact(&mut transaction, outcome.invoice_id, "invoice", artifact).await?;
        }
        insert_event(
            &mut transaction,
            invoice.tenant_id,
            outcome.invoice_id,
            "invoice_issued",
            Some("issuing"),
            outcome.status.as_str(),
            actor,
        )
        .await?;
        let result = invoice_in(&mut transaction, outcome.invoice_id, false).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn fail_issue(
        &self,
        invoice_id: InvoiceId,
        reason: &str,
        actor: &str,
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, invoice_id, true).await?;
        if invoice.status == "issuing" {
            sqlx::query(
                "UPDATE invoice_requests SET status = 'failed', failure_reason = $2, \
                     version = version + 1 WHERE id = $1",
            )
            .bind(invoice_id.into_uuid())
            .bind(reason)
            .execute(&mut *transaction)
            .await?;
            insert_event(
                &mut transaction,
                invoice.tenant_id,
                invoice_id,
                "invoice_issue_failed",
                Some("issuing"),
                "failed",
                actor,
            )
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn void(
        &self,
        invoice_id: InvoiceId,
        actor: &str,
    ) -> Result<InvoiceRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, invoice_id, true).await?;
        if !matches!(
            invoice.status.as_str(),
            "requested" | "reviewing" | "failed"
        ) {
            return Err(StoreError::Conflict(
                "issued invoices require a red-letter correction, not void".to_owned(),
            ));
        }
        sqlx::query(
            "UPDATE invoice_requests SET status = 'voided', version = version + 1 WHERE id = $1",
        )
        .bind(invoice_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        insert_event(
            &mut transaction,
            invoice.tenant_id,
            invoice_id,
            "invoice_voided",
            Some(&invoice.status),
            "voided",
            actor,
        )
        .await?;
        let result = invoice_in(&mut transaction, invoice_id, false).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn begin_red_letter(
        &self,
        invoice_id: InvoiceId,
        actor: &str,
    ) -> Result<InvoiceRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, invoice_id, true).await?;
        if invoice.correction_of_invoice_id.is_none() || invoice.status != "red_letter_pending" {
            return Err(StoreError::Conflict(format!(
                "invoice status {} cannot be red-lettered",
                invoice.status
            )));
        }
        insert_event(
            &mut transaction,
            invoice.tenant_id,
            invoice_id,
            "red_letter_issue_started",
            Some("red_letter_pending"),
            "red_letter_pending",
            actor,
        )
        .await?;
        let result = invoice_in(&mut transaction, invoice_id, false).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn complete_red_letter(
        &self,
        outcome: &InvoiceOutcome,
        artifact: Option<&EncryptedArtifact>,
        actor: &str,
    ) -> Result<InvoiceRecord, StoreError> {
        let mut transaction = self.pool.begin().await?;
        let invoice = invoice_in(&mut transaction, outcome.invoice_id, true).await?;
        if invoice.status != "red_letter_pending" {
            return Err(StoreError::Conflict(format!(
                "invoice status {} cannot accept a credit note",
                invoice.status
            )));
        }
        sqlx::query(
            "UPDATE invoice_requests SET status = 'red_lettered', provider_reference = $2, \
                 invoice_number = $3, issued_at = clock_timestamp(), version = version + 1 \
             WHERE id = $1",
        )
        .bind(outcome.invoice_id.into_uuid())
        .bind(&outcome.provider_reference)
        .bind(&outcome.invoice_number)
        .execute(&mut *transaction)
        .await?;
        if let Some(artifact) = artifact {
            insert_artifact(
                &mut transaction,
                outcome.invoice_id,
                "credit_note",
                artifact,
            )
            .await?;
        }
        insert_event(
            &mut transaction,
            invoice.tenant_id,
            outcome.invoice_id,
            "red_letter_issued",
            Some("red_letter_pending"),
            "red_lettered",
            actor,
        )
        .await?;
        let result = invoice_in(&mut transaction, outcome.invoice_id, false).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn artifact(
        &self,
        invoice_id: InvoiceId,
        kind: &str,
    ) -> Result<StoredArtifact, StoreError> {
        let row = sqlx::query(
            "SELECT invoice_id, media_type, inline_content_ciphertext, content_nonce, \
                    encryption_key_version, content_hash FROM invoice_artifacts \
             WHERE invoice_id = $1 AND artifact_kind = $2",
        )
        .bind(invoice_id.into_uuid())
        .bind(kind)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound("invoice artifact"))?;
        Ok(StoredArtifact {
            invoice_id: InvoiceId::from_uuid(row.try_get("invoice_id")?),
            media_type: row.try_get("media_type")?,
            ciphertext: row.try_get("inline_content_ciphertext").map_err(|_| {
                StoreError::Invalid("external artifact storage is not configured".to_owned())
            })?,
            nonce: row.try_get("content_nonce")?,
            key_version: row.try_get("encryption_key_version")?,
            content_hash: row.try_get("content_hash")?,
        })
    }
}

const INVOICE_SELECT: &str = "SELECT id, tenant_id, payment_id, offline_deal_id, correction_of_invoice_id, kind, amount::text AS amount, currency, \
            currency_scale, description, billing_details_ciphertext, billing_details_nonce, encryption_key_version, \
            status, provider_key, provider_mode, provider_reference, invoice_number, failure_reason, \
            requested_by, reviewed_by, version, requested_at, issued_at, updated_at \
     FROM invoice_requests WHERE id = $1";

async fn invoice_in(
    transaction: &mut Transaction<'_, Postgres>,
    invoice_id: InvoiceId,
    for_update: bool,
) -> Result<InvoiceRecord, StoreError> {
    let statement = if for_update {
        format!("{INVOICE_SELECT} FOR UPDATE")
    } else {
        INVOICE_SELECT.to_owned()
    };
    let row = sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(invoice_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or(StoreError::NotFound("invoice"))?;
    invoice_from_row(&row)
}

fn invoice_from_row(row: &sqlx::postgres::PgRow) -> Result<InvoiceRecord, StoreError> {
    Ok(InvoiceRecord {
        invoice_id: InvoiceId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        payment_id: row
            .try_get::<Option<Uuid>, _>("payment_id")?
            .map(PaymentId::from_uuid),
        offline_deal_id: row
            .try_get::<Option<Uuid>, _>("offline_deal_id")?
            .map(OfflineDealId::from_uuid),
        correction_of_invoice_id: row
            .try_get::<Option<Uuid>, _>("correction_of_invoice_id")?
            .map(InvoiceId::from_uuid),
        kind: row.try_get("kind")?,
        amount: row.try_get("amount")?,
        currency: row.try_get("currency")?,
        currency_scale: row.try_get("currency_scale")?,
        description: row.try_get("description")?,
        status: row.try_get("status")?,
        provider_key: row.try_get("provider_key")?,
        provider_mode: row.try_get("provider_mode")?,
        provider_reference: row.try_get("provider_reference")?,
        invoice_number: row.try_get("invoice_number")?,
        failure_reason: row.try_get("failure_reason")?,
        requested_by: row.try_get("requested_by")?,
        reviewed_by: row.try_get("reviewed_by")?,
        version: row.try_get("version")?,
        requested_at: row.try_get("requested_at")?,
        issued_at: row.try_get("issued_at")?,
        updated_at: row.try_get("updated_at")?,
        billing_details_ciphertext: row.try_get("billing_details_ciphertext")?,
        billing_details_nonce: row.try_get("billing_details_nonce")?,
        encryption_key_version: row.try_get("encryption_key_version")?,
    })
}

async fn validate_invoice_source(
    transaction: &mut Transaction<'_, Postgres>,
    command: &NewInvoice,
) -> Result<(), StoreError> {
    match (command.payment_id, command.offline_deal_id, command.kind) {
        (Some(payment_id), _, kind) => {
            let row = sqlx::query(
                "SELECT status, purpose, offline_deal_id, captured_amount::text AS captured_amount, \
                        refunded_amount::text AS refunded_amount, commission_amount::text AS commission_amount, \
                        commission_refunded_amount::text AS commission_refunded_amount, currency, currency_scale \
                 FROM payment_intents WHERE tenant_id = $1 AND id = $2 FOR SHARE",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(payment_id.into_uuid())
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or(StoreError::NotFound("invoice payment"))?;
            let payment_offline_deal_id = row
                .try_get::<Option<Uuid>, _>("offline_deal_id")?
                .map(OfflineDealId::from_uuid);
            if payment_offline_deal_id != command.offline_deal_id {
                return Err(StoreError::Invalid(
                    "invoice source deal must match the payment's offline deal".to_owned(),
                ));
            }
            let status: String = row.try_get("status")?;
            if status != "captured" {
                return Err(StoreError::Conflict(
                    "invoice requires a captured payment".to_owned(),
                ));
            }
            let purpose: String = row.try_get("purpose")?;
            if matches!(kind, InvoiceKind::VehicleSale) && purpose != "vehicle_purchase" {
                return Err(StoreError::Invalid(
                    "vehicle-sale invoices require a vehicle_purchase payment".to_owned(),
                ));
            }
            let captured = exact(&row.try_get::<String, _>("captured_amount")?)?;
            let refunded = exact(&row.try_get::<String, _>("refunded_amount")?)?;
            let commission = exact(&row.try_get::<String, _>("commission_amount")?)?;
            let commission_refunded =
                exact(&row.try_get::<String, _>("commission_refunded_amount")?)?;
            let expected = match kind {
                InvoiceKind::VehicleSale => captured.checked_sub(refunded),
                InvoiceKind::PlatformCommission if purpose == "platform_commission" => {
                    captured.checked_sub(refunded)
                }
                InvoiceKind::PlatformCommission => commission.checked_sub(commission_refunded),
            }
            .ok_or_else(|| StoreError::Invalid("invoice source amount underflow".to_owned()))?;
            if command.amount != expected
                || command.currency != row.try_get::<String, _>("currency")?
                || command.currency_scale != row.try_get::<i16, _>("currency_scale")?
            {
                return Err(StoreError::Invalid(
                    "invoice total must equal the current refundable source amount".to_owned(),
                ));
            }
        }
        (None, Some(deal_id), InvoiceKind::VehicleSale) => {
            let row = sqlx::query(
                "SELECT status, final_amount::text AS final_amount, currency, currency_scale \
                 FROM offline_deals WHERE tenant_id = $1 AND id = $2 FOR SHARE",
            )
            .bind(command.tenant_id.into_uuid())
            .bind(deal_id.into_uuid())
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or(StoreError::NotFound("offline deal"))?;
            if row.try_get::<String, _>("status")? != "completed"
                || command.amount != exact(&row.try_get::<String, _>("final_amount")?)?
                || command.currency != row.try_get::<String, _>("currency")?
                || command.currency_scale != row.try_get::<i16, _>("currency_scale")?
            {
                return Err(StoreError::Invalid(
                    "offline vehicle invoice must equal the completed deal amount".to_owned(),
                ));
            }
        }
        _ => {
            return Err(StoreError::Invalid(
                "vehicle invoices require a payment or completed offline deal; commission invoices require a payment"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

async fn insert_artifact(
    transaction: &mut Transaction<'_, Postgres>,
    invoice_id: InvoiceId,
    kind: &str,
    artifact: &EncryptedArtifact,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO invoice_artifacts \
         (id, invoice_id, artifact_kind, media_type, inline_content_ciphertext, content_nonce, \
          encryption_key_version, content_hash) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (invoice_id, artifact_kind) DO UPDATE SET media_type = EXCLUDED.media_type, \
             inline_content_ciphertext = EXCLUDED.inline_content_ciphertext, \
             content_nonce = EXCLUDED.content_nonce, \
             encryption_key_version = EXCLUDED.encryption_key_version, \
             content_hash = EXCLUDED.content_hash",
    )
    .bind(Uuid::now_v7())
    .bind(invoice_id.into_uuid())
    .bind(kind)
    .bind(&artifact.media_type)
    .bind(&artifact.ciphertext)
    .bind(&artifact.nonce)
    .bind(artifact.key_version)
    .bind(&artifact.content_hash)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_event(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    invoice_id: InvoiceId,
    event_type: &str,
    from_status: Option<&str>,
    to_status: &str,
    actor: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO invoice_events \
         (id, tenant_id, invoice_id, event_type, from_status, to_status, actor) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(invoice_id.into_uuid())
    .bind(event_type)
    .bind(from_status)
    .bind(to_status)
    .bind(actor)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn serializable(transaction: &mut Transaction<'_, Postgres>) -> Result<(), StoreError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

const fn invoice_kind_text(kind: InvoiceKind) -> &'static str {
    match kind {
        InvoiceKind::VehicleSale => "vehicle_sale",
        InvoiceKind::PlatformCommission => "platform_commission",
    }
}

fn exact(value: &str) -> Result<i128, StoreError> {
    value
        .parse()
        .map_err(|_| StoreError::Invalid("database amount exceeds exact i128".to_owned()))
}

pub fn invoice_kind(value: &str) -> Result<InvoiceKind, PaymentError> {
    match value {
        "vehicle_sale" => Ok(InvoiceKind::VehicleSale),
        "platform_commission" => Ok(InvoiceKind::PlatformCommission),
        _ => Err(PaymentError::Invalid(format!(
            "unknown invoice kind {value}"
        ))),
    }
}
