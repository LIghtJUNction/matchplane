use matchplane_domain::{PaymentGatewayId, TenantId};
use matchplane_payments::{GatewayKind, GatewayMode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::store::StoreError;

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

#[derive(Debug, Clone)]
pub struct AdminStore {
    pool: PgPool,
}

impl AdminStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn gateways(&self, tenant_id: TenantId) -> Result<Vec<GatewayRecord>, StoreError> {
        let rows = sqlx::query(GATEWAY_SELECT_TENANT)
            .bind(tenant_id.into_uuid())
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(gateway_from_row).collect()
    }

    pub async fn mutate_gateway(
        &self,
        mutation: &GatewayMutation,
    ) -> Result<GatewayRecord, StoreError> {
        validate_gateway(mutation)?;
        let mut transaction = self.pool.begin().await?;
        serializable(&mut transaction).await?;
        let gateway_id = mutation.gateway_id.unwrap_or_default();
        let before = gateway_in_optional(&mut transaction, gateway_id, true).await?;
        let action = if let Some(current) = &before {
            if current.tenant_id != mutation.tenant_id {
                return Err(StoreError::NotFound("payment gateway"));
            }
            if mutation.expected_version != Some(current.version) {
                return Err(StoreError::Conflict(format!(
                    "gateway version is {}, expected {:?}",
                    current.version, mutation.expected_version
                )));
            }
            let result = sqlx::query(
                "UPDATE payment_gateway_configs SET name = $3, gateway_kind = $4, mode = $5, \
                     settings = $6, credential_secret_ref = $7, enabled = $8, version = version + 1 \
                 WHERE tenant_id = $1 AND id = $2 AND version = $9",
            )
            .bind(mutation.tenant_id.into_uuid())
            .bind(gateway_id.into_uuid())
            .bind(&mutation.name)
            .bind(mutation.kind.as_str())
            .bind(mutation.mode.as_str())
            .bind(&mutation.settings)
            .bind(&mutation.credential_secret_ref)
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
        } else {
            if mutation.expected_version.is_some() {
                return Err(StoreError::Conflict(
                    "new gateway must not provide expected_version".to_owned(),
                ));
            }
            sqlx::query(
                "INSERT INTO payment_gateway_configs \
                 (id, tenant_id, name, gateway_kind, mode, settings, credential_secret_ref, enabled) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(gateway_id.into_uuid())
            .bind(mutation.tenant_id.into_uuid())
            .bind(&mutation.name)
            .bind(mutation.kind.as_str())
            .bind(mutation.mode.as_str())
            .bind(&mutation.settings)
            .bind(&mutation.credential_secret_ref)
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
        let route_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM payment_routes r \
             JOIN payment_gateway_configs g ON g.id = r.gateway_id \
             WHERE r.tenant_id = $1 AND r.enabled AND g.enabled AND g.mode = $2)",
        )
        .bind(command.tenant_id.into_uuid())
        .bind(command.mode.as_str())
        .fetch_one(&mut *transaction)
        .await?;
        if !route_exists {
            return Err(StoreError::Conflict(format!(
                "{} mode has no enabled route",
                command.mode.as_str()
            )));
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

async fn serializable(transaction: &mut Transaction<'_, Postgres>) -> Result<(), StoreError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}
