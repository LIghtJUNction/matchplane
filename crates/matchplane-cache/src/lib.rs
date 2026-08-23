//! Rebuildable Valkey market-data projections.

use std::{fs::File, io::BufReader, path::Path};

use fred::rustls::{ClientConfig, RootCertStore, crypto::ring};
use fred::{
    clients::Client,
    interfaces::{ClientLike, KeysInterface, LuaInterface},
    types::{
        Builder,
        config::{Config, TlsConnector},
    },
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// One exact aggregate order-book level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedLevel {
    /// Exact integer price text.
    pub price: String,
    /// Exact integer aggregate quantity text.
    pub quantity: String,
}

/// Rebuildable market-data response stored alongside Valkey ZSET indexes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedBook {
    /// Market ID string.
    pub market_id: String,
    /// Last contiguous command sequence.
    pub sequence: u64,
    /// Bids in highest-price-first order.
    pub bids: Vec<CachedLevel>,
    /// Asks in lowest-price-first order.
    pub asks: Vec<CachedLevel>,
    /// Engine state checksum in lowercase hexadecimal.
    pub state_hash: String,
}

/// Atomic projection outcome for one shard sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionOutcome {
    /// The incoming delta advanced the projection by one sequence.
    Applied,
    /// The event was already present and required no change.
    Duplicate,
    /// The incoming sequence skipped at least one event and must trigger rebuild.
    Gap,
}

/// Valkey client and sequence-guarded book projector.
#[derive(Clone)]
pub struct ValkeyCache {
    client: Client,
}

impl std::fmt::Debug for ValkeyCache {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ValkeyCache")
            .finish_non_exhaustive()
    }
}

/// Valkey connection or command failure.
#[derive(Debug, Error)]
pub enum CacheError {
    /// Valkey protocol client failure.
    #[error("Valkey operation failed: {0}")]
    Valkey(#[from] fred::error::Error),
    /// The configured Valkey TLS CA bundle could not be read.
    #[error("Valkey TLS CA bundle could not be read: {0}")]
    TlsCertificate(#[from] std::io::Error),
    /// The configured TLS trust bundle was empty or contained an invalid certificate.
    #[error("Valkey TLS configuration is invalid: {0}")]
    TlsConfiguration(String),
    /// Projection script returned an unknown code.
    #[error("Valkey projection returned unexpected code {0}")]
    UnexpectedProjectionCode(i64),
    /// Rate-limit script returned an unknown code.
    #[error("Valkey rate limiter returned unexpected code {0}")]
    UnexpectedRateLimitCode(i64),
    /// Rate-limit arguments were outside the supported bounds.
    #[error("Valkey rate limiter received invalid parameters")]
    InvalidRateLimitParameters,
    /// Rate-limit key was empty, too long, or contained unsupported bytes.
    #[error("Valkey rate limiter received an invalid key")]
    InvalidRateLimitKey,
    /// Cached JSON is malformed or could not be encoded.
    #[error("Valkey projection JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

fn install_default_crypto_provider() {
    let _ = ring::default_provider().install_default();
}

fn tls_client_config(path: &Path) -> Result<ClientConfig, CacheError> {
    install_default_crypto_provider();
    let mut reader = BufReader::new(File::open(path)?);
    let certificates = rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>()?;
    if certificates.is_empty() {
        return Err(CacheError::TlsConfiguration(
            "CA bundle contains no certificates".to_owned(),
        ));
    }

    let mut roots = RootCertStore::empty();
    for certificate in certificates {
        roots
            .add(certificate)
            .map_err(|error| CacheError::TlsConfiguration(error.to_string()))?;
    }
    Ok(ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth())
}

impl ValkeyCache {
    /// Opens an asynchronous Valkey connection manager.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] when the URL or connection is invalid.
    pub async fn connect(url: &str) -> Result<Self, CacheError> {
        Self::connect_with_ca(url, None).await
    }

    /// Opens an asynchronous Valkey connection manager with an optional private CA bundle.
    ///
    /// `rediss://` URLs use Fred's Rustls transport. When `ca_file` is provided, the certificate
    /// bundle is used as the exclusive trust anchor for that connection; otherwise Fred uses the
    /// operating-system trust store. Plain `redis://` URLs remain supported for development and
    /// test profiles because that URI scheme is part of the RESP ecosystem; production
    /// configuration rejects plaintext before this method is called.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] when the URL, CA bundle, or connection is invalid.
    pub async fn connect_with_ca(url: &str, ca_file: Option<&Path>) -> Result<Self, CacheError> {
        let mut config = Config::from_url(url)?;
        if let Some(path) = ca_file.filter(|path| !path.as_os_str().is_empty()) {
            config.tls = Some(TlsConnector::from(tls_client_config(path)?).into());
        }
        let client = Builder::from_config(config).build()?;
        client.init().await?;
        Ok(Self { client })
    }

    /// Pings Valkey.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] when Valkey is unavailable.
    pub async fn ping(&mut self) -> Result<(), CacheError> {
        let _: String = self.client.ping(None).await?;
        Ok(())
    }

    /// Atomically consumes one fixed-window rate-limit token.
    ///
    /// The counter and its expiry are updated in one Valkey script, so concurrent gateway
    /// instances cannot race past the limit. Callers should use a bounded, namespaced key; this
    /// method additionally rejects control characters and oversized keys to keep the keyspace
    /// predictable.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] when the key or limits are invalid, Valkey is unavailable, or the
    /// script returns an unknown result.
    pub async fn consume_fixed_window(
        &mut self,
        key: &str,
        limit: u32,
        window_secs: u32,
    ) -> Result<bool, CacheError> {
        if key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b":-_".contains(&byte))
        {
            return Err(CacheError::InvalidRateLimitKey);
        }
        if limit == 0 || window_secs == 0 {
            return Err(CacheError::InvalidRateLimitParameters);
        }

        const LUA: &str = r#"
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
if limit == nil or window == nil or limit <= 0 or window <= 0 then return -2 end
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then redis.call('EXPIRE', KEYS[1], window) end
if count <= limit then return 1 end
return 0
"#;
        let code: i64 = self
            .client
            .eval(
                LUA,
                vec![key],
                vec![limit.to_string(), window_secs.to_string()],
            )
            .await?;
        match code {
            1 => Ok(true),
            0 => Ok(false),
            -2 => Err(CacheError::InvalidRateLimitParameters),
            other => Err(CacheError::UnexpectedRateLimitCode(other)),
        }
    }

    /// Atomically replaces one derived book when its command sequence is contiguous.
    ///
    /// Exact price text is left-padded and indexed as a zero-score lexicographic ZSET member. This
    /// avoids converting money into IEEE-754 scores while still satisfying low-latency ZSET reads.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] for Valkey protocol failures or invalid script results.
    pub async fn apply_book(&mut self, book: &CachedBook) -> Result<ProjectionOutcome, CacheError> {
        const LUA: &str = r#"
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local incoming = tonumber(ARGV[1])
if incoming <= current then return 0 end
if incoming ~= current + 1 then return -1 end
local book = cjson.decode(ARGV[2])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
for _, level in ipairs(book.bids) do
  if string.len(level.price) > 38 or string.match(level.price, '^%d+$') == nil then return -2 end
  local member = string.rep('0', 38 - string.len(level.price)) .. level.price
  redis.call('ZADD', KEYS[2], 0, member)
  redis.call('HSET', KEYS[3], member, level.quantity)
end
for _, level in ipairs(book.asks) do
  if string.len(level.price) > 38 or string.match(level.price, '^%d+$') == nil then return -2 end
  local member = string.rep('0', 38 - string.len(level.price)) .. level.price
  redis.call('ZADD', KEYS[4], 0, member)
  redis.call('HSET', KEYS[5], member, level.quantity)
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[6], ARGV[2])
return 1
"#;
        let prefix = format!("mp:book:{}", book.market_id);
        let sequence_key = format!("{prefix}:sequence");
        let bid_prices_key = format!("{prefix}:bid:prices");
        let bid_quantities_key = format!("{prefix}:bid:quantities");
        let ask_prices_key = format!("{prefix}:ask:prices");
        let ask_quantities_key = format!("{prefix}:ask:quantities");
        let json_key = format!("{prefix}:json");
        let json = serde_json::to_string(book)?;
        let code: i64 = self
            .client
            .eval(
                LUA,
                vec![
                    sequence_key,
                    bid_prices_key,
                    bid_quantities_key,
                    ask_prices_key,
                    ask_quantities_key,
                    json_key,
                ],
                vec![book.sequence.to_string(), json],
            )
            .await?;
        match code {
            1 => Ok(ProjectionOutcome::Applied),
            0 => Ok(ProjectionOutcome::Duplicate),
            -1 => Ok(ProjectionOutcome::Gap),
            -2 => Err(CacheError::UnexpectedProjectionCode(-2)),
            other => Err(CacheError::UnexpectedProjectionCode(other)),
        }
    }

    /// Reads the exact JSON projection used by the HTTP query path.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] if Valkey is unavailable or stored JSON is corrupt.
    pub async fn book(&mut self, market_id: &str) -> Result<Option<CachedBook>, CacheError> {
        let key = format!("mp:book:{market_id}:json");
        let value: Option<String> = self.client.get(key).await?;
        value
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(CacheError::from)
    }
}

#[cfg(test)]
mod tests {
    use fred::rustls::crypto::CryptoProvider;

    use super::*;

    #[test]
    fn installs_ring_as_the_process_crypto_provider() {
        install_default_crypto_provider();

        assert!(CryptoProvider::get_default().is_some());
    }
}
