use std::{
    collections::BTreeSet,
    env, fmt,
    future::Future,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
    },
    time::{Duration, Instant},
};

use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{Client, ClientBuilder};
use rig_core::{
    client::CompletionClient,
    completion::{CompletionError, CompletionModel, CompletionRequestBuilder},
    http_client::{
        Error as RigHttpError, HttpClientExt, LazyBody, MultipartForm, Request, Response,
        StreamingResponse,
    },
    providers::{anthropic, gemini, openai},
};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use url::{Host, Url};

use crate::platform_router::{ManagedRouterRead, ManagedSource, private_or_reserved_ip};

const MAX_ENDPOINT_LEN: usize = 2_048;
const MAX_MODEL_LEN: usize = 256;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_BUDGET_MS: u64 = 4_000;
pub(crate) const DEFAULT_PROVIDER_PROTOCOL: &str = "openai-compatible";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderProtocol {
    OpenAiCompatible,
    AnthropicMessages,
    GeminiGenerateContent,
}

impl ProviderProtocol {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai-compatible" => Some(Self::OpenAiCompatible),
            "anthropic-messages" => Some(Self::AnthropicMessages),
            "gemini-generate-content" => Some(Self::GeminiGenerateContent),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai-compatible",
            Self::AnthropicMessages => "anthropic-messages",
            Self::GeminiGenerateContent => "gemini-generate-content",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct ProviderConfigConflicts {
    endpoint: bool,
    model: bool,
    protocol: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProviderPreflightReport {
    pub(crate) ready: bool,
    pub(crate) blocking: bool,
    schema_version: u8,
    status: String,
    capability_status: String,
    code: Option<String>,
    preferred_http_status: Option<u16>,
    source: String,
    managed_overrides_environment: bool,
    conflicts: ProviderConfigConflicts,
    endpoint_origin: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
    credential_configured: bool,
    response_status: Option<u16>,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    issues: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct EnvironmentProviderValues {
    endpoint: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
    credential_present: bool,
}

#[derive(Debug, Clone, Copy)]
enum CredentialSource {
    Managed,
    Environment,
}

#[derive(Debug, Clone)]
struct ProviderDescriptor {
    endpoint: Url,
    rig_base_url: Url,
    authority: String,
    model: String,
    protocol: ProviderProtocol,
    credential_source: CredentialSource,
}

struct EffectiveProviderConfig {
    descriptor: ProviderDescriptor,
    api_key: SecretString,
}

impl fmt::Debug for EffectiveProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectiveProviderConfig")
            .field("descriptor", &self.descriptor)
            .field("api_key", &"[redacted]")
            .finish()
    }
}

#[derive(Debug)]
struct ProviderResolution {
    descriptor: Option<ProviderDescriptor>,
    intent_enabled: bool,
    required: bool,
    source: String,
    managed_overrides_environment: bool,
    conflicts: ProviderConfigConflicts,
    endpoint_origin: Option<String>,
    model: Option<String>,
    protocol: Option<String>,
    credential_configured: bool,
    issues: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProviderProbeFailure {
    issue: &'static str,
    response_status: Option<u16>,
}

impl fmt::Display for ProviderProbeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.issue)
    }
}

impl std::error::Error for ProviderProbeFailure {}

#[derive(Debug)]
struct ProviderProbeOutcome {
    status: &'static str,
    issue: &'static str,
    response_status: Option<u16>,
    latency_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

pub(crate) async fn provider_preflight_command() -> anyhow::Result<()> {
    let managed = crate::platform_router::PlatformRouterReader::default().read();
    let report = provider_preflight_report_from_managed(&managed).await;
    println!(
        "{}",
        serde_json::to_string_pretty(&report)
            .map_err(|error| anyhow::anyhow!("provider preflight encoding failed: {error}"))?
    );
    if report.ready {
        Ok(())
    } else {
        anyhow::bail!("AI provider preflight is not ready")
    }
}

pub(crate) async fn provider_preflight_report() -> ProviderPreflightReport {
    let managed = crate::platform_router::PlatformRouterReader::default().read();
    provider_preflight_report_from_managed(&managed).await
}

pub(crate) async fn provider_preflight_report_from_managed(
    managed: &ManagedRouterRead,
) -> ProviderPreflightReport {
    let resolution = resolve_effective_provider(managed);
    let timeout_ms = bounded_environment_millis(
        "MATCHPLANE_ROUTER_AI_PREFLIGHT_TIMEOUT_MS",
        DEFAULT_TIMEOUT_MS,
        100,
        30_000,
    );
    let budget_ms = bounded_environment_millis(
        "MATCHPLANE_ROUTER_AI_PREFLIGHT_BUDGET_MS",
        DEFAULT_BUDGET_MS,
        100,
        timeout_ms,
    );
    execute_resolution(
        managed,
        resolution,
        Duration::from_millis(timeout_ms),
        Duration::from_millis(budget_ms),
    )
    .await
}

async fn execute_resolution(
    managed: &ManagedRouterRead,
    resolution: ProviderResolution,
    timeout: Duration,
    budget: Duration,
) -> ProviderPreflightReport {
    let mut report = preflight_report_from_resolution(&resolution);
    if !resolution.intent_enabled {
        report.status = "disabled".to_owned();
        report.capability_status = "disabled".to_owned();
        report.code = None;
        report.preferred_http_status = None;
        return report;
    }
    if !resolution.issues.is_empty() {
        return report;
    }
    let Some(descriptor) = resolution.descriptor.as_ref() else {
        return report;
    };

    let started = Instant::now();
    let probe = tokio::time::timeout(timeout, async {
        let plan = prepare_provider_probe_plan(descriptor, timeout, resolve_public_addresses)
            .await
            .map_err(|issue| provider_probe_failure(issue, None))?;
        let config = EffectiveProviderConfig {
            descriptor: descriptor.clone(),
            api_key: load_credential(managed, descriptor.credential_source)
                .map_err(|issue| provider_probe_failure(issue, None))?,
        };
        execute_native_rig_completion(config, plan, budget, started).await
    })
    .await;

    let outcome = match probe {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(failure)) => provider_probe_outcome(started, failure.issue, failure.response_status),
        Err(_) => provider_probe_outcome(started, "provider_timeout", None),
    };
    report.ready = outcome.status == "ready";
    report.status = outcome.status.to_owned();
    report.response_status = outcome.response_status;
    report.latency_ms = outcome.latency_ms;
    report.input_tokens = outcome.input_tokens;
    report.output_tokens = outcome.output_tokens;
    if report.ready {
        report.capability_status = provider_capability_status(true, "").to_owned();
        report.code = None;
        report.preferred_http_status = None;
        report.issues.clear();
    } else {
        report.capability_status = provider_capability_status(false, outcome.issue).to_owned();
        report.code = Some(if outcome.issue == "provider_capability_unsupported" {
            "provider_capability_unsupported".to_owned()
        } else {
            "upstream_configuration".to_owned()
        });
        report.preferred_http_status = Some(451);
        report.issues.push(outcome.issue.to_owned());
    }
    report
}

fn provider_capability_status(ready: bool, issue: &str) -> &'static str {
    if ready {
        "supported"
    } else if issue == "provider_capability_unsupported" {
        "unsupported"
    } else {
        "unknown"
    }
}

fn resolve_effective_provider(managed: &ManagedRouterRead) -> ProviderResolution {
    let environment = EnvironmentProviderValues {
        endpoint: nonempty_environment("MATCHPLANE_ROUTER_AI_URL"),
        model: nonempty_environment("MATCHPLANE_ROUTER_AI_MODEL"),
        protocol: nonempty_environment("MATCHPLANE_ROUTER_AI_PROTOCOL"),
        credential_present: env::var_os("MATCHPLANE_ROUTER_AI_KEY").is_some(),
    };
    resolve_effective_provider_with_environment(
        managed,
        environment,
        environment_flag("MATCHPLANE_ROUTER_AI_REQUIRED"),
    )
}

fn resolve_effective_provider_with_environment(
    managed: &ManagedRouterRead,
    environment: EnvironmentProviderValues,
    required: bool,
) -> ProviderResolution {
    let environment_present = environment.endpoint.is_some()
        || environment.model.is_some()
        || environment.protocol.is_some()
        || environment.credential_present;
    let managed_authoritative = matches!(
        managed.source(),
        ManagedSource::ManagedGeneration | ManagedSource::Legacy
    );
    let managed_config = managed.active();
    let managed_disabled =
        managed_authoritative && managed_config.is_some_and(|config| !config.enabled);
    let managed_enabled =
        managed_authoritative && managed_config.is_some_and(|config| config.enabled);
    let managed_unreadable = managed.source() == ManagedSource::ManagedUnreadable;

    let (source, endpoint, model, protocol, credential_configured, credential_source) =
        if managed_unreadable {
            ("managed_unreadable", None, None, None, false, None)
        } else if managed_authoritative {
            (
                managed.source().as_str(),
                managed_config.map(|config| config.endpoint.clone()),
                managed_config.map(|config| config.model.clone()),
                managed_config.map(|config| config.protocol.clone()),
                managed.active_credential_configured(),
                Some(CredentialSource::Managed),
            )
        } else if environment_present {
            (
                "environment",
                environment.endpoint.clone(),
                environment.model.clone(),
                environment.protocol.clone(),
                environment.credential_present,
                Some(CredentialSource::Environment),
            )
        } else {
            ("absent", None, None, None, false, None)
        };

    let parsed_protocol = protocol.as_deref().and_then(ProviderProtocol::parse);
    let endpoint_origin = endpoint
        .as_deref()
        .and_then(parse_safe_endpoint)
        .map(|url| url.origin().ascii_serialization());
    let reported_model = model
        .as_ref()
        .filter(|value| parsed_protocol.is_some_and(|protocol| valid_model(value, protocol)));
    let mut issues = Vec::new();
    if let Some(error) = managed.unreadable() {
        issues.push(error.code().to_owned());
        issues.push("managed_state_unreadable".to_owned());
    }
    let descriptor = if managed_disabled {
        None
    } else if source == "absent" || (managed_authoritative && managed_config.is_none()) {
        issues.push("provider_not_configured".to_owned());
        None
    } else {
        validate_provider_descriptor(
            endpoint.as_deref(),
            model.as_deref(),
            protocol.as_deref(),
            credential_source,
            &mut issues,
        )
    };
    if !managed_disabled && !credential_configured {
        issues.push("credential_not_configured".to_owned());
    }
    issues.sort();
    issues.dedup();

    let conflicts = ProviderConfigConflicts {
        endpoint: managed_enabled
            && environment.endpoint.as_ref().is_some_and(|value| {
                managed_config.is_some_and(|managed| {
                    canonical_endpoint(value) != canonical_endpoint(&managed.endpoint)
                })
            }),
        model: managed_enabled
            && environment
                .model
                .as_ref()
                .is_some_and(|value| managed_config.is_some_and(|managed| value != &managed.model)),
        protocol: managed_enabled
            && environment.protocol.as_ref().is_some_and(|value| {
                managed_config.is_some_and(|managed| value != &managed.protocol)
            }),
    };

    ProviderResolution {
        descriptor,
        intent_enabled: !managed_disabled
            && (required || managed_authoritative || managed_unreadable || environment_present),
        required,
        source: source.to_owned(),
        managed_overrides_environment: managed_enabled && environment_present,
        conflicts,
        endpoint_origin,
        model: reported_model.cloned(),
        protocol: parsed_protocol.map(|protocol| protocol.as_str().to_owned()),
        credential_configured,
        issues,
    }
}

fn validate_provider_descriptor(
    endpoint: Option<&str>,
    model: Option<&str>,
    protocol: Option<&str>,
    credential_source: Option<CredentialSource>,
    issues: &mut Vec<String>,
) -> Option<ProviderDescriptor> {
    let protocol = match protocol.and_then(ProviderProtocol::parse) {
        Some(protocol) => protocol,
        None => {
            issues.push("provider_capability_unsupported".to_owned());
            return None;
        }
    };
    let model = match model.filter(|value| valid_model(value, protocol)) {
        Some(model) => model.to_owned(),
        None => {
            issues.push("model_invalid".to_owned());
            return None;
        }
    };
    let endpoint = match endpoint.and_then(parse_safe_endpoint) {
        Some(endpoint) => endpoint,
        None => {
            issues.push("endpoint_invalid".to_owned());
            return None;
        }
    };
    let rig_base_url = match canonicalize_rig_base(&endpoint, protocol, &model) {
        Some(base) => base,
        None => {
            issues.push("endpoint_invalid".to_owned());
            return None;
        }
    };
    let authority = endpoint.origin().ascii_serialization();
    if !origin_allowed(&authority) {
        issues.push("provider_origin_not_allowed".to_owned());
        return None;
    }
    Some(ProviderDescriptor {
        endpoint,
        rig_base_url,
        authority,
        model,
        protocol,
        credential_source: credential_source?,
    })
}

fn parse_safe_endpoint(value: &str) -> Option<Url> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_ENDPOINT_LEN {
        return None;
    }
    let url = Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

fn valid_model(value: &str, protocol: ProviderProtocol) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_MODEL_LEN
        || value != value.trim()
        || value.contains("..")
        || value.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | ':'))
        })
    {
        return false;
    }
    match protocol {
        ProviderProtocol::GeminiGenerateContent => !value.contains(['/', ':']),
        ProviderProtocol::OpenAiCompatible | ProviderProtocol::AnthropicMessages => true,
    }
}

fn canonicalize_rig_base(endpoint: &Url, protocol: ProviderProtocol, model: &str) -> Option<Url> {
    let mut base = endpoint.clone();
    let path = endpoint.path().trim_end_matches('/');
    let canonical_path = match protocol {
        ProviderProtocol::OpenAiCompatible if path.is_empty() => "/v1".to_owned(),
        ProviderProtocol::OpenAiCompatible => path
            .strip_suffix("/chat/completions")
            .unwrap_or(path)
            .to_owned(),
        ProviderProtocol::AnthropicMessages => {
            if let Some(prefix) = path.strip_suffix("/v1/messages") {
                prefix.to_owned()
            } else if path.ends_with("/messages") {
                return None;
            } else {
                path.to_owned()
            }
        }
        ProviderProtocol::GeminiGenerateContent => {
            let full_path = format!("/v1beta/models/{model}:generateContent");
            if path.is_empty() || path == full_path {
                String::new()
            } else {
                return None;
            }
        }
    };
    base.set_path(if canonical_path.is_empty() {
        "/"
    } else {
        &canonical_path
    });
    (base.origin() == endpoint.origin()).then_some(base)
}

fn origin_allowed(authority: &str) -> bool {
    let Some(policy) = nonempty_environment("MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS") else {
        return true;
    };
    let mut saw_origin = false;
    for candidate in policy.split(',').map(str::trim) {
        let Ok(url) = Url::parse(candidate) else {
            return false;
        };
        if url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.path(), "" | "/")
            && matches!(url.scheme(), "https")
            && url.host_str().is_some()
        {
            saw_origin |= url.origin().ascii_serialization() == authority;
        } else {
            return false;
        }
    }
    saw_origin
}

fn preflight_report_from_resolution(resolution: &ProviderResolution) -> ProviderPreflightReport {
    let unsupported = resolution
        .issues
        .iter()
        .any(|issue| issue == "provider_capability_unsupported");
    ProviderPreflightReport {
        ready: false,
        blocking: resolution.required,
        schema_version: 2,
        status: if unsupported {
            "provider_capability_unsupported".to_owned()
        } else {
            "configuration_invalid".to_owned()
        },
        capability_status: provider_capability_status(
            false,
            if unsupported {
                "provider_capability_unsupported"
            } else {
                ""
            },
        )
        .to_owned(),
        code: Some(if unsupported {
            "provider_capability_unsupported".to_owned()
        } else {
            "upstream_configuration".to_owned()
        }),
        preferred_http_status: Some(451),
        source: resolution.source.clone(),
        managed_overrides_environment: resolution.managed_overrides_environment,
        conflicts: resolution.conflicts.clone(),
        endpoint_origin: resolution.endpoint_origin.clone(),
        model: resolution.model.clone(),
        protocol: resolution.protocol.clone(),
        credential_configured: resolution.credential_configured,
        response_status: None,
        latency_ms: 0,
        input_tokens: None,
        output_tokens: None,
        issues: resolution.issues.clone(),
    }
}

#[derive(Clone)]
struct ProviderProbePlan {
    client: Client,
    #[cfg(test)]
    addresses: Vec<SocketAddr>,
}

async fn prepare_provider_probe_plan<R, F>(
    descriptor: &ProviderDescriptor,
    timeout: Duration,
    resolver: R,
) -> Result<ProviderProbePlan, &'static str>
where
    R: FnOnce(String, u16) -> F,
    F: Future<Output = Result<Vec<SocketAddr>, ()>>,
{
    let host = descriptor
        .endpoint
        .host_str()
        .ok_or("provider_dns_untrusted")?
        .to_owned();
    let port = descriptor
        .endpoint
        .port_or_known_default()
        .ok_or("provider_dns_untrusted")?;
    let addresses = match descriptor.endpoint.host() {
        Some(Host::Ipv4(address)) => vec![SocketAddr::new(IpAddr::V4(address), port)],
        Some(Host::Ipv6(address)) => vec![SocketAddr::new(IpAddr::V6(address), port)],
        Some(Host::Domain(_)) => resolver(host.clone(), port)
            .await
            .map_err(|()| "provider_dns_resolution")?,
        None => return Err("provider_dns_untrusted"),
    }
    .into_iter()
    .collect::<BTreeSet<_>>()
    .into_iter()
    .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| address.port() != port || private_or_reserved_ip(address.ip()))
    {
        return Err("provider_dns_untrusted");
    }
    let client = build_provider_probe_client(Client::builder(), timeout, &host, &addresses)?;
    Ok(ProviderProbePlan {
        client,
        #[cfg(test)]
        addresses,
    })
}

async fn resolve_public_addresses(host: String, port: u16) -> Result<Vec<SocketAddr>, ()> {
    tokio::net::lookup_host((host.as_str(), port))
        .await
        .map(|addresses| addresses.collect())
        .map_err(|_| ())
}

fn build_provider_probe_client(
    builder: ClientBuilder,
    timeout: Duration,
    host: &str,
    addresses: &[SocketAddr],
) -> Result<Client, &'static str> {
    builder
        .timeout(timeout)
        .no_proxy()
        .resolve_to_addrs(host, addresses)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "client_configuration")
}

fn load_credential(
    managed: &ManagedRouterRead,
    source: CredentialSource,
) -> Result<SecretString, &'static str> {
    match source {
        CredentialSource::Managed => managed
            .read_active_secret()
            .map_err(|_| "managed_state_unreadable")?
            .ok_or("credential_not_configured"),
        CredentialSource::Environment => env::var("MATCHPLANE_ROUTER_AI_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(SecretString::from)
            .ok_or("credential_not_configured"),
    }
}

#[derive(Clone)]
struct PinnedRigTransport {
    client: Client,
    authority: Arc<str>,
    protocol: ProviderProtocol,
    api_key: SecretString,
    last_status: Arc<AtomicU16>,
    usable: bool,
}

impl fmt::Debug for PinnedRigTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PinnedRigTransport")
            .field("authority", &self.authority)
            .field("protocol", &self.protocol)
            .field("api_key", &"[redacted]")
            .field("usable", &self.usable)
            .finish_non_exhaustive()
    }
}

impl Default for PinnedRigTransport {
    fn default() -> Self {
        Self {
            client: Client::new(),
            authority: Arc::from("https://invalid.invalid"),
            protocol: ProviderProtocol::OpenAiCompatible,
            api_key: SecretString::from(String::new()),
            last_status: Arc::new(AtomicU16::new(0)),
            usable: false,
        }
    }
}

impl PinnedRigTransport {
    fn new(
        client: Client,
        authority: String,
        protocol: ProviderProtocol,
        api_key: SecretString,
    ) -> Self {
        Self {
            client,
            authority: Arc::from(authority),
            protocol,
            api_key,
            last_status: Arc::new(AtomicU16::new(0)),
            usable: true,
        }
    }

    fn response_status(&self) -> Option<u16> {
        match self.last_status.load(Ordering::Relaxed) {
            0 => None,
            status => Some(status),
        }
    }

    fn prepare_request<T>(
        &self,
        request: Request<T>,
    ) -> Result<reqwest::RequestBuilder, RigHttpError>
    where
        T: Into<Bytes>,
    {
        if !self.usable {
            return Err(transport_error(TransportFailure::CapabilityUnsupported));
        }
        let (mut parts, body) = request.into_parts();
        let mut url = Url::parse(&parts.uri.to_string())
            .map_err(|_| transport_error(TransportFailure::RequestInvalid))?;
        if url.origin().ascii_serialization() != self.authority.as_ref() {
            return Err(transport_error(TransportFailure::AuthorityChanged));
        }
        if self.protocol == ProviderProtocol::GeminiGenerateContent {
            let pairs = url.query_pairs().collect::<Vec<_>>();
            if pairs.len() != 1
                || pairs[0].0 != "key"
                || pairs[0].1.as_ref() != self.api_key.expose_secret()
            {
                return Err(transport_error(TransportFailure::CapabilityUnsupported));
            }
            url.set_query(None);
            let header = reqwest::header::HeaderValue::from_str(self.api_key.expose_secret())
                .map_err(|_| transport_error(TransportFailure::RequestInvalid))?;
            parts.headers.insert("x-goog-api-key", header);
        } else if url.query().is_some() {
            return Err(transport_error(TransportFailure::RequestInvalid));
        }
        Ok(self
            .client
            .request(parts.method, url)
            .headers(parts.headers)
            .body(body.into()))
    }
}

impl HttpClientExt for PinnedRigTransport {
    fn send<T, U>(
        &self,
        request: Request<T>,
    ) -> impl Future<Output = rig_core::http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        let prepared = self.prepare_request(request);
        let status_cell = Arc::clone(&self.last_status);
        async move {
            let response = prepared?.send().await.map_err(classify_reqwest_error)?;
            let status = response.status();
            status_cell.store(status.as_u16(), Ordering::Relaxed);
            if !status.is_success() {
                return Err(RigHttpError::InvalidStatusCode(status));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(transport_error(TransportFailure::BodyTooLarge));
            }
            let headers = response.headers().clone();
            let body: LazyBody<U> = Box::pin(async move {
                let mut stream = response.bytes_stream();
                let mut bounded = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(classify_reqwest_error)?;
                    if bounded.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                        return Err(transport_error(TransportFailure::BodyTooLarge));
                    }
                    bounded.extend_from_slice(&chunk);
                }
                Ok(U::from(Bytes::from(bounded)))
            });
            let mut result = Response::builder().status(status);
            if let Some(result_headers) = result.headers_mut() {
                *result_headers = headers;
            }
            result.body(body).map_err(RigHttpError::Protocol)
        }
    }

    // The Rig trait requires a `'static` future. An `async fn` would capture
    // `&self` and fail that bound even though these branches never use it.
    #[allow(clippy::manual_async_fn)]
    fn send_multipart<U>(
        &self,
        _request: Request<MultipartForm>,
    ) -> impl Future<Output = rig_core::http_client::Result<Response<LazyBody<U>>>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        async { Err(transport_error(TransportFailure::MultipartUnsupported)) }
    }

    #[allow(clippy::manual_async_fn)]
    fn send_streaming<T>(
        &self,
        _request: Request<T>,
    ) -> impl Future<Output = rig_core::http_client::Result<StreamingResponse>> + Send
    where
        T: Into<Bytes> + Send,
    {
        async { Err(transport_error(TransportFailure::StreamingUnsupported)) }
    }
}

#[derive(Debug, Clone, Copy)]
enum TransportFailure {
    Timeout,
    Unreachable,
    BodyTooLarge,
    AuthorityChanged,
    RequestInvalid,
    CapabilityUnsupported,
    MultipartUnsupported,
    StreamingUnsupported,
}

impl fmt::Display for TransportFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Timeout => "provider transport timeout",
            Self::Unreachable => "provider transport unreachable",
            Self::BodyTooLarge => "provider response too large",
            Self::AuthorityChanged => "provider authority changed",
            Self::RequestInvalid => "provider request invalid",
            Self::CapabilityUnsupported => "provider capability unsupported",
            Self::MultipartUnsupported => "provider multipart unsupported",
            Self::StreamingUnsupported => "provider streaming unsupported",
        })
    }
}

impl std::error::Error for TransportFailure {}

fn transport_error(failure: TransportFailure) -> RigHttpError {
    RigHttpError::Instance(Box::new(failure))
}

fn classify_reqwest_error(error: reqwest::Error) -> RigHttpError {
    transport_error(if error.is_timeout() {
        TransportFailure::Timeout
    } else {
        TransportFailure::Unreachable
    })
}

#[derive(Clone)]
enum RigCompletionModel {
    OpenAi(openai::completion::CompletionModel<PinnedRigTransport>),
    Anthropic(anthropic::completion::CompletionModel<PinnedRigTransport>),
    Gemini(gemini::CompletionModel<PinnedRigTransport>),
}

impl RigCompletionModel {
    async fn completion(
        &self,
        request: rig_core::completion::CompletionRequest,
    ) -> Result<rig_core::completion::CompletionResponse, CompletionError> {
        match self {
            Self::OpenAi(model) => model.completion(request).await,
            Self::Anthropic(model) => model.completion(request).await,
            Self::Gemini(model) => model.completion(request).await,
        }
    }
}

async fn execute_native_rig_completion(
    config: EffectiveProviderConfig,
    plan: ProviderProbePlan,
    budget: Duration,
    started: Instant,
) -> Result<ProviderProbeOutcome, ProviderProbeFailure> {
    let transport = PinnedRigTransport::new(
        plan.client,
        config.descriptor.authority.clone(),
        config.descriptor.protocol,
        config.api_key.clone(),
    );
    // `Url::as_str()` serializes an origin with a trailing slash. Rig appends
    // provider paths that already begin with `/`, so pass the bare authority
    // for an origin base to avoid a `//v1...` request target.
    let base = if config.descriptor.rig_base_url.path() == "/" {
        config.descriptor.authority.as_str()
    } else {
        config.descriptor.rig_base_url.as_str()
    };
    let model_name = config.descriptor.model.clone();
    let model = match config.descriptor.protocol {
        ProviderProtocol::OpenAiCompatible => {
            let client = openai::CompletionsClient::builder()
                .api_key(config.api_key.expose_secret())
                .base_url(base)
                .http_client(transport.clone())
                .build()
                .map_err(|_| provider_probe_failure("provider_configuration", None))?;
            RigCompletionModel::OpenAi(client.completion_model(model_name))
        }
        ProviderProtocol::AnthropicMessages => {
            let client = anthropic::Client::builder()
                .api_key(config.api_key.expose_secret())
                .base_url(base)
                .http_client(transport.clone())
                .build()
                .map_err(|_| provider_probe_failure("provider_configuration", None))?;
            RigCompletionModel::Anthropic(client.completion_model(model_name))
        }
        ProviderProtocol::GeminiGenerateContent => {
            let client = gemini::Client::builder()
                .api_key(config.api_key.expose_secret())
                .base_url(base)
                .http_client(transport.clone())
                .build()
                .map_err(|_| provider_probe_failure("provider_configuration", None))?;
            RigCompletionModel::Gemini(client.completion_model(model_name))
        }
    };
    let request = CompletionRequestBuilder::new(model.clone(), "Reply OK.")
        .max_tokens(1)
        .temperature(0.0)
        .build();
    let response = model.completion(request).await.map_err(|error| {
        provider_probe_failure(
            classify_completion_error(error),
            transport.response_status(),
        )
    })?;
    let usage = provider_reported_usage(config.descriptor.protocol, &response);
    let elapsed = started.elapsed();
    if elapsed > budget {
        return Ok(ProviderProbeOutcome {
            status: "slow",
            issue: "provider_slow",
            response_status: transport.response_status(),
            latency_ms: elapsed_ms(elapsed),
            input_tokens: usage.map(|value| value.0),
            output_tokens: usage.map(|value| value.1),
        });
    }
    Ok(ProviderProbeOutcome {
        status: "ready",
        issue: "",
        response_status: transport.response_status(),
        latency_ms: elapsed_ms(elapsed),
        input_tokens: usage.map(|value| value.0),
        output_tokens: usage.map(|value| value.1),
    })
}

fn provider_reported_usage(
    protocol: ProviderProtocol,
    response: &rig_core::completion::CompletionResponse,
) -> Option<(u64, u64)> {
    let key = match protocol {
        ProviderProtocol::GeminiGenerateContent => "usageMetadata",
        ProviderProtocol::OpenAiCompatible | ProviderProtocol::AnthropicMessages => "usage",
    };
    response
        .raw
        .get(key)
        .filter(|value| !value.is_null())
        .map(|_| (response.usage.input_tokens, response.usage.output_tokens))
}

impl CompletionModel for RigCompletionModel {
    async fn completion(
        &self,
        request: rig_core::completion::CompletionRequest,
    ) -> Result<rig_core::completion::CompletionResponse, CompletionError> {
        RigCompletionModel::completion(self, request).await
    }

    async fn stream(
        &self,
        _request: rig_core::completion::CompletionRequest,
    ) -> Result<rig_core::streaming::StreamingCompletionResponse, CompletionError> {
        Err(CompletionError::ProviderError(
            "provider streaming unsupported".to_owned(),
        ))
    }
}

fn classify_completion_error(error: CompletionError) -> &'static str {
    if let Some(status) = error.provider_response_status() {
        return if status.is_server_error() {
            "provider_5xx"
        } else {
            "provider_http"
        };
    }
    if let CompletionError::HttpError(RigHttpError::Instance(error)) = &error
        && let Some(failure) = error.downcast_ref::<TransportFailure>()
    {
        return match failure {
            TransportFailure::Timeout => "provider_timeout",
            TransportFailure::Unreachable => "provider_unreachable",
            TransportFailure::BodyTooLarge => "provider_response_too_large",
            TransportFailure::CapabilityUnsupported
            | TransportFailure::MultipartUnsupported
            | TransportFailure::StreamingUnsupported => "provider_capability_unsupported",
            TransportFailure::AuthorityChanged | TransportFailure::RequestInvalid => {
                "provider_transport_rejected"
            }
        };
    }
    "provider_malformed_response"
}

fn provider_probe_failure(
    issue: &'static str,
    response_status: Option<u16>,
) -> ProviderProbeFailure {
    ProviderProbeFailure {
        issue,
        response_status,
    }
}

fn provider_probe_outcome(
    started: Instant,
    issue: &'static str,
    response_status: Option<u16>,
) -> ProviderProbeOutcome {
    ProviderProbeOutcome {
        status: issue,
        issue,
        response_status,
        latency_ms: elapsed_ms(started.elapsed()),
        input_tokens: None,
        output_tokens: None,
    }
}

fn elapsed_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn canonical_endpoint(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn nonempty_environment(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn environment_flag(name: &str) -> bool {
    env::var(name).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn bounded_environment_millis(name: &str, fallback: u64, minimum: u64, maximum: u64) -> u64 {
    nonempty_environment(name)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Clone, Copy)]
    struct ProtocolFixture {
        protocol: ProviderProtocol,
        model: &'static str,
        endpoint_path: &'static str,
        expected_path: &'static str,
        expected_auth_header: &'static str,
        response: &'static str,
    }

    const FIXTURES: &[ProtocolFixture] = &[
        ProtocolFixture {
            protocol: ProviderProtocol::OpenAiCompatible,
            model: "fixture-model",
            endpoint_path: "/",
            expected_path: "/v1/chat/completions",
            expected_auth_header: "authorization: Bearer fixture-secret",
            response: r#"{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
        },
        ProtocolFixture {
            protocol: ProviderProtocol::OpenAiCompatible,
            model: "fixture-model",
            endpoint_path: "/v1/chat/completions",
            expected_path: "/v1/chat/completions",
            expected_auth_header: "authorization: Bearer fixture-secret",
            response: r#"{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
        },
        ProtocolFixture {
            protocol: ProviderProtocol::AnthropicMessages,
            model: "fixture-model",
            endpoint_path: "/v1/messages",
            expected_path: "/v1/messages",
            expected_auth_header: "x-api-key: fixture-secret",
            response: r#"{"type":"message","id":"msg_fixture","model":"fixture-model","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}"#,
        },
        ProtocolFixture {
            protocol: ProviderProtocol::GeminiGenerateContent,
            model: "fixture-model",
            endpoint_path: "/v1beta/models/fixture-model:generateContent",
            expected_path: "/v1beta/models/fixture-model:generateContent",
            expected_auth_header: "x-goog-api-key: fixture-secret",
            response: r#"{"candidates":[{"content":{"parts":[{"text":"OK"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2},"modelVersion":"fixture-model","responseId":"response_fixture"}"#,
        },
    ];

    #[test]
    fn canonicalization_is_protocol_specific_and_rejects_ambiguous_paths() {
        let openai_root = Url::parse("https://tokenrhythm.studio").expect("fixture URL");
        assert_eq!(
            canonicalize_rig_base(
                &openai_root,
                ProviderProtocol::OpenAiCompatible,
                "deepseek-v4-flash-0731"
            )
            .expect("OpenAI-compatible origin uses the conventional v1 base")
            .path(),
            "/v1"
        );
        let openai =
            Url::parse("https://provider.example/custom/v1/chat/completions").expect("fixture URL");
        assert_eq!(
            canonicalize_rig_base(&openai, ProviderProtocol::OpenAiCompatible, "model")
                .expect("OpenAI completion suffix is accepted")
                .path(),
            "/custom/v1"
        );
        let anthropic = Url::parse("https://provider.example/v1/messages").expect("fixture URL");
        assert_eq!(
            canonicalize_rig_base(&anthropic, ProviderProtocol::AnthropicMessages, "model")
                .expect("Anthropic messages suffix is accepted")
                .path(),
            "/"
        );
        let gemini =
            Url::parse("https://provider.example/v1beta/models/gemini-test:generateContent")
                .expect("fixture URL");
        assert_eq!(
            canonicalize_rig_base(
                &gemini,
                ProviderProtocol::GeminiGenerateContent,
                "gemini-test"
            )
            .expect("matching Gemini terminal endpoint is accepted")
            .path(),
            "/"
        );
        let ambiguous = Url::parse("https://provider.example/custom").expect("fixture URL");
        assert!(
            canonicalize_rig_base(
                &ambiguous,
                ProviderProtocol::GeminiGenerateContent,
                "gemini-test"
            )
            .is_none()
        );
    }

    #[test]
    fn capability_status_is_supported_only_after_a_successful_native_completion() {
        assert_eq!(provider_capability_status(true, ""), "supported");
        assert_eq!(
            provider_capability_status(false, "provider_capability_unsupported"),
            "unsupported"
        );
        for (issue, response_status) in [
            ("endpoint_invalid", None),
            ("provider_dns_untrusted", None),
            ("provider_http", Some(401)),
            ("provider_http", Some(404)),
            ("provider_http", Some(503)),
            ("provider_malformed", Some(200)),
            ("provider_timeout", None),
            ("provider_configuration", None),
        ] {
            assert_eq!(
                provider_capability_status(false, issue),
                "unknown",
                "unexpected capability status for issue={issue} status={response_status:?}"
            );
        }
    }

    #[test]
    fn invalid_capability_never_invokes_credential_loader() {
        let calls = AtomicUsize::new(0);
        for (endpoint, model, protocol) in [
            (
                Some("https://provider.example"),
                Some("model"),
                Some("unknown"),
            ),
            (
                Some("https://provider.example/custom"),
                Some("gemini-test"),
                Some("gemini-generate-content"),
            ),
            (
                Some("https://provider.example"),
                Some("bad model"),
                Some("openai-compatible"),
            ),
        ] {
            let mut issues = Vec::new();
            let descriptor = validate_provider_descriptor(
                endpoint,
                model,
                protocol,
                Some(CredentialSource::Environment),
                &mut issues,
            );
            let loaded = descriptor.map(|_| {
                calls.fetch_add(1, Ordering::SeqCst);
                SecretString::from("must-not-load")
            });
            assert!(loaded.is_none());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn managed_state_is_authoritative_and_environment_conflicts_are_informational() {
        let managed = ManagedRouterRead::test_managed_generation(true);
        let resolution = resolve_effective_provider_with_environment(
            &managed,
            EnvironmentProviderValues {
                endpoint: Some("https://different.example/v1".to_owned()),
                model: Some("different-model".to_owned()),
                protocol: Some("anthropic-messages".to_owned()),
                credential_present: true,
            },
            false,
        );
        assert_eq!(resolution.source, "managed_generation");
        assert!(resolution.managed_overrides_environment);
        assert!(resolution.conflicts.endpoint);
        assert!(resolution.conflicts.model);
        assert!(resolution.conflicts.protocol);
        let descriptor = resolution.descriptor.expect("managed descriptor retained");
        assert_eq!(descriptor.protocol, ProviderProtocol::OpenAiCompatible);
        assert_eq!(descriptor.model, "deepseek-v3.2");
    }

    #[test]
    fn managed_disable_and_unreadable_state_never_fall_back_to_environment() {
        let environment = EnvironmentProviderValues {
            endpoint: Some("https://environment.example/v1".to_owned()),
            model: Some("environment-model".to_owned()),
            protocol: Some("openai-compatible".to_owned()),
            credential_present: true,
        };
        let disabled = resolve_effective_provider_with_environment(
            &ManagedRouterRead::test_managed_generation(false),
            environment.clone(),
            true,
        );
        assert!(!disabled.intent_enabled);
        assert!(disabled.descriptor.is_none());
        assert_eq!(disabled.source, "managed_generation");

        let unreadable = resolve_effective_provider_with_environment(
            &ManagedRouterRead::test_security_policy_unreadable(),
            environment,
            false,
        );
        assert!(unreadable.intent_enabled);
        assert!(unreadable.descriptor.is_none());
        assert_eq!(unreadable.source, "managed_unreadable");
        assert!(
            unreadable
                .issues
                .iter()
                .any(|issue| issue == "managed_state_unreadable")
        );
    }

    #[test]
    fn doctor_blocking_depends_only_on_existing_required_flag() {
        let managed = ManagedRouterRead::test_managed_generation(true);
        let optional = resolve_effective_provider_with_environment(
            &managed,
            EnvironmentProviderValues::default(),
            false,
        );
        assert!(!preflight_report_from_resolution(&optional).blocking);
        let required = resolve_effective_provider_with_environment(
            &managed,
            EnvironmentProviderValues::default(),
            true,
        );
        assert!(preflight_report_from_resolution(&required).blocking);
    }

    #[tokio::test]
    async fn dns_policy_rejects_empty_private_and_mixed_answers_before_credentials() {
        let descriptor = test_descriptor(ProviderProtocol::OpenAiCompatible, "/v1", "model");
        let credential_loads = AtomicUsize::new(0);
        for addresses in [
            Vec::new(),
            vec!["127.0.0.1:443".parse().expect("loopback fixture")],
            vec![
                "8.8.8.8:443".parse().expect("public fixture"),
                "169.254.169.254:443".parse().expect("metadata fixture"),
            ],
        ] {
            let plan = prepare_provider_probe_plan(
                &descriptor,
                Duration::from_secs(1),
                move |_, _| async move { Ok(addresses) },
            )
            .await;
            if plan.is_ok() {
                credential_loads.fetch_add(1, Ordering::SeqCst);
            }
            assert!(matches!(plan, Err("provider_dns_untrusted")));
        }
        assert_eq!(credential_loads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn resolver_runs_once_and_pinned_rebind_is_ignored() {
        let descriptor = test_descriptor(ProviderProtocol::OpenAiCompatible, "/v1", "model");
        let calls = Arc::new(AtomicUsize::new(0));
        let answers = Arc::new(Mutex::new(vec![
            "8.8.8.8:443".parse().expect("public fixture"),
        ]));
        let calls_for_resolver = Arc::clone(&calls);
        let answers_for_resolver = Arc::clone(&answers);
        let plan = prepare_provider_probe_plan(
            &descriptor,
            Duration::from_secs(1),
            move |_, _| async move {
                calls_for_resolver.fetch_add(1, Ordering::SeqCst);
                Ok(answers_for_resolver
                    .lock()
                    .expect("answer fixture lock")
                    .clone())
            },
        )
        .await
        .expect("public DNS answer accepted");
        *answers.lock().expect("answer fixture lock") =
            vec!["127.0.0.1:443".parse().expect("rebind fixture")];
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            plan.addresses,
            vec!["8.8.8.8:443".parse().expect("public fixture")]
        );
    }

    #[tokio::test]
    async fn rig_produces_native_paths_auth_and_usage_for_every_protocol() -> anyhow::Result<()> {
        for fixture in FIXTURES {
            let (descriptor, plan, request_task) =
                local_fixture_plan(*fixture, Duration::ZERO).await?;
            let outcome = execute_native_rig_completion(
                test_config(descriptor),
                plan,
                Duration::from_secs(2),
                Instant::now(),
            )
            .await
            .map_err(anyhow::Error::new)?;
            let request = request_task.await??;
            assert_eq!(outcome.status, "ready");
            assert_eq!(outcome.response_status, Some(200));
            assert_eq!(outcome.input_tokens, Some(1));
            assert_eq!(outcome.output_tokens, Some(1));
            let expected_request_line = format!("POST {} HTTP/1.1", fixture.expected_path);
            assert_eq!(
                request.lines().next(),
                Some(expected_request_line.as_str()),
                "unexpected request target for {}",
                fixture.protocol.as_str()
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains(&fixture.expected_auth_header.to_ascii_lowercase())
            );
            assert!(!request.contains("?key="));
        }
        Ok(())
    }

    #[tokio::test]
    async fn missing_optional_usage_is_not_reported_as_zero_tokens() -> anyhow::Result<()> {
        for fixture in [
            ProtocolFixture {
                response: r#"{"id":"chatcmpl_fixture","object":"chat.completion","created":1,"model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}"#,
                ..FIXTURES[0]
            },
            ProtocolFixture {
                response: r#"{"candidates":[{"content":{"parts":[{"text":"OK"}],"role":"model"},"finishReason":"STOP","index":0}],"modelVersion":"fixture-model","responseId":"response_fixture"}"#,
                ..FIXTURES[3]
            },
        ] {
            let (descriptor, plan, request_task) =
                local_fixture_plan(fixture, Duration::ZERO).await?;
            let outcome = execute_native_rig_completion(
                test_config(descriptor),
                plan,
                Duration::from_secs(2),
                Instant::now(),
            )
            .await
            .map_err(anyhow::Error::new)?;
            request_task.await??;
            assert_eq!(outcome.status, "ready");
            assert_eq!(outcome.input_tokens, None);
            assert_eq!(outcome.output_tokens, None);
        }
        Ok(())
    }

    #[tokio::test]
    async fn transport_denies_redirect_timeout_oversize_and_malformed_success() -> anyhow::Result<()>
    {
        let cases = [
            (302, "", Duration::ZERO, "provider_http", Some(302)),
            (
                200,
                FIXTURES[0].response,
                Duration::from_millis(100),
                "provider_timeout",
                None,
            ),
            (
                200,
                "x",
                Duration::ZERO,
                "provider_response_too_large",
                Some(200),
            ),
            (
                200,
                "{malformed",
                Duration::ZERO,
                "provider_malformed_response",
                Some(200),
            ),
        ];
        for (index, (status, body, delay, expected, expected_status)) in
            cases.into_iter().enumerate()
        {
            let fixture = FIXTURES[0];
            let oversized = "x".repeat(MAX_RESPONSE_BYTES + 1);
            let response_body = if index == 2 { oversized.as_str() } else { body };
            let (descriptor, mut plan, request_task) =
                local_fixture_plan_with_status(fixture, status, response_body, delay).await?;
            if index == 1 {
                plan.client = build_provider_probe_client(
                    Client::builder(),
                    Duration::from_millis(20),
                    "provider-test.invalid",
                    &plan.addresses,
                )
                .map_err(anyhow::Error::msg)?;
            }
            let result = execute_native_rig_completion(
                test_config(descriptor),
                plan,
                Duration::from_secs(2),
                Instant::now(),
            )
            .await;
            let failure = result.expect_err("fixture must fail");
            assert_eq!(failure.issue, expected);
            assert_eq!(failure.response_status, expected_status);
            let _ = request_task.await?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn a_stalled_lazy_body_after_headers_honors_the_transport_timeout() -> anyhow::Result<()>
    {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let request_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = vec![0_u8; 32 * 1024];
            let size = stream.read(&mut request).await?;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 4096\r\nconnection: close\r\n\r\n{",
                )
                .await?;
            stream.flush().await?;
            tokio::time::sleep(Duration::from_millis(150)).await;
            anyhow::Ok(String::from_utf8_lossy(&request[..size]).into_owned())
        });
        let descriptor = local_descriptor(
            ProviderProtocol::OpenAiCompatible,
            address.port(),
            "/",
            "fixture-model",
        )?;
        let client = Client::builder()
            .timeout(Duration::from_millis(25))
            .no_proxy()
            .resolve_to_addrs("provider-test.invalid", &[address])
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let failure = execute_native_rig_completion(
            test_config(descriptor),
            ProviderProbePlan {
                client,
                addresses: vec![address],
            },
            Duration::from_secs(1),
            Instant::now(),
        )
        .await
        .expect_err("the partial response body must time out");
        assert_eq!(failure.issue, "provider_timeout");
        assert_eq!(failure.response_status, Some(200));
        request_task.await??;
        Ok(())
    }

    #[tokio::test]
    async fn redirects_are_not_followed() -> anyhow::Result<()> {
        let trap = TcpListener::bind("127.0.0.1:0").await?;
        let trap_address = trap.local_addr()?;
        let origin = TcpListener::bind("127.0.0.1:0").await?;
        let origin_address = origin.local_addr()?;
        let origin_task = tokio::spawn(async move {
            let (mut stream, _) = origin.accept().await?;
            let mut request = [0_u8; 8_192];
            let _ = stream.read(&mut request).await?;
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{trap_address}/must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await?;
            anyhow::Ok(())
        });
        let descriptor = local_descriptor(
            ProviderProtocol::OpenAiCompatible,
            origin_address.port(),
            "/v1/chat/completions",
            "fixture-model",
        )?;
        let client = build_provider_probe_client(
            Client::builder(),
            Duration::from_secs(1),
            "provider-test.invalid",
            &[origin_address],
        )
        .map_err(anyhow::Error::msg)?;
        let failure = execute_native_rig_completion(
            test_config(descriptor),
            ProviderProbePlan {
                client,
                addresses: vec![origin_address],
            },
            Duration::from_secs(1),
            Instant::now(),
        )
        .await
        .expect_err("redirect response must fail");
        assert_eq!(failure.issue, "provider_http");
        assert_eq!(failure.response_status, Some(302));
        origin_task.await??;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), trap.accept())
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn configured_proxy_is_never_contacted() -> anyhow::Result<()> {
        let proxy = TcpListener::bind("127.0.0.1:0").await?;
        let proxy_address = proxy.local_addr()?;
        let origin = TcpListener::bind("127.0.0.1:0").await?;
        let origin_address = origin.local_addr()?;
        let client = build_provider_probe_client(
            Client::builder().proxy(reqwest::Proxy::all(format!("http://{proxy_address}"))?),
            Duration::from_secs(1),
            "provider-test.invalid",
            &[origin_address],
        )
        .map_err(anyhow::Error::msg)?;
        let origin_task = tokio::spawn(async move {
            let (mut stream, _) = origin.accept().await?;
            let mut request = [0_u8; 8_192];
            let size = stream.read(&mut request).await?;
            let body = FIXTURES[0].response;
            let response = http_response(200, body);
            stream.write_all(response.as_bytes()).await?;
            anyhow::Ok(String::from_utf8_lossy(&request[..size]).into_owned())
        });
        let descriptor = local_descriptor(
            ProviderProtocol::OpenAiCompatible,
            origin_address.port(),
            "/v1/chat/completions",
            "fixture-model",
        )?;
        let plan = ProviderProbePlan {
            client,
            addresses: vec![origin_address],
        };
        let outcome = execute_native_rig_completion(
            test_config(descriptor),
            plan,
            Duration::from_secs(1),
            Instant::now(),
        )
        .await
        .map_err(anyhow::Error::new)?;
        assert_eq!(outcome.status, "ready");
        origin_task.await??;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), proxy.accept())
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test]
    async fn streaming_and_multipart_are_explicitly_unsupported() -> anyhow::Result<()> {
        let transport = PinnedRigTransport::default();
        let streaming_request = Request::builder()
            .uri("https://invalid.invalid/stream")
            .body(Vec::<u8>::new())?;
        let streaming_error = match transport.send_streaming(streaming_request).await {
            Err(error) => error,
            Ok(_) => panic!("streaming must be rejected"),
        };
        assert_transport_failure(streaming_error, TransportFailure::StreamingUnsupported);

        let multipart_request = Request::builder()
            .uri("https://invalid.invalid/multipart")
            .body(MultipartForm::new())?;
        let multipart_result: rig_core::http_client::Result<Response<LazyBody<Vec<u8>>>> =
            transport.send_multipart(multipart_request).await;
        let multipart_error = match multipart_result {
            Err(error) => error,
            Ok(_) => panic!("multipart must be rejected"),
        };
        assert_transport_failure(multipart_error, TransportFailure::MultipartUnsupported);
        Ok(())
    }

    #[test]
    fn report_serialization_never_contains_secret_response_or_full_path() -> anyhow::Result<()> {
        let resolution = ProviderResolution {
            descriptor: None,
            intent_enabled: true,
            required: true,
            source: "environment".to_owned(),
            managed_overrides_environment: false,
            conflicts: ProviderConfigConflicts::default(),
            endpoint_origin: Some("https://provider.example".to_owned()),
            model: Some("fixture-model".to_owned()),
            protocol: Some("openai-compatible".to_owned()),
            credential_configured: true,
            issues: vec!["provider_malformed_response".to_owned()],
        };
        let encoded = serde_json::to_string(&preflight_report_from_resolution(&resolution))?;
        assert!(!encoded.contains("fixture-secret"));
        assert!(!encoded.contains("sensitive upstream response"));
        assert!(!encoded.contains("chat/completions"));
        assert!(!encoded.contains("required_endpoint"));
        assert!(!encoded.contains("matches_required"));

        let unsafe_metadata = resolve_effective_provider_with_environment(
            &ManagedRouterRead::test_absent(),
            EnvironmentProviderValues {
                endpoint: Some("https://provider.example/sensitive/full/path".to_owned()),
                model: Some("fixture-secret model".to_owned()),
                protocol: Some("fixture-secret-protocol".to_owned()),
                credential_present: true,
            },
            true,
        );
        let unsafe_encoded =
            serde_json::to_string(&preflight_report_from_resolution(&unsafe_metadata))?;
        assert!(!unsafe_encoded.contains("fixture-secret"));
        assert!(!unsafe_encoded.contains("sensitive/full/path"));
        Ok(())
    }

    fn assert_transport_failure(error: RigHttpError, expected: TransportFailure) {
        let RigHttpError::Instance(error) = error else {
            panic!("expected typed transport failure");
        };
        assert_eq!(
            error
                .downcast_ref::<TransportFailure>()
                .map(|failure| { std::mem::discriminant(failure) }),
            Some(std::mem::discriminant(&expected))
        );
    }

    fn test_config(descriptor: ProviderDescriptor) -> EffectiveProviderConfig {
        EffectiveProviderConfig {
            descriptor,
            api_key: SecretString::from("fixture-secret"),
        }
    }

    fn test_descriptor(protocol: ProviderProtocol, path: &str, model: &str) -> ProviderDescriptor {
        let endpoint = Url::parse(&format!("https://provider.example{path}"))
            .expect("valid descriptor fixture");
        ProviderDescriptor {
            rig_base_url: canonicalize_rig_base(&endpoint, protocol, model)
                .expect("canonical fixture path"),
            authority: endpoint.origin().ascii_serialization(),
            endpoint,
            model: model.to_owned(),
            protocol,
            credential_source: CredentialSource::Environment,
        }
    }

    async fn local_fixture_plan(
        fixture: ProtocolFixture,
        delay: Duration,
    ) -> anyhow::Result<(
        ProviderDescriptor,
        ProviderProbePlan,
        tokio::task::JoinHandle<anyhow::Result<String>>,
    )> {
        local_fixture_plan_with_status(fixture, 200, fixture.response, delay).await
    }

    async fn local_fixture_plan_with_status(
        fixture: ProtocolFixture,
        status: u16,
        response_body: &str,
        delay: Duration,
    ) -> anyhow::Result<(
        ProviderDescriptor,
        ProviderProbePlan,
        tokio::task::JoinHandle<anyhow::Result<String>>,
    )> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let body = response_body.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = vec![0_u8; 32 * 1024];
            let size = stream.read(&mut request).await?;
            tokio::time::sleep(delay).await;
            stream
                .write_all(http_response(status, &body).as_bytes())
                .await?;
            anyhow::Ok(String::from_utf8_lossy(&request[..size]).into_owned())
        });
        let descriptor = local_descriptor(
            fixture.protocol,
            address.port(),
            fixture.endpoint_path,
            fixture.model,
        )?;
        let client = Client::builder()
            .timeout(Duration::from_secs(1))
            .no_proxy()
            .resolve_to_addrs("provider-test.invalid", &[address])
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok((
            descriptor,
            ProviderProbePlan {
                client,
                addresses: vec![address],
            },
            task,
        ))
    }

    fn local_descriptor(
        protocol: ProviderProtocol,
        port: u16,
        endpoint_path: &str,
        model: &str,
    ) -> anyhow::Result<ProviderDescriptor> {
        let endpoint = Url::parse(&format!(
            "http://provider-test.invalid:{port}{endpoint_path}"
        ))?;
        Ok(ProviderDescriptor {
            rig_base_url: canonicalize_rig_base(&endpoint, protocol, model)
                .ok_or_else(|| anyhow::anyhow!("invalid local fixture base"))?,
            authority: endpoint.origin().ascii_serialization(),
            endpoint,
            model: model.to_owned(),
            protocol,
            credential_source: CredentialSource::Environment,
        })
    }

    fn http_response(status: u16, body: &str) -> String {
        let reason = if (200..300).contains(&status) {
            "OK"
        } else {
            "Failure"
        };
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
}
