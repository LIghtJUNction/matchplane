use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{EventId, OrderId, OrderIntent, Quantity, Trade};

/// A fully deterministic matching command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineCommand {
    /// Globally unique command ID used for deduplication and derived IDs.
    pub command_id: EventId,
    /// Contiguous command stream position for this shard.
    pub shard_sequence: u64,
    /// Producer-provided time; the engine never reads a wall clock.
    pub occurred_at: OffsetDateTime,
    /// Command payload.
    pub kind: EngineCommandKind,
}

/// Commands understood by the deterministic limit-order-book engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineCommandKind {
    /// Admit and match a limit order.
    PlaceLimitOrder { intent: OrderIntent },
    /// Cancel an open order.
    CancelOrder { order_id: OrderId },
    /// Expire an order when command time is at or after its expiry.
    ExpireOrder { order_id: OrderId },
}

/// An event emitted by the matching engine with deterministic identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineEvent {
    /// Event ID derived from the command ID and ordinal.
    pub event_id: EventId,
    /// Command that caused this event.
    pub causation_id: EventId,
    /// Position of the command that caused this event.
    pub command_sequence: u64,
    /// Producer-provided command time.
    pub occurred_at: OffsetDateTime,
    /// Event payload.
    pub payload: MatchingEvent,
}

/// Replayable facts emitted by the matching engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MatchingEvent {
    /// An order entered the deterministic state machine.
    OrderAccepted {
        /// Original order intent.
        intent: OrderIntent,
        /// FIFO priority sequence.
        accepted_sequence: u64,
    },
    /// A maker and taker traded.
    TradeExecuted { trade: Trade },
    /// An open order was cancelled.
    OrderCancelled {
        /// Cancelled order.
        order_id: OrderId,
        /// Quantity released by cancellation.
        released_quantity: Quantity,
    },
    /// An open order reached its deterministic expiry.
    OrderExpired {
        /// Expired order.
        order_id: OrderId,
        /// Quantity released by expiry.
        released_quantity: Quantity,
    },
}
