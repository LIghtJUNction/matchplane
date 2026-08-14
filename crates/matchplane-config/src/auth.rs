//! Shared bearer-token authentication for internal operator APIs.

use std::{env, fs};

use crate::Environment;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;

/// Errors raised while loading an operator bearer token.
#[derive(Debug, Error)]
pub enum AuthError {
    /// The token file or environment value could not be read.
    #[error("operator authentication configuration is invalid: {0}")]
    Configuration(String),
}

/// A one-way hashed bearer token. The clear-text token is never retained.
#[derive(Clone)]
pub struct BearerToken {
    token_hash: [u8; 32],
}

impl std::fmt::Debug for BearerToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BearerToken([REDACTED])")
    }
}

impl BearerToken {
    /// Loads a token from a restricted file in production, or an explicit environment variable
    /// in development and test environments.
    pub fn load(
        environment: Environment,
        file_variable: &str,
        inline_variable: &str,
        development_default: &str,
    ) -> Result<Self, AuthError> {
        let token = if let Ok(path) = env::var(file_variable) {
            let path = path.trim();
            if path.is_empty() {
                return Err(AuthError::Configuration(format!(
                    "{file_variable} cannot be empty"
                )));
            }
            fs::read_to_string(path).map_err(|error| {
                AuthError::Configuration(format!("token file cannot be read: {error}"))
            })?
        } else if environment != Environment::Production {
            env::var(inline_variable).unwrap_or_else(|_| development_default.to_owned())
        } else {
            return Err(AuthError::Configuration(format!(
                "production requires {file_variable}"
            )));
        };

        Self::from_token(token.trim(), inline_variable)
    }

    /// Creates an authentication verifier from a clear-text token during startup.
    fn from_token(token: &str, variable_name: &str) -> Result<Self, AuthError> {
        if token.len() < 24 {
            return Err(AuthError::Configuration(format!(
                "{variable_name} must contain at least 24 bytes"
            )));
        }
        if token.len() > 4096 || token.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(AuthError::Configuration(format!(
                "{variable_name} contains invalid characters or is too long"
            )));
        }
        Ok(Self {
            token_hash: Sha256::digest(token.as_bytes()).into(),
        })
    }

    /// Verifies an HTTP `Authorization: Bearer ...` value in constant time.
    #[must_use]
    pub fn verify_bearer(&self, authorization: Option<&str>) -> bool {
        let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
            return false;
        };
        let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        bool::from(self.token_hash.ct_eq(&candidate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_token_requires_a_long_secret() {
        let error =
            BearerToken::from_token("too-short", "TOKEN").expect_err("short token must fail");
        assert!(error.to_string().contains("at least 24 bytes"));
    }

    #[test]
    fn bearer_token_accepts_only_the_exact_bearer_value() {
        let token = BearerToken::from_token("operator-token-with-more-than-24-bytes", "TOKEN")
            .expect("test token should load");

        assert!(token.verify_bearer(Some("Bearer operator-token-with-more-than-24-bytes")));
        assert!(!token.verify_bearer(Some("operator-token-with-more-than-24-bytes")));
        assert!(!token.verify_bearer(Some("Bearer operator-token-with-more-than-24-byte")));
    }
}
