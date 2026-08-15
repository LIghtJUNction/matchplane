//! Root-owned subplatform configuration records.

use matchplane_domain::{DomainId, MarketplacePartyId, TenantId};
use serde::Serialize;
use sqlx::Row;

use crate::{PgStore, StorageError};

/// Mutation submitted by a scoped subplatform administrator.
#[derive(Debug)]
pub struct UpsertSubplatformEmailConfig {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub actor_party_id: MarketplacePartyId,
    pub provider_key: String,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub tls_mode: String,
    pub username: String,
    pub credential_secret_ref: String,
    pub from_address: String,
    pub reply_to: Option<String>,
    pub mode: String,
    pub enabled: bool,
    pub expected_version: Option<i64>,
    pub updated_by: String,
}

/// Email configuration returned to the admin UI without secret material.
#[derive(Debug, Clone, Serialize)]
pub struct SubplatformEmailConfig {
    pub tenant_id: TenantId,
    pub domain_id: DomainId,
    pub provider_key: String,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub tls_mode: String,
    pub username: String,
    pub credential_configured: bool,
    pub from_address: String,
    pub reply_to: Option<String>,
    pub mode: String,
    pub enabled: bool,
    pub version: i64,
    pub updated_by: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: time::OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

impl PgStore {
    /// Reads the current subplatform SMTP configuration for a scoped admin.
    pub async fn subplatform_email_config(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        actor_party_id: MarketplacePartyId,
    ) -> Result<SubplatformEmailConfig, StorageError> {
        self.ensure_subplatform_admin(tenant_id, domain_id, actor_party_id)
            .await?;
        let row = sqlx::query(
            "SELECT tenant_id, domain_id, provider_key, smtp_host, smtp_port, tls_mode, username, \
                    credential_secret_ref IS NOT NULL AS credential_configured, from_address, \
                    reply_to, mode, enabled, version, updated_by, created_at, updated_at \
             FROM subplatform_email_configs WHERE tenant_id = $1 AND domain_id = $2",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::NotFound("subplatform email configuration"))?;
        subplatform_email_config_from_row(&row)
    }

    /// Upserts SMTP routing under the active membership of a subplatform administrator.
    pub async fn upsert_subplatform_email_config(
        &self,
        command: &UpsertSubplatformEmailConfig,
    ) -> Result<SubplatformEmailConfig, StorageError> {
        if command.provider_key.trim().is_empty() || command.provider_key.len() > 100 {
            return Err(StorageError::InvalidData(
                "provider_key must contain 1..=100 bytes".to_owned(),
            ));
        }
        if command.smtp_host.trim().is_empty() || command.smtp_host.len() > 255 {
            return Err(StorageError::InvalidData(
                "smtp_host must contain 1..=255 bytes".to_owned(),
            ));
        }
        if !(1..=65_535).contains(&command.smtp_port) {
            return Err(StorageError::InvalidData(
                "smtp_port must be between 1 and 65535".to_owned(),
            ));
        }
        if !matches!(command.tls_mode.as_str(), "starttls" | "tls" | "plain") {
            return Err(StorageError::InvalidData(
                "tls_mode must be starttls, tls, or plain".to_owned(),
            ));
        }
        if command.credential_secret_ref.len() < 5 || command.credential_secret_ref.len() > 2048 {
            return Err(StorageError::InvalidData(
                "credential_secret_ref must contain 5..=2048 bytes".to_owned(),
            ));
        }
        if !matches!(command.mode.as_str(), "test" | "production") {
            return Err(StorageError::InvalidData(
                "email mode must be test or production".to_owned(),
            ));
        }
        let mut transaction = self.pool().begin().await?;
        ensure_subplatform_admin_in_transaction(
            &mut transaction,
            command.tenant_id,
            command.domain_id,
            command.actor_party_id,
        )
        .await?;
        let current = sqlx::query(
            "SELECT version FROM subplatform_email_configs \
             WHERE tenant_id = $1 AND domain_id = $2 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?;
        let current_version = current
            .as_ref()
            .map(|row| row.try_get::<i64, _>("version"))
            .transpose()?;
        match (current_version, command.expected_version) {
            (Some(version), Some(expected)) if version != expected => {
                return Err(StorageError::Conflict(format!(
                    "subplatform email configuration version is {version}, expected {expected}"
                )));
            }
            (Some(_), None) => {
                return Err(StorageError::Conflict(
                    "existing subplatform email configuration requires expected_version".to_owned(),
                ));
            }
            (None, Some(_)) => {
                return Err(StorageError::Conflict(
                    "new subplatform email configuration must not provide expected_version"
                        .to_owned(),
                ));
            }
            _ => {}
        }
        sqlx::query(
            "INSERT INTO subplatform_email_configs \
             (tenant_id, domain_id, provider_key, smtp_host, smtp_port, tls_mode, username, \
              credential_secret_ref, from_address, reply_to, mode, enabled, updated_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) \
             ON CONFLICT (tenant_id, domain_id) DO UPDATE SET provider_key = EXCLUDED.provider_key, \
                 smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, \
                 tls_mode = EXCLUDED.tls_mode, username = EXCLUDED.username, \
                 credential_secret_ref = EXCLUDED.credential_secret_ref, from_address = EXCLUDED.from_address, \
                 reply_to = EXCLUDED.reply_to, mode = EXCLUDED.mode, enabled = EXCLUDED.enabled, \
                 updated_by = EXCLUDED.updated_by, version = subplatform_email_configs.version + 1",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .bind(&command.provider_key)
        .bind(&command.smtp_host)
        .bind(command.smtp_port)
        .bind(&command.tls_mode)
        .bind(&command.username)
        .bind(&command.credential_secret_ref)
        .bind(&command.from_address)
        .bind(&command.reply_to)
        .bind(&command.mode)
        .bind(command.enabled)
        .bind(&command.updated_by)
        .execute(&mut *transaction)
        .await?;
        let row = sqlx::query(
            "SELECT tenant_id, domain_id, provider_key, smtp_host, smtp_port, tls_mode, username, \
                    credential_secret_ref IS NOT NULL AS credential_configured, from_address, \
                    reply_to, mode, enabled, version, updated_by, created_at, updated_at \
             FROM subplatform_email_configs WHERE tenant_id = $1 AND domain_id = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.domain_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        let config = subplatform_email_config_from_row(&row)?;
        transaction.commit().await?;
        Ok(config)
    }

    async fn ensure_subplatform_admin(
        &self,
        tenant_id: TenantId,
        domain_id: DomainId,
        party_id: MarketplacePartyId,
    ) -> Result<(), StorageError> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM marketplace_subplatform_memberships \
             WHERE tenant_id = $1 AND domain_id = $2 AND party_id = $3 \
               AND role = 'admin' AND status = 'active')",
        )
        .bind(tenant_id.into_uuid())
        .bind(domain_id.into_uuid())
        .bind(party_id.into_uuid())
        .fetch_one(self.pool())
        .await?;
        if exists {
            Ok(())
        } else {
            Err(StorageError::Forbidden(
                "active subplatform admin membership is required".to_owned(),
            ))
        }
    }
}

async fn ensure_subplatform_admin_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    tenant_id: TenantId,
    domain_id: DomainId,
    party_id: MarketplacePartyId,
) -> Result<(), StorageError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM marketplace_subplatform_memberships \
         WHERE tenant_id = $1 AND domain_id = $2 AND party_id = $3 \
           AND role = 'admin' AND status = 'active')",
    )
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(party_id.into_uuid())
    .fetch_one(&mut **transaction)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(StorageError::Forbidden(
            "active subplatform admin membership is required".to_owned(),
        ))
    }
}

fn subplatform_email_config_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<SubplatformEmailConfig, StorageError> {
    Ok(SubplatformEmailConfig {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: DomainId::from_uuid(row.try_get("domain_id")?),
        provider_key: row.try_get("provider_key")?,
        smtp_host: row.try_get("smtp_host")?,
        smtp_port: row.try_get("smtp_port")?,
        tls_mode: row.try_get("tls_mode")?,
        username: row.try_get("username")?,
        credential_configured: row.try_get("credential_configured")?,
        from_address: row.try_get("from_address")?,
        reply_to: row.try_get("reply_to")?,
        mode: row.try_get("mode")?,
        enabled: row.try_get("enabled")?,
        version: row.try_get("version")?,
        updated_by: row.try_get("updated_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}
