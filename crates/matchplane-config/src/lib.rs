//! Validated configuration shared by MatchPlane service binaries.

use std::{net::SocketAddr, str::FromStr};

use config::{Config, Environment as EnvironmentSource};
use matchplane_domain::FederationNodeId;
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use thiserror::Error;
use url::Url;

pub mod auth;
pub mod provider_registry;

pub use auth::{AuthError, BearerToken};

/// Deployment safety profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    /// Local development with explicitly insecure service endpoints.
    Development,
    /// Test environment with isolated credentials.
    Test,
    /// Production mode with secure-default validation.
    Production,
}

/// Raw values loaded from `MATCHPLANE_*` environment variables.
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    /// Environment safety profile.
    pub environment: Environment,
    /// Workload identity used to apply service-specific production checks.
    pub service_role: String,
    /// Stable federation node UUID.
    pub node_id: String,
    /// HTTP listen address.
    pub http_addr: String,
    /// Whether the standalone conversion projector may claim work.
    pub conversion_projector_enabled: bool,
    /// Serial conversion claim size. Retained as a deployment compatibility gate and fixed at one.
    pub conversion_projector_batch_size: u16,
    /// Empty-loop polling interval in milliseconds.
    pub conversion_projector_poll_ms: u64,
    /// PostgreSQL pool size dedicated to conversion projection.
    pub conversion_projector_pool_size: u32,
    /// Oldest unresolved age that degrades projector readiness.
    pub conversion_projector_degraded_after_seconds: u64,
    /// gRPC listen address.
    pub grpc_addr: String,
    /// PostgreSQL connection URL.
    pub database_url: String,
    /// Comma-separated Kafka bootstrap servers.
    pub kafka_brokers: String,
    /// Kafka librdkafka security protocol.
    pub kafka_security_protocol: String,
    /// Kafka broker CA bundle path for TLS verification.
    pub kafka_ssl_ca_location: String,
    /// Kafka client certificate path for mTLS.
    pub kafka_ssl_certificate_location: String,
    /// Kafka client private key path for mTLS.
    pub kafka_ssl_key_location: String,
    /// Valkey connection URL.
    pub valkey_url: String,
    /// Optional PEM CA bundle used to verify a private Valkey TLS certificate.
    pub valkey_ca_file: String,
    /// `tracing_subscriber` filter expression.
    pub log_filter: String,
    /// OpenTelemetry Collector gRPC endpoint.
    pub otlp_endpoint: String,
    /// Whether service-to-service TLS is mandatory.
    pub require_tls: bool,
    /// PEM server certificate used by the federation gRPC listener.
    pub tls_certificate_path: String,
    /// PEM private key used by the federation gRPC listener.
    pub tls_private_key_path: String,
    /// PEM certificate authority used to authenticate federation clients.
    pub tls_client_ca_path: String,
    /// Platform-owned HTTPS origin used to build and validate payment callbacks.
    pub payment_callback_origin: String,
}

/// Parsed values safe for service startup.
#[derive(Debug, Clone)]
pub struct ValidatedConfig {
    /// Environment safety profile.
    pub environment: Environment,
    /// Workload identity used to apply service-specific production checks.
    pub service_role: String,
    /// Stable federation node ID.
    pub node_id: FederationNodeId,
    /// Parsed HTTP listen address.
    pub http_addr: SocketAddr,
    /// Whether the standalone conversion projector may claim work.
    pub conversion_projector_enabled: bool,
    /// Serial conversion claim size. Retained as a deployment compatibility gate and fixed at one.
    pub conversion_projector_batch_size: u16,
    /// Empty-loop polling interval in milliseconds.
    pub conversion_projector_poll_ms: u64,
    /// PostgreSQL pool size dedicated to conversion projection.
    pub conversion_projector_pool_size: u32,
    /// Oldest unresolved age that degrades projector readiness.
    pub conversion_projector_degraded_after_seconds: u64,
    /// Parsed gRPC listen address.
    pub grpc_addr: SocketAddr,
    /// PostgreSQL connection URL.
    pub database_url: String,
    /// Kafka bootstrap servers.
    pub kafka_brokers: String,
    /// Kafka librdkafka security protocol.
    pub kafka_security_protocol: String,
    /// Kafka broker CA bundle path for TLS verification.
    pub kafka_ssl_ca_location: String,
    /// Kafka client certificate path for mTLS.
    pub kafka_ssl_certificate_location: String,
    /// Kafka client private key path for mTLS.
    pub kafka_ssl_key_location: String,
    /// Valkey connection URL.
    pub valkey_url: String,
    /// Optional PEM CA bundle used to verify a private Valkey TLS certificate.
    pub valkey_ca_file: String,
    /// Log filter expression.
    pub log_filter: String,
    /// OTLP endpoint.
    pub otlp_endpoint: String,
    /// Whether TLS is required.
    pub require_tls: bool,
    /// PEM server certificate path.
    pub tls_certificate_path: String,
    /// PEM private key path.
    pub tls_private_key_path: String,
    /// PEM client CA path.
    pub tls_client_ca_path: String,
    /// Platform-owned HTTPS origin used to build and validate payment callbacks.
    pub payment_callback_origin: String,
}

/// Configuration loading and validation failures.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// The configuration source could not be decoded.
    #[error("configuration could not be loaded: {0}")]
    Load(#[from] config::ConfigError),
    /// The node UUID is malformed.
    #[error("MATCHPLANE_NODE_ID is invalid: {0}")]
    NodeId(#[from] uuid::Error),
    /// A listen address is malformed.
    #[error("{field} is invalid: {source}")]
    SocketAddress {
        /// Configuration field.
        field: &'static str,
        /// Parse failure.
        source: std::net::AddrParseError,
    },
    /// Production mode rejected an insecure value.
    #[error("production configuration is insecure: {0}")]
    InsecureProduction(&'static str),
    /// A numeric workload setting is outside its fail-closed range.
    #[error("configuration value {field} must be in {minimum}..={maximum}, got {actual}")]
    OutOfRange {
        /// Environment variable name.
        field: &'static str,
        /// Inclusive lower bound.
        minimum: u64,
        /// Inclusive upper bound.
        maximum: u64,
        /// Rejected value.
        actual: u64,
    },
    /// A required endpoint is empty.
    #[error("configuration value {0} cannot be empty")]
    Empty(&'static str),
}

impl AppConfig {
    /// Loads configuration from defaults and `MATCHPLANE_*` environment variables.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when decoding or validation fails.
    pub fn load() -> Result<ValidatedConfig, ConfigError> {
        Self::load_raw()?.validate()
    }

    /// Loads raw configuration and returns every validation message without weakening the
    /// fail-closed [`Self::load`] path.  Operator tooling uses this to report all production
    /// blockers in one invocation instead of making an operator fix one variable at a time.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] when the environment cannot be decoded into the raw shape.  A
    /// successfully decoded configuration may still contain validation messages.
    pub fn load_diagnostics() -> Result<ConfigurationDiagnostics, ConfigError> {
        let config = Self::load_raw()?;
        Ok(ConfigurationDiagnostics {
            environment: config.environment,
            service_role: config.service_role.clone(),
            errors: config.validation_messages(),
        })
    }

    fn load_raw() -> Result<Self, ConfigError> {
        let config = Config::builder()
            .set_default("environment", "development")?
            .set_default("service_role", "generic")?
            .set_default("node_id", "00000000-0000-7000-8000-00000000000a")?
            .set_default("http_addr", "0.0.0.0:8080")?
            .set_default("conversion_projector_enabled", false)?
            .set_default("conversion_projector_batch_size", 1)?
            .set_default("conversion_projector_poll_ms", 1_000)?
            .set_default("conversion_projector_pool_size", 5)?
            .set_default("conversion_projector_degraded_after_seconds", 300)?
            .set_default("grpc_addr", "0.0.0.0:50051")?
            .set_default(
                "database_url",
                "postgres://matchplane:matchplane_dev_only@localhost:5432/matchplane",
            )?
            .set_default("kafka_brokers", "localhost:9092")?
            .set_default("kafka_security_protocol", "PLAINTEXT")?
            .set_default("kafka_ssl_ca_location", "")?
            .set_default("kafka_ssl_certificate_location", "")?
            .set_default("kafka_ssl_key_location", "")?
            .set_default("valkey_url", "redis://localhost:6379/")?
            .set_default("valkey_ca_file", "")?
            .set_default("log_filter", "info,matchplane=debug")?
            .set_default("otlp_endpoint", "http://localhost:4317")?
            .set_default("require_tls", false)?
            .set_default("tls_certificate_path", "")?
            .set_default("tls_private_key_path", "")?
            .set_default("tls_client_ca_path", "")?
            .set_default("payment_callback_origin", "")?
            .add_source(
                EnvironmentSource::with_prefix("MATCHPLANE")
                    .prefix_separator("_")
                    .separator("__")
                    .try_parsing(true),
            )
            .build()?
            .try_deserialize::<Self>()?;
        Ok(config)
    }

    /// Parses and applies production safety checks.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] for malformed or insecure values.
    pub fn validate(self) -> Result<ValidatedConfig, ConfigError> {
        if let Some(error) = self.validation_errors().into_iter().next() {
            return Err(error);
        }

        Ok(ValidatedConfig {
            environment: self.environment,
            service_role: self.service_role,
            node_id: FederationNodeId::from_str(&self.node_id)?,
            http_addr: self
                .http_addr
                .parse()
                .map_err(|source| ConfigError::SocketAddress {
                    field: "MATCHPLANE_HTTP_ADDR",
                    source,
                })?,
            conversion_projector_enabled: self.conversion_projector_enabled,
            conversion_projector_batch_size: self.conversion_projector_batch_size,
            conversion_projector_poll_ms: self.conversion_projector_poll_ms,
            conversion_projector_pool_size: self.conversion_projector_pool_size,
            conversion_projector_degraded_after_seconds: self
                .conversion_projector_degraded_after_seconds,
            grpc_addr: self
                .grpc_addr
                .parse()
                .map_err(|source| ConfigError::SocketAddress {
                    field: "MATCHPLANE_GRPC_ADDR",
                    source,
                })?,
            database_url: self.database_url,
            kafka_brokers: self.kafka_brokers,
            kafka_security_protocol: self.kafka_security_protocol,
            kafka_ssl_ca_location: self.kafka_ssl_ca_location,
            kafka_ssl_certificate_location: self.kafka_ssl_certificate_location,
            kafka_ssl_key_location: self.kafka_ssl_key_location,
            valkey_url: self.valkey_url,
            valkey_ca_file: self.valkey_ca_file,
            log_filter: self.log_filter,
            otlp_endpoint: self.otlp_endpoint,
            require_tls: self.require_tls,
            tls_certificate_path: self.tls_certificate_path,
            tls_private_key_path: self.tls_private_key_path,
            tls_client_ca_path: self.tls_client_ca_path,
            payment_callback_origin: self.payment_callback_origin,
        })
    }

    fn validation_messages(&self) -> Vec<String> {
        self.validation_errors()
            .into_iter()
            .map(|error| error.to_string())
            .collect()
    }

    fn validation_errors(&self) -> Vec<ConfigError> {
        let mut errors = Vec::new();
        for (field, value) in [
            ("MATCHPLANE_DATABASE_URL", self.database_url.as_str()),
            ("MATCHPLANE_KAFKA_BROKERS", self.kafka_brokers.as_str()),
            ("MATCHPLANE_OTLP_ENDPOINT", self.otlp_endpoint.as_str()),
        ] {
            if value.trim().is_empty() {
                errors.push(ConfigError::Empty(field));
            }
        }
        if self.service_role != "conversion-projector" && self.valkey_url.trim().is_empty() {
            errors.push(ConfigError::Empty("MATCHPLANE_VALKEY_URL"));
        }

        for (field, actual, minimum, maximum) in [
            (
                "MATCHPLANE_CONVERSION_PROJECTOR_BATCH_SIZE",
                u64::from(self.conversion_projector_batch_size),
                1,
                1,
            ),
            (
                "MATCHPLANE_CONVERSION_PROJECTOR_POLL_MS",
                self.conversion_projector_poll_ms,
                100,
                60_000,
            ),
            (
                "MATCHPLANE_CONVERSION_PROJECTOR_POOL_SIZE",
                u64::from(self.conversion_projector_pool_size),
                1,
                20,
            ),
            (
                "MATCHPLANE_CONVERSION_PROJECTOR_DEGRADED_AFTER_SECONDS",
                self.conversion_projector_degraded_after_seconds,
                1,
                86_400,
            ),
        ] {
            if !(minimum..=maximum).contains(&actual) {
                errors.push(ConfigError::OutOfRange {
                    field,
                    minimum,
                    maximum,
                    actual,
                });
            }
        }

        if self.environment == Environment::Production {
            if !matches!(
                self.service_role.as_str(),
                "web"
                    | "gateway"
                    | "payment-service"
                    | "event-relay"
                    | "conversion-projector"
                    | "matcher"
                    | "projector"
                    | "vector-worker"
                    | "federation-hub"
                    | "migration"
            ) {
                errors.push(ConfigError::InsecureProduction(
                    "MATCHPLANE_SERVICE_ROLE must identify a known workload in production",
                ));
            }
            if !self.require_tls {
                errors.push(ConfigError::InsecureProduction(
                    "MATCHPLANE_REQUIRE_TLS must be true",
                ));
            }
            if self.node_id == "00000000-0000-7000-8000-00000000000a" {
                errors.push(ConfigError::InsecureProduction(
                    "MATCHPLANE_NODE_ID must be unique and cannot use the development default",
                ));
            }
            if self.service_role != "conversion-projector" {
                let valkey_url = match Url::parse(&self.valkey_url) {
                    Ok(url) => Some(url),
                    Err(_) if !self.valkey_url.trim().is_empty() => {
                        errors.push(ConfigError::InsecureProduction(
                            "MATCHPLANE_VALKEY_URL must be a valid URL",
                        ));
                        None
                    }
                    Err(_) => None,
                };
                if let Some(valkey_url) = valkey_url {
                    if valkey_url.scheme() != "rediss" || valkey_url.fragment().is_some() {
                        errors.push(ConfigError::InsecureProduction(
                            "Valkey must use rediss:// with certificate verification enabled",
                        ));
                    }
                    if let Err(error) = reject_placeholder_credentials(&valkey_url, "Valkey") {
                        errors.push(error);
                    }
                }
            }

            let database_url = match Url::parse(&self.database_url) {
                Ok(url) => Some(url),
                Err(_) if !self.database_url.trim().is_empty() => {
                    errors.push(ConfigError::InsecureProduction(
                        "MATCHPLANE_DATABASE_URL must be a valid URL",
                    ));
                    None
                }
                Err(_) => None,
            };
            if let Some(database_url) = database_url {
                if database_url.fragment().is_some() {
                    errors.push(ConfigError::InsecureProduction(
                        "MATCHPLANE_DATABASE_URL must not contain a fragment",
                    ));
                }
                if let Err(error) = reject_placeholder_credentials(&database_url, "database") {
                    errors.push(error);
                }
                let sslmodes: Vec<_> = database_url
                    .query_pairs()
                    .filter(|(key, _)| key == "sslmode" || key == "ssl-mode")
                    .collect();
                if sslmodes.len() != 1
                    || sslmodes[0].0 != "sslmode"
                    || sslmodes[0].1 != "verify-full"
                {
                    errors.push(ConfigError::InsecureProduction(
                        "PostgreSQL must use exactly one canonical sslmode=verify-full option in production",
                    ));
                }
            }
            if matches!(
                self.service_role.as_str(),
                "event-relay" | "matcher" | "projector"
            ) && (self.kafka_security_protocol != "SSL"
                || self.kafka_ssl_ca_location.trim().is_empty()
                || self.kafka_ssl_certificate_location.trim().is_empty()
                || self.kafka_ssl_key_location.trim().is_empty())
            {
                errors.push(ConfigError::InsecureProduction(
                    "Kafka workloads must use mTLS with security.protocol=SSL and CA, certificate, and key paths",
                ));
            }
            if self.service_role == "federation-hub" {
                for (field, value) in [
                    (
                        "MATCHPLANE_TLS_CERTIFICATE_PATH",
                        self.tls_certificate_path.as_str(),
                    ),
                    (
                        "MATCHPLANE_TLS_PRIVATE_KEY_PATH",
                        self.tls_private_key_path.as_str(),
                    ),
                    (
                        "MATCHPLANE_TLS_CLIENT_CA_PATH",
                        self.tls_client_ca_path.as_str(),
                    ),
                ] {
                    if value.trim().is_empty() {
                        errors.push(ConfigError::Empty(field));
                    }
                }
            }
            if !self.otlp_endpoint.starts_with("https://") {
                errors.push(ConfigError::InsecureProduction(
                    "MATCHPLANE_OTLP_ENDPOINT must use HTTPS",
                ));
            }
            if self.log_filter.contains("debug") || self.log_filter.contains("trace") {
                errors.push(ConfigError::InsecureProduction(
                    "production log filter must not enable debug or trace logging",
                ));
            }
            if let Err(error) = validate_payment_callback_origin(&self.payment_callback_origin) {
                errors.push(error);
            }
        }

        if let Err(error) = FederationNodeId::from_str(&self.node_id) {
            errors.push(ConfigError::NodeId(error));
        }
        if let Err(source) = self.http_addr.parse::<SocketAddr>() {
            errors.push(ConfigError::SocketAddress {
                field: "MATCHPLANE_HTTP_ADDR",
                source,
            });
        }
        if let Err(source) = self.grpc_addr.parse::<SocketAddr>() {
            errors.push(ConfigError::SocketAddress {
                field: "MATCHPLANE_GRPC_ADDR",
                source,
            });
        }
        errors
    }
}

/// Non-secret configuration diagnostics for operator tooling and the read-only MCP server.
#[derive(Debug, Clone)]
pub struct ConfigurationDiagnostics {
    /// Parsed deployment environment.
    pub environment: Environment,
    /// Parsed workload role.
    pub service_role: String,
    /// Every validation blocker, with secrets excluded by the error vocabulary.
    pub errors: Vec<String>,
}

fn reject_placeholder_credentials(url: &Url, service: &'static str) -> Result<(), ConfigError> {
    let mut values = Vec::new();
    values.push(url.username().to_owned());
    if let Some(password) = url.password() {
        values.push(password.to_owned());
    }
    for (key, value) in url.query_pairs() {
        if matches!(key.as_ref(), "user" | "username" | "password" | "pass") {
            values.push(value.into_owned());
        }
    }
    for value in values {
        let decoded = percent_decode_str(&value)
            .decode_utf8()
            .map_err(|_| ConfigError::InsecureProduction("credentials must be valid UTF-8"))?;
        if decoded.contains("matchplane_dev_only") || decoded.contains("CHANGE_ME") {
            return Err(ConfigError::InsecureProduction(match service {
                "database" => "development or placeholder database credentials are forbidden",
                _ => "placeholder Valkey credentials are forbidden",
            }));
        }
    }
    Ok(())
}

fn validate_payment_callback_origin(value: &str) -> Result<(), ConfigError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ConfigError::Empty("MATCHPLANE_PAYMENT_CALLBACK_ORIGIN"));
    }
    let Some((scheme, authority)) = value.split_once("://") else {
        return Err(ConfigError::InsecureProduction(
            "MATCHPLANE_PAYMENT_CALLBACK_ORIGIN must be an HTTPS origin",
        ));
    };
    if scheme != "https"
        || authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('@')
    {
        return Err(ConfigError::InsecureProduction(
            "MATCHPLANE_PAYMENT_CALLBACK_ORIGIN must be an HTTPS origin without path or credentials",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production_config() -> AppConfig {
        AppConfig {
            environment: Environment::Production,
            service_role: "gateway".to_owned(),
            node_id: FederationNodeId::new().to_string(),
            http_addr: "127.0.0.1:8080".to_owned(),
            conversion_projector_enabled: false,
            conversion_projector_batch_size: 1,
            conversion_projector_poll_ms: 1_000,
            conversion_projector_pool_size: 5,
            conversion_projector_degraded_after_seconds: 300,
            grpc_addr: "127.0.0.1:50051".to_owned(),
            database_url: "postgres://matchplane:secret@db/matchplane?sslmode=verify-full"
                .to_owned(),
            kafka_brokers: "kafka:9093".to_owned(),
            kafka_security_protocol: "SSL".to_owned(),
            kafka_ssl_ca_location: "/run/matchplane/kafka/ca.crt".to_owned(),
            kafka_ssl_certificate_location: "/run/matchplane/kafka/client.crt".to_owned(),
            kafka_ssl_key_location: "/run/matchplane/kafka/client.key".to_owned(),
            valkey_url: "rediss://valkey:6380/".to_owned(),
            valkey_ca_file: String::new(),
            log_filter: "info".to_owned(),
            otlp_endpoint: "https://otel:4317".to_owned(),
            require_tls: true,
            tls_certificate_path: "/run/matchplane/tls/server.crt".to_owned(),
            tls_private_key_path: "/run/matchplane/tls/server.key".to_owned(),
            tls_client_ca_path: "/run/matchplane/tls/client-ca.crt".to_owned(),
            payment_callback_origin: "https://payments.example.com".to_owned(),
        }
    }

    #[test]
    fn validate_should_reject_plaintext_valkey_in_production() {
        let mut config = production_config();
        config.valkey_url = "redis://valkey:6379/".to_owned();

        let error = config.validate().expect_err("plaintext Valkey must fail");

        assert!(matches!(error, ConfigError::InsecureProduction(_)));
    }

    #[test]
    fn validate_should_accept_secure_production_configuration() {
        let result = production_config().validate();

        assert!(result.is_ok(), "secure config failed: {result:?}");
    }

    #[test]
    fn validate_should_reject_duplicate_or_alias_sslmode_options() {
        for query in [
            "sslmode=verify-full&sslmode=disable",
            "sslmode=verify-full&ssl-mode=disable",
            "ssl-mode=verify-full",
        ] {
            let mut config = production_config();
            config.database_url = format!("postgres://matchplane:secret@db/matchplane?{query}");
            assert!(
                config.validate().is_err(),
                "insecure query accepted: {query}"
            );
        }
    }

    #[test]
    fn validate_should_reject_percent_encoded_placeholder_credentials() {
        let mut config = production_config();
        config.database_url =
            "postgres://matchplane:matchplane%5Fdev%5Fonly@db/matchplane?sslmode=verify-full"
                .to_owned();
        assert!(config.validate().is_err());

        let mut config = production_config();
        config.valkey_url = "rediss://:CHANGE%5FME@valkey:6380/".to_owned();
        assert!(config.validate().is_err());
    }

    #[test]
    fn validate_should_reject_the_development_node_id_in_production() {
        let mut config = production_config();
        config.node_id = "00000000-0000-7000-8000-00000000000a".to_owned();

        let error = config
            .validate()
            .expect_err("the development node id must not be reused");

        assert!(matches!(error, ConfigError::InsecureProduction(_)));
    }

    #[test]
    fn validate_should_require_a_platform_payment_callback_origin() {
        let mut config = production_config();
        config.payment_callback_origin = "https://payments.example.com/callback".to_owned();

        let error = config
            .validate()
            .expect_err("callback origins must not contain a path");

        assert!(matches!(error, ConfigError::InsecureProduction(_)));
    }

    #[test]
    fn validate_should_require_kafka_tls_only_for_kafka_workloads() {
        let mut config = production_config();
        config.service_role = "event-relay".to_owned();
        config.kafka_security_protocol = "PLAINTEXT".to_owned();

        let error = config
            .validate()
            .expect_err("Kafka clients must fail closed without mTLS");

        assert!(matches!(error, ConfigError::InsecureProduction(_)));
    }

    #[test]
    fn validate_should_accept_database_only_conversion_projector_role() {
        let mut config = production_config();
        config.service_role = "conversion-projector".to_owned();
        config.kafka_security_protocol = "PLAINTEXT".to_owned();
        config.kafka_ssl_ca_location.clear();
        config.kafka_ssl_certificate_location.clear();
        config.kafka_ssl_key_location.clear();
        config.valkey_url.clear();
        config.valkey_ca_file.clear();

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validate_should_require_valkey_for_cache_using_roles() {
        let mut config = production_config();
        config.valkey_url.clear();

        assert!(matches!(
            config.validate(),
            Err(ConfigError::Empty("MATCHPLANE_VALKEY_URL"))
        ));
    }

    #[test]
    fn validate_should_reject_conversion_projector_values_outside_bounds() {
        for mutate in [
            |config: &mut AppConfig| config.conversion_projector_batch_size = 0,
            |config: &mut AppConfig| config.conversion_projector_batch_size = 2,
            |config: &mut AppConfig| config.conversion_projector_poll_ms = 60_001,
            |config: &mut AppConfig| config.conversion_projector_pool_size = 21,
            |config: &mut AppConfig| config.conversion_projector_degraded_after_seconds = 0,
        ] {
            let mut config = production_config();
            mutate(&mut config);
            assert!(matches!(
                config.validate(),
                Err(ConfigError::OutOfRange { .. })
            ));
        }
    }

    #[test]
    fn validate_should_require_federation_tls_only_for_federation_hub() {
        let mut config = production_config();
        config.service_role = "federation-hub".to_owned();
        config.tls_certificate_path.clear();

        let error = config
            .validate()
            .expect_err("federation hub must fail closed without server TLS");

        assert!(matches!(
            error,
            ConfigError::Empty("MATCHPLANE_TLS_CERTIFICATE_PATH")
        ));
    }

    #[test]
    fn validate_should_reject_an_unknown_production_workload() {
        let mut config = production_config();
        config.service_role = "unknown".to_owned();

        let error = config
            .validate()
            .expect_err("unknown workloads must not inherit generic production checks");

        assert!(matches!(error, ConfigError::InsecureProduction(_)));
    }

    #[test]
    fn diagnostics_should_report_all_production_blockers() {
        let mut config = production_config();
        config.require_tls = false;
        config.database_url =
            "postgres://matchplane:secret@db/matchplane?sslmode=disable".to_owned();
        config.valkey_url = "redis://valkey:6379/".to_owned();
        config.payment_callback_origin.clear();

        let messages = config.validation_messages();

        assert!(
            messages
                .iter()
                .any(|message| message.contains("MATCHPLANE_REQUIRE_TLS"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("PostgreSQL"))
        );
        assert!(messages.iter().any(|message| message.contains("Valkey")));
        assert!(
            messages
                .iter()
                .any(|message| message.contains("MATCHPLANE_PAYMENT_CALLBACK_ORIGIN"))
        );
    }
}
