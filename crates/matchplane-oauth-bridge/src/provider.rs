#![forbid(unsafe_code)]

use secrecy::SecretString;

/// Provider independent OAuth configuration.
///
/// The web/admin layer can store these values and select a runtime adapter
/// without adding a new database schema for every external identity provider.
#[derive(Clone, Debug)]
pub struct OAuthProviderConfig {
    pub name: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: SecretString,
    pub scopes: Vec<String>,
    pub enabled: bool,
}

impl OAuthProviderConfig {
    pub fn validate(&self) -> Result<(), OAuthProviderConfigError> {
        if self.name.trim().is_empty()
            || self.authorization_endpoint.trim().is_empty()
            || self.token_endpoint.trim().is_empty()
            || self.client_id.trim().is_empty()
            || self.client_secret.expose_secret().trim().is_empty()
        {
            return Err(OAuthProviderConfigError::MissingField);
        }
        if self.scopes.is_empty() {
            return Err(OAuthProviderConfigError::MissingScopes);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OAuthProviderConfigError {
    MissingField,
    MissingScopes,
}
