#![forbid(unsafe_code)]

//! A one-time OAuth authorization-code bridge backed by `oauth-axum`.
//!
//! The bridge owns provider PKCE state and token exchange, but deliberately
//! does not create a MatchPlane browser session. The web authentication layer
//! remains the authority for users, sessions, organization membership, and
//! login cookies after it verifies the bridge result.

pub mod provider;

use std::sync::Arc;

use async_trait::async_trait;
use oauth_axum::{OAuthClient, StateAuth, providers::google::GoogleProvider};
use secrecy::{ExposeSecret, SecretString};
use thiserror::Error;
use time::{Duration, OffsetDateTime};

/// Google OAuth client configuration owned by the deployment secret manager.
#[derive(Clone, Debug)]
pub struct GoogleOAuthConfig {
    client_id: String,
    client_secret: SecretString,
    redirect_url: String,
    scopes: Vec<String>,
}

impl GoogleOAuthConfig {
    /// Creates a Google OAuth configuration with deployment-owned credentials.
    ///
    /// # Errors
    ///
    /// Returns [`OAuthBridgeError`] when a required value is empty or the
    /// callback URL is not an absolute HTTPS URL.
    pub fn new(
        client_id: impl Into<String>,
        client_secret: SecretString,
        redirect_url: impl Into<String>,
        scopes: impl IntoIterator<Item = String>,
    ) -> Result<Self, OAuthBridgeError> {
        let client_id = client_id.into();
        let redirect_url = redirect_url.into();
        if client_id.trim().is_empty() || client_secret.expose_secret().trim().is_empty() {
            return Err(OAuthBridgeError::MissingConfiguration);
        }
        if !is_https_url(&redirect_url) {
            return Err(OAuthBridgeError::InvalidRedirectUrl);
        }
        let scopes = scopes
            .into_iter()
            .filter(|scope| !scope.trim().is_empty())
            .collect::<Vec<_>>();
        if scopes.is_empty() {
            return Err(OAuthBridgeError::MissingScopes);
        }
        Ok(Self {
            client_id,
            client_secret,
            redirect_url,
            scopes,
        })
    }
}

/// A provider authorization URL ready for a top-level browser redirect.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OAuthAuthorization {
    /// The OAuth provider authorization URL containing PKCE and CSRF state.
    pub url: String,
    /// The bounded expiry for the corresponding pending state.
    pub expires_at: OffsetDateTime,
}

/// The secret pending state that a durable store must consume exactly once.
#[derive(Clone, Debug)]
pub struct PendingOAuthState {
    /// Provider name for the stored state.
    pub provider: &'static str,
    /// CSRF state returned by the OAuth provider.
    pub state: String,
    /// OAuth PKCE verifier. This value must never be sent to the browser.
    pub verifier: SecretString,
    /// State expiry after which the callback must be rejected.
    pub expires_at: OffsetDateTime,
}

/// A deployment-owned, atomic store for short-lived OAuth state.
#[async_trait]
pub trait OAuthStateStore: Send + Sync {
    /// Stores a newly-issued OAuth state. Existing entries for the same state must not be overwritten.
    async fn put(&self, state: PendingOAuthState) -> Result<(), OAuthBridgeError>;

    /// Atomically removes and returns one OAuth state, making each callback one-time.
    async fn take(&self, state: &str) -> Result<Option<PendingOAuthState>, OAuthBridgeError>;
}

/// The short-lived external access token returned after a verified callback.
#[derive(Debug)]
pub struct OAuthAccessToken {
    /// Provider identifier associated with the token.
    pub provider: &'static str,
    /// Provider token. Callers must keep it server-side and exchange it for profile data immediately.
    pub access_token: SecretString,
}

/// Runs Google OAuth PKCE through `oauth-axum` with a caller-supplied durable state store.
pub struct GoogleOAuthBridge {
    config: GoogleOAuthConfig,
    state_store: Arc<dyn OAuthStateStore>,
    state_ttl: Duration,
}

impl std::fmt::Debug for GoogleOAuthBridge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GoogleOAuthBridge")
            .field("config", &self.config)
            .field("state_ttl", &self.state_ttl)
            .finish_non_exhaustive()
    }
}

impl GoogleOAuthBridge {
    /// Creates a bridge with a five-minute callback state lifetime.
    #[must_use]
    pub fn new(config: GoogleOAuthConfig, state_store: Arc<dyn OAuthStateStore>) -> Self {
        Self {
            config,
            state_store,
            state_ttl: Duration::minutes(5),
        }
    }

    /// Builds and persists one PKCE authorization request.
    ///
    /// # Errors
    ///
    /// Returns [`OAuthBridgeError`] when `oauth-axum` cannot build the provider URL
    /// or the deployment state store rejects the pending state.
    pub async fn begin(&self, now: OffsetDateTime) -> Result<OAuthAuthorization, OAuthBridgeError> {
        let provider = self.provider();
        let generated = provider
            .generate_url(self.config.scopes.clone(), |_| async {})
            .await
            .map_err(|_| OAuthBridgeError::AuthorizationUrlGenerationFailed)?;
        let state = generated
            .get_state()
            .ok_or(OAuthBridgeError::MissingGeneratedState)?;
        let expires_at = now + self.state_ttl;
        self.state_store
            .put(pending_state(&state, expires_at))
            .await?;
        let url = state
            .url_generated
            .ok_or(OAuthBridgeError::MissingGeneratedState)?;
        Ok(OAuthAuthorization { url, expires_at })
    }

    /// Consumes a callback state once and exchanges an authorization code for a provider token.
    ///
    /// # Errors
    ///
    /// Returns [`OAuthBridgeError`] if the callback is expired, replayed, or rejected by the provider.
    pub async fn complete(
        &self,
        authorization_code: &str,
        state: &str,
        now: OffsetDateTime,
    ) -> Result<OAuthAccessToken, OAuthBridgeError> {
        if authorization_code.trim().is_empty() || state.trim().is_empty() {
            return Err(OAuthBridgeError::InvalidCallback);
        }
        let pending = self
            .state_store
            .take(state)
            .await?
            .ok_or(OAuthBridgeError::StateNotFound)?;
        if pending.provider != "google" || pending.state != state {
            return Err(OAuthBridgeError::StateNotFound);
        }
        if now > pending.expires_at {
            return Err(OAuthBridgeError::StateExpired);
        }
        let token = self
            .provider()
            .generate_token(
                authorization_code.to_owned(),
                pending.verifier.expose_secret().to_owned(),
            )
            .await
            .map_err(|_| OAuthBridgeError::TokenExchangeFailed)?;
        Ok(OAuthAccessToken {
            provider: "google",
            access_token: SecretString::from(token),
        })
    }

    fn provider(&self) -> oauth_axum::CustomProvider {
        GoogleProvider::new(
            self.config.client_id.clone(),
            self.config.client_secret.expose_secret().to_owned(),
            self.config.redirect_url.clone(),
        )
    }
}

/// OAuth bridge failures safe to surface without exposing provider credentials or tokens.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum OAuthBridgeError {
    /// Client credentials are missing or blank.
    #[error("OAuth client configuration is incomplete")]
    MissingConfiguration,
    /// The provider callback must use a deployment-owned HTTPS URL.
    #[error("OAuth redirect URL must be an absolute HTTPS URL")]
    InvalidRedirectUrl,
    /// At least one provider scope is required.
    #[error("OAuth scopes are required")]
    MissingScopes,
    /// The provider library did not return the expected state or authorization URL.
    #[error("OAuth authorization URL could not be generated")]
    AuthorizationUrlGenerationFailed,
    /// The provider library generated an incomplete state object.
    #[error("OAuth generated state is incomplete")]
    MissingGeneratedState,
    /// Durable state storage returned an internal failure.
    #[error("OAuth state storage failed")]
    StateStorageFailed,
    /// The callback had no usable authorization code or state.
    #[error("OAuth callback is invalid")]
    InvalidCallback,
    /// The callback state is absent or already consumed.
    #[error("OAuth state was not found or was already consumed")]
    StateNotFound,
    /// The callback arrived after the bounded state lifetime.
    #[error("OAuth state has expired")]
    StateExpired,
    /// The upstream provider rejected the authorization code exchange.
    #[error("OAuth provider token exchange failed")]
    TokenExchangeFailed,
}

fn pending_state(state: &StateAuth, expires_at: OffsetDateTime) -> PendingOAuthState {
    PendingOAuthState {
        provider: "google",
        state: state.state.clone(),
        verifier: SecretString::from(state.verifier.clone()),
        expires_at,
    }
}

fn is_https_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct MemoryStateStore {
        states: Mutex<BTreeMap<String, PendingOAuthState>>,
    }

    #[async_trait]
    impl OAuthStateStore for MemoryStateStore {
        async fn put(&self, state: PendingOAuthState) -> Result<(), OAuthBridgeError> {
            let mut states = self
                .states
                .lock()
                .map_err(|_| OAuthBridgeError::StateStorageFailed)?;
            if states.contains_key(&state.state) {
                return Err(OAuthBridgeError::StateStorageFailed);
            }
            states.insert(state.state.clone(), state);
            Ok(())
        }

        async fn take(&self, state: &str) -> Result<Option<PendingOAuthState>, OAuthBridgeError> {
            Ok(self
                .states
                .lock()
                .map_err(|_| OAuthBridgeError::StateStorageFailed)?
                .remove(state))
        }
    }

    #[tokio::test]
    async fn begin_should_store_a_one_time_google_pkce_state() {
        let state_store = Arc::new(MemoryStateStore::default());
        let bridge = GoogleOAuthBridge::new(
            GoogleOAuthConfig::new(
                "google-client-id",
                SecretString::from("google-client-secret"),
                "https://matchplane.example/oauth/google/callback",
                [
                    "openid".to_owned(),
                    "profile".to_owned(),
                    "email".to_owned(),
                ],
            )
            .expect("fixture configuration should be valid"),
            state_store.clone(),
        );
        let now = OffsetDateTime::now_utc();
        let authorization = bridge
            .begin(now)
            .await
            .expect("authorization URL should be generated");

        assert!(
            authorization
                .url
                .starts_with("https://accounts.google.com/o/oauth2/v2/auth")
        );
        let url = url::Url::parse(&authorization.url).expect("generated URL should be valid");
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .expect("authorization URL should include state");
        let pending = state_store
            .take(&state)
            .await
            .expect("memory state read should work");

        assert!(pending.is_some());
        assert!(
            state_store
                .take(&state)
                .await
                .expect("second memory state read should work")
                .is_none()
        );
    }
}
