use std::{env, path::Path, process::Command as ProcessCommand, time::Duration};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use matchplane_config::{AppConfig, ConfigurationDiagnostics, Environment};
use matchplane_domain::{DomainId, TenantId};
use matchplane_storage::{
    PgStore, ProvisionRootDomain, ProvisionRootPlatform, ProvisionedRootPlatform,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use url::Url;
use uuid::{Uuid, Variant};

#[derive(Debug, Parser)]
#[command(name = "matchplane", about = "MatchPlane operator and agent CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Apply all embedded PostgreSQL migrations.
    Migrate,
    /// Apply all embedded PostgreSQL migrations.
    Initialize,
    /// Create or verify the operator-supplied root tenant and optional first domain.
    ProvisionRoot {
        /// Root tenant slug. This value is never chosen by the core.
        #[arg(long)]
        tenant_slug: String,
        /// Root tenant display name. This value is never chosen by the core.
        #[arg(long)]
        tenant_name: String,
        /// Optional stable tenant UUID. A UUIDv7 is generated only when omitted.
        #[arg(long)]
        tenant_id: Option<Uuid>,
        /// Optional first-domain slug. `--domain-slug` and `--domain-name` must be supplied
        /// together; `--domain-id` is optional and is generated when omitted.
        #[arg(long)]
        domain_slug: Option<String>,
        /// Optional first-domain display name.
        #[arg(long)]
        domain_name: Option<String>,
        /// Optional stable first-domain UUID. A UUIDv7 is generated only when omitted.
        #[arg(long)]
        domain_id: Option<Uuid>,
        /// Operator-owned root administrator email to print in the next-step configuration.
        /// This is never persisted by the core.
        #[arg(long, env = "MATCHPLANE_ROOT_ADMIN_EMAIL")]
        admin_email: Option<String>,
    },
    /// Issue a one-time administrator registration URL for an existing platform organization.
    AdminInvite {
        /// Administrator scope. Root invitations use the provisioned root organization;
        /// subplatform invitations require `--organization-id`.
        #[arg(long, value_enum)]
        role: AdminInviteRole,
        /// Target Better Auth organization UUID. Omit only for a root administrator invite.
        #[arg(long)]
        organization_id: Option<Uuid>,
        /// Link lifetime in hours. The CLI caps this at seven days.
        #[arg(long, default_value_t = 24)]
        expires_hours: u32,
        /// Public web origin to place in the registration URL. Defaults to BETTER_AUTH_URL.
        #[arg(long, env = "BETTER_AUTH_URL")]
        base_url: Option<String>,
    },
    /// Issue a one-time invite for a signed remote MatchPlane platform enrollment.
    #[command(name = "federation-invite")]
    FederationInvite {
        /// Active root-domain UUID where the remote node will be mounted.
        #[arg(long)]
        domain_id: Uuid,
        /// Parent organization UUID. Omit to mount directly under the root organization.
        #[arg(long)]
        parent_organization_id: Option<Uuid>,
        /// Link lifetime in hours. The CLI caps this at seven days.
        #[arg(long, default_value_t = 24)]
        expires_hours: u32,
        /// Public web origin used as the remote enrollment endpoint base URL.
        #[arg(long, env = "BETTER_AUTH_URL")]
        base_url: Option<String>,
    },
    /// Validate configuration and production safety gates.
    Doctor {
        /// Emit machine-readable JSON (the default output is also JSON for agent stability).
        #[arg(long)]
        json: bool,
    },
    /// Probe gateway, payment, and web readiness endpoints.
    Status {
        /// Emit machine-readable JSON (the default output is also JSON for agent stability).
        #[arg(long)]
        json: bool,
    },
    /// Start one named workload under a process supervisor.
    Serve {
        /// Workload to start. The child inherits the current environment and standard streams.
        service: Service,
        /// Arguments forwarded to the workload executable.
        #[arg(trailing_var_arg = true)]
        args: Vec<String>,
    },
    /// Run the read-only MCP operations server over stdio.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Service {
    Gateway,
    #[value(name = "payment-service")]
    Payment,
    EventRelay,
    Matcher,
    Projector,
    VectorWorker,
    FederationHub,
    #[value(name = "subplatform-builder")]
    SubplatformBuilder,
    Web,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum AdminInviteRole {
    #[value(name = "root-admin")]
    RootAdmin,
    #[value(name = "subplatform-admin")]
    SubplatformAdmin,
}

#[derive(Debug, Subcommand)]
enum McpCommand {
    /// Serve `platform.status`, `platform.doctor`, and `platform.health` tools.
    Serve,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Migrate => migrate().await,
        Command::Initialize => initialize().await,
        Command::ProvisionRoot {
            tenant_slug,
            tenant_name,
            tenant_id,
            domain_slug,
            domain_name,
            domain_id,
            admin_email,
        } => {
            provision_root(
                tenant_slug,
                tenant_name,
                tenant_id,
                domain_slug,
                domain_name,
                domain_id,
                admin_email,
            )
            .await
        }
        Command::AdminInvite {
            role,
            organization_id,
            expires_hours,
            base_url,
        } => create_admin_invite(role, organization_id, expires_hours, base_url).await,
        Command::FederationInvite {
            domain_id,
            parent_organization_id,
            expires_hours,
            base_url,
        } => {
            create_federation_invite(domain_id, parent_organization_id, expires_hours, base_url)
                .await
        }
        Command::Doctor { json: _ } => doctor().await,
        Command::Status { json: _ } => status().await,
        Command::Serve { service, args } => serve(service, &args),
        Command::Mcp {
            command: McpCommand::Serve,
        } => serve_mcp().await,
    }
}

async fn initialize() -> Result<()> {
    // Initialization is intentionally migration-only. Tenants, domains, schemas,
    // payment providers and catalogue records must be supplied by an operator or
    // a registered subplatform; the core never fabricates marketplace data.
    migrate().await
}

async fn migrate() -> Result<()> {
    let config = AppConfig::load().context("migration configuration is invalid")?;
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("migration runner could not connect to PostgreSQL")?;
    store.migrate().await.context("database migration failed")
}

async fn provision_root(
    tenant_slug: String,
    tenant_name: String,
    tenant_id: Option<Uuid>,
    domain_slug: Option<String>,
    domain_name: Option<String>,
    domain_id: Option<Uuid>,
    admin_email: Option<String>,
) -> Result<()> {
    let admin_email = admin_email
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty());
    if let Some(email) = &admin_email {
        validate_operator_email(email)?;
    }
    if let Some(id) = tenant_id {
        validate_operator_uuid(id, "--tenant-id")?;
    }
    if let Some(id) = domain_id {
        validate_operator_uuid(id, "--domain-id")?;
    }
    let domain = match (domain_slug, domain_name, domain_id) {
        (None, None, None) => None,
        (Some(slug), Some(name), id) => Some(ProvisionRootDomain {
            domain_id: DomainId::from_uuid(id.unwrap_or_else(Uuid::now_v7)),
            domain_slug: slug,
            domain_name: name,
        }),
        _ => bail!(
            "--domain-slug, --domain-name, and --domain-id must be supplied together; omit all three to start without a domain"
        ),
    };
    let config = AppConfig::load().context("root provisioning configuration is invalid")?;
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("root provisioning could not connect to PostgreSQL")?;
    store
        .migrate()
        .await
        .context("root provisioning could not apply database migrations")?;
    let provisioned = store
        .provision_root_platform(&ProvisionRootPlatform {
            tenant_id: TenantId::from_uuid(tenant_id.unwrap_or_else(Uuid::now_v7)),
            tenant_slug,
            tenant_name,
            domain,
        })
        .await
        .context("root identity provisioning failed")?;
    print_provisioned_root(&provisioned, admin_email.as_deref())?;
    Ok(())
}

async fn create_admin_invite(
    role: AdminInviteRole,
    organization_id: Option<Uuid>,
    expires_hours: u32,
    base_url: Option<String>,
) -> Result<()> {
    if !(1..=168).contains(&expires_hours) {
        bail!("--expires-hours must be between 1 and 168");
    }
    let root_tenant_id = env::var("MATCHPLANE_ROOT_TENANT_ID")
        .context("MATCHPLANE_ROOT_TENANT_ID is required before issuing an administrator invite")?;
    let root_tenant_id = Uuid::parse_str(root_tenant_id.trim())
        .context("MATCHPLANE_ROOT_TENANT_ID must be a UUID")?;
    validate_operator_uuid(root_tenant_id, "MATCHPLANE_ROOT_TENANT_ID")?;

    if matches!(role, AdminInviteRole::RootAdmin) && organization_id.is_some() {
        // An explicit target is useful for scripting only when it is still the root organization;
        // resolve and verify it below rather than trusting a user-provided UUID.
    }
    if matches!(role, AdminInviteRole::SubplatformAdmin) && organization_id.is_none() {
        bail!("--organization-id is required for --role subplatform-admin");
    }

    let config = AppConfig::load().context("administrator invite configuration is invalid")?;
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("administrator invite could not connect to PostgreSQL")?;
    store
        .migrate()
        .await
        .context("administrator invite could not apply database migrations")?;

    let target = if let Some(organization_id) = organization_id {
        sqlx::query(
            r#"SELECT id, slug, "tenantId" AS tenant_id, "rootPlatform" AS root_platform
                 FROM "organization"
                WHERE id = $1::uuid AND "tenantId" = $2
                LIMIT 1"#,
        )
        .bind(organization_id)
        .bind(root_tenant_id.to_string())
        .fetch_optional(store.pool())
        .await
        .context("administrator invite target lookup failed")?
    } else {
        sqlx::query(
            r#"SELECT id, slug, "tenantId" AS tenant_id, "rootPlatform" AS root_platform
                 FROM "organization"
                WHERE "tenantId" = $1 AND "rootPlatform" = true
                ORDER BY "createdAt" ASC
                LIMIT 1"#,
        )
        .bind(root_tenant_id.to_string())
        .fetch_optional(store.pool())
        .await
        .context("root organization lookup failed")?
    };
    let Some(target) = target else {
        bail!(
            "the requested platform organization does not exist under the configured root tenant"
        );
    };
    let target_id: Uuid = target
        .try_get("id")
        .context("administrator invite target id is invalid")?;
    let target_slug: String = target
        .try_get("slug")
        .context("administrator invite target slug is invalid")?;
    let target_tenant: String = target
        .try_get("tenant_id")
        .context("administrator invite target tenant is invalid")?;
    let is_root: bool = target
        .try_get("root_platform")
        .context("administrator invite target root flag is invalid")?;
    if target_tenant != root_tenant_id.to_string() {
        bail!("administrator invite target does not belong to the configured root tenant");
    }
    if matches!(role, AdminInviteRole::RootAdmin) && !is_root {
        bail!("root-admin invitations must target the root organization");
    }
    if matches!(role, AdminInviteRole::SubplatformAdmin) && is_root {
        bail!("subplatform-admin invitations must target a child organization");
    }

    let raw_token = format!("mpa_{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let token_hash = sha256(&raw_token);
    let invite_id = Uuid::now_v7();
    let expires_at = OffsetDateTime::now_utc() + TimeDuration::hours(i64::from(expires_hours));
    sqlx::query(
        r#"INSERT INTO platform_admin_invites
             (id, token_hash, organization_id, role, created_by, expires_at)
           VALUES ($1::uuid, $2, $3::uuid, $4, 'cli', $5)"#,
    )
    .bind(invite_id)
    .bind(&token_hash)
    .bind(target_id)
    .bind(admin_invite_role_value(role))
    .bind(expires_at)
    .execute(store.pool())
    .await
    .context("administrator invite could not be stored")?;

    let base_url = normalize_admin_base_url(
        base_url
            .or_else(|| env::var("BETTER_AUTH_URL").ok())
            .unwrap_or_else(|| "http://localhost:4173".to_owned()),
    )?;
    let next = match role {
        AdminInviteRole::RootAdmin => "/?role=platform".to_owned(),
        AdminInviteRole::SubplatformAdmin => format!("/{target_slug}?role=subplatform_admin"),
    };
    let encoded_next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "inviteId": invite_id,
            "organizationId": target_id,
            "role": admin_invite_role_value(role),
            "expiresAt": expires_at,
            "registrationUrl": format!("{base_url}/admin/register?token={raw_token}&next={encoded_next}"),
            "next": next,
            "expiresInHours": expires_hours,
        }))
        .context("administrator invite output failed")?
    );
    Ok(())
}

async fn create_federation_invite(
    domain_id: Uuid,
    parent_organization_id: Option<Uuid>,
    expires_hours: u32,
    base_url: Option<String>,
) -> Result<()> {
    if !(1..=168).contains(&expires_hours) {
        bail!("--expires-hours must be between 1 and 168");
    }
    validate_operator_uuid(domain_id, "--domain-id")?;
    if let Some(parent) = parent_organization_id {
        validate_operator_uuid(parent, "--parent-organization-id")?;
    }
    let root_tenant_id = env::var("MATCHPLANE_ROOT_TENANT_ID")
        .context("MATCHPLANE_ROOT_TENANT_ID is required before issuing a federation invite")?;
    let root_tenant_id = Uuid::parse_str(root_tenant_id.trim())
        .context("MATCHPLANE_ROOT_TENANT_ID must be a UUID")?;
    validate_operator_uuid(root_tenant_id, "MATCHPLANE_ROOT_TENANT_ID")?;

    let config = AppConfig::load().context("federation invite configuration is invalid")?;
    let store = PgStore::connect(&config.database_url, 2)
        .await
        .context("federation invite could not connect to PostgreSQL")?;
    store
        .migrate()
        .await
        .context("federation invite could not apply database migrations")?;
    let parent = if let Some(parent) = parent_organization_id {
        parent
    } else {
        sqlx::query_scalar::<_, Uuid>(
            r#"SELECT id FROM "organization"
                WHERE "tenantId" = $1 AND "rootPlatform" = true AND "parentOrganizationId" IS NULL
                LIMIT 1"#,
        )
        .bind(root_tenant_id.to_string())
        .fetch_optional(store.pool())
        .await
        .context("root organization lookup failed")?
        .context("root organization does not exist; initialize Better Auth first")?
    };
    let parent_check = sqlx::query(
        r#"WITH RECURSIVE chain(id, parent_id, depth, tenant_id, root_platform) AS (
             SELECT id, "parentOrganizationId", 0, "tenantId", "rootPlatform"
               FROM "organization" WHERE id = $1::uuid
             UNION ALL
             SELECT parent.id, parent."parentOrganizationId", chain.depth + 1,
                    parent."tenantId", parent."rootPlatform"
               FROM "organization" parent JOIN chain ON parent.id = chain.parent_id
              WHERE chain.depth < 64
           )
           SELECT count(*)::int AS count,
                  coalesce(bool_and(tenant_id = $2), false) AS same_tenant,
                  coalesce(bool_or(root_platform AND parent_id IS NULL), false) AS reaches_root
             FROM chain"#,
    )
    .bind(parent)
    .bind(root_tenant_id.to_string())
    .fetch_one(store.pool())
    .await
    .context("federation parent lookup failed")?;
    let count: i32 = parent_check.try_get("count")?;
    let same_tenant: bool = parent_check.try_get("same_tenant")?;
    let reaches_root: bool = parent_check.try_get("reaches_root")?;
    if count == 0 || !same_tenant || !reaches_root {
        bail!("--parent-organization-id must belong to the configured root tree");
    }
    let domain_exists = sqlx::query(
        "SELECT 1 FROM domains WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active' LIMIT 1",
    )
    .bind(root_tenant_id)
    .bind(domain_id)
    .fetch_optional(store.pool())
    .await
    .context("federation domain lookup failed")?;
    if domain_exists.is_none() {
        bail!("--domain-id must identify an active domain under the root tenant");
    }

    let raw_token = format!("mpf_{}{}", Uuid::now_v7().simple(), Uuid::now_v7().simple());
    let token_hash = sha256(&raw_token);
    let invite_id = Uuid::now_v7();
    let expires_at = OffsetDateTime::now_utc() + TimeDuration::hours(i64::from(expires_hours));
    sqlx::query(
        r#"INSERT INTO platform_federation_invites
             (id, tenant_id, parent_organization_id, domain_id, token_hash, expires_at, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, decode($5, 'hex'), $6, 'cli')"#,
    )
    .bind(invite_id)
    .bind(root_tenant_id)
    .bind(parent)
    .bind(domain_id)
    .bind(token_hash)
    .bind(expires_at)
    .execute(store.pool())
    .await
    .context("federation invite could not be stored")?;

    let base_url = normalize_admin_base_url(
        base_url
            .or_else(|| env::var("BETTER_AUTH_URL").ok())
            .unwrap_or_else(|| "http://localhost:4173".to_owned()),
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "inviteId": invite_id,
            "tenantId": root_tenant_id,
            "parentOrganizationId": parent,
            "domainId": domain_id,
            "expiresAt": expires_at,
            "enrollmentToken": raw_token,
            "enrollmentUrl": format!("{base_url}/api/platform/federation/enroll"),
            "next": "remote_admin_submits_signed_matchplane_federation_v1_manifest_then_root_admin_activates"
        }))
        .context("federation invite output failed")?
    );
    Ok(())
}

fn admin_invite_role_value(role: AdminInviteRole) -> &'static str {
    match role {
        AdminInviteRole::RootAdmin => "rootAdmin",
        AdminInviteRole::SubplatformAdmin => "subplatform_admin",
    }
}

fn normalize_admin_base_url(value: String) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    let mut parsed = Url::parse(value).context("--base-url must be a valid http(s) URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        bail!("--base-url must be an http(s) origin");
    }
    if env::var("MATCHPLANE_ENVIRONMENT").ok().as_deref() == Some("production")
        && parsed.scheme() != "https"
    {
        bail!("--base-url must use HTTPS in production");
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    let path = parsed.path().trim_end_matches('/').to_owned();
    parsed.set_path(&path);
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}

fn sha256(value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    hex::encode(digest.finalize())
}

fn print_provisioned_root(
    provisioned: &ProvisionedRootPlatform,
    admin_email: Option<&str>,
) -> Result<()> {
    let mut output =
        serde_json::to_value(provisioned).context("root provisioning result encoding failed")?;
    if let Some(object) = output.as_object_mut() {
        object.insert(
            "next".to_owned(),
            json!({
                "setRootTenantId": format!(
                    "MATCHPLANE_ROOT_TENANT_ID={}",
                    provisioned.tenant.id
                ),
                "setRootAdminEmail": admin_email.map(|email| format!("MATCHPLANE_ROOT_ADMIN_EMAIL={email}")),
                "firstAdminFlow": [
                    "配置 MATCHPLANE_ROOT_ADMIN_EMAIL 与 root SMTP 后重启 web",
                    "使用该邮箱在 /login?role=platform 注册并完成邮箱验证",
                    "在根平台后台点击“初始化根平台组织”",
                    "再执行 matchplane admin-invite --role root-admin 为其他管理员签发一次性链接"
                ],
                "adminInviteCommand": "matchplane admin-invite --role root-admin（根组织初始化后）",
                "loginPath": "/login?role=platform",
                "restartRequired": true
            }),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&output).context("root provisioning output failed")?
    );
    Ok(())
}

fn validate_operator_email(email: &str) -> Result<()> {
    let Some((local, domain)) = email.split_once('@') else {
        bail!("--admin-email must be an operator-owned email address");
    };
    let valid = email.len() <= 320
        && !local.is_empty()
        && email.matches('@').count() == 1
        && local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._%+-".contains(&byte))
        && domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.starts_with('-')
        && !domain.ends_with('-')
        && !domain.contains("..")
        && !email.ends_with("@example.com")
        && !email.ends_with("@example.org")
        && !email.ends_with("@example.net");
    if valid {
        Ok(())
    } else {
        bail!("--admin-email must be an operator-owned email address")
    }
}

fn validate_operator_uuid(value: Uuid, flag: &str) -> Result<()> {
    if value.is_nil()
        || value.get_variant() != Variant::RFC4122
        || !(1..=8).contains(&value.get_version_num())
    {
        bail!("{flag} must be a non-nil RFC 4122 UUID with version 1 through 8");
    }
    Ok(())
}

async fn doctor() -> Result<()> {
    let report = doctor_report();
    println!(
        "{}",
        serde_json::to_string_pretty(&report).context("doctor result encoding failed")?
    );
    if report.ok {
        Ok(())
    } else {
        bail!("configuration doctor found a blocking error")
    }
}

fn doctor_report() -> DoctorReport {
    match AppConfig::load_diagnostics() {
        Ok(diagnostics) => doctor_report_from_diagnostics(diagnostics),
        Err(error) => DoctorReport {
            ok: false,
            environment: env::var("MATCHPLANE_ENVIRONMENT").ok(),
            service_role: env::var("MATCHPLANE_SERVICE_ROLE").ok(),
            error: Some(safe_error(&error.to_string())),
            errors: vec![safe_error(&error.to_string())],
        },
    }
}

fn doctor_report_from_diagnostics(diagnostics: ConfigurationDiagnostics) -> DoctorReport {
    let errors = diagnostics
        .errors
        .iter()
        .map(|error| safe_error(error))
        .collect::<Vec<_>>();
    DoctorReport {
        ok: errors.is_empty(),
        environment: Some(environment_name(diagnostics.environment).to_owned()),
        service_role: Some(diagnostics.service_role),
        error: errors.first().cloned(),
        errors,
    }
}

async fn status() -> Result<()> {
    let report = probe_status().await;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).context("status result encoding failed")?
    );
    if report.ok {
        Ok(())
    } else {
        bail!("one or more MatchPlane readiness probes failed")
    }
}

fn serve(service: Service, args: &[String]) -> Result<()> {
    let mut command = if matches!(service, Service::Web) {
        ProcessCommand::new(resolve_web_node())
    } else {
        let (program, default_args) = service_command(service);
        let mut command = ProcessCommand::new(program);
        command.args(default_args);
        command
    };
    if matches!(service, Service::Web) {
        command.arg(env_or(
            "MATCHPLANE_WEB_SERVER",
            "/usr/share/matchplane/web/server.js",
        ));
    }
    command.args(args);
    let status = command
        .status()
        .with_context(|| format!("could not start MatchPlane {service:?} workload"))?;
    if let Some(code) = status.code() {
        if code == 0 {
            return Ok(());
        }
        bail!("MatchPlane {service:?} workload exited with status {code}");
    }
    bail!("MatchPlane {service:?} workload terminated by a signal")
}

fn service_command(service: Service) -> (&'static str, &'static [&'static str]) {
    match service {
        Service::Gateway => ("matchplane-gateway", &[]),
        Service::Payment => ("matchplane-payment-service", &[]),
        Service::EventRelay => ("matchplane-event-relay", &[]),
        Service::Matcher => ("matchplane-matcher", &[]),
        Service::Projector => ("matchplane-projector", &[]),
        Service::VectorWorker => ("matchplane-vector-worker", &[]),
        Service::FederationHub => ("matchplane-federation-hub", &[]),
        Service::SubplatformBuilder => ("matchplane-subplatform-builder", &[]),
        Service::Web => ("node", &[]),
    }
}

async fn serve_mcp() -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.context("MCP stdin read failed")? {
        if line.trim().is_empty() {
            continue;
        }
        let request = serde_json::from_str::<JsonRpcRequest>(&line)
            .with_context(|| "MCP request must be one JSON object per line")?;
        let response = handle_mcp_request(request).await?;
        if let Some(response) = response {
            let encoded = serde_json::to_vec(&response).context("MCP response encoding failed")?;
            stdout
                .write_all(&encoded)
                .await
                .context("MCP stdout write failed")?;
            stdout
                .write_all(b"\n")
                .await
                .context("MCP stdout newline write failed")?;
            stdout.flush().await.context("MCP stdout flush failed")?;
        }
    }
    Ok(())
}

async fn handle_mcp_request(request: JsonRpcRequest) -> Result<Option<JsonRpcResponse>> {
    let Some(id) = request.id else {
        // Notifications intentionally have no response, as required by JSON-RPC/MCP.
        return Ok(None);
    };
    let response = match request.method.as_str() {
        "initialize" => JsonRpcResponse::success(
            id,
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "matchplane", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "tools/list" => JsonRpcResponse::success(id, tool_list()),
        "tools/call" => match mcp_tool_name(&request.params) {
            Some("platform.status") => {
                JsonRpcResponse::success(id, tool_result(probe_status().await))
            }
            Some("platform.doctor") => JsonRpcResponse::success(id, tool_result(doctor_report())),
            Some("platform.health") => {
                JsonRpcResponse::success(id, tool_result(probe_status().await))
            }
            Some(name) => JsonRpcResponse::error(id, -32602, format!("unknown MCP tool: {name}")),
            None => {
                JsonRpcResponse::error(id, -32602, "tools/call requires params.name".to_owned())
            }
        },
        _ => JsonRpcResponse::error(id, -32601, format!("method not found: {}", request.method)),
    };
    Ok(Some(response))
}

fn tool_list() -> Value {
    json!({
        "tools": [
            { "name": "platform.status", "description": "Probe MatchPlane readiness endpoints without exposing secrets.", "inputSchema": { "type": "object", "additionalProperties": false } },
            { "name": "platform.doctor", "description": "Validate loaded configuration and production safety gates.", "inputSchema": { "type": "object", "additionalProperties": false } },
            { "name": "platform.health", "description": "Return the same bounded read-only health report as platform.status.", "inputSchema": { "type": "object", "additionalProperties": false } }
        ]
    })
}

fn mcp_tool_name(params: &Value) -> Option<&str> {
    params.get("name").and_then(Value::as_str)
}

fn tool_result<T: Serialize>(value: T) -> Value {
    let text = serde_json::to_string(&value).unwrap_or_else(|_| "{\"ok\":false}".to_owned());
    json!({ "content": [{ "type": "text", "text": text }] })
}

async fn probe_status() -> StatusReport {
    let client = match Client::builder().timeout(Duration::from_secs(4)).build() {
        Ok(client) => client,
        Err(error) => {
            return StatusReport {
                ok: false,
                checks: vec![Probe {
                    service: "cli",
                    url: "internal".to_owned(),
                    ok: false,
                    status: None,
                    error: Some(safe_error(&error.to_string())),
                }],
            };
        }
    };
    let checks = vec![
        probe(
            &client,
            "gateway",
            env_or(
                "MATCHPLANE_GATEWAY_HEALTH_URL",
                "http://127.0.0.1:8080/health/ready",
            ),
        )
        .await,
        probe(
            &client,
            "payment",
            env_or(
                "MATCHPLANE_PAYMENT_HEALTH_URL",
                "http://127.0.0.1:8081/health/ready",
            ),
        )
        .await,
        probe(
            &client,
            "web",
            env_or(
                "MATCHPLANE_WEB_HEALTH_URL",
                "http://127.0.0.1:4173/api/health/web",
            ),
        )
        .await,
    ];
    StatusReport {
        ok: checks.iter().all(|check| check.ok),
        checks,
    }
}

async fn probe(client: &Client, service: &'static str, url: String) -> Probe {
    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            Probe {
                service,
                url,
                ok: response.status().is_success(),
                status: Some(status),
                error: None,
            }
        }
        Err(error) => Probe {
            service,
            url,
            ok: false,
            status: None,
            error: Some(safe_error(&error.to_string())),
        },
    }
}

fn env_or(name: &str, fallback: &str) -> String {
    env::var(name).unwrap_or_else(|_| fallback.to_owned())
}

/// Resolve the Node executable for the standalone web workload.
///
/// Linux packages normally install Node at `/usr/bin/node`, while operators who install a
/// pinned upstream runtime often use `/usr/local/bin/node`. A missing explicit path should not
/// make an otherwise valid release fail before the child process can emit a useful error.
fn resolve_web_node() -> String {
    resolve_web_node_with(
        env::var("MATCHPLANE_WEB_NODE").ok().as_deref(),
        node_candidate_exists,
    )
}

fn resolve_web_node_with<F>(configured: Option<&str>, mut candidate_exists: F) -> String
where
    F: FnMut(&str) -> bool,
{
    let configured = configured.unwrap_or("node");
    if candidate_exists(configured) {
        return configured.to_owned();
    }

    for candidate in ["/usr/local/bin/node", "/usr/bin/node", "node"] {
        if candidate_exists(candidate) {
            return candidate.to_owned();
        }
    }

    // Keep the operator's explicit value for the eventual OS error when no candidate exists.
    configured.to_owned()
}

fn node_candidate_exists(candidate: &str) -> bool {
    candidate == "node" || Path::new(candidate).is_file()
}

fn environment_name(environment: Environment) -> &'static str {
    match environment {
        Environment::Development => "development",
        Environment::Test => "test",
        Environment::Production => "production",
    }
}

fn safe_error(error: &str) -> String {
    let mut redacted = error.to_owned();
    for scheme in ["postgres://", "redis://", "rediss://"] {
        let mut search_from = 0;
        while let Some(relative_start) = redacted[search_from..].find(scheme) {
            let scheme_start = search_from + relative_start;
            let authority_start = scheme_start + scheme.len();
            let Some(relative_at) = redacted[authority_start..].find('@') else {
                search_from = authority_start;
                continue;
            };
            let authority_end = authority_start + relative_at + 1;
            redacted.replace_range(authority_start..authority_end, "[redacted]@");
            search_from = authority_start + "[redacted]@".len();
        }
    }
    redacted.chars().take(500).collect()
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    ok: bool,
    environment: Option<String>,
    service_role: Option<String>,
    error: Option<String>,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
struct StatusReport {
    ok: bool,
    checks: Vec<Probe>,
}

#[derive(Debug, Serialize)]
struct Probe {
    service: &'static str,
    url: String,
    ok: bool,
    status: Option<u16>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError { code, message }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AdminInviteRole, Service, admin_invite_role_value, normalize_admin_base_url,
        resolve_web_node_with, service_command, sha256, validate_operator_email,
        validate_operator_uuid,
    };
    use uuid::Uuid;

    #[test]
    fn service_command_maps_gateway_to_the_packaged_binary() {
        assert_eq!(service_command(Service::Gateway).0, "matchplane-gateway");
    }

    #[test]
    fn service_command_maps_web_to_node() {
        assert_eq!(service_command(Service::Web).0, "node");
    }

    #[test]
    fn web_node_resolution_keeps_an_available_configured_path() {
        let resolved = resolve_web_node_with(Some("/opt/node/bin/node"), |candidate| {
            candidate == "/opt/node/bin/node"
        });
        assert_eq!(resolved, "/opt/node/bin/node");
    }

    #[test]
    fn web_node_resolution_falls_back_to_a_host_runtime_path() {
        let resolved = resolve_web_node_with(Some("/usr/bin/node"), |candidate| {
            candidate == "/usr/local/bin/node"
        });
        assert_eq!(resolved, "/usr/local/bin/node");
    }

    #[test]
    fn operator_email_rejects_placeholder_domains() {
        assert!(validate_operator_email("admin@example.com").is_err());
    }

    #[test]
    fn operator_email_accepts_an_owned_domain_shape() {
        assert!(validate_operator_email("owner@operator.test").is_ok());
    }

    #[test]
    fn operator_email_rejects_shell_metacharacters() {
        assert!(validate_operator_email("owner$(id)@operator.test").is_err());
        assert!(validate_operator_email("owner@operator.test;echo bad").is_err());
    }

    #[test]
    fn operator_uuid_rejects_nil_and_non_rfc_versions() {
        assert!(validate_operator_uuid(Uuid::nil(), "--tenant-id").is_err());
        assert!(
            validate_operator_uuid(
                Uuid::parse_str("00000000-0000-9000-8000-000000000001").unwrap(),
                "--tenant-id",
            )
            .is_err()
        );
        assert!(
            validate_operator_uuid(
                Uuid::parse_str("00000000-0000-7000-8000-000000000001").unwrap(),
                "--tenant-id",
            )
            .is_ok()
        );
    }

    #[test]
    fn admin_invite_token_hash_is_stable_and_hex() {
        let hash = sha256("mpa_test");
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn admin_invite_roles_use_better_auth_role_names() {
        assert_eq!(
            admin_invite_role_value(AdminInviteRole::RootAdmin),
            "rootAdmin"
        );
        assert_eq!(
            admin_invite_role_value(AdminInviteRole::SubplatformAdmin),
            "subplatform_admin"
        );
    }

    #[test]
    fn admin_base_url_strips_query_and_fragment() {
        assert_eq!(
            normalize_admin_base_url("https://matx.tech/console/?old=1#fragment".to_owned())
                .unwrap(),
            "https://matx.tech/console"
        );
        assert!(normalize_admin_base_url("ftp://matx.tech".to_owned()).is_err());
    }
}
