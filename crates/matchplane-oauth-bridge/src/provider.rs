#![forbid(unsafe_code)]

use secrecy::{ExposeSecret, SecretString};
use thiserror::Error;
use url::Url;

/// The endpoint contract accepted by a server-side generic OAuth provider.
#[derive(Clone, Debug)]
pub enum OAuthEndpointContract {
    /// A provider-owned discovery document.
    Discovery {
        /// Absolute provider discovery URL.
        discovery_url: String,
    },
    /// Explicit endpoints for providers without discovery support.
    Explicit {
        /// Absolute authorization endpoint.
        authorization_endpoint: String,
        /// Absolute token endpoint.
        token_endpoint: String,
        /// Absolute user-info endpoint.
        userinfo_endpoint: String,
    },
}

/// Provider-independent OAuth configuration retained only on the server.
#[derive(Clone, Debug)]
pub struct OAuthProviderConfig {
    /// Stable administrator-defined provider identifier.
    pub id: String,
    /// Human-readable provider name.
    pub name: String,
    /// Whether a fully configured provider may be used at runtime.
    pub enabled: bool,
    /// Provider discovery or explicit endpoint contract.
    pub endpoints: OAuthEndpointContract,
    /// OAuth public client identifier.
    pub client_id: String,
    /// Server-only OAuth client secret.
    pub client_secret: SecretString,
    /// Requested OAuth scopes.
    pub scopes: Vec<String>,
}

impl OAuthProviderConfig {
    /// Validates a complete server-only OAuth provider configuration.
    ///
    /// # Errors
    ///
    /// Returns [`OAuthProviderConfigError`] for blank fields, malformed provider
    /// identifiers, incomplete scope data, or endpoints outside HTTPS origins.
    pub fn validate(&self) -> Result<(), OAuthProviderConfigError> {
        if !is_provider_id(&self.id)
            || self.name.trim().is_empty()
            || self.client_id.trim().is_empty()
            || self.client_secret.expose_secret().trim().is_empty()
        {
            return Err(OAuthProviderConfigError::MissingField);
        }
        if self.scopes.is_empty() || self.scopes.iter().any(|scope| scope.trim().is_empty()) {
            return Err(OAuthProviderConfigError::MissingScopes);
        }
        match &self.endpoints {
            OAuthEndpointContract::Discovery { discovery_url } => {
                validate_https_url(discovery_url)?
            }
            OAuthEndpointContract::Explicit {
                authorization_endpoint,
                token_endpoint,
                userinfo_endpoint,
            } => {
                validate_https_url(authorization_endpoint)?;
                validate_https_url(token_endpoint)?;
                validate_https_url(userinfo_endpoint)?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum OAuthProviderConfigError {
    /// Required provider metadata or credentials are blank.
    #[error("OAuth provider configuration is incomplete")]
    MissingField,
    /// At least one non-empty OAuth scope is required.
    #[error("OAuth provider scopes are required")]
    MissingScopes,
    /// A provider endpoint must be an absolute HTTPS URL without credentials or fragments.
    #[error("OAuth provider endpoint must be an absolute HTTPS URL")]
    InvalidEndpoint,
}

fn is_provider_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=128).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'.' | b'_' | b'-')
        })
}

fn validate_https_url(value: &str) -> Result<(), OAuthProviderConfigError> {
    let url = Url::parse(value).map_err(|_| OAuthProviderConfigError::InvalidEndpoint)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(OAuthProviderConfigError::InvalidEndpoint);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;

    use super::{OAuthEndpointContract, OAuthProviderConfig, OAuthProviderConfigError};

    fn configured_provider() -> OAuthProviderConfig {
        OAuthProviderConfig {
            id: "example-oauth".to_owned(),
            name: "Example OAuth".to_owned(),
            enabled: true,
            endpoints: OAuthEndpointContract::Discovery {
                discovery_url: "https://identity.example/.well-known/openid-configuration"
                    .to_owned(),
            },
            client_id: "client-id".to_owned(),
            client_secret: SecretString::from("client-secret"),
            scopes: vec!["openid".to_owned()],
        }
    }

    #[test]
    fn provider_config_accepts_a_complete_discovery_contract() {
        assert!(configured_provider().validate().is_ok());
    }

    #[test]
    fn provider_config_rejects_an_insecure_explicit_endpoint() {
        let mut provider = configured_provider();
        provider.endpoints = OAuthEndpointContract::Explicit {
            authorization_endpoint: "http://identity.example/authorize".to_owned(),
            token_endpoint: "https://identity.example/token".to_owned(),
            userinfo_endpoint: "https://identity.example/userinfo".to_owned(),
        };

        assert_eq!(
            provider.validate(),
            Err(OAuthProviderConfigError::InvalidEndpoint)
        );
    }
}
