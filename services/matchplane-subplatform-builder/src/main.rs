//! Isolated builder for MatchPlane static subplatform packages.
//!
//! The worker deliberately has no database client and no platform credentials. It leases a
//! registration from the web process, materialises the immutable source in a private work root,
//! runs one of the allow-listed package build templates, publishes only a static directory, and
//! reports a digest. Activation remains an operator action in the web process.

use std::{
    collections::BTreeMap,
    env,
    ffi::OsStr,
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use anyhow::{Context, Result, bail};
use flate2::read::GzDecoder;
use matchplane_observability::init;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tar::Archive;
use tokio::{
    fs as tokio_fs,
    io::AsyncWriteExt,
    process::Command,
    time::{sleep, timeout},
};
use tracing::{error, info, warn};
use url::Url;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXTRACTED_FILES: usize = 20_000;
const MAX_COMMAND_OUTPUT: usize = 2 * 1024 * 1024;
const DEFAULT_POLL_SECONDS: u64 = 5;
const DEFAULT_BUILD_SECONDS: u64 = 900;
const SAFE_COMMAND_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

#[derive(Debug, Clone)]
struct Config {
    web_url: Url,
    token: String,
    upload_root: PathBuf,
    artifact_root: PathBuf,
    work_root: PathBuf,
    poll_seconds: Duration,
    build_seconds: Duration,
    allowed_git_hosts: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    job: Option<BuildJob>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryClaimResponse {
    job: Option<DiscoveryJob>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildJob {
    id: Uuid,
    package_id: String,
    slug: String,
    source_kind: String,
    source_locator: String,
    pinned_revision: String,
    source_digest: String,
    manifest_digest: String,
    lease_id: Uuid,
    build_attempts: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryJob {
    id: Uuid,
    source_kind: String,
    source_locator: String,
    source_digest: Option<String>,
    lease_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildSuccess<'a> {
    registration_id: Uuid,
    lease_id: Uuid,
    build_digest: &'a str,
    source_digest: &'a str,
    manifest_digest: &'a str,
    artifact_path: &'a str,
    artifact_entry: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildFailure {
    registration_id: Uuid,
    lease_id: Uuid,
    error: String,
    retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverySuccess {
    intake_id: Uuid,
    lease_id: Uuid,
    source_digest: String,
    pinned_revision: String,
    manifest_digest: String,
    manifest: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFailure {
    intake_id: Uuid,
    lease_id: Uuid,
    error: String,
    retryable: bool,
}

#[derive(Debug)]
struct MaterializedSource {
    root: PathBuf,
    source_digest: String,
}

#[derive(Debug)]
struct DiscoveredSource {
    root: PathBuf,
    source_digest: String,
    pinned_revision: String,
}

#[derive(Debug)]
struct BuildOutput {
    digest: String,
    artifact_path: String,
    artifact_entry: String,
}

#[derive(Debug)]
struct Manifest {
    slug: String,
    manifest_digest: String,
    package_root: PathBuf,
    static_directory: PathBuf,
    build_template: BuildTemplate,
    dependency_policy: DependencyPolicy,
}

#[derive(Debug, Clone, Copy)]
enum BuildTemplate {
    Bun,
    Npm,
    Pnpm,
    Yarn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DependencyPolicy {
    Locked,
    Latest,
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load()?;
    fs::create_dir_all(&config.work_root).context("creating builder work root")?;
    fs::create_dir_all(&config.artifact_root).context("creating builder artifact root")?;
    let log_filter = env::var("MATCHPLANE_LOG_FILTER").unwrap_or_else(|_| "info".to_owned());
    let otlp_endpoint =
        env::var("MATCHPLANE_OTLP_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:4317".to_owned());
    let telemetry = init(
        "matchplane-subplatform-builder",
        &log_filter,
        &otlp_endpoint,
    )
    .context("builder observability initialization failed")?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .context("builder HTTP client initialization failed")?;

    info!(web_url = %config.web_url, "static subplatform builder ready");
    let mut shutdown = Box::pin(tokio::signal::ctrl_c());
    loop {
        let discovery_claim = tokio::select! {
            signal = &mut shutdown => {
                signal.context("builder shutdown signal failed")?;
                info!("static subplatform builder shutting down");
                break;
            }
            result = claim_discovery(&client, &config) => result,
        };
        match discovery_claim {
            Ok(Some(job)) => {
                info!(intake_id = %job.id, "claimed subplatform source discovery");
                if let Err(error) = discover_one(&client, &config, &job).await {
                    let message = summarize_error(&error);
                    let retryable = is_retryable(&message, 1);
                    error!(intake_id = %job.id, %message, retryable, "subplatform source discovery failed");
                    if let Err(callback_error) =
                        report_discovery_failure(&client, &config, &job, message, retryable).await
                    {
                        error!(intake_id = %job.id, error = %callback_error, "could not report source discovery failure");
                    }
                }
                continue;
            }
            Ok(None) => {}
            Err(error) => {
                warn!(error = %error, "source discovery claim failed; backing off");
                tokio::select! {
                    signal = &mut shutdown => {
                        signal.context("builder shutdown signal failed")?;
                        info!("static subplatform builder shutting down");
                        break;
                    }
                    _ = sleep(config.poll_seconds) => {}
                }
                continue;
            }
        }
        let claim = tokio::select! {
            signal = &mut shutdown => {
                signal.context("builder shutdown signal failed")?;
                info!("static subplatform builder shutting down");
                break;
            }
            result = claim_job(&client, &config) => result,
        };
        match claim {
            Ok(Some(job)) => {
                info!(registration_id = %job.id, attempts = job.build_attempts, "claimed subplatform build");
                if let Err(error) = build_one(&client, &config, &job).await {
                    let message = summarize_error(&error);
                    let retryable = is_retryable(&message, job.build_attempts);
                    error!(registration_id = %job.id, %message, retryable, "subplatform build failed");
                    if let Err(callback_error) =
                        report_failure(&client, &config, &job, message, retryable).await
                    {
                        error!(registration_id = %job.id, error = %callback_error, "could not report builder failure");
                    }
                }
            }
            Ok(None) => {
                tokio::select! {
                    signal = &mut shutdown => {
                        signal.context("builder shutdown signal failed")?;
                        info!("static subplatform builder shutting down");
                        break;
                    }
                    _ = sleep(config.poll_seconds) => {}
                }
            }
            Err(error) => {
                warn!(error = %error, "builder claim failed; backing off");
                tokio::select! {
                    signal = &mut shutdown => {
                        signal.context("builder shutdown signal failed")?;
                        info!("static subplatform builder shutting down");
                        break;
                    }
                    _ = sleep(config.poll_seconds) => {}
                }
            }
        }
    }
    telemetry
        .shutdown()
        .context("builder telemetry shutdown failed")?;
    Ok(())
}

impl Config {
    fn load() -> Result<Self> {
        let web_url = required_url("MATCHPLANE_SUBPLATFORM_BUILDER_WEB_URL")?;
        let token = secret_from_env_or_file(
            "MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN",
            "MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE",
        )?;
        let upload_root = required_absolute_path("MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT")?;
        let artifact_root = required_absolute_path("MATCHPLANE_SUBPLATFORM_ARTIFACT_ROOT")?;
        let work_root = env::var("MATCHPLANE_SUBPLATFORM_BUILDER_WORK_ROOT")
            .unwrap_or_else(|_| "/var/lib/matchplane/subplatform-builder-work".to_owned());
        let work_root = absolute_path(&work_root, "MATCHPLANE_SUBPLATFORM_BUILDER_WORK_ROOT")?;
        let poll_seconds = bounded_seconds(
            "MATCHPLANE_SUBPLATFORM_BUILDER_POLL_SECONDS",
            DEFAULT_POLL_SECONDS,
            1,
            60,
        );
        let build_seconds = bounded_seconds(
            "MATCHPLANE_SUBPLATFORM_BUILDER_BUILD_SECONDS",
            DEFAULT_BUILD_SECONDS,
            30,
            3_600,
        );
        let allowed_git_hosts = env::var("MATCHPLANE_SUBPLATFORM_GIT_ALLOWED_HOSTS")
            .unwrap_or_else(|_| "github.com,gitlab.com".to_owned())
            .split(',')
            .map(|host| host.trim().to_ascii_lowercase())
            .filter(|host| !host.is_empty())
            .collect::<Vec<_>>();
        if allowed_git_hosts.is_empty() {
            bail!("MATCHPLANE_SUBPLATFORM_GIT_ALLOWED_HOSTS must contain at least one host");
        }
        Ok(Self {
            web_url,
            token,
            upload_root,
            artifact_root,
            work_root,
            poll_seconds,
            build_seconds,
            allowed_git_hosts,
        })
    }
}

async fn claim_job(client: &Client, config: &Config) -> Result<Option<BuildJob>> {
    let response = client
        .post(
            config
                .web_url
                .join("/api/platform/subplatforms/build/claim")?,
        )
        .header("x-matchplane-builder-token", &config.token)
        .send()
        .await
        .context("claim request failed")?;
    let status = response.status();
    let body = response.text().await.context("reading claim response")?;
    if !status.is_success() {
        bail!("claim endpoint returned {status}: {}", truncate(&body, 800));
    }
    let claim: ClaimResponse = serde_json::from_str(&body).context("invalid claim response")?;
    Ok(claim.job)
}

async fn claim_discovery(client: &Client, config: &Config) -> Result<Option<DiscoveryJob>> {
    let response = client
        .post(
            config
                .web_url
                .join("/api/platform/subplatforms/discover/claim")?,
        )
        .header("x-matchplane-builder-token", &config.token)
        .send()
        .await
        .context("source discovery claim request failed")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("reading discovery claim response")?;
    if !status.is_success() {
        bail!(
            "discovery claim endpoint returned {status}: {}",
            truncate(&body, 800)
        );
    }
    let claim = serde_json::from_str::<DiscoveryClaimResponse>(&body)
        .context("invalid discovery claim response")?;
    Ok(claim.job)
}

async fn discover_one(client: &Client, config: &Config, job: &DiscoveryJob) -> Result<()> {
    let workspace = config
        .work_root
        .join(format!("discover-{}-{}", job.id, job.lease_id));
    remove_dir(&workspace).await?;
    tokio_fs::create_dir_all(&workspace)
        .await
        .context("creating discovery workspace")?;
    let result = discover_one_inner(client, config, job, &workspace).await;
    if let Err(error) = tokio_fs::remove_dir_all(&workspace).await {
        warn!(path = %workspace.display(), error = %error, "could not remove discovery workspace");
    }
    result
}

async fn discover_one_inner(
    client: &Client,
    config: &Config,
    job: &DiscoveryJob,
    workspace: &Path,
) -> Result<()> {
    let source = materialize_discovery_source(config, job, workspace).await?;
    if let Some(expected) = &job.source_digest
        && !constant_time_hex_eq(expected, &source.source_digest)
    {
        bail!(
            "source digest mismatch: expected {expected}, got {}",
            source.source_digest
        );
    }
    let manifest_path = locate_manifest(&source.root)?;
    let bytes = fs::read(&manifest_path).context("reading matchplane.subplatform.json")?;
    if bytes.len() > 64 * 1024 {
        bail!("manifest exceeds 64 KiB");
    }
    let manifest: Value = serde_json::from_slice(&bytes).context("manifest is not valid JSON")?;
    let object = manifest
        .as_object()
        .context("manifest must be a JSON object")?;
    if object.get("apiVersion").and_then(Value::as_str) != Some("matchplane.subplatform/v1")
        || object.get("rootApiVersion").and_then(Value::as_str) != Some("v1")
    {
        bail!("unsupported subplatform manifest API");
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .context("manifest.id is required")?;
    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .context("manifest.slug is required")?;
    if !is_valid_package_id(id) || !is_valid_slug(slug) || slug == "root" {
        bail!("manifest id or slug is invalid");
    }
    let assets = object
        .get("assets")
        .and_then(Value::as_object)
        .context("manifest.assets is required")?;
    let static_directory = assets
        .get("staticDirectory")
        .and_then(Value::as_str)
        .context("manifest.assets.staticDirectory is required")?;
    safe_relative_path(Path::new(static_directory))?;
    let build_template = BuildTemplate::parse(
        assets
            .get("buildCommand")
            .and_then(Value::as_str)
            .context("manifest.assets.buildCommand is required")?,
    )?;
    DependencyPolicy::parse(
        assets.get("dependencyPolicy").and_then(Value::as_str),
        build_template,
    )?;
    let manifest_digest = hex::encode(Sha256::digest(canonical_json(&manifest).as_bytes()));
    let payload = DiscoverySuccess {
        intake_id: job.id,
        lease_id: job.lease_id,
        source_digest: source.source_digest,
        pinned_revision: source.pinned_revision,
        manifest_digest,
        manifest,
    };
    post_json(
        client,
        config,
        "/api/platform/subplatforms/discover/complete",
        &payload,
    )
    .await
}

async fn report_discovery_failure(
    client: &Client,
    config: &Config,
    job: &DiscoveryJob,
    error: String,
    retryable: bool,
) -> Result<()> {
    let payload = DiscoveryFailure {
        intake_id: job.id,
        lease_id: job.lease_id,
        error,
        retryable,
    };
    post_json(
        client,
        config,
        "/api/platform/subplatforms/discover/fail",
        &payload,
    )
    .await
}

async fn materialize_discovery_source(
    config: &Config,
    job: &DiscoveryJob,
    workspace: &Path,
) -> Result<DiscoveredSource> {
    let source_dir = workspace.join("source");
    tokio_fs::create_dir_all(&source_dir)
        .await
        .context("creating discovery source directory")?;
    match job.source_kind.as_str() {
        "archive" => {
            let upload_id = job
                .source_locator
                .strip_prefix("upload://")
                .context("archive locator must be upload://")?;
            let upload_id =
                Uuid::parse_str(upload_id).context("archive upload locator is not a UUID")?;
            let archive_path = config.upload_root.join(format!("{upload_id}.archive"));
            if !is_within(&config.upload_root, &archive_path) || !archive_path.is_file() {
                bail!("archive upload was not found");
            }
            let actual = hex::encode(sha256_file(&archive_path)?);
            extract_archive(&archive_path, &source_dir)?;
            Ok(DiscoveredSource {
                root: source_dir,
                source_digest: actual.clone(),
                pinned_revision: actual,
            })
        }
        "git" => {
            let url = Url::parse(&job.source_locator).context("git source locator is not a URL")?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                bail!("builder accepts only credential-free HTTPS Git URLs");
            }
            validate_allowed_host(&url, &config.allowed_git_hosts)?;
            let revision = run_git_checkout_default(&url, &source_dir).await?;
            let archive_path = workspace.join("git-source.tar");
            run_checked(
                "git",
                &[
                    "-c".into(),
                    "protocol.file.allow=never".into(),
                    "-c".into(),
                    "core.hooksPath=/dev/null".into(),
                    "-C".into(),
                    source_dir.display().to_string(),
                    "archive".into(),
                    "--format=tar".into(),
                    "--output".into(),
                    archive_path.display().to_string(),
                    revision.clone(),
                ],
                workspace,
                Duration::from_secs(300),
            )
            .await?;
            let actual = hex::encode(sha256_file(&archive_path)?);
            Ok(DiscoveredSource {
                root: source_dir,
                source_digest: actual,
                pinned_revision: revision,
            })
        }
        other => bail!("unsupported source kind {other}"),
    }
}

fn is_valid_package_id(value: &str) -> bool {
    value.len() <= 128
        && value.len() >= 2
        && value
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}
fn is_valid_slug(value: &str) -> bool {
    value.len() <= 63
        && value.len() >= 2
        && value
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

async fn build_one(client: &Client, config: &Config, job: &BuildJob) -> Result<()> {
    let workspace = config
        .work_root
        .join(format!("{}-{}", job.id, job.lease_id));
    remove_dir(&workspace).await?;
    tokio_fs::create_dir_all(&workspace)
        .await
        .context("creating isolated workspace")?;
    let result = build_one_inner(client, config, job, &workspace).await;
    if let Err(error) = tokio_fs::remove_dir_all(&workspace).await {
        warn!(path = %workspace.display(), error = %error, "could not remove builder workspace");
    }
    result
}

async fn build_one_inner(
    client: &Client,
    config: &Config,
    job: &BuildJob,
    workspace: &Path,
) -> Result<()> {
    let source = materialize_source(client, config, job, workspace).await?;
    if !constant_time_hex_eq(&source.source_digest, &job.source_digest) {
        bail!(
            "source digest mismatch: expected {}, got {}",
            job.source_digest,
            source.source_digest
        );
    }
    let manifest = read_manifest(&source.root, job, &job.manifest_digest)?;
    let build_dir = workspace.join("build");
    tokio_fs::create_dir_all(&build_dir)
        .await
        .context("creating build scratch directory")?;
    prepare_dependencies(&manifest, &build_dir).await?;
    run_build(&manifest, config.build_seconds, &build_dir).await?;
    let output = publish_artifact(config, &manifest, &build_dir, &job.id).await?;
    let payload = BuildSuccess {
        registration_id: job.id,
        lease_id: job.lease_id,
        build_digest: &output.digest,
        source_digest: &source.source_digest,
        manifest_digest: &manifest.manifest_digest,
        artifact_path: &output.artifact_path,
        artifact_entry: &output.artifact_entry,
    };
    post_json(client, config, "/api/platform/subplatforms/build", &payload).await?;
    info!(registration_id = %job.id, build_digest = %output.digest, "subplatform build is ready for operator activation");
    Ok(())
}

async fn report_failure(
    client: &Client,
    config: &Config,
    job: &BuildJob,
    error: String,
    retryable: bool,
) -> Result<()> {
    let payload = BuildFailure {
        registration_id: job.id,
        lease_id: job.lease_id,
        error,
        retryable,
    };
    post_json(
        client,
        config,
        "/api/platform/subplatforms/build/fail",
        &payload,
    )
    .await
}

async fn post_json<T: Serialize>(
    client: &Client,
    config: &Config,
    path: &str,
    payload: &T,
) -> Result<()> {
    let response = client
        .post(config.web_url.join(path)?)
        .header("x-matchplane-builder-token", &config.token)
        .json(payload)
        .send()
        .await
        .with_context(|| format!("POST {path} failed"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("reading builder callback response")?;
    if !status.is_success() {
        bail!(
            "builder callback returned {status}: {}",
            truncate(&body, 800)
        );
    }
    Ok(())
}

async fn materialize_source(
    client: &Client,
    config: &Config,
    job: &BuildJob,
    workspace: &Path,
) -> Result<MaterializedSource> {
    let source_dir = workspace.join("source");
    tokio_fs::create_dir_all(&source_dir)
        .await
        .context("creating source directory")?;
    match job.source_kind.as_str() {
        "archive" => {
            let archive_path = if let Some(upload_id) = job.source_locator.strip_prefix("upload://")
            {
                let upload_id =
                    Uuid::parse_str(upload_id).context("archive upload locator is not a UUID")?;
                config.upload_root.join(format!("{upload_id}.archive"))
            } else if let Some(url) = job.source_locator.strip_prefix("https://") {
                let url = Url::parse(&format!("https://{url}"))?;
                validate_allowed_host(&url, &config.allowed_git_hosts)?;
                let path = workspace.join("download.archive");
                download_bounded(client, &url, &path).await?;
                path
            } else {
                bail!("archive locator must be upload:// or HTTPS");
            };
            if !is_within(&config.upload_root, &archive_path)
                && archive_path != workspace.join("download.archive")
            {
                bail!("archive locator escapes the upload root");
            }
            let actual = sha256_file(&archive_path)?;
            let actual_hex = hex::encode(actual);
            extract_archive(&archive_path, &source_dir)?;
            Ok(MaterializedSource {
                root: source_dir,
                source_digest: actual_hex,
            })
        }
        "git" => {
            if !is_full_git_revision(&job.pinned_revision) {
                bail!("git pinnedRevision must be a full 40-character commit SHA");
            }
            let url = Url::parse(&job.source_locator).context("git source locator is not a URL")?;
            if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
                bail!("builder accepts only credential-free HTTPS Git URLs");
            }
            validate_allowed_host(&url, &config.allowed_git_hosts)?;
            run_git_checkout(&url, &job.pinned_revision, &source_dir).await?;
            let archive_path = workspace.join("git-source.tar");
            run_checked(
                "git",
                &[
                    "-c".into(),
                    "protocol.file.allow=never".into(),
                    "-c".into(),
                    "core.hooksPath=/dev/null".into(),
                    "-C".into(),
                    source_dir.display().to_string(),
                    "archive".into(),
                    "--format=tar".into(),
                    "--output".into(),
                    archive_path.display().to_string(),
                    job.pinned_revision.clone(),
                ],
                workspace,
                Duration::from_secs(300),
            )
            .await?;
            let actual = sha256_file(&archive_path)?;
            let actual_hex = hex::encode(actual);
            Ok(MaterializedSource {
                root: source_dir,
                source_digest: actual_hex,
            })
        }
        other => bail!("unsupported source kind {other}"),
    }
}

async fn run_git_checkout(url: &Url, revision: &str, destination: &Path) -> Result<()> {
    run_checked(
        "git",
        &[
            "-c".into(),
            "protocol.file.allow=never".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "init".into(),
            "--quiet".into(),
            destination.display().to_string(),
        ],
        destination.parent().unwrap_or_else(|| Path::new("/")),
        Duration::from_secs(300),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-C".into(),
            destination.display().to_string(),
            "remote".into(),
            "add".into(),
            "origin".into(),
            url.to_string(),
        ],
        destination,
        Duration::from_secs(60),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-c".into(),
            "protocol.file.allow=never".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-C".into(),
            destination.display().to_string(),
            "fetch".into(),
            "--depth=1".into(),
            "--no-tags".into(),
            "origin".into(),
            revision.into(),
        ],
        destination,
        Duration::from_secs(300),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-C".into(),
            destination.display().to_string(),
            "checkout".into(),
            "--detach".into(),
            "FETCH_HEAD".into(),
        ],
        destination,
        Duration::from_secs(60),
    )
    .await
}

/// Fetch the repository's advertised default branch once and return the exact commit that was
/// inspected. The returned SHA becomes the immutable registration revision; subsequent builds do
/// not follow a moving branch.
async fn run_git_checkout_default(url: &Url, destination: &Path) -> Result<String> {
    run_checked(
        "git",
        &[
            "-c".into(),
            "protocol.file.allow=never".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "init".into(),
            "--quiet".into(),
            destination.display().to_string(),
        ],
        destination.parent().unwrap_or_else(|| Path::new("/")),
        Duration::from_secs(300),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-C".into(),
            destination.display().to_string(),
            "remote".into(),
            "add".into(),
            "origin".into(),
            url.to_string(),
        ],
        destination,
        Duration::from_secs(60),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-c".into(),
            "protocol.file.allow=never".into(),
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-C".into(),
            destination.display().to_string(),
            "fetch".into(),
            "--depth=1".into(),
            "--no-tags".into(),
            "origin".into(),
            "HEAD".into(),
        ],
        destination,
        Duration::from_secs(300),
    )
    .await?;
    run_checked(
        "git",
        &[
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-C".into(),
            destination.display().to_string(),
            "checkout".into(),
            "--detach".into(),
            "FETCH_HEAD".into(),
        ],
        destination,
        Duration::from_secs(60),
    )
    .await?;
    let revision = run_capture(
        "git",
        &[
            "-c".into(),
            "core.hooksPath=/dev/null".into(),
            "-C".into(),
            destination.display().to_string(),
            "rev-parse".into(),
            "HEAD".into(),
        ],
        destination,
        Duration::from_secs(60),
    )
    .await?;
    let revision = revision.trim().to_owned();
    if !is_full_git_revision(&revision) {
        bail!("git default branch did not resolve to a full commit SHA");
    }
    Ok(revision)
}

async fn download_bounded(client: &Client, url: &Url, destination: &Path) -> Result<()> {
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .context("archive download failed")?;
    if !response.status().is_success() {
        bail!("archive download returned {}", response.status());
    }
    if let Some(length) = response.content_length()
        && length > MAX_SOURCE_BYTES
    {
        bail!("archive download exceeds 64 MiB");
    }
    let mut file = tokio_fs::File::create(destination)
        .await
        .context("creating archive staging file")?;
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await.context("reading archive download")? {
        total = total
            .checked_add(chunk.len() as u64)
            .context("archive download size overflow")?;
        if total > MAX_SOURCE_BYTES {
            bail!("archive download exceeds 64 MiB");
        }
        file.write_all(&chunk)
            .await
            .context("staging archive download")?;
    }
    file.flush()
        .await
        .context("flushing archive staging file")?;
    if total == 0 {
        bail!("archive download must be between 1 B and 64 MiB");
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, destination: &Path) -> Result<()> {
    let bytes = fs::read(archive_path).context("reading source archive")?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        bail!("source archive exceeds 64 MiB");
    }
    let mut reader: Box<dyn Read> = if bytes.starts_with(&[0x1f, 0x8b]) {
        Box::new(GzDecoder::new(bytes.as_slice()))
    } else if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        Box::new(
            zstd::stream::read::Decoder::new(bytes.as_slice()).context("invalid zstd archive")?,
        )
    } else {
        Box::new(bytes.as_slice())
    };
    let mut archive = Archive::new(&mut reader);
    let mut files = 0usize;
    let mut total_bytes = 0u64;
    for entry in archive.entries().context("reading tar entries")? {
        let mut entry = entry.context("reading tar entry")?;
        let path = entry.path().context("reading tar path")?.into_owned();
        let relative = safe_relative_path(&path)?;
        let target = destination.join(&relative);
        if !is_within(destination, &target) {
            bail!("archive entry escapes destination");
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink()
            || kind.is_hard_link()
            || kind.is_block_special()
            || kind.is_character_special()
            || kind.is_fifo()
        {
            bail!(
                "archive contains a link or device entry: {}",
                relative.display()
            );
        }
        if kind.is_dir() {
            fs::create_dir_all(&target)
                .with_context(|| format!("creating archive directory {}", relative.display()))?;
            continue;
        }
        if !kind.is_file() {
            bail!("archive contains unsupported entry: {}", relative.display());
        }
        files += 1;
        if files > MAX_EXTRACTED_FILES {
            bail!("archive contains too many files");
        }
        let size = entry.size();
        total_bytes = total_bytes
            .checked_add(size)
            .context("archive size overflow")?;
        if total_bytes > MAX_EXTRACTED_BYTES {
            bail!("expanded archive exceeds 256 MiB");
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        entry
            .unpack(&target)
            .with_context(|| format!("extracting archive entry {}", relative.display()))?;
    }
    Ok(())
}

fn read_manifest(source_root: &Path, job: &BuildJob, expected_digest: &str) -> Result<Manifest> {
    let manifest_path = locate_manifest(source_root)?;
    let bytes = fs::read(&manifest_path).context("reading matchplane.subplatform.json")?;
    if bytes.len() > 64 * 1024 {
        bail!("manifest exceeds 64 KiB");
    }
    let value: Value = serde_json::from_slice(&bytes).context("manifest is not valid JSON")?;
    let object = value
        .as_object()
        .context("manifest must be a JSON object")?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .context("manifest.id is required")?;
    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .context("manifest.slug is required")?;
    if id != job.package_id || slug != job.slug {
        bail!("manifest id/slug does not match the registration");
    }
    if object.get("apiVersion").and_then(Value::as_str) != Some("matchplane.subplatform/v1")
        || object.get("rootApiVersion").and_then(Value::as_str) != Some("v1")
    {
        bail!("unsupported subplatform manifest API");
    }
    let assets = object
        .get("assets")
        .and_then(Value::as_object)
        .context("manifest.assets is required")?;
    let static_directory = assets
        .get("staticDirectory")
        .and_then(Value::as_str)
        .context("manifest.assets.staticDirectory is required")?;
    let build_command = assets
        .get("buildCommand")
        .and_then(Value::as_str)
        .context("manifest.assets.buildCommand is required")?;
    let static_directory = safe_relative_path(Path::new(static_directory))?;
    let package_root = manifest_path
        .parent()
        .context("manifest has no parent directory")?
        .to_path_buf();
    let build_template = BuildTemplate::parse(build_command)?;
    let dependency_policy = DependencyPolicy::parse(
        assets.get("dependencyPolicy").and_then(Value::as_str),
        build_template,
    )?;
    let digest = hex::encode(Sha256::digest(canonical_json(&value).as_bytes()));
    if !constant_time_hex_eq(&digest, expected_digest) {
        bail!("manifest digest mismatch");
    }
    Ok(Manifest {
        slug: slug.to_owned(),
        manifest_digest: digest,
        package_root,
        static_directory,
        build_template,
        dependency_policy,
    })
}

fn locate_manifest(root: &Path) -> Result<PathBuf> {
    let direct = root.join("matchplane.subplatform.json");
    if direct.is_file() {
        return Ok(direct);
    }
    let mut candidate = None;
    for entry in WalkDir::new(root).follow_links(false).max_depth(4) {
        let entry = entry.context("walking source tree")?;
        if entry.file_type().is_symlink() {
            bail!("source tree contains a symlink");
        }
        if entry.file_type().is_file()
            && entry.file_name() == OsStr::new("matchplane.subplatform.json")
        {
            if candidate.is_some() {
                bail!("source contains multiple manifests");
            }
            candidate = Some(entry.into_path());
        }
    }
    candidate.context("matchplane.subplatform.json was not found")
}

impl BuildTemplate {
    fn parse(command: &str) -> Result<Self> {
        match command.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["bun", "run", "build"] => Ok(Self::Bun),
            ["npm", "run", "build"] => Ok(Self::Npm),
            ["pnpm", "run", "build"] => Ok(Self::Pnpm),
            ["yarn", "build"] => Ok(Self::Yarn),
            _ => bail!("manifest buildCommand is not an allow-listed static template"),
        }
    }

    fn command(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Bun => ("bun", &["run", "build"]),
            Self::Npm => ("npm", &["run", "build"]),
            Self::Pnpm => ("pnpm", &["run", "build"]),
            Self::Yarn => ("yarn", &["build"]),
        }
    }
}

impl DependencyPolicy {
    fn parse(value: Option<&str>, build_template: BuildTemplate) -> Result<Self> {
        let policy = match value.unwrap_or("locked") {
            "locked" => Self::Locked,
            "latest" => Self::Latest,
            other => {
                bail!("manifest.assets.dependencyPolicy must be locked or latest, got {other}")
            }
        };
        if matches!(policy, Self::Latest) && !matches!(build_template, BuildTemplate::Bun) {
            bail!(
                "manifest.assets.dependencyPolicy latest currently requires the Bun build template"
            );
        }
        Ok(policy)
    }
}

fn resolve_build_program(program: &str) -> Result<String> {
    let configured_bun = env::var("MATCHPLANE_SUBPLATFORM_BUILDER_BUN").ok();
    resolve_build_program_with_config(program, configured_bun.as_deref())
}

fn resolve_build_program_with_config(
    program: &str,
    configured_bun: Option<&str>,
) -> Result<String> {
    if program != "bun" {
        return Ok(program.to_owned());
    }
    let Some(configured_bun) = configured_bun
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(program.to_owned());
    };
    let path = PathBuf::from(configured_bun);
    if !path.is_absolute() {
        bail!("MATCHPLANE_SUBPLATFORM_BUILDER_BUN must be an absolute executable path");
    }
    let metadata = fs::metadata(&path)
        .with_context(|| format!("reading configured Bun runtime {}", path.display()))?;
    if !metadata.is_file() {
        bail!(
            "configured Bun runtime {} is not a regular file",
            path.display()
        );
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        bail!(
            "configured Bun runtime {} is not executable",
            path.display()
        );
    }
    Ok(path.to_string_lossy().into_owned())
}

async fn run_build(manifest: &Manifest, build_timeout: Duration, build_dir: &Path) -> Result<()> {
    let source_root = &manifest.package_root;
    let static_dir = source_root.join(&manifest.static_directory);
    if !is_within(source_root, &static_dir) {
        bail!("staticDirectory escapes the package root");
    }
    fs::create_dir_all(build_dir).context("creating build scratch directory")?;
    let (program, args) = manifest.build_template.command();
    let program = resolve_build_program(program)?;
    let mut command_args = vec![
        "--die-with-parent".to_owned(),
        "--unshare-net".to_owned(),
        "--unshare-pid".to_owned(),
        "--unshare-uts".to_owned(),
        "--unshare-ipc".to_owned(),
        "--ro-bind".to_owned(),
        "/".to_owned(),
        "/".to_owned(),
        "--bind".to_owned(),
        source_root.display().to_string(),
        source_root.display().to_string(),
        "--bind".to_owned(),
        build_dir.display().to_string(),
        build_dir.display().to_string(),
        "--tmpfs".to_owned(),
        "/tmp".to_owned(),
        "--proc".to_owned(),
        "/proc".to_owned(),
        "--dev".to_owned(),
        "/dev".to_owned(),
        "--chdir".to_owned(),
        source_root.display().to_string(),
        "--clearenv".to_owned(),
        "--setenv".to_owned(),
        "PATH".to_owned(),
        SAFE_COMMAND_PATH.to_owned(),
        "--setenv".to_owned(),
        "CI".to_owned(),
        "1".to_owned(),
        "--setenv".to_owned(),
        "HOME".to_owned(),
        "/tmp".to_owned(),
        "--".to_owned(),
        program.clone(),
    ];
    command_args.extend(args.iter().map(|arg| (*arg).to_owned()));
    let bwrap =
        env::var("MATCHPLANE_SUBPLATFORM_BUILDER_BWRAP").unwrap_or_else(|_| "bwrap".to_owned());
    run_checked(&bwrap, &command_args, source_root, build_timeout)
        .await
        .with_context(|| format!("static package build failed for {}", manifest.slug))?;
    if !static_dir.is_dir() {
        bail!("build did not produce assets.staticDirectory");
    }
    if !static_dir.join("index.html").is_file() {
        bail!("static artifact must contain index.html");
    }
    Ok(())
}

/// Run a package-manager phase in the same filesystem sandbox as the build.
/// Dependency resolution may use the network, but it receives a scrubbed environment and only
/// sees a read-only host filesystem plus the package and scratch bind mounts. The subsequent build
/// phase uses this helper with `unshare_net = true`.
async fn run_sandboxed(
    program: &str,
    args: &[String],
    source_root: &Path,
    build_dir: &Path,
    unshare_net: bool,
    command_timeout: Duration,
) -> Result<()> {
    let bwrap =
        env::var("MATCHPLANE_SUBPLATFORM_BUILDER_BWRAP").unwrap_or_else(|_| "bwrap".to_owned());
    let mut sandbox_args = vec![
        "--die-with-parent".to_owned(),
        "--unshare-pid".to_owned(),
        "--unshare-uts".to_owned(),
        "--unshare-ipc".to_owned(),
        "--ro-bind".to_owned(),
        "/".to_owned(),
        "/".to_owned(),
        "--bind".to_owned(),
        source_root.display().to_string(),
        source_root.display().to_string(),
        "--bind".to_owned(),
        build_dir.display().to_string(),
        build_dir.display().to_string(),
        "--tmpfs".to_owned(),
        "/tmp".to_owned(),
        "--proc".to_owned(),
        "/proc".to_owned(),
        "--dev".to_owned(),
        "/dev".to_owned(),
        "--chdir".to_owned(),
        source_root.display().to_string(),
        "--clearenv".to_owned(),
        "--setenv".to_owned(),
        "PATH".to_owned(),
        SAFE_COMMAND_PATH.to_owned(),
        "--setenv".to_owned(),
        "HOME".to_owned(),
        "/tmp".to_owned(),
        "--setenv".to_owned(),
        "CI".to_owned(),
        "1".to_owned(),
        "--".to_owned(),
        program.to_owned(),
    ];
    if unshare_net {
        sandbox_args.insert(1, "--unshare-net".to_owned());
    }
    sandbox_args.extend(args.iter().cloned());
    run_checked(&bwrap, &sandbox_args, source_root, command_timeout).await
}

async fn prepare_dependencies(manifest: &Manifest, build_dir: &Path) -> Result<()> {
    let package_json = manifest.package_root.join("package.json");
    if !package_json.is_file() {
        return Ok(());
    }
    let (program, args, lockfiles): (&str, Vec<&str>, &[&str]) =
        if matches!(manifest.dependency_policy, DependencyPolicy::Latest) {
            // The latest policy is deliberately explicit and currently limited to Bun. It lets a
            // subplatform follow current package versions without making the root platform
            // resolve or execute arbitrary package-manager commands.
            (
                "bun",
                vec!["install", "--no-save", "--ignore-scripts", "--no-progress"],
                &[],
            )
        } else {
            match manifest.build_template {
                BuildTemplate::Bun => (
                    "bun",
                    vec![
                        "install",
                        "--frozen-lockfile",
                        "--ignore-scripts",
                        "--no-progress",
                    ],
                    &["bun.lock", "bun.lockb"],
                ),
                BuildTemplate::Npm => (
                    "npm",
                    vec!["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                    &["package-lock.json", "npm-shrinkwrap.json"],
                ),
                BuildTemplate::Pnpm => (
                    "pnpm",
                    vec![
                        "install",
                        "--frozen-lockfile",
                        "--ignore-scripts",
                        "--reporter",
                        "append-only",
                    ],
                    &["pnpm-lock.yaml"],
                ),
                BuildTemplate::Yarn => (
                    "yarn",
                    vec![
                        "install",
                        "--frozen-lockfile",
                        "--ignore-scripts",
                        "--non-interactive",
                    ],
                    &["yarn.lock"],
                ),
            }
        };
    if !lockfiles.is_empty()
        && !lockfiles
            .iter()
            .any(|name| manifest.package_root.join(name).is_file())
    {
        bail!("{} build requires a committed lockfile", manifest.slug);
    }
    let program = resolve_build_program(program)?;
    let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
    run_sandboxed(
        &program,
        &args,
        &manifest.package_root,
        build_dir,
        false,
        Duration::from_secs(600),
    )
    .await
    .with_context(|| {
        format!(
            "installing {} dependencies for {}",
            if matches!(manifest.dependency_policy, DependencyPolicy::Latest) {
                "latest"
            } else {
                "locked"
            },
            manifest.slug
        )
    })
}

async fn publish_artifact(
    config: &Config,
    manifest: &Manifest,
    build_dir: &Path,
    registration_id: &Uuid,
) -> Result<BuildOutput> {
    let static_dir = manifest.package_root.join(&manifest.static_directory);
    // Copy to a staging directory before hashing. A successful callback therefore always points
    // at a complete, immutable tree rather than a directory which is still being written.
    let staging = config
        .artifact_root
        .join(format!(".staging-{registration_id}"));
    remove_dir(&staging).await?;
    tokio_fs::create_dir_all(&staging)
        .await
        .context("creating artifact staging directory")?;
    copy_static_tree(&static_dir, &staging)?;
    let digest = hash_tree(&staging)?;
    let final_dir = config.artifact_root.join("builds").join(&digest);
    tokio_fs::create_dir_all(final_dir.parent().context("artifact root has no parent")?).await?;
    if final_dir.exists() {
        remove_dir(&staging).await?;
    } else if let Err(error) = tokio_fs::rename(&staging, &final_dir).await {
        if final_dir.exists() {
            remove_dir(&staging).await?;
        } else {
            return Err(error).context("publishing immutable artifact");
        }
    }
    // Keep this check tied to the actual published path. `build_dir` is intentionally otherwise
    // unused here, but retaining it in the signature makes callers explicit about the build phase.
    let _ = build_dir;
    Ok(BuildOutput {
        artifact_path: format!("builds/{digest}"),
        digest,
        artifact_entry: "index.html".to_owned(),
    })
}

fn copy_static_tree(source: &Path, destination: &Path) -> Result<()> {
    let mut files = 0usize;
    let mut total = 0u64;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.context("walking static build output")?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .context("static output path is invalid")?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry.file_type().is_symlink() {
            bail!("static output contains a symlink");
        }
        let target = destination.join(relative);
        if !is_within(destination, &target) {
            bail!("static output escapes artifact root");
        }
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if !entry.file_type().is_file() {
            bail!("static output contains a non-regular file");
        }
        files += 1;
        if files > MAX_EXTRACTED_FILES {
            bail!("static output contains too many files");
        }
        let size = entry
            .metadata()
            .context("reading static output metadata")?
            .len();
        total = total
            .checked_add(size)
            .context("static output size overflow")?;
        if total > MAX_EXTRACTED_BYTES {
            bail!("static output exceeds 256 MiB");
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &target)
            .with_context(|| format!("copying static output {}", relative.display()))?;
    }
    Ok(())
}

fn hash_tree(root: &Path) -> Result<String> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.context("walking artifact tree")?;
        if entry.file_type().is_symlink() {
            bail!("published artifact contains a symlink");
        }
        if entry.file_type().is_file() {
            entries.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .context("artifact path is invalid")?
                    .to_path_buf(),
            );
        }
    }
    entries.sort();
    let mut digest = Sha256::new();
    for relative in entries {
        let bytes = relative.to_string_lossy().replace('\\', "/");
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes.as_bytes());
        let content = fs::read(root.join(&relative))
            .with_context(|| format!("reading artifact {}", relative.display()))?;
        digest.update((content.len() as u64).to_be_bytes());
        digest.update(content);
    }
    Ok(hex::encode(digest.finalize()))
}

async fn run_checked(
    program: &str,
    args: &[String],
    cwd: &Path,
    command_timeout: Duration,
) -> Result<()> {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("PATH", SAFE_COMMAND_PATH)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Dropping the timeout future must not leave an unbounded build process
        // behind while the lease is retried. The builder already runs each
        // command inside its own bwrap namespace; kill-on-drop terminates that
        // sandbox root when the deadline expires.
        .kill_on_drop(true);
    let child = command
        .spawn()
        .with_context(|| format!("starting {program}"))?;
    let output = timeout(command_timeout, child.wait_with_output())
        .await
        .with_context(|| format!("{program} exceeded its time limit"))?
        .with_context(|| format!("waiting for {program}"))?;
    let stdout = truncate_bytes(&output.stdout, MAX_COMMAND_OUTPUT);
    let stderr = truncate_bytes(&output.stderr, MAX_COMMAND_OUTPUT);
    if !output.status.success() {
        bail!(
            "{program} exited with {}: {}{}",
            output.status,
            String::from_utf8_lossy(&stderr),
            if stdout.is_empty() {
                String::new()
            } else {
                format!(" stdout: {}", String::from_utf8_lossy(&stdout))
            }
        );
    }
    Ok(())
}

async fn run_capture(
    program: &str,
    args: &[String],
    cwd: &Path,
    command_timeout: Duration,
) -> Result<String> {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("PATH", SAFE_COMMAND_PATH)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .with_context(|| format!("starting {program}"))?;
    let output = timeout(command_timeout, child.wait_with_output())
        .await
        .with_context(|| format!("{program} exceeded its time limit"))?
        .with_context(|| format!("waiting for {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} exited with {}: {}",
            output.status,
            truncate(&String::from_utf8_lossy(&output.stderr), MAX_COMMAND_OUTPUT)
        );
    }
    String::from_utf8(output.stdout).context("command output was not UTF-8")
}

fn safe_relative_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        bail!("path must be relative and non-empty");
    }
    let raw = path.to_string_lossy();
    if raw.contains('\\')
        || raw
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        bail!("path contains traversal or an empty component");
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => clean.push(value),
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => bail!("path contains traversal or an absolute prefix"),
        }
    }
    if clean.as_os_str().is_empty() {
        bail!("path must not be empty");
    }
    Ok(clean)
}

fn validate_allowed_host(url: &Url, allowed_hosts: &[String]) -> Result<()> {
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .context("source URL has no host")?;
    if !allowed_hosts
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
    {
        bail!("source host {host} is not in the configured allowlist");
    }
    Ok(())
}

fn is_full_git_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_file(path: &Path) -> Result<[u8; 32]> {
    let metadata = fs::metadata(path).with_context(|| format!("reading {}", path.display()))?;
    if metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
        bail!("source archive has an invalid size");
    }
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let ordered = values.iter().collect::<BTreeMap<_, _>>();
            format!(
                "{{{}}}",
                ordered
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn is_within(parent: &Path, child: &Path) -> bool {
    let parent = parent.components().collect::<Vec<_>>();
    let child = child.components().collect::<Vec<_>>();
    child.len() >= parent.len()
        && child
            .iter()
            .zip(parent.iter())
            .all(|(left, right)| left == right)
}

async fn remove_dir(path: &Path) -> Result<()> {
    match tokio_fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing {}", path.display())),
    }
}

fn required(name: &str) -> Result<String> {
    env::var(name)
        .map(|value| value.trim().to_owned())
        .with_context(|| format!("{name} is required"))
}

fn secret_from_env_or_file(value_name: &str, file_name: &str) -> Result<String> {
    if let Ok(value) = env::var(value_name) {
        let value = value.trim().to_owned();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let file = required(file_name)?;
    let value = fs::read_to_string(&file)
        .with_context(|| format!("reading {file_name} target {file}"))?
        .trim()
        .to_owned();
    if value.is_empty() {
        bail!("{value_name} or {file_name} must not be empty");
    }
    Ok(value)
}

fn required_url(name: &str) -> Result<Url> {
    let value = required(name)?;
    let url = Url::parse(&value).with_context(|| format!("{name} must be a URL"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        bail!("{name} must use http or https");
    }
    Ok(url)
}

fn required_absolute_path(name: &str) -> Result<PathBuf> {
    absolute_path(&required(name)?, name)
}

fn absolute_path(value: &str, name: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        bail!("{name} must be an absolute path");
    }
    Ok(path)
}

fn bounded_seconds(name: &str, fallback: u64, minimum: u64, maximum: u64) -> Duration {
    let value = env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(fallback);
    Duration::from_secs(value.clamp(minimum, maximum))
}

fn constant_time_hex_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .as_bytes()
            .iter()
            .zip(right.as_bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

fn truncate(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn truncate_bytes(value: &[u8], maximum: usize) -> Vec<u8> {
    value.iter().copied().take(maximum).collect()
}

fn summarize_error(error: &anyhow::Error) -> String {
    truncate(&format!("{error:#}"), 4_000)
}

fn is_retryable(message: &str, attempts: u32) -> bool {
    attempts < 3
        && ["download", "fetch", "claim", "timed", "network", "tempor"]
            .iter()
            .any(|marker| message.to_ascii_lowercase().contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_paths_reject_traversal_and_absolute_names() {
        assert!(safe_relative_path(Path::new("dist/index.html")).is_ok());
        assert!(safe_relative_path(Path::new("../secret")).is_err());
        assert!(safe_relative_path(Path::new("/etc/passwd")).is_err());
        assert!(safe_relative_path(Path::new("dist/./index.html")).is_err());
    }

    #[test]
    fn only_static_build_templates_are_accepted() {
        assert!(matches!(
            BuildTemplate::parse("bun run build"),
            Ok(BuildTemplate::Bun)
        ));
        assert!(matches!(
            BuildTemplate::parse("npm run build"),
            Ok(BuildTemplate::Npm)
        ));
        assert!(BuildTemplate::parse("bun run build && curl https://evil.example").is_err());
        assert!(BuildTemplate::parse("sh -c echo pwned").is_err());
    }

    #[test]
    fn dependency_policy_defaults_to_locked_and_latest_is_bun_only() {
        assert_eq!(
            DependencyPolicy::parse(None, BuildTemplate::Bun).expect("default policy"),
            DependencyPolicy::Locked
        );
        assert_eq!(
            DependencyPolicy::parse(Some("latest"), BuildTemplate::Bun).expect("latest Bun policy"),
            DependencyPolicy::Latest
        );
        assert!(DependencyPolicy::parse(Some("latest"), BuildTemplate::Npm).is_err());
        assert!(DependencyPolicy::parse(Some("floating"), BuildTemplate::Bun).is_err());
    }

    #[test]
    fn configured_bun_runtime_must_be_an_absolute_executable_file() {
        assert_eq!(
            resolve_build_program_with_config("bun", None).expect("default runtime"),
            "bun"
        );
        assert_eq!(
            resolve_build_program_with_config("bun", Some("/bin/sh"))
                .expect("absolute executable runtime"),
            "/bin/sh"
        );
        assert!(resolve_build_program_with_config("bun", Some("bun")).is_err());
        assert!(resolve_build_program_with_config("bun", Some("/tmp")).is_err());
    }

    #[test]
    fn configured_bun_runtime_does_not_affect_other_build_templates() {
        assert_eq!(
            resolve_build_program_with_config("npm", Some("relative/bun"))
                .expect("non-Bun runtime"),
            "npm"
        );
    }

    #[test]
    fn canonical_manifest_order_is_stable() {
        let first: Value = serde_json::json!({"b": 2, "a": {"z": true, "y": null}});
        let second: Value = serde_json::json!({"a": {"y": null, "z": true}, "b": 2});
        assert_eq!(canonical_json(&first), canonical_json(&second));
    }

    #[test]
    fn host_allowlist_accepts_only_exact_hosts_or_subdomains() {
        let allowed = vec!["github.com".to_owned()];
        assert!(
            validate_allowed_host(
                &Url::parse("https://github.com/acme/pkg").unwrap(),
                &allowed
            )
            .is_ok()
        );
        assert!(
            validate_allowed_host(
                &Url::parse("https://raw.github.com/acme/pkg").unwrap(),
                &allowed
            )
            .is_ok()
        );
        assert!(
            validate_allowed_host(
                &Url::parse("https://github.com.evil.example/pkg").unwrap(),
                &allowed
            )
            .is_err()
        );
    }
}
