//! Validated configuration shared by MatchPlane service binaries.

use std::{net::SocketAddr, str::FromStr};

use config::{Config, Environment as EnvironmentSource};
use matchplane_domain::FederationNodeId;
use serde::Deserialize;
use thiserror::Error;

pub mod auth;

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
    /// Stable federation node UUID.
    pub node_id: String,
    /// HTTP listen address.
    pub http_addr: String,
    /// gRPC listen address.
    pub grpc_addr: String,
    /// PostgreSQL connection URL.
    pub database_url: String,
    /// Comma-separated Kafka bootstrap servers.
    pub kafka_brokers: String,
    /// Valkey connection URL.
    pub valkey_url: String,
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
    /// Stable federation node ID.
    pub node_id: FederationNodeId,
    /// Parsed HTTP listen address.
    pub http_addr: SocketAddr,
    /// Parsed gRPC listen address.
    pub grpc_addr: SocketAddr,
    /// PostgreSQL connection URL.
    pub database_url: String,
    /// Kafka bootstrap servers.
    pub kafka_brokers: String,
    /// Valkey connection URL.
    pub valkey_url: String,
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
        let config = Config::builder()
            .set_default("environment", "development")?
            .set_default("node_id", "00000000-0000-7000-8000-00000000000a")?
            .set_default("http_addr", "0.0.0.0:8080")?
            .set_default("grpc_addr", "0.0.0.0:50051")?
            .set_default(
                "database_url",
                "postgres://matchplane:matchplane_dev_only@localhost:5432/matchplane",
            )?
            .set_default("kafka_brokers", "localhost:9092")?
            .set_default("valkey_url", "redis://localhost:6379/")?
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
        config.validate()
    }

    /// Parses and applies production safety checks.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] for malformed or insecure values.
    pub fn validate(self) -> Result<ValidatedConfig, ConfigError> {
        for (field, value) in [
            ("MATCHPLANE_DATABASE_URL", self.database_url.as_str()),
            ("MATCHPLANE_KAFKA_BROKERS", self.kafka_brokers.as_str()),
            ("MATCHPLANE_VALKEY_URL", self.valkey_url.as_str()),
            ("MATCHPLANE_OTLP_ENDPOINT", self.otlp_endpoint.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ConfigError::Empty(field));
            }
        }

        if self.environment == Environment::Production {
            if !self.require_tls {
                return Err(ConfigError::InsecureProduction(
                    "MATCHPLANE_REQUIRE_TLS must be true",
                ));
            }
            if self.database_url.contains("matchplane_dev_only") {
                return Err(ConfigError::InsecureProduction(
                    "development database password is forbidden",
                ));
            }
            if self.node_id == "00000000-0000-7000-8000-00000000000a" {
                return Err(ConfigError::InsecureProduction(
                    "MATCHPLANE_NODE_ID must be unique and cannot use the development default",
                ));
            }
            if self.database_url.contains("CHANGE_ME") || self.valkey_url.contains("CHANGE_ME") {
                return Err(ConfigError::InsecureProduction(
                    "database and Valkey credentials must be replaced",
                ));
            }
            if self.valkey_url.starts_with("redis://") {
                return Err(ConfigError::InsecureProduction(
                    "Valkey must use a TLS endpoint",
                ));
            }
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
                    return Err(ConfigError::Empty(field));
                }
            }
            if !self.otlp_endpoint.starts_with("https://") {
                return Err(ConfigError::InsecureProduction(
                    "MATCHPLANE_OTLP_ENDPOINT must use HTTPS",
                ));
            }
            if self.log_filter.contains("debug") || self.log_filter.contains("trace") {
                return Err(ConfigError::InsecureProduction(
                    "production log filter must not enable debug or trace logging",
                ));
            }
            validate_payment_callback_origin(&self.payment_callback_origin)?;
        }

        Ok(ValidatedConfig {
            environment: self.environment,
            node_id: FederationNodeId::from_str(&self.node_id)?,
            http_addr: self
                .http_addr
                .parse()
                .map_err(|source| ConfigError::SocketAddress {
                    field: "MATCHPLANE_HTTP_ADDR",
                    source,
                })?,
            grpc_addr: self
                .grpc_addr
                .parse()
                .map_err(|source| ConfigError::SocketAddress {
                    field: "MATCHPLANE_GRPC_ADDR",
                    source,
                })?,
            database_url: self.database_url,
            kafka_brokers: self.kafka_brokers,
            valkey_url: self.valkey_url,
            log_filter: self.log_filter,
            otlp_endpoint: self.otlp_endpoint,
            require_tls: self.require_tls,
            tls_certificate_path: self.tls_certificate_path,
            tls_private_key_path: self.tls_private_key_path,
            tls_client_ca_path: self.tls_client_ca_path,
            payment_callback_origin: self.payment_callback_origin,
        })
    }
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
            node_id: FederationNodeId::new().to_string(),
            http_addr: "127.0.0.1:8080".to_owned(),
            grpc_addr: "127.0.0.1:50051".to_owned(),
            database_url: "postgres://matchplane:secret@db/matchplane".to_owned(),
            kafka_brokers: "kafka:9093".to_owned(),
            valkey_url: "rediss://valkey:6380/".to_owned(),
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
}
