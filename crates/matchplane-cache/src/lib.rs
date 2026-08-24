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
    /// The incoming sequence skipped prior state or the canonical cache pair is incomplete.
    Gap,
    /// The same sequence already exists with a different canonical state hash.
    Conflict,
}

/// Outcome of atomically repairing a projection from its durable source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionRepairOutcome {
    /// The durable full projection replaced missing or older cache state.
    Repaired,
    /// A complete projection at the same or a newer sequence was already present.
    Current,
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
    /// A full projection contained malformed exact values.
    #[error("Valkey projection contains invalid exact values")]
    InvalidProjectionData,
    /// The cached projection sequence marker was malformed.
    #[error("Valkey projection sequence state is corrupt")]
    InvalidProjectionSequence,
    /// The canonical projection sequence/JSON key pair was only partially present.
    #[error("Valkey projection state is incomplete")]
    IncompleteProjection,
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
    /// A missing sequence/JSON pair is reported as a gap instead of accepting a false duplicate.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] for Valkey protocol failures or invalid projection data.
    pub async fn apply_book(&mut self, book: &CachedBook) -> Result<ProjectionOutcome, CacheError> {
        match self.project_book(book, false).await? {
            1 => Ok(ProjectionOutcome::Applied),
            0 => Ok(ProjectionOutcome::Duplicate),
            -1 => Ok(ProjectionOutcome::Gap),
            -4 => Ok(ProjectionOutcome::Conflict),
            other => Err(CacheError::UnexpectedProjectionCode(other)),
        }
    }

    /// Atomically installs a full PostgreSQL-authoritative projection without requiring replay.
    ///
    /// A complete projection at the same or a newer sequence wins, fencing delayed repairers. An
    /// incomplete sequence/JSON pair is replaced even when its sequence marker is newer.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] for Valkey protocol failures or invalid projection data.
    pub async fn repair_book(
        &mut self,
        book: &CachedBook,
    ) -> Result<ProjectionRepairOutcome, CacheError> {
        match self.project_book(book, true).await? {
            1 => Ok(ProjectionRepairOutcome::Repaired),
            0 => Ok(ProjectionRepairOutcome::Current),
            other => Err(CacheError::UnexpectedProjectionCode(other)),
        }
    }

    async fn project_book(&mut self, book: &CachedBook, repair: bool) -> Result<i64, CacheError> {
        const LUA: &str = r#"
local function normalize_decimal(value)
  if type(value) ~= 'string' or string.match(value, '^%d+$') == nil then return nil end
  local normalized = string.gsub(value, '^0+', '')
  if normalized == '' then return '0' end
  return normalized
end
local function compare_decimal(left, right)
  if string.len(left) < string.len(right) then return -1 end
  if string.len(left) > string.len(right) then return 1 end
  if left < right then return -1 end
  if left > right then return 1 end
  return 0
end
local function increment_decimal(value)
  local result = {}
  local carry = 1
  for index = string.len(value), 1, -1 do
    local digit = string.byte(value, index) - 48 + carry
    if digit >= 10 then digit = digit - 10 else carry = 0 end
    table.insert(result, 1, string.char(48 + digit))
  end
  if carry == 1 then table.insert(result, 1, '1') end
  return table.concat(result)
end
local function valid_exact(value)
  if type(value) ~= 'string' or string.len(value) == 0 or string.len(value) > 38 then return false end
  if string.match(value, '^%d+$') == nil or value == '0' then return false end
  if string.len(value) > 1 and string.sub(value, 1, 1) == '0' then return false end
  return true
end
local function valid_side(side, descending)
  local previous = nil
  for _, level in ipairs(side) do
    if type(level) ~= 'table' then return false end
    if not valid_exact(level.price) or not valid_exact(level.quantity) then return false end
    if previous ~= nil then
      local comparison = compare_decimal(level.price, previous)
      if descending and comparison >= 0 then return false end
      if not descending and comparison <= 0 then return false end
    end
    previous = level.price
  end
  return true
end
local function valid_book(book)
  if type(book) ~= 'table' or type(book.market_id) ~= 'string' or book.market_id == '' then return false end
  if type(book.bids) ~= 'table' or type(book.asks) ~= 'table' then return false end
  if type(book.state_hash) ~= 'string' or string.len(book.state_hash) ~= 64 or string.match(book.state_hash, '^[0-9a-f]+$') == nil then return false end
  return valid_side(book.bids, true) and valid_side(book.asks, false)
end
local sequence_value = redis.call('GET', KEYS[1])
local existing_json = redis.call('GET', KEYS[6])
local current = normalize_decimal(sequence_value or '0')
local incoming = normalize_decimal(ARGV[1])
local repair = ARGV[3] == '1'
if incoming == nil then return -3 end
if current == nil then
  if not repair then return -3 end
  current = '0'
end
local decoded, book = pcall(cjson.decode, ARGV[2])
local book_sequence = normalize_decimal(string.match(ARGV[2], '"sequence"%s*:%s*(%d+)'))
if not decoded or not valid_book(book) or book_sequence ~= incoming then return -2 end
local complete = sequence_value ~= false and existing_json ~= false
local comparison = compare_decimal(incoming, current)
if complete and comparison < 0 then return 0 end
if complete and comparison == 0 then
  local existing_decoded, existing_book = pcall(cjson.decode, existing_json)
  local existing_sequence = normalize_decimal(string.match(existing_json, '"sequence"%s*:%s*(%d+)'))
  local same_identity = existing_decoded and valid_book(existing_book) and existing_sequence == current and existing_book.market_id == book.market_id
  if same_identity and existing_book.state_hash == book.state_hash then return 0 end
  if not repair then return -4 end
end
if not repair and incoming ~= increment_decimal(current) then return -1 end
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4], KEYS[5])
for _, level in ipairs(book.bids) do
  local member = string.rep('0', 38 - string.len(level.price)) .. level.price
  redis.call('ZADD', KEYS[2], 0, member)
  redis.call('HSET', KEYS[3], member, level.quantity)
end
for _, level in ipairs(book.asks) do
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
                vec![
                    book.sequence.to_string(),
                    json,
                    if repair { "1" } else { "0" }.to_owned(),
                ],
            )
            .await?;
        match code {
            -2 => Err(CacheError::InvalidProjectionData),
            -3 => Err(CacheError::InvalidProjectionSequence),
            other => Ok(other),
        }
    }

    /// Reads and validates the canonical sequence/JSON projection pair used by HTTP queries.
    ///
    /// # Errors
    ///
    /// Returns [`CacheError`] if Valkey is unavailable, one canonical key is missing, or the stored
    /// projection is malformed or belongs to a different market/sequence.
    pub async fn book(&mut self, market_id: &str) -> Result<Option<CachedBook>, CacheError> {
        let prefix = format!("mp:book:{market_id}");
        let values: Vec<Option<String>> = self
            .client
            .mget(vec![format!("{prefix}:sequence"), format!("{prefix}:json")])
            .await?;
        let (sequence, json) = match values.as_slice() {
            [None, None] => return Ok(None),
            [Some(sequence), Some(json)] => (sequence, json),
            _ => return Err(CacheError::IncompleteProjection),
        };
        let sequence = sequence
            .parse::<u64>()
            .map_err(|_| CacheError::InvalidProjectionSequence)?;
        let book: CachedBook = serde_json::from_str(json)?;
        let valid_hash = book.state_hash.len() == 64
            && book
                .state_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        let valid_levels = valid_book_side(&book.bids, true) && valid_book_side(&book.asks, false);
        if book.market_id != market_id || book.sequence != sequence || !valid_hash || !valid_levels
        {
            return Err(CacheError::InvalidProjectionData);
        }
        Ok(Some(book))
    }
}

fn valid_exact_value(value: &str) -> Option<i128> {
    if value.is_empty()
        || value.len() > 38
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse::<i128>().ok().filter(|number| *number > 0)
}

fn valid_book_side(levels: &[CachedLevel], descending: bool) -> bool {
    let mut previous_price = None;
    for level in levels {
        let Some(price) = valid_exact_value(&level.price) else {
            return false;
        };
        if valid_exact_value(&level.quantity).is_none()
            || previous_price.is_some_and(|previous| {
                if descending {
                    price >= previous
                } else {
                    price <= previous
                }
            })
        {
            return false;
        }
        previous_price = Some(price);
    }
    true
}

#[cfg(test)]
mod tests {
    use fred::{
        interfaces::{KeysInterface, LuaInterface},
        rustls::crypto::CryptoProvider,
    };
    use uuid::Uuid;

    use super::*;

    #[test]
    fn installs_ring_as_the_process_crypto_provider() {
        install_default_crypto_provider();

        assert!(CryptoProvider::get_default().is_some());
    }

    #[tokio::test]
    #[ignore = "requires Valkey; CI runs ignored cache tests explicitly"]
    async fn durable_repair_should_seed_gap_and_fence_stale_writers()
    -> Result<(), Box<dyn std::error::Error>> {
        let url = std::env::var("MATCHPLANE_TEST_VALKEY_URL")?;
        let market_id = Uuid::now_v7().to_string();
        let mut cache = ValkeyCache::connect(&url).await?;
        let initial_sequence = 9_007_199_254_740_992;
        let initial_book = test_book(&market_id, initial_sequence, "100");

        assert_eq!(
            cache.apply_book(&initial_book).await?,
            ProjectionOutcome::Gap
        );
        assert_eq!(
            cache.repair_book(&initial_book).await?,
            ProjectionRepairOutcome::Repaired
        );

        let next_book = test_book(&market_id, initial_sequence + 1, "101");
        assert_eq!(
            cache.apply_book(&next_book).await?,
            ProjectionOutcome::Applied
        );
        assert_eq!(
            cache.apply_book(&next_book).await?,
            ProjectionOutcome::Duplicate
        );
        let mut forked_book = next_book.clone();
        forked_book.bids[0].quantity = "9".to_owned();
        forked_book.state_hash = "f".repeat(64);
        assert_eq!(
            cache.apply_book(&forked_book).await?,
            ProjectionOutcome::Conflict
        );
        assert_eq!(cache.book(&market_id).await?, Some(next_book.clone()));
        assert_eq!(
            cache.repair_book(&initial_book).await?,
            ProjectionRepairOutcome::Current
        );
        assert_eq!(cache.book(&market_id).await?, Some(next_book.clone()));

        let json_key = format!("mp:book:{market_id}:json");
        let _: i64 = cache.client.del(json_key.clone()).await?;
        assert!(matches!(
            cache.book(&market_id).await,
            Err(CacheError::IncompleteProjection)
        ));
        assert_eq!(cache.apply_book(&next_book).await?, ProjectionOutcome::Gap);
        assert_eq!(
            cache.repair_book(&next_book).await?,
            ProjectionRepairOutcome::Repaired
        );
        assert_eq!(cache.book(&market_id).await?, Some(next_book.clone()));

        let stale_json = serde_json::to_string(&initial_book)?;
        let _: String = cache
            .client
            .eval(
                "return redis.call('SET', KEYS[1], ARGV[1])",
                vec![json_key.clone()],
                vec![stale_json],
            )
            .await?;
        assert!(matches!(
            cache.book(&market_id).await,
            Err(CacheError::InvalidProjectionData)
        ));
        assert_eq!(
            cache.repair_book(&next_book).await?,
            ProjectionRepairOutcome::Repaired
        );

        let _: String = cache
            .client
            .eval(
                "return redis.call('SET', KEYS[1], ARGV[1])",
                vec![json_key],
                vec!["{"],
            )
            .await?;
        assert!(matches!(
            cache.book(&market_id).await,
            Err(CacheError::Json(_))
        ));
        assert_eq!(
            cache.repair_book(&next_book).await?,
            ProjectionRepairOutcome::Repaired
        );
        assert_eq!(cache.book(&market_id).await?, Some(next_book.clone()));

        let sequence_key = format!("mp:book:{market_id}:sequence");
        let _: String = cache
            .client
            .eval(
                "return redis.call('SET', KEYS[1], ARGV[1])",
                vec![sequence_key],
                vec!["corrupt-sequence"],
            )
            .await?;
        assert!(matches!(
            cache.apply_book(&next_book).await,
            Err(CacheError::InvalidProjectionSequence)
        ));
        assert_eq!(
            cache.repair_book(&next_book).await?,
            ProjectionRepairOutcome::Repaired
        );
        assert_eq!(cache.book(&market_id).await?, Some(next_book.clone()));

        let invalid = CachedBook {
            sequence: initial_sequence + 2,
            bids: vec![CachedLevel {
                price: "not-an-integer".to_owned(),
                quantity: "1".to_owned(),
            }],
            ..next_book.clone()
        };
        assert!(matches!(
            cache.apply_book(&invalid).await,
            Err(CacheError::InvalidProjectionData)
        ));
        assert_eq!(cache.book(&market_id).await?, Some(next_book));
        Ok(())
    }

    fn test_book(market_id: &str, sequence: u64, price: &str) -> CachedBook {
        CachedBook {
            market_id: market_id.to_owned(),
            sequence,
            bids: vec![CachedLevel {
                price: price.to_owned(),
                quantity: "2".to_owned(),
            }],
            asks: vec![CachedLevel {
                price: price
                    .parse::<u64>()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .to_string(),
                quantity: "3".to_owned(),
            }],
            state_hash: format!("{sequence:064x}"),
        }
    }
}
