use std::str::FromStr;

use matchplane_config::Environment;
use matchplane_domain::{PaymentGatewayId, TenantId};
use matchplane_payments::{GatewayKind, GatewayMode, HttpInvoiceProvider};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    gateways::{GatewayConfig, GatewayFactory, resolve_secret, resolve_secret_digest},
    store::StoreError,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GatewayMutation {
    pub gateway_id: Option<PaymentGatewayId>,
    pub tenant_id: TenantId,
    pub name: String,
    pub kind: GatewayKind,
    pub mode: GatewayMode,
    pub settings: Value,
    pub credential_secret_ref: Option<String>,
    pub enabled: bool,
    pub expected_version: Option<i64>,
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayRecord {
    pub gateway_id: PaymentGatewayId,
    pub tenant_id: TenantId,
    pub name: String,
    pub kind: GatewayKind,
    pub mode: GatewayMode,
    pub settings: Value,
    /// Whether credentials are configured. The secret file/environment reference is never
    /// returned to API clients.
    pub credential_configured: bool,
    pub enabled: bool,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RouteMutation {
    pub route_id: Option<Uuid>,
    pub tenant_id: TenantId,
    pub gateway_id: PaymentGatewayId,
    pub method_code: String,
    pub currency: String,
    pub priority: i32,
    pub enabled: bool,
    pub expected_version: Option<i64>,
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteRecord {
    pub route_id: Uuid,
    pub tenant_id: TenantId,
    pub gateway_id: PaymentGatewayId,
    pub method_code: String,
    pub currency: String,
    pub priority: i32,
    pub enabled: bool,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModeSwitch {
    pub tenant_id: TenantId,
    pub mode: GatewayMode,
    pub expected_version: i64,
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentSetting {
    pub tenant_id: TenantId,
    pub active_mode: GatewayMode,
    pub updated_by: String,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InvoiceProviderMutation {
    pub provider_id: Option<Uuid>,
    pub tenant_id: TenantId,
    pub name: String,
    pub provider_key: String,
    pub mode: GatewayMode,
    pub settings: Value,
    pub credential_secret_ref: Option<String>,
    pub enabled: bool,
    pub expected_version: Option<i64>,
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvoiceProviderRecord {
    pub provider_id: Uuid,
    pub tenant_id: TenantId,
    pub name: String,
    pub provider_key: String,
    pub mode: GatewayMode,
    pub settings: Value,
    /// Whether a credential reference is configured. The reference itself is never returned.
    pub credential_configured: bool,
    pub enabled: bool,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InvoiceModeSwitch {
    pub tenant_id: TenantId,
    pub mode: GatewayMode,
    pub provider_id: Option<Uuid>,
    pub expected_version: i64,
    pub actor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvoiceSetting {
    pub tenant_id: TenantId,
    pub active_mode: GatewayMode,
    pub active_provider_id: Uuid,
    pub updated_by: String,
    pub version: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct AdminStore {
    pool: PgPool,
    environment: Environment,
}

impl AdminStore {
    pub fn new(pool: PgPool, environment: Environment) -> Self {
        Self { pool, environment }
    }

    pub async fn gateways(&self, tenant_id: TenantId) -> Result<Vec<GatewayRecord>, StoreError> {
        let rows = sqlx::query(GATEWAY_SELECT_TENANT)
            .bind(tenant_id.into_uuid())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(gateway_from_row).collect()
    }

    pub async fn invoice_providers(
        &self,
        tenant_id: TenantId,
    ) -> Result<Vec<InvoiceProviderRecord>, StoreError> {
        let rows = sqlx::query(INVOICE_PROVIDER_SELECT_TENANT)
            .bind(tenant_id.into_uuid())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(invoice_provider_from_row).collect()
    }

    pub async fn mutate_invoice_provider(
        &self,
        mutation: &InvoiceProviderMutation,
    ) -> Result<InvoiceProviderRecord, StoreError> {
        validate_invoice_provider(mutation)?;
        if self.environment == Environment::Production && mutation.mode == GatewayMode::Test {
            return Err(StoreError::Invalid(
                "test invoice providers cannot be configured in production".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let provider_id = mutation.provider_id.unwrap_or_else(Uuid::now_v7);
        let before = invoice_provider_in_optional(&mut transaction, provider_id, true).await?;
        if let Some(current) = before.as_ref() {
            let has_invoice_history: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM invoice_requests \
                 WHERE tenant_id = $1 AND provider_key = $2 AND provider_mode = $3)",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(&current.provider_key)
            .bind(current.mode.as_str())
            .fetch_one(&mut *transaction)
            .await?;
            if has_invoice_history {
                return Err(StoreError::Conflict(
                    "invoice provider configuration is immutable after invoice history exists; create a new provider for rotation"
                        .to_owned(),
                ));
            }
            let active_mode: Option<String> = sqlx::query_scalar(
                "SELECT active_mode FROM invoice_settings \
                 WHERE tenant_id = $1 AND active_provider_id = $2 FOR UPDATE",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(provider_id)
            .fetch_optional(&mut *transaction)
            .await?;
            if active_mode
                .as_deref()
                .is_some_and(|mode| mode != mutation.mode.as_str() || !mutation.enabled)
            {
                return Err(StoreError::Conflict(
                    "the active invoice provider must remain enabled and in the active mode"
                        .to_owned(),
                ));
            }
        }
        let credential_digest = mutation
            .credential_secret_ref
            .as_deref()
            .map(resolve_secret_digest)
            .transpose()?;
        let action = if let Some(current) = &before {
            if current.tenant_id != mutation.tenant_id {
                return Err(StoreError::NotFound("invoice provider"));
            }
            if mutation.expected_version != Some(current.version) {
                return Err(StoreError::Conflict(format!(
                    "invoice provider version is {}, expected {:?}",
                    current.version, mutation.expected_version
                )));
            }
            let result = sqlx::query(
                "UPDATE invoice_provider_configs SET name = $3, provider_key = $4, mode = $5, \
                     settings = $6, credential_secret_ref = $7, credential_secret_digest = $8, \
                     enabled = $9, version = version + 1 \
                 WHERE tenant_id = $1 AND id = $2 AND version = $10",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(provider_id)
            .bind(&mutation.name)
            .bind(&mutation.provider_key)
            .bind(mutation.mode.as_str())
            .bind(&mutation.settings)
            .bind(&mutation.credential_secret_ref)
            .bind(&credential_digest)
            .bind(mutation.enabled)
            .bind(current.version)
            .execute(&mut *transaction)
            .await?;
            if result.rows_affected() != 1 {
                return Err(StoreError::Conflict(
                    "invoice provider was concurrently modified".to_owned(),
                ));
            }
            "provider_updated"
        } else {
            if mutation.expected_version.is_some() {
                return Err(StoreError::Conflict(
                    "new invoice provider must not provide expected_version".to_owned(),
                ));
            }
            sqlx::query(
                "INSERT INTO invoice_provider_configs \
                 (id, tenant_id, provider_key, name, mode, settings, credential_secret_ref, \
                  credential_secret_digest, enabled) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(provider_id)
            .bind(mutation.tenant_id.into_uuid())
            .bind(&mutation.provider_key)
            .bind(&mutation.name)
            .bind(mutation.mode.as_str())
            .bind(&mutation.settings)
            .bind(&mutation.credential_secret_ref)
            .bind(&credential_digest)
            .bind(mutation.enabled)
            .execute(&mut *transaction)
            .await?;
            "provider_created"
        };
        let after = invoice_provider_in_optional(&mut transaction, provider_id, false)
            .await?
            .ok_or(StoreError::NotFound("invoice provider"))?;
        audit_invoice_config(
            &mut transaction,
            mutation.tenant_id,
            &mutation.actor,
            action,
            provider_id,
            before.as_ref().map(serde_json::to_value).transpose()?,
            serde_json::to_value(&after)?,
            &mutation.reason,
        )
        .await?;
        transaction.commit().await?;
        Ok(after)
    }

    pub async fn invoice_setting(&self, tenant_id: TenantId) -> Result<InvoiceSetting, StoreError> {
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, active_provider_id, updated_by, version, updated_at \
             FROM invoice_settings WHERE tenant_id = $1",
        )
        .bind(tenant_id.into_uuid())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound("invoice settings"))?;
        invoice_setting_from_row(&row)
    }

    pub async fn switch_invoice_mode(
        &self,
        command: &InvoiceModeSwitch,
    ) -> Result<InvoiceSetting, StoreError> {
        validate_actor_reason(&command.actor, &command.reason)?;
        if self.environment == Environment::Production && command.mode == GatewayMode::Test {
            return Err(StoreError::Invalid(
                "production cannot switch to test invoice mode".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, active_provider_id, updated_by, version, updated_at \
             FROM invoice_settings WHERE tenant_id = $1 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("invoice settings"))?;
        let current = invoice_setting_from_row(&row)?;
        if current.version != command.expected_version {
            return Err(StoreError::Conflict(format!(
                "invoice settings version is {}, expected {}",
                current.version, command.expected_version
            )));
        }
        let provider = sqlx::query(
            "SELECT id, provider_key, mode, settings, credential_secret_ref, credential_secret_digest \
             FROM invoice_provider_configs \
             WHERE tenant_id = $1 AND enabled AND mode = $2 \
               AND ($3::uuid IS NULL OR id = $3) \
             ORDER BY (id = $3) DESC, created_at ASC LIMIT 1 FOR SHARE",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.mode.as_str())
        .bind(command.provider_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::Conflict(format!(
            "{} mode has no enabled invoice provider",
            command.mode.as_str()
        )))?;
        validate_invoice_provider_row(&provider)?;
        let provider_id: Uuid = provider.try_get("id")?;
        if current.active_mode == command.mode && current.active_provider_id == provider_id {
            transaction.commit().await?;
            return Ok(current);
        }
        let outstanding: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM invoice_requests WHERE tenant_id = $1 AND provider_mode = $2 \
             AND status IN ('requested', 'reviewing', 'issuing', 'red_letter_pending')",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(current.active_mode.as_str())
        .fetch_one(&mut *transaction)
        .await?;
        if outstanding > 0 {
            return Err(StoreError::Conflict(format!(
                "cannot switch invoice modes while {outstanding} invoice(s) are outstanding"
            )));
        }
        let new_version = current.version + 1;
        let result = sqlx::query(
            "UPDATE invoice_settings SET active_mode = $2, active_provider_id = $3, \
                 updated_by = $4, version = $5 WHERE tenant_id = $1 AND version = $6",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.mode.as_str())
        .bind(provider_id)
        .bind(&command.actor)
        .bind(new_version)
        .bind(current.version)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StoreError::Conflict(
                "invoice settings were concurrently modified".to_owned(),
            ));
        }
        sqlx::query(
            "INSERT INTO invoice_mode_audit \
             (id, tenant_id, old_mode, new_mode, old_provider_id, new_provider_id, \
              old_version, new_version, actor, reason) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(Uuid::now_v7())
        .bind(command.tenant_id.into_uuid())
        .bind(current.active_mode.as_str())
        .bind(command.mode.as_str())
        .bind(current.active_provider_id)
        .bind(provider_id)
        .bind(current.version)
        .bind(new_version)
        .bind(&command.actor)
        .bind(&command.reason)
        .execute(&mut *transaction)
        .await?;
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, active_provider_id, updated_by, version, updated_at \
             FROM invoice_settings WHERE tenant_id = $1",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        let result = invoice_setting_from_row(&row)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn mutate_gateway(
        &self,
        mutation: &GatewayMutation,
    ) -> Result<GatewayRecord, StoreError> {
        validate_gateway(mutation)?;
        if self.environment == Environment::Production && mutation.mode == GatewayMode::Test {
            return Err(StoreError::Invalid(
                "test payment gateways cannot be configured in production".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let gateway_id = mutation.gateway_id.unwrap_or_default();
        let before = gateway_in_optional(&mut transaction, gateway_id, true).await?;
        let action = if let Some(current) = &before {
            if current.tenant_id != mutation.tenant_id {
                return Err(StoreError::NotFound("payment gateway"));
            }
            let has_payment_history: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM payment_intents \
                 WHERE tenant_id = $1 AND gateway_id = $2)",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(gateway_id.into_uuid())
            .fetch_one(&mut *transaction)
            .await?;
            if has_payment_history {
                if mutation.enabled
                    || mutation.name != current.name
                    || mutation.kind != current.kind
                    || mutation.mode != current.mode
                    || mutation.settings != current.settings
                {
                    return Err(StoreError::Conflict(
                        "historical payment gateways may only be disabled; create a new gateway for rotation"
                            .to_owned(),
                    ));
                }
                if mutation.expected_version != Some(current.version) {
                    return Err(StoreError::Conflict(format!(
                        "gateway version is {}, expected {:?}",
                        current.version, mutation.expected_version
                    )));
                }
                let result = sqlx::query(
                    "UPDATE payment_gateway_configs SET enabled = false \
                     WHERE tenant_id = $1 AND id = $2 AND version = $3",
                )
                .bind(mutation.tenant_id.into_uuid())
                .bind(gateway_id.into_uuid())
                .bind(current.version)
                .execute(&mut *transaction)
                .await?;
                if result.rows_affected() != 1 {
                    return Err(StoreError::Conflict(
                        "gateway was concurrently modified".to_owned(),
                    ));
                }
                "gateway_disabled"
            } else {
                if mutation.expected_version != Some(current.version) {
                    return Err(StoreError::Conflict(format!(
                        "gateway version is {}, expected {:?}",
                        current.version, mutation.expected_version
                    )));
                }
                let config = GatewayConfig::from_parts(
                    gateway_id,
                    mutation.name.clone(),
                    mutation.kind.as_str(),
                    mutation.mode.as_str(),
                    mutation.settings.clone(),
                    mutation.credential_secret_ref.clone(),
                )?;
                let credential_digest = GatewayFactory::credential_digest(&config)?;
                let result = sqlx::query(
                    "UPDATE payment_gateway_configs SET name = $3, gateway_kind = $4, mode = $5, \
                     settings = $6, credential_secret_ref = $7, credential_secret_digest = $8, \
                     enabled = $9, version = version + 1 \
                 WHERE tenant_id = $1 AND id = $2 AND version = $10",
                )
                .bind(mutation.tenant_id.into_uuid())
                .bind(gateway_id.into_uuid())
                .bind(&mutation.name)
                .bind(mutation.kind.as_str())
                .bind(mutation.mode.as_str())
                .bind(&mutation.settings)
                .bind(&mutation.credential_secret_ref)
                .bind(&credential_digest)
                .bind(mutation.enabled)
                .bind(current.version)
                .execute(&mut *transaction)
                .await?;
                if result.rows_affected() != 1 {
                    return Err(StoreError::Conflict(
                        "gateway was concurrently modified".to_owned(),
                    ));
                }
                "gateway_updated"
            }
        } else {
            if mutation.expected_version.is_some() {
                return Err(StoreError::Conflict(
                    "new gateway must not provide expected_version".to_owned(),
                ));
            }
            let config = GatewayConfig::from_parts(
                gateway_id,
                mutation.name.clone(),
                mutation.kind.as_str(),
                mutation.mode.as_str(),
                mutation.settings.clone(),
                mutation.credential_secret_ref.clone(),
            )?;
            let credential_digest = GatewayFactory::credential_digest(&config)?;
            sqlx::query(
                "INSERT INTO payment_gateway_configs \
                 (id, tenant_id, name, gateway_kind, mode, settings, credential_secret_ref, \
                  credential_secret_digest, enabled) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(gateway_id.into_uuid())
            .bind(mutation.tenant_id.into_uuid())
            .bind(&mutation.name)
            .bind(mutation.kind.as_str())
            .bind(mutation.mode.as_str())
            .bind(&mutation.settings)
            .bind(&mutation.credential_secret_ref)
            .bind(&credential_digest)
            .bind(mutation.enabled)
            .execute(&mut *transaction)
            .await?;
            "gateway_created"
        };
        let after = gateway_in_optional(&mut transaction, gateway_id, false)
            .await?
            .ok_or(StoreError::NotFound("payment gateway"))?;
        audit_config(
            &mut transaction,
            mutation.tenant_id,
            &mutation.actor,
            action,
            "gateway",
            gateway_id.into_uuid(),
            before.as_ref().map(serde_json::to_value).transpose()?,
            serde_json::to_value(&after)?,
            &mutation.reason,
        )
        .await?;
        transaction.commit().await?;
        Ok(after)
    }

    pub async fn routes(&self, tenant_id: TenantId) -> Result<Vec<RouteRecord>, StoreError> {
        let rows = sqlx::query(ROUTE_SELECT_TENANT)
            .bind(tenant_id.into_uuid())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(route_from_row).collect()
    }

    pub async fn mutate_route(&self, mutation: &RouteMutation) -> Result<RouteRecord, StoreError> {
        validate_route(mutation)?;
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let gateway_mode: String = sqlx::query_scalar(
            "SELECT mode FROM payment_gateway_configs WHERE tenant_id = $1 AND id = $2 AND enabled FOR SHARE",
        )
        .bind(mutation.tenant_id.into_uuid())
        .bind(mutation.gateway_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("enabled payment gateway"))?;
        if gateway_mode != "test" && gateway_mode != "production" {
            return Err(StoreError::Invalid("gateway mode is invalid".to_owned()));
        }
        let route_id = mutation.route_id.unwrap_or_else(Uuid::now_v7);
        let before = route_in_optional(&mut transaction, route_id, true).await?;
        let action = if let Some(current) = &before {
            if current.tenant_id != mutation.tenant_id {
                return Err(StoreError::NotFound("payment route"));
            }
            if mutation.expected_version != Some(current.version) {
                return Err(StoreError::Conflict(format!(
                    "route version is {}, expected {:?}",
                    current.version, mutation.expected_version
                )));
            }
            let result = sqlx::query(
                "UPDATE payment_routes SET gateway_id = $3, method_code = $4, currency = $5, \
                     priority = $6, enabled = $7, version = version + 1 \
                 WHERE tenant_id = $1 AND id = $2 AND version = $8",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(route_id)
            .bind(mutation.gateway_id.into_uuid())
            .bind(&mutation.method_code)
            .bind(&mutation.currency)
            .bind(mutation.priority)
            .bind(mutation.enabled)
            .bind(current.version)
            .execute(&mut *transaction)
            .await?;
            if result.rows_affected() != 1 {
                return Err(StoreError::Conflict(
                    "route was concurrently modified".to_owned(),
                ));
            }
            "route_updated"
        } else {
            if mutation.expected_version.is_some() {
                return Err(StoreError::Conflict(
                    "new route must not provide expected_version".to_owned(),
                ));
            }
            sqlx::query(
                "INSERT INTO payment_routes \
                 (id, tenant_id, gateway_id, method_code, currency, priority, enabled) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(route_id)
            .bind(mutation.tenant_id.into_uuid())
            .bind(mutation.gateway_id.into_uuid())
            .bind(&mutation.method_code)
            .bind(&mutation.currency)
            .bind(mutation.priority)
            .bind(mutation.enabled)
            .execute(&mut *transaction)
            .await?;
            "route_created"
        };
        let after = route_in_optional(&mut transaction, route_id, false)
            .await?
            .ok_or(StoreError::NotFound("payment route"))?;
        audit_config(
            &mut transaction,
            mutation.tenant_id,
            &mutation.actor,
            action,
            "route",
            route_id,
            before.as_ref().map(serde_json::to_value).transpose()?,
            serde_json::to_value(&after)?,
            &mutation.reason,
        )
        .await?;
        transaction.commit().await?;
        Ok(after)
    }

    pub async fn setting(&self, tenant_id: TenantId) -> Result<PaymentSetting, StoreError> {
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, updated_by, version, updated_at \
             FROM payment_settings WHERE tenant_id = $1",
        )
        .bind(tenant_id.into_uuid())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound("payment settings"))?;
        setting_from_row(&row)
    }

    pub async fn switch_mode(&self, command: &ModeSwitch) -> Result<PaymentSetting, StoreError> {
        validate_actor_reason(&command.actor, &command.reason)?;
        if self.environment == Environment::Production && command.mode == GatewayMode::Test {
            return Err(StoreError::Invalid(
                "production cannot switch to test payment mode".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, updated_by, version, updated_at \
             FROM payment_settings WHERE tenant_id = $1 FOR UPDATE",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::NotFound("payment settings"))?;
        let current = setting_from_row(&row)?;
        if current.version != command.expected_version {
            return Err(StoreError::Conflict(format!(
                "payment settings version is {}, expected {}",
                current.version, command.expected_version
            )));
        }
        if current.active_mode == command.mode {
            return Ok(current);
        }
        let route_configs = sqlx::query(
            "SELECT DISTINCT g.id, g.tenant_id, g.name, g.gateway_kind, g.mode, g.settings, \
                    g.credential_secret_ref, g.credential_secret_digest \
             FROM payment_routes r \
             JOIN payment_gateway_configs g ON g.tenant_id = r.tenant_id AND g.id = r.gateway_id \
             WHERE r.tenant_id = $1 AND r.enabled AND g.enabled AND g.mode = $2",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.mode.as_str())
        .fetch_all(&mut *transaction)
        .await?;
        if route_configs.is_empty() {
            return Err(StoreError::Conflict(format!(
                "{} mode has no enabled route",
                command.mode.as_str()
            )));
        }
        for row in &route_configs {
            let config = GatewayConfig::from_parts(
                PaymentGatewayId::from_uuid(row.try_get("id")?),
                row.try_get("name")?,
                &row.try_get::<String, _>("gateway_kind")?,
                &row.try_get::<String, _>("mode")?,
                row.try_get("settings")?,
                row.try_get("credential_secret_ref")?,
            )?
            .with_credential_digest(row.try_get("credential_secret_digest")?);
            GatewayFactory::build(&config)?;
        }
        let outstanding: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM payment_intents WHERE tenant_id = $1 AND gateway_mode = $2 \
             AND status IN ('requested', 'requires_action', 'authorized', 'pending', \
                            'capture_pending', 'void_pending', 'unknown')",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(current.active_mode.as_str())
        .fetch_one(&mut *transaction)
        .await?;
        if outstanding > 0 {
            return Err(StoreError::Conflict(format!(
                "cannot switch modes while {outstanding} payment(s) are outstanding"
            )));
        }
        let new_version = current.version + 1;
        sqlx::query(
            "UPDATE payment_settings SET active_mode = $2, updated_by = $3, version = $4 \
             WHERE tenant_id = $1 AND version = $5",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.mode.as_str())
        .bind(&command.actor)
        .bind(new_version)
        .bind(current.version)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO payment_mode_audit \
             (id, tenant_id, old_mode, new_mode, old_version, new_version, actor, reason) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::now_v7())
        .bind(command.tenant_id.into_uuid())
        .bind(current.active_mode.as_str())
        .bind(command.mode.as_str())
        .bind(current.version)
        .bind(new_version)
        .bind(&command.actor)
        .bind(&command.reason)
        .execute(&mut *transaction)
        .await?;
        let row = sqlx::query(
            "SELECT tenant_id, active_mode, updated_by, version, updated_at \
             FROM payment_settings WHERE tenant_id = $1",
        )
        .bind(command.tenant_id.into_uuid())
        .fetch_one(&mut *transaction)
        .await?;
        let result = setting_from_row(&row)?;
        transaction.commit().await?;
        Ok(result)
    }
}

const GATEWAY_SELECT: &str = "SELECT id, tenant_id, name, gateway_kind, mode, settings, credential_secret_ref, enabled, \
            version, created_at, updated_at FROM payment_gateway_configs WHERE id = $1";
const GATEWAY_SELECT_TENANT: &str = "SELECT id, tenant_id, name, gateway_kind, mode, settings, credential_secret_ref, enabled, \
            version, created_at, updated_at FROM payment_gateway_configs \
     WHERE tenant_id = $1 ORDER BY name, id";
const ROUTE_SELECT: &str = "SELECT id, tenant_id, gateway_id, method_code, currency, priority, enabled, version, \
            created_at, updated_at FROM payment_routes WHERE id = $1";
const ROUTE_SELECT_TENANT: &str = "SELECT id, tenant_id, gateway_id, method_code, currency, priority, enabled, version, \
            created_at, updated_at FROM payment_routes WHERE tenant_id = $1 \
     ORDER BY priority, method_code, currency, id";
const INVOICE_PROVIDER_SELECT: &str = "SELECT id, tenant_id, provider_key, name, mode, settings, \
            credential_secret_ref, enabled, version, created_at, updated_at \
     FROM invoice_provider_configs WHERE id = $1";
const INVOICE_PROVIDER_SELECT_TENANT: &str = "SELECT id, tenant_id, provider_key, name, mode, settings, \
            credential_secret_ref, enabled, version, created_at, updated_at \
     FROM invoice_provider_configs WHERE tenant_id = $1 ORDER BY name, id";

async fn gateway_in_optional(
    transaction: &mut Transaction<'_, Postgres>,
    gateway_id: PaymentGatewayId,
    for_update: bool,
) -> Result<Option<GatewayRecord>, StoreError> {
    let statement = if for_update {
        format!("{GATEWAY_SELECT} FOR UPDATE")
    } else {
        GATEWAY_SELECT.to_owned()
    };
    sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(gateway_id.into_uuid())
        .fetch_optional(&mut **transaction)
        .await?
        .as_ref()
        .map(gateway_from_row)
        .transpose()
}

fn gateway_from_row(row: &sqlx::postgres::PgRow) -> Result<GatewayRecord, StoreError> {
    use std::str::FromStr;
    Ok(GatewayRecord {
        gateway_id: PaymentGatewayId::from_uuid(row.try_get("id")?),
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        name: row.try_get("name")?,
        kind: GatewayKind::from_str(&row.try_get::<String, _>("gateway_kind")?)?,
        mode: GatewayMode::from_str(&row.try_get::<String, _>("mode")?)?,
        settings: row.try_get("settings")?,
        credential_configured: row
            .try_get::<Option<String>, _>("credential_secret_ref")?
            .is_some(),
        enabled: row.try_get("enabled")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn route_in_optional(
    transaction: &mut Transaction<'_, Postgres>,
    route_id: Uuid,
    for_update: bool,
) -> Result<Option<RouteRecord>, StoreError> {
    let statement = if for_update {
        format!("{ROUTE_SELECT} FOR UPDATE")
    } else {
        ROUTE_SELECT.to_owned()
    };
    sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(route_id)
        .fetch_optional(&mut **transaction)
        .await?
        .as_ref()
        .map(route_from_row)
        .transpose()
}

fn route_from_row(row: &sqlx::postgres::PgRow) -> Result<RouteRecord, StoreError> {
    Ok(RouteRecord {
        route_id: row.try_get("id")?,
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        gateway_id: PaymentGatewayId::from_uuid(row.try_get("gateway_id")?),
        method_code: row.try_get("method_code")?,
        currency: row.try_get("currency")?,
        priority: row.try_get("priority")?,
        enabled: row.try_get("enabled")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn invoice_provider_in_optional(
    transaction: &mut Transaction<'_, Postgres>,
    provider_id: Uuid,
    for_update: bool,
) -> Result<Option<InvoiceProviderRecord>, StoreError> {
    let statement = if for_update {
        format!("{INVOICE_PROVIDER_SELECT} FOR UPDATE")
    } else {
        INVOICE_PROVIDER_SELECT.to_owned()
    };
    sqlx::query(sqlx::AssertSqlSafe(statement))
        .bind(provider_id)
        .fetch_optional(&mut **transaction)
        .await?
        .as_ref()
        .map(invoice_provider_from_row)
        .transpose()
}

fn invoice_provider_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<InvoiceProviderRecord, StoreError> {
    Ok(InvoiceProviderRecord {
        provider_id: row.try_get("id")?,
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        name: row.try_get("name")?,
        provider_key: row.try_get("provider_key")?,
        mode: GatewayMode::from_str(&row.try_get::<String, _>("mode")?)?,
        settings: row.try_get("settings")?,
        credential_configured: row
            .try_get::<Option<String>, _>("credential_secret_ref")?
            .is_some(),
        enabled: row.try_get("enabled")?,
        version: row.try_get("version")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn invoice_setting_from_row(row: &sqlx::postgres::PgRow) -> Result<InvoiceSetting, StoreError> {
    Ok(InvoiceSetting {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        active_mode: GatewayMode::from_str(&row.try_get::<String, _>("active_mode")?)?,
        active_provider_id: row.try_get("active_provider_id")?,
        updated_by: row.try_get("updated_by")?,
        version: row.try_get("version")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn setting_from_row(row: &sqlx::postgres::PgRow) -> Result<PaymentSetting, StoreError> {
    use std::str::FromStr;
    Ok(PaymentSetting {
        tenant_id: TenantId::from_uuid(row.try_get("tenant_id")?),
        active_mode: GatewayMode::from_str(&row.try_get::<String, _>("active_mode")?)?,
        updated_by: row.try_get("updated_by")?,
        version: row.try_get("version")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn validate_gateway(mutation: &GatewayMutation) -> Result<(), StoreError> {
    validate_actor_reason(&mutation.actor, &mutation.reason)?;
    if mutation.name.trim().is_empty() || mutation.name.len() > 200 {
        return Err(StoreError::Invalid(
            "gateway name must contain 1..=200 bytes".to_owned(),
        ));
    }
    if !mutation.settings.is_object() {
        return Err(StoreError::Invalid(
            "gateway settings must be a JSON object".to_owned(),
        ));
    }
    match (mutation.mode, mutation.kind, &mutation.credential_secret_ref) {
        (GatewayMode::Test, GatewayKind::Test, None) => Ok(()),
        (GatewayMode::Production, kind, Some(reference))
            if kind != GatewayKind::Test
                && (reference.starts_with("file:") || reference.starts_with("env:")) =>
        {
            Ok(())
        }
        _ => Err(StoreError::Invalid(
            "test mode requires the test adapter without secrets; production requires a non-test adapter and secret reference"
                .to_owned(),
        )),
    }
}

fn validate_invoice_provider(mutation: &InvoiceProviderMutation) -> Result<(), StoreError> {
    validate_actor_reason(&mutation.actor, &mutation.reason)?;
    if mutation.name.trim().is_empty() || mutation.name.len() > 200 {
        return Err(StoreError::Invalid(
            "invoice provider name must contain 1..=200 bytes".to_owned(),
        ));
    }
    if mutation.provider_key.trim().is_empty() || mutation.provider_key.len() > 100 {
        return Err(StoreError::Invalid(
            "invoice provider key must contain 1..=100 bytes".to_owned(),
        ));
    }
    if !mutation.settings.is_object() {
        return Err(StoreError::Invalid(
            "invoice provider settings must be a JSON object".to_owned(),
        ));
    }
    validate_invoice_provider_parts(
        &mutation.provider_key,
        mutation.mode,
        &mutation.settings,
        mutation.credential_secret_ref.as_deref(),
    )
}

fn validate_invoice_provider_row(row: &sqlx::postgres::PgRow) -> Result<(), StoreError> {
    let mode = GatewayMode::from_str(&row.try_get::<String, _>("mode")?)?;
    let provider_key: String = row.try_get("provider_key")?;
    let settings: Value = row.try_get("settings")?;
    let credential_secret_ref: Option<String> = row.try_get("credential_secret_ref")?;
    validate_invoice_provider_parts(
        &provider_key,
        mode,
        &settings,
        credential_secret_ref.as_deref(),
    )?;
    if mode == GatewayMode::Production {
        let expected: Option<Vec<u8>> = row.try_get("credential_secret_digest")?;
        let actual = resolve_secret_digest(credential_secret_ref.as_deref().ok_or_else(|| {
            StoreError::Invalid("invoice provider credential is missing".to_owned())
        })?)?;
        if expected.as_deref() != Some(actual.as_slice()) {
            return Err(StoreError::Invalid(
                "invoice provider credential digest is missing or stale; re-save the provider"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_invoice_provider_parts(
    provider_key: &str,
    mode: GatewayMode,
    settings: &Value,
    credential_secret_ref: Option<&str>,
) -> Result<(), StoreError> {
    match (mode, provider_key, credential_secret_ref) {
        (GatewayMode::Test, "local_test", None) => Ok(()),
        (GatewayMode::Production, "http_json" | "fapiao_http", Some(reference))
            if reference.starts_with("file:") || reference.starts_with("env:") =>
        {
            let secret = resolve_secret(reference)?;
            HttpInvoiceProvider::new(provider_key, settings, secret)?;
            Ok(())
        }
        _ => Err(StoreError::Invalid(
            "test invoice mode requires local_test without secrets; production requires http_json or fapiao_http with a valid secret reference"
                .to_owned(),
        )),
    }
}

fn validate_route(mutation: &RouteMutation) -> Result<(), StoreError> {
    validate_actor_reason(&mutation.actor, &mutation.reason)?;
    if mutation.method_code.trim().is_empty() || mutation.method_code.len() > 100 {
        return Err(StoreError::Invalid(
            "method_code must contain 1..=100 bytes".to_owned(),
        ));
    }
    if mutation.currency != "*"
        && (mutation.currency.len() != 3
            || !mutation
                .currency
                .bytes()
                .all(|byte| byte.is_ascii_uppercase()))
    {
        return Err(StoreError::Invalid(
            "currency must be * or three uppercase ASCII letters".to_owned(),
        ));
    }
    if mutation.priority < 0 {
        return Err(StoreError::Invalid(
            "route priority cannot be negative".to_owned(),
        ));
    }
    Ok(())
}

fn validate_actor_reason(actor: &str, reason: &str) -> Result<(), StoreError> {
    if actor.trim().is_empty() || actor.len() > 256 {
        return Err(StoreError::Invalid(
            "actor must contain 1..=256 bytes".to_owned(),
        ));
    }
    if reason.trim().is_empty() || reason.len() > 2_000 {
        return Err(StoreError::Invalid(
            "reason must contain 1..=2000 bytes".to_owned(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit_config(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    actor: &str,
    action: &str,
    target_type: &str,
    target_id: Uuid,
    before: Option<Value>,
    after: Value,
    reason: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO payment_config_audit \
         (id, tenant_id, actor, action, target_type, target_id, before_value, after_value, reason) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(actor)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(before)
    .bind(after)
    .bind(reason)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit_invoice_config(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: TenantId,
    actor: &str,
    action: &str,
    target_id: Uuid,
    before: Option<Value>,
    after: Value,
    reason: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO invoice_config_audit \
         (id, tenant_id, actor, action, target_id, before_value, after_value, reason) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::now_v7())
    .bind(tenant_id.into_uuid())
    .bind(actor)
    .bind(action)
    .bind(target_id)
    .bind(before)
    .bind(after)
    .bind(reason)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn invoice_test_mode_accepts_only_the_local_adapter() {
        assert!(
            validate_invoice_provider_parts("local_test", GatewayMode::Test, &json!({}), None,)
                .is_ok()
        );
        assert!(
            validate_invoice_provider_parts("http_json", GatewayMode::Test, &json!({}), None,)
                .is_err()
        );
    }

    #[test]
    fn invoice_production_rejects_local_adapter() {
        let result = validate_invoice_provider_parts(
            "local_test",
            GatewayMode::Production,
            &json!({}),
            Some("file:/etc/matchplane/secrets/invoice-provider.token"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn invoice_production_requires_a_resolvable_allowlisted_secret() {
        let result = validate_invoice_provider_parts(
            "http_json",
            GatewayMode::Production,
            &json!({"base_url": "https://invoice.example.test"}),
            Some("env:UNSAFE_INVOICE_TOKEN"),
        );
        assert!(result.is_err());
    }
}
