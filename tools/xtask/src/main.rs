use std::{env, process::Command as ProcessCommand, time::Duration};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use matchplane_config::{AppConfig, Environment};
use matchplane_storage::PgStore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
    Web,
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

async fn doctor() -> Result<()> {
    let report = match AppConfig::load() {
        Ok(config) => DoctorReport {
            ok: true,
            environment: Some(environment_name(config.environment).to_owned()),
            service_role: Some(config.service_role),
            error: None,
        },
        Err(error) => DoctorReport {
            ok: false,
            environment: env::var("MATCHPLANE_ENVIRONMENT").ok(),
            service_role: env::var("MATCHPLANE_SERVICE_ROLE").ok(),
            error: Some(safe_error(&error.to_string())),
        },
    };
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
        ProcessCommand::new(env_or("MATCHPLANE_WEB_NODE", "node"))
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
            Some("platform.doctor") => {
                let report = match AppConfig::load() {
                    Ok(config) => DoctorReport {
                        ok: true,
                        environment: Some(environment_name(config.environment).to_owned()),
                        service_role: Some(config.service_role),
                        error: None,
                    },
                    Err(error) => DoctorReport {
                        ok: false,
                        environment: env::var("MATCHPLANE_ENVIRONMENT").ok(),
                        service_role: env::var("MATCHPLANE_SERVICE_ROLE").ok(),
                        error: Some(safe_error(&error.to_string())),
                    },
                };
                JsonRpcResponse::success(id, tool_result(report))
            }
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

fn environment_name(environment: Environment) -> &'static str {
    match environment {
        Environment::Development => "development",
        Environment::Test => "test",
        Environment::Production => "production",
    }
}

fn safe_error(error: &str) -> String {
    error
        .replace("postgres://", "postgres://[redacted]@")
        .replace("redis://", "redis://[redacted]@")
        .replace("rediss://", "rediss://[redacted]@")
        .chars()
        .take(500)
        .collect()
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    ok: bool,
    environment: Option<String>,
    service_role: Option<String>,
    error: Option<String>,
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
    use super::{Service, service_command};

    #[test]
    fn service_command_maps_gateway_to_the_packaged_binary() {
        assert_eq!(service_command(Service::Gateway).0, "matchplane-gateway");
    }

    #[test]
    fn service_command_maps_web_to_node() {
        assert_eq!(service_command(Service::Web).0, "node");
    }
}
