//! Structured JSON logging, OTLP tracing, and Prometheus recording for MatchPlane services.

use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{Resource, trace::SdkTracerProvider};
use rustls::crypto::ring;
use thiserror::Error;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

/// Handles installed observability exporters.
#[derive(Debug, Clone)]
pub struct Telemetry {
    prometheus: PrometheusHandle,
    tracer_provider: SdkTracerProvider,
}

impl Telemetry {
    /// Renders the current Prometheus exposition document.
    #[must_use]
    pub fn render_metrics(&self) -> String {
        self.prometheus.render()
    }

    /// Flushes and shuts down the OTLP trace pipeline during graceful service termination.
    ///
    /// # Errors
    ///
    /// Returns [`ObservabilityError`] if one or more queued spans cannot be flushed.
    pub fn shutdown(&self) -> Result<(), ObservabilityError> {
        self.tracer_provider
            .shutdown()
            .map_err(|error| ObservabilityError::Shutdown(error.to_string()))
    }
}

/// Global subscriber or metrics-recorder initialization failure.
#[derive(Debug, Error)]
pub enum ObservabilityError {
    /// Log filter syntax was invalid.
    #[error("invalid tracing filter: {0}")]
    Filter(#[from] tracing_subscriber::filter::ParseError),
    /// The global subscriber was already installed or could not be set.
    #[error("tracing subscriber initialization failed: {0}")]
    Subscriber(#[from] tracing_subscriber::util::TryInitError),
    /// The global metrics recorder could not be installed.
    #[error("metrics recorder initialization failed: {0}")]
    Metrics(String),
    /// The OTLP exporter configuration could not be built.
    #[error("OpenTelemetry exporter initialization failed: {0}")]
    Exporter(#[from] opentelemetry_otlp::ExporterBuildError),
    /// Queued OpenTelemetry spans could not be flushed during shutdown.
    #[error("OpenTelemetry shutdown failed: {0}")]
    Shutdown(String),
}

fn install_default_crypto_provider() {
    let _ = ring::default_provider().install_default();
}

/// Installs JSON tracing and a Prometheus recorder once per process.
///
/// # Errors
///
/// Returns [`ObservabilityError`] when global initialization fails.
pub fn init(
    service_name: &'static str,
    filter: &str,
    otlp_endpoint: &str,
) -> Result<Telemetry, ObservabilityError> {
    install_default_crypto_provider();
    let env_filter = EnvFilter::try_new(filter)?;
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(otlp_endpoint.to_owned())
        .build()?;
    let resource = Resource::builder().with_service_name(service_name).build();
    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();
    let tracer = tracer_provider.tracer(service_name);
    global::set_tracer_provider(tracer_provider.clone());
    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_current_span(true)
                .with_span_list(true)
                .with_target(true),
        )
        .try_init()?;
    let prometheus = PrometheusBuilder::new()
        .add_global_label("service", service_name)
        .install_recorder()
        .map_err(|error| ObservabilityError::Metrics(error.to_string()))?;
    Ok(Telemetry {
        prometheus,
        tracer_provider,
    })
}

/// Waits until the process receives Ctrl+C or, on Unix, SIGTERM.
///
/// Service entrypoints share this helper so graceful shutdown behaves the same
/// across HTTP, gRPC, and worker binaries.
pub async fn shutdown_signal() {
    let control_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "failed to listen for Ctrl+C");
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "failed to listen for SIGTERM");
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = control_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn https_otlp_exporter_builds_with_workspace_tls_features() {
        install_default_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());

        let result = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint("https://localhost:4317")
            .build();

        assert!(result.is_ok(), "HTTPS OTLP exporter failed: {result:?}");
    }
}
