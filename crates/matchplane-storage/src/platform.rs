//! Operator-owned platform identity provisioning.
//!
//! The kernel never invents a tenant, domain, catalogue, or vertical-specific field.  This
//! module only persists the identities explicitly supplied by an operator so a clean install has
//! a small, auditable path to its first root platform.

use matchplane_domain::{DomainId, TenantId};
use serde::Serialize;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgStore, StorageError};

/// Explicit platform identity requested by an operator.
#[derive(Debug, Clone)]
pub struct ProvisionRootPlatform {
    /// Stable tenant identifier.  Callers may generate it before constructing this command.
    pub tenant_id: TenantId,
    /// Tenant slug used by operator configuration and APIs.
    pub tenant_slug: String,
    /// Human-readable tenant name supplied by the operator.
    pub tenant_name: String,
    /// Optional first domain identity.  A root may also start with no domains.
    pub domain: Option<ProvisionRootDomain>,
}

/// Explicit first-domain identity requested by an operator.
#[derive(Debug, Clone)]
pub struct ProvisionRootDomain {
    /// Stable domain identifier.
    pub domain_id: DomainId,
    /// Domain slug mounted beneath the root platform.
    pub domain_slug: String,
    /// Human-readable domain name supplied by the operator.
    pub domain_name: String,
}

/// Durable identities returned after idempotent provisioning.
#[derive(Debug, Clone, Serialize)]
pub struct ProvisionedRootPlatform {
    /// Tenant identity and whether this invocation created it.
    pub tenant: ProvisionedTenant,
    /// Optional first domain identity and whether this invocation created it.
    pub domain: Option<ProvisionedDomain>,
}

/// Provisioned tenant projection.
#[derive(Debug, Clone, Serialize)]
pub struct ProvisionedTenant {
    /// Stable tenant identifier.
    pub id: TenantId,
    /// Tenant slug.
    pub slug: String,
    /// Tenant name.
    pub name: String,
    /// `true` only when the row was inserted by this invocation.
    pub created: bool,
}

/// Provisioned domain projection.
#[derive(Debug, Clone, Serialize)]
pub struct ProvisionedDomain {
    /// Stable domain identifier.
    pub id: DomainId,
    /// Domain slug.
    pub slug: String,
    /// Domain name.
    pub name: String,
    /// `true` only when the row was inserted by this invocation.
    pub created: bool,
}

impl PgStore {
    /// Creates or verifies operator-supplied root identities without changing existing names.
    ///
    /// The operation is idempotent for the exact same IDs, slugs, and names.  A mismatch is
    /// rejected instead of silently overwriting a tenant or domain that may already be in use.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Conflict`] when an ID or slug belongs to another identity,
    /// [`StorageError::InvalidData`] for malformed operator input, or [`StorageError::Sqlx`]
    /// when PostgreSQL rejects the transaction.
    pub async fn provision_root_platform(
        &self,
        command: &ProvisionRootPlatform,
    ) -> Result<ProvisionedRootPlatform, StorageError> {
        validate_name("tenant_slug", &command.tenant_slug, 63)?;
        validate_slug("tenant_slug", &command.tenant_slug)?;
        validate_name("tenant_name", &command.tenant_name, 200)?;
        if let Some(domain) = &command.domain {
            validate_name("domain_slug", &domain.domain_slug, 63)?;
            validate_slug("domain_slug", &domain.domain_slug)?;
            if domain.domain_slug == "root" {
                return Err(StorageError::InvalidData(
                    "domain_slug 'root' is reserved for the deployment root".to_owned(),
                ));
            }
            validate_name("domain_name", &domain.domain_name, 200)?;
            if domain.domain_id.into_uuid() == command.tenant_id.into_uuid() {
                return Err(StorageError::InvalidData(
                    "domain_id must differ from tenant_id".to_owned(),
                ));
            }
        }

        let mut transaction = self.pool().begin().await?;
        let tenant_id = command.tenant_id.into_uuid();
        let tenant =
            sqlx::query("SELECT id, slug, name FROM tenants WHERE id = $1 OR slug = $2 FOR UPDATE")
                .bind(tenant_id)
                .bind(&command.tenant_slug)
                .fetch_all(&mut *transaction)
                .await?;

        let (tenant_slug, tenant_name, tenant_created) = match tenant.as_slice() {
            [] => {
                sqlx::query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)")
                    .bind(tenant_id)
                    .bind(&command.tenant_slug)
                    .bind(&command.tenant_name)
                    .execute(&mut *transaction)
                    .await?;
                (
                    command.tenant_slug.clone(),
                    command.tenant_name.clone(),
                    true,
                )
            }
            rows if rows.len() > 1 => {
                return Err(StorageError::Conflict(
                    "tenant ID and slug resolve to different existing rows".to_owned(),
                ));
            }
            rows => {
                let row = rows.first().ok_or_else(|| {
                    StorageError::InvalidData("tenant lookup returned no row".to_owned())
                })?;
                let existing_id: Uuid = row.try_get("id")?;
                let existing_slug: String = row.try_get("slug")?;
                let existing_name: String = row.try_get("name")?;
                if existing_id != tenant_id {
                    return Err(StorageError::Conflict(format!(
                        "tenant slug '{}' is already owned by {}",
                        command.tenant_slug, existing_id
                    )));
                }
                if existing_slug != command.tenant_slug || existing_name != command.tenant_name {
                    return Err(StorageError::Conflict(format!(
                        "tenant {} already exists with slug/name '{} / {}'",
                        tenant_id, existing_slug, existing_name
                    )));
                }
                (existing_slug, existing_name, false)
            }
        };

        let domain = if let Some(command_domain) = &command.domain {
            let domain_id = command_domain.domain_id.into_uuid();
            let rows = sqlx::query(
                "SELECT id, tenant_id, slug, name FROM domains \
                 WHERE id = $1 OR (tenant_id = $2 AND slug = $3) FOR UPDATE",
            )
            .bind(domain_id)
            .bind(tenant_id)
            .bind(&command_domain.domain_slug)
            .fetch_all(&mut *transaction)
            .await?;
            let (slug, name, created) = match rows.as_slice() {
                [] => {
                    sqlx::query(
                        "INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
                    )
                    .bind(domain_id)
                    .bind(tenant_id)
                    .bind(&command_domain.domain_slug)
                    .bind(&command_domain.domain_name)
                    .execute(&mut *transaction)
                    .await?;
                    (
                        command_domain.domain_slug.clone(),
                        command_domain.domain_name.clone(),
                        true,
                    )
                }
                existing_rows if existing_rows.len() > 1 => {
                    return Err(StorageError::Conflict(
                        "domain ID and slug resolve to different existing rows".to_owned(),
                    ));
                }
                existing_rows => {
                    let row = existing_rows.first().ok_or_else(|| {
                        StorageError::InvalidData("domain lookup returned no row".to_owned())
                    })?;
                    let existing_id: Uuid = row.try_get("id")?;
                    let existing_tenant_id: Uuid = row.try_get("tenant_id")?;
                    let existing_slug: String = row.try_get("slug")?;
                    let existing_name: String = row.try_get("name")?;
                    if existing_id != domain_id || existing_tenant_id != tenant_id {
                        return Err(StorageError::Conflict(format!(
                            "domain '{}' or id {} belongs to another tenant",
                            command_domain.domain_slug, domain_id
                        )));
                    }
                    if existing_slug != command_domain.domain_slug
                        || existing_name != command_domain.domain_name
                    {
                        return Err(StorageError::Conflict(format!(
                            "domain {} already exists with slug/name '{} / {}'",
                            domain_id, existing_slug, existing_name
                        )));
                    }
                    (existing_slug, existing_name, false)
                }
            };
            Some(ProvisionedDomain {
                id: DomainId::from_uuid(domain_id),
                slug,
                name,
                created,
            })
        } else {
            None
        };

        transaction.commit().await?;
        Ok(ProvisionedRootPlatform {
            tenant: ProvisionedTenant {
                id: TenantId::from_uuid(tenant_id),
                slug: tenant_slug,
                name: tenant_name,
                created: tenant_created,
            },
            domain,
        })
    }
}

fn validate_name(field: &str, value: &str, max_bytes: usize) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(StorageError::InvalidData(format!(
            "{field} must contain 1..={max_bytes} bytes"
        )));
    }
    Ok(())
}

fn validate_slug(field: &str, value: &str) -> Result<(), StorageError> {
    let bytes = value.as_bytes();
    if !(2..=63).contains(&bytes.len())
        || !bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || !bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        || bytes
            .iter()
            .any(|byte| !byte.is_ascii_lowercase() && !byte.is_ascii_digit() && *byte != b'-')
    {
        return Err(StorageError::InvalidData(format!(
            "{field} must match ^[a-z0-9][a-z0-9-]{{1,62}}$"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_name, validate_slug};

    #[test]
    fn validate_slug_rejects_uppercase_and_punctuation() {
        assert!(validate_slug("slug", "Store_A").is_err());
        assert!(validate_slug("slug", "store_a").is_err());
    }

    #[test]
    fn validate_slug_accepts_operator_supplied_slug() {
        assert!(validate_slug("slug", "store-a").is_ok());
        assert!(validate_slug("slug", "2nd-hand").is_ok());
    }

    #[test]
    fn validate_name_rejects_empty_operator_input() {
        assert!(validate_name("name", "  ", 200).is_err());
    }
}
