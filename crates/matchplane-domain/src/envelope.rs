use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::{
    CausationId, CorrelationId, DomainId, EventId, FederationNodeId, MarketId, ShardId, TenantId,
};

/// A SHA-256 digest of deterministic wire payload bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PayloadHash([u8; 32]);

impl PayloadHash {
    /// Hashes deterministic payload bytes.
    #[must_use]
    pub fn from_bytes(payload: &[u8]) -> Self {
        Self(Sha256::digest(payload).into())
    }

    /// Wraps a digest that was already verified or loaded from durable storage.
    #[must_use]
    pub const fn from_digest(digest: [u8; 32]) -> Self {
        Self(digest)
    }

    /// Returns the raw digest.
    #[must_use]
    pub const fn into_bytes(self) -> [u8; 32] {
        self.0
    }

    /// Returns a lowercase hexadecimal representation.
    #[must_use]
    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }
}

/// Distinguishes independent shard sequence namespaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    /// Durable input commands.
    Command,
    /// Authoritative domain facts.
    DomainEvent,
    /// Rebuildable order-book deltas.
    OrderBookDelta,
    /// Rebuildable market summaries.
    MarketSummary,
    /// Federation control and saga messages.
    Federation,
    /// Node health events.
    NodeHealth,
}

/// Mandatory metadata carried by every command, event, and federation message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope<T> {
    /// Globally unique message ID.
    pub event_id: EventId,
    /// End-to-end request correlation ID.
    pub correlation_id: CorrelationId,
    /// ID of the message that directly caused this message.
    pub causation_id: CausationId,
    /// Node that produced the message.
    pub source_node_id: FederationNodeId,
    /// Tenant authority boundary.
    pub tenant_id: TenantId,
    /// Vertical domain boundary.
    pub domain_id: DomainId,
    /// Market affected by the message.
    pub market_id: MarketId,
    /// Logical order-book shard.
    pub shard_id: ShardId,
    /// Monotonic position within the stream kind and shard.
    pub shard_sequence: u64,
    /// Wire schema version.
    pub schema_version: u32,
    /// Stream sequence namespace.
    pub stream_kind: StreamKind,
    /// Producer-provided event time.
    pub occurred_at: OffsetDateTime,
    /// SHA-256 digest of deterministic payload bytes.
    pub payload_hash: PayloadHash,
    /// Typed message payload.
    pub payload: T,
}
