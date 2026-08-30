//! Pure deterministic limit-order-book matching for MatchPlane.
//!
//! [`OrderBook`] consumes commands with caller-supplied IDs, sequence numbers, and timestamps. It
//! emits replayable events and never reads a clock, random source, database, broker, cache, or
//! network.

use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
};

use matchplane_domain::{
    EngineCommand, EngineCommandKind, EngineEvent, EventId, MarketId, MatchingEvent, NumericError,
    OrderId, OrderIntent, OrderSide, OrderStatus, PayloadHash, Price, Quantity, Trade, TradeId,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors that reject commands or indicate a corrupt replay stream.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EngineError {
    /// A command targeted another market.
    #[error("command market {actual} does not match order book market {expected}")]
    MarketMismatch {
        /// Market owned by this book.
        expected: MarketId,
        /// Market in the command.
        actual: MarketId,
    },
    /// The command stream has a gap or arrives out of order.
    #[error("expected command sequence {expected}, received {actual}")]
    CommandSequenceGap {
        /// Next expected sequence.
        expected: u64,
        /// Received sequence.
        actual: u64,
    },
    /// An order ID may be admitted only once.
    #[error("order {0} already exists")]
    OrderAlreadyExists(OrderId),
    /// A command referenced an unknown order.
    #[error("order {0} was not found")]
    OrderNotFound(OrderId),
    /// Only open or partially-filled orders may be cancelled or expired.
    #[error("order {order_id} is not open; current status is {status:?}")]
    OrderNotOpen {
        /// Referenced order.
        order_id: OrderId,
        /// Current order state.
        status: OrderStatus,
    },
    /// Expiry was requested before the intent's expiry time.
    #[error("order {0} has not expired at command time")]
    OrderNotExpired(OrderId),
    /// An incoming order was already expired.
    #[error("order {0} is expired at admission time")]
    OrderExpiredAtAdmission(OrderId),
    /// Exact integer arithmetic failed.
    #[error(transparent)]
    Numeric(#[from] NumericError),
    /// An event contradicts the current deterministic state.
    #[error("event stream invariant failed: {0}")]
    EventInvariant(String),
    /// A snapshot could not be serialized or decoded.
    #[error("snapshot serialization failed: {0}")]
    SnapshotSerialization(String),
}

/// Read-only order state exposed by the engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderView {
    /// Original order intent.
    pub intent: OrderIntent,
    /// Remaining unfilled quantity.
    pub remaining_quantity: Quantity,
    /// Current lifecycle state.
    pub status: OrderStatus,
    /// FIFO priority within its price level.
    pub accepted_sequence: u64,
}

/// Aggregated deterministic price level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriceLevel {
    /// Level price.
    pub price: Price,
    /// Sum of remaining order quantities.
    pub quantity: Quantity,
    /// FIFO order IDs at this price.
    pub order_ids: Vec<OrderId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SnapshotState {
    market_id: MarketId,
    last_command_sequence: u64,
    orders: Vec<OrderView>,
    processed_commands: Vec<EventId>,
    applied_events: Vec<EventId>,
}

/// In-memory state for one market shard.
#[derive(Debug, Clone)]
pub struct OrderBook {
    market_id: MarketId,
    bids: BTreeMap<Reverse<Price>, VecDeque<OrderId>>,
    asks: BTreeMap<Price, VecDeque<OrderId>>,
    orders: HashMap<OrderId, OrderView>,
    processed_commands: HashSet<EventId>,
    applied_events: HashSet<EventId>,
    last_command_sequence: u64,
}

impl OrderBook {
    /// Creates an empty order book for one market shard.
    #[must_use]
    pub fn new(market_id: MarketId) -> Self {
        Self {
            market_id,
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            orders: HashMap::new(),
            processed_commands: HashSet::new(),
            applied_events: HashSet::new(),
            last_command_sequence: 0,
        }
    }

    /// Returns the market owned by this state machine.
    #[must_use]
    pub const fn market_id(&self) -> MarketId {
        self.market_id
    }

    /// Returns the last accepted command sequence.
    #[must_use]
    pub const fn last_command_sequence(&self) -> u64 {
        self.last_command_sequence
    }

    /// Returns the current state of an order.
    #[must_use]
    pub fn order(&self, order_id: OrderId) -> Option<&OrderView> {
        self.orders.get(&order_id)
    }

    /// Returns bid levels from highest to lowest price.
    ///
    /// # Errors
    ///
    /// Returns an invariant or arithmetic error when the internal book is corrupt.
    pub fn bids(&self) -> Result<Vec<PriceLevel>, EngineError> {
        self.bids
            .iter()
            .map(|(price, queue)| self.aggregate_level(price.0, queue))
            .collect()
    }

    /// Returns ask levels from lowest to highest price.
    ///
    /// # Errors
    ///
    /// Returns an invariant or arithmetic error when the internal book is corrupt.
    pub fn asks(&self) -> Result<Vec<PriceLevel>, EngineError> {
        self.asks
            .iter()
            .map(|(price, queue)| self.aggregate_level(*price, queue))
            .collect()
    }

    /// Decides and applies one command, returning newly produced events.
    ///
    /// Duplicate command IDs are successful no-ops. All other commands must be contiguous by
    /// `shard_sequence`.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] when validation, sequence, or state invariants fail.
    pub fn process(&mut self, command: &EngineCommand) -> Result<Vec<EngineEvent>, EngineError> {
        if self.processed_commands.contains(&command.command_id) {
            return Ok(Vec::new());
        }

        let expected = self
            .last_command_sequence
            .checked_add(1)
            .ok_or_else(|| EngineError::EventInvariant("command sequence overflow".to_owned()))?;
        if command.shard_sequence != expected {
            return Err(EngineError::CommandSequenceGap {
                expected,
                actual: command.shard_sequence,
            });
        }

        let events = match &command.kind {
            EngineCommandKind::PlaceLimitOrder { intent } => {
                self.decide_place_limit_order(command, intent)?
            }
            EngineCommandKind::CancelOrder { order_id } => {
                self.decide_cancel_order(command, *order_id)?
            }
            EngineCommandKind::ExpireOrder { order_id } => {
                self.decide_expire_order(command, *order_id)?
            }
        };

        for event in &events {
            let applied = self.apply(event)?;
            if !applied {
                return Err(EngineError::EventInvariant(format!(
                    "new event {} was already applied",
                    event.event_id
                )));
            }
        }

        Ok(events)
    }

    /// Applies an event during live processing or replay.
    ///
    /// Returns `false` for an already-applied `event_id`, making replay idempotent.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::EventInvariant`] when the event contradicts current state.
    pub fn apply(&mut self, event: &EngineEvent) -> Result<bool, EngineError> {
        if self.applied_events.contains(&event.event_id) {
            return Ok(false);
        }

        match &event.payload {
            MatchingEvent::OrderAccepted {
                intent,
                accepted_sequence,
            } => self.apply_order_accepted(intent, *accepted_sequence)?,
            MatchingEvent::TradeExecuted { trade } => self.apply_trade(trade)?,
            MatchingEvent::OrderCancelled {
                order_id,
                released_quantity,
            } => self.apply_closed_order(*order_id, *released_quantity, OrderStatus::Cancelled)?,
            MatchingEvent::OrderExpired {
                order_id,
                released_quantity,
            } => self.apply_closed_order(*order_id, *released_quantity, OrderStatus::Expired)?,
        }

        self.applied_events.insert(event.event_id);
        self.processed_commands.insert(event.causation_id);
        self.last_command_sequence = self.last_command_sequence.max(event.command_sequence);
        Ok(true)
    }

    /// Serializes canonical state for checksum-verified persistence.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::SnapshotSerialization`] when JSON encoding fails.
    pub fn snapshot_bytes(&self) -> Result<Vec<u8>, EngineError> {
        serde_json::to_vec(&self.snapshot_state())
            .map_err(|error| EngineError::SnapshotSerialization(error.to_string()))
    }

    /// Returns the SHA-256 hash of canonical snapshot bytes.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::SnapshotSerialization`] when state encoding fails.
    pub fn state_hash(&self) -> Result<PayloadHash, EngineError> {
        self.snapshot_bytes()
            .map(|bytes| PayloadHash::from_bytes(&bytes))
    }

    /// Restores an order book from canonical snapshot bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when decoding fails or restored state violates an invariant.
    pub fn from_snapshot_bytes(bytes: &[u8]) -> Result<Self, EngineError> {
        let snapshot: SnapshotState = serde_json::from_slice(bytes)
            .map_err(|error| EngineError::SnapshotSerialization(error.to_string()))?;
        let mut book = Self::new(snapshot.market_id);
        book.last_command_sequence = snapshot.last_command_sequence;
        book.processed_commands = snapshot.processed_commands.into_iter().collect();
        book.applied_events = snapshot.applied_events.into_iter().collect();

        for order in snapshot.orders {
            book.validate_order_scope(&order.intent)?;
            if book
                .orders
                .insert(order.intent.order_id, order.clone())
                .is_some()
            {
                return Err(EngineError::EventInvariant(format!(
                    "snapshot contains duplicate order {}",
                    order.intent.order_id
                )));
            }
            if matches!(
                order.status,
                OrderStatus::Open | OrderStatus::PartiallyFilled
            ) {
                book.push_to_level(&order);
            }
        }

        Ok(book)
    }

    fn decide_place_limit_order(
        &self,
        command: &EngineCommand,
        intent: &OrderIntent,
    ) -> Result<Vec<EngineEvent>, EngineError> {
        self.validate_intent(command, intent)?;

        let mut events = vec![Self::event(
            command,
            0,
            MatchingEvent::OrderAccepted {
                intent: intent.clone(),
                accepted_sequence: command.shard_sequence,
            },
        )];
        let mut taker_remaining = intent.quantity;
        let mut trade_ordinal = 0_u32;

        match intent.side {
            OrderSide::Buy => {
                'levels: for (maker_price, order_ids) in self.asks.range(..=intent.price) {
                    for maker_order_id in order_ids {
                        let maker = self.open_order(*maker_order_id)?;
                        trade_ordinal = trade_ordinal.checked_add(1).ok_or_else(|| {
                            EngineError::EventInvariant("trade ordinal overflow".to_owned())
                        })?;
                        let quantity = taker_remaining.min(maker.remaining_quantity);
                        events.push(Self::trade_event(
                            command,
                            trade_ordinal,
                            intent,
                            maker,
                            *maker_price,
                            quantity,
                        ));
                        taker_remaining = taker_remaining.checked_sub(quantity)?;
                        if taker_remaining.is_zero() {
                            break 'levels;
                        }
                    }
                }
            }
            OrderSide::Sell => {
                'levels: for (maker_price, order_ids) in &self.bids {
                    let maker_price = maker_price.0;
                    if maker_price < intent.price {
                        break;
                    }
                    for maker_order_id in order_ids {
                        let maker = self.open_order(*maker_order_id)?;
                        trade_ordinal = trade_ordinal.checked_add(1).ok_or_else(|| {
                            EngineError::EventInvariant("trade ordinal overflow".to_owned())
                        })?;
                        let quantity = taker_remaining.min(maker.remaining_quantity);
                        events.push(Self::trade_event(
                            command,
                            trade_ordinal,
                            intent,
                            maker,
                            maker_price,
                            quantity,
                        ));
                        taker_remaining = taker_remaining.checked_sub(quantity)?;
                        if taker_remaining.is_zero() {
                            break 'levels;
                        }
                    }
                }
            }
        }

        Ok(events)
    }

    fn decide_cancel_order(
        &self,
        command: &EngineCommand,
        order_id: OrderId,
    ) -> Result<Vec<EngineEvent>, EngineError> {
        let order = self.open_order(order_id)?;
        Ok(vec![Self::event(
            command,
            0,
            MatchingEvent::OrderCancelled {
                order_id,
                released_quantity: order.remaining_quantity,
            },
        )])
    }

    fn decide_expire_order(
        &self,
        command: &EngineCommand,
        order_id: OrderId,
    ) -> Result<Vec<EngineEvent>, EngineError> {
        let order = self.open_order(order_id)?;
        let is_expired = order
            .intent
            .expires_at
            .is_some_and(|expires_at| command.occurred_at >= expires_at);
        if !is_expired {
            return Err(EngineError::OrderNotExpired(order_id));
        }

        Ok(vec![Self::event(
            command,
            0,
            MatchingEvent::OrderExpired {
                order_id,
                released_quantity: order.remaining_quantity,
            },
        )])
    }

    fn validate_intent(
        &self,
        command: &EngineCommand,
        intent: &OrderIntent,
    ) -> Result<(), EngineError> {
        self.validate_order_scope(intent)?;
        if self.orders.contains_key(&intent.order_id) {
            return Err(EngineError::OrderAlreadyExists(intent.order_id));
        }
        if intent.quantity.is_zero() {
            return Err(NumericError::NonPositiveQuantity.into());
        }
        if intent
            .expires_at
            .is_some_and(|expires_at| command.occurred_at >= expires_at)
        {
            return Err(EngineError::OrderExpiredAtAdmission(intent.order_id));
        }
        Ok(())
    }

    fn validate_order_scope(&self, intent: &OrderIntent) -> Result<(), EngineError> {
        if intent.market_id != self.market_id {
            return Err(EngineError::MarketMismatch {
                expected: self.market_id,
                actual: intent.market_id,
            });
        }
        if self.orders.values().next().is_some_and(|existing| {
            existing.intent.tenant_id != intent.tenant_id
                || existing.intent.domain_id != intent.domain_id
        }) {
            return Err(EngineError::EventInvariant(
                "order authority scope does not match the market book".to_owned(),
            ));
        }
        Ok(())
    }

    fn event(command: &EngineCommand, ordinal: u32, payload: MatchingEvent) -> EngineEvent {
        EngineEvent {
            event_id: command.command_id.derive("matching-event", ordinal),
            causation_id: command.command_id,
            command_sequence: command.shard_sequence,
            occurred_at: command.occurred_at,
            payload,
        }
    }

    fn trade_event(
        command: &EngineCommand,
        trade_ordinal: u32,
        taker: &OrderIntent,
        maker: &OrderView,
        price: Price,
        quantity: Quantity,
    ) -> EngineEvent {
        let (buy_order_id, sell_order_id) = match taker.side {
            OrderSide::Buy => (taker.order_id, maker.intent.order_id),
            OrderSide::Sell => (maker.intent.order_id, taker.order_id),
        };
        let trade = Trade {
            id: TradeId::derive(command.command_id, trade_ordinal),
            tenant_id: taker.tenant_id,
            domain_id: taker.domain_id,
            market_id: taker.market_id,
            maker_order_id: maker.intent.order_id,
            taker_order_id: taker.order_id,
            buy_order_id,
            sell_order_id,
            price,
            quantity,
            occurred_at: command.occurred_at,
        };
        Self::event(
            command,
            trade_ordinal,
            MatchingEvent::TradeExecuted { trade },
        )
    }

    fn apply_order_accepted(
        &mut self,
        intent: &OrderIntent,
        accepted_sequence: u64,
    ) -> Result<(), EngineError> {
        self.validate_order_scope(intent)?;
        if self.orders.contains_key(&intent.order_id) {
            return Err(EngineError::OrderAlreadyExists(intent.order_id));
        }
        if intent.quantity.is_zero() {
            return Err(NumericError::NonPositiveQuantity.into());
        }
        let order = OrderView {
            intent: intent.clone(),
            remaining_quantity: intent.quantity,
            status: OrderStatus::Open,
            accepted_sequence,
        };
        self.orders.insert(intent.order_id, order.clone());
        self.push_to_level(&order);
        Ok(())
    }

    fn apply_trade(&mut self, trade: &Trade) -> Result<(), EngineError> {
        if trade.market_id != self.market_id {
            return Err(EngineError::MarketMismatch {
                expected: self.market_id,
                actual: trade.market_id,
            });
        }
        if trade.maker_order_id == trade.taker_order_id {
            return Err(EngineError::EventInvariant(
                "trade maker and taker must be different orders".to_owned(),
            ));
        }
        if trade.quantity.is_zero() {
            return Err(NumericError::NonPositiveQuantity.into());
        }

        let maker = self.open_order(trade.maker_order_id)?;
        let taker = self.open_order(trade.taker_order_id)?;
        if maker.intent.tenant_id != trade.tenant_id
            || taker.intent.tenant_id != trade.tenant_id
            || maker.intent.domain_id != trade.domain_id
            || taker.intent.domain_id != trade.domain_id
            || maker.intent.market_id != trade.market_id
            || taker.intent.market_id != trade.market_id
        {
            return Err(EngineError::EventInvariant(
                "trade authority scope does not match both orders".to_owned(),
            ));
        }
        if maker.intent.side == taker.intent.side {
            return Err(EngineError::EventInvariant(
                "trade orders must be on opposite sides".to_owned(),
            ));
        }
        if maker.accepted_sequence >= taker.accepted_sequence {
            return Err(EngineError::EventInvariant(
                "trade maker must have earlier price-time priority than the taker".to_owned(),
            ));
        }
        let (buy_order_id, sell_order_id) = match maker.intent.side {
            OrderSide::Buy => (trade.maker_order_id, trade.taker_order_id),
            OrderSide::Sell => (trade.taker_order_id, trade.maker_order_id),
        };
        if trade.buy_order_id != buy_order_id || trade.sell_order_id != sell_order_id {
            return Err(EngineError::EventInvariant(
                "trade side order IDs do not match the maker and taker".to_owned(),
            ));
        }
        if trade.price != maker.intent.price {
            return Err(EngineError::EventInvariant(
                "trade price does not match the maker limit price".to_owned(),
            ));
        }
        let taker_crosses_maker = match taker.intent.side {
            OrderSide::Buy => trade.price <= taker.intent.price,
            OrderSide::Sell => trade.price >= taker.intent.price,
        };
        if !taker_crosses_maker {
            return Err(EngineError::EventInvariant(
                "trade price does not satisfy the taker limit".to_owned(),
            ));
        }

        maker.remaining_quantity.checked_sub(trade.quantity)?;
        taker.remaining_quantity.checked_sub(trade.quantity)?;
        self.decrease_order(trade.maker_order_id, trade.quantity)?;
        self.decrease_order(trade.taker_order_id, trade.quantity)
    }

    fn apply_closed_order(
        &mut self,
        order_id: OrderId,
        released_quantity: Quantity,
        status: OrderStatus,
    ) -> Result<(), EngineError> {
        let order = self.open_order(order_id)?;
        if order.remaining_quantity != released_quantity {
            return Err(EngineError::EventInvariant(format!(
                "released quantity for order {order_id} does not match remaining quantity"
            )));
        }
        self.remove_from_level(order_id)?;
        let order = self
            .orders
            .get_mut(&order_id)
            .ok_or(EngineError::OrderNotFound(order_id))?;
        order.remaining_quantity = Quantity::ZERO;
        order.status = status;
        Ok(())
    }

    fn decrease_order(&mut self, order_id: OrderId, quantity: Quantity) -> Result<(), EngineError> {
        let remaining = self.open_order(order_id)?.remaining_quantity;
        let new_remaining = remaining.checked_sub(quantity)?;
        if new_remaining.is_zero() {
            self.remove_from_level(order_id)?;
        }
        let order = self
            .orders
            .get_mut(&order_id)
            .ok_or(EngineError::OrderNotFound(order_id))?;
        order.remaining_quantity = new_remaining;
        order.status = if new_remaining.is_zero() {
            OrderStatus::Filled
        } else if new_remaining == order.intent.quantity {
            OrderStatus::Open
        } else {
            OrderStatus::PartiallyFilled
        };
        Ok(())
    }

    fn open_order(&self, order_id: OrderId) -> Result<&OrderView, EngineError> {
        let order = self
            .orders
            .get(&order_id)
            .ok_or(EngineError::OrderNotFound(order_id))?;
        if matches!(
            order.status,
            OrderStatus::Open | OrderStatus::PartiallyFilled
        ) {
            Ok(order)
        } else {
            Err(EngineError::OrderNotOpen {
                order_id,
                status: order.status,
            })
        }
    }

    fn push_to_level(&mut self, order: &OrderView) {
        match order.intent.side {
            OrderSide::Buy => self
                .bids
                .entry(Reverse(order.intent.price))
                .or_default()
                .push_back(order.intent.order_id),
            OrderSide::Sell => self
                .asks
                .entry(order.intent.price)
                .or_default()
                .push_back(order.intent.order_id),
        }
    }

    fn remove_from_level(&mut self, order_id: OrderId) -> Result<(), EngineError> {
        let order = self
            .orders
            .get(&order_id)
            .ok_or(EngineError::OrderNotFound(order_id))?;
        let (queue_empty, side, price) = match order.intent.side {
            OrderSide::Buy => {
                let key = Reverse(order.intent.price);
                let queue = self.bids.get_mut(&key).ok_or_else(|| {
                    EngineError::EventInvariant(format!("missing bid level for order {order_id}"))
                })?;
                queue.retain(|candidate| *candidate != order_id);
                (queue.is_empty(), OrderSide::Buy, order.intent.price)
            }
            OrderSide::Sell => {
                let queue = self.asks.get_mut(&order.intent.price).ok_or_else(|| {
                    EngineError::EventInvariant(format!("missing ask level for order {order_id}"))
                })?;
                queue.retain(|candidate| *candidate != order_id);
                (queue.is_empty(), OrderSide::Sell, order.intent.price)
            }
        };

        if queue_empty {
            match side {
                OrderSide::Buy => {
                    self.bids.remove(&Reverse(price));
                }
                OrderSide::Sell => {
                    self.asks.remove(&price);
                }
            }
        }
        Ok(())
    }

    fn aggregate_level(
        &self,
        price: Price,
        queue: &VecDeque<OrderId>,
    ) -> Result<PriceLevel, EngineError> {
        let mut quantity = Quantity::ZERO;
        for order_id in queue {
            quantity = quantity.checked_add(self.open_order(*order_id)?.remaining_quantity)?;
        }
        Ok(PriceLevel {
            price,
            quantity,
            order_ids: queue.iter().copied().collect(),
        })
    }

    fn snapshot_state(&self) -> SnapshotState {
        let mut orders: Vec<_> = self.orders.values().cloned().collect();
        orders.sort_by_key(|order| (order.accepted_sequence, order.intent.order_id));
        let mut processed_commands: Vec<_> = self.processed_commands.iter().copied().collect();
        processed_commands.sort_unstable();
        let mut applied_events: Vec<_> = self.applied_events.iter().copied().collect();
        applied_events.sort_unstable();
        SnapshotState {
            market_id: self.market_id,
            last_command_sequence: self.last_command_sequence,
            orders,
            processed_commands,
            applied_events,
        }
    }
}

#[cfg(test)]
mod tests {
    use time::{Duration, OffsetDateTime};

    use super::*;
    use matchplane_domain::{DomainId, TenantId};

    fn timestamp(seconds: i64) -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(seconds).expect("test timestamp should be valid")
    }

    fn intent(
        market_id: MarketId,
        side: OrderSide,
        price: i128,
        quantity: i128,
        submitted_at: OffsetDateTime,
    ) -> OrderIntent {
        OrderIntent {
            order_id: OrderId::new(),
            tenant_id: TenantId::from_uuid(market_id.into_uuid()),
            domain_id: DomainId::from_uuid(market_id.into_uuid()),
            market_id,
            side,
            price: Price::new(price).expect("test price should be positive"),
            quantity: Quantity::new(quantity).expect("test quantity should be positive"),
            submitted_at,
            expires_at: None,
        }
    }

    fn place(sequence: u64, intent: OrderIntent) -> EngineCommand {
        EngineCommand {
            command_id: EventId::new(),
            shard_sequence: sequence,
            occurred_at: intent.submitted_at,
            kind: EngineCommandKind::PlaceLimitOrder { intent },
        }
    }

    #[test]
    fn process_should_fill_lower_ask_before_higher_ask() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let high = intent(market_id, OrderSide::Sell, 110, 5, timestamp(1));
        let low = intent(market_id, OrderSide::Sell, 100, 5, timestamp(2));
        let buy = intent(market_id, OrderSide::Buy, 110, 5, timestamp(3));
        let low_id = low.order_id;

        book.process(&place(1, high)).expect("high ask should rest");
        book.process(&place(2, low)).expect("low ask should rest");
        let events = book.process(&place(3, buy)).expect("buy should match");
        let trade = events
            .iter()
            .find_map(|event| match &event.payload {
                MatchingEvent::TradeExecuted { trade } => Some(trade),
                _ => None,
            })
            .expect("one trade should be emitted");

        assert_eq!(trade.maker_order_id, low_id);
    }

    #[test]
    fn process_should_preserve_fifo_within_one_price_level() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let first = intent(market_id, OrderSide::Sell, 100, 3, timestamp(1));
        let second = intent(market_id, OrderSide::Sell, 100, 3, timestamp(2));
        let buy = intent(market_id, OrderSide::Buy, 100, 4, timestamp(3));
        let first_id = first.order_id;
        let second_id = second.order_id;

        book.process(&place(1, first))
            .expect("first ask should rest");
        book.process(&place(2, second))
            .expect("second ask should rest");
        let events = book.process(&place(3, buy)).expect("buy should match");
        let makers: Vec<_> = events
            .iter()
            .filter_map(|event| match &event.payload {
                MatchingEvent::TradeExecuted { trade } => Some(trade.maker_order_id),
                _ => None,
            })
            .collect();

        assert_eq!(makers, vec![first_id, second_id]);
    }

    #[test]
    fn process_should_never_trade_more_than_remaining_quantity() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let sell = intent(market_id, OrderSide::Sell, 100, 10, timestamp(1));
        let sell_id = sell.order_id;
        let buy = intent(market_id, OrderSide::Buy, 100, 4, timestamp(2));

        book.process(&place(1, sell)).expect("sell should rest");
        book.process(&place(2, buy)).expect("buy should match");
        let remaining = book
            .order(sell_id)
            .expect("sell should remain")
            .remaining_quantity;

        assert_eq!(remaining, Quantity::new(6).expect("six is positive"));
    }

    #[test]
    fn process_should_make_duplicate_command_a_no_op() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let command = place(1, intent(market_id, OrderSide::Sell, 100, 5, timestamp(1)));
        book.process(&command).expect("first command should apply");

        let duplicate_events = book
            .process(&command)
            .expect("duplicate should be accepted");

        assert!(duplicate_events.is_empty());
    }

    #[test]
    fn process_should_reject_zero_quantity_order() {
        let market_id = MarketId::new();
        let mut invalid = intent(market_id, OrderSide::Buy, 100, 1, timestamp(1));
        invalid.quantity = Quantity::ZERO;
        let mut book = OrderBook::new(market_id);

        let error = book
            .process(&place(1, invalid))
            .expect_err("zero quantity must be rejected");

        assert_eq!(
            error,
            EngineError::Numeric(NumericError::NonPositiveQuantity)
        );
        assert_eq!(book.last_command_sequence(), 0);
    }

    #[test]
    fn apply_should_reject_invalid_order_acceptance_without_mutating_state() {
        let market_id = MarketId::new();
        let original = intent(market_id, OrderSide::Buy, 100, 5, timestamp(1));
        let order_id = original.order_id;
        let mut book = OrderBook::new(market_id);
        book.process(&place(1, original.clone()))
            .expect("original order should apply");
        let state_before = book.state_hash().expect("book should hash");

        let mut replacement = original;
        replacement.price = Price::new(101).expect("replacement price should be valid");
        let duplicate_command = place(2, replacement.clone());
        let duplicate_event = OrderBook::event(
            &duplicate_command,
            0,
            MatchingEvent::OrderAccepted {
                intent: replacement,
                accepted_sequence: 2,
            },
        );
        let duplicate_error = book
            .apply(&duplicate_event)
            .expect_err("duplicate order event must be rejected");
        assert_eq!(duplicate_error, EngineError::OrderAlreadyExists(order_id));
        assert_eq!(book.state_hash().expect("book should hash"), state_before);

        let mut zero = intent(market_id, OrderSide::Sell, 99, 1, timestamp(2));
        let zero_order_id = zero.order_id;
        zero.quantity = Quantity::ZERO;
        let zero_command = place(2, zero.clone());
        let zero_event = OrderBook::event(
            &zero_command,
            0,
            MatchingEvent::OrderAccepted {
                intent: zero,
                accepted_sequence: 2,
            },
        );
        let zero_error = book
            .apply(&zero_event)
            .expect_err("zero-quantity order event must be rejected");
        assert_eq!(
            zero_error,
            EngineError::Numeric(NumericError::NonPositiveQuantity)
        );
        assert!(book.order(zero_order_id).is_none());
        assert_eq!(book.state_hash().expect("book should hash"), state_before);

        let mut foreign = intent(market_id, OrderSide::Sell, 99, 1, timestamp(2));
        let foreign_order_id = foreign.order_id;
        foreign.tenant_id = TenantId::new();
        let foreign_command = place(2, foreign.clone());
        let foreign_event = OrderBook::event(
            &foreign_command,
            0,
            MatchingEvent::OrderAccepted {
                intent: foreign,
                accepted_sequence: 2,
            },
        );
        let foreign_error = book
            .apply(&foreign_event)
            .expect_err("cross-tenant order event must be rejected");
        assert!(matches!(foreign_error, EngineError::EventInvariant(_)));
        assert!(book.order(foreign_order_id).is_none());
        assert_eq!(book.state_hash().expect("book should hash"), state_before);
    }

    #[test]
    fn apply_should_reject_corrupt_trade_without_partially_decreasing_the_maker() {
        let market_id = MarketId::new();
        let maker = intent(market_id, OrderSide::Sell, 100, 5, timestamp(1));
        let maker_order_id = maker.order_id;
        let mut book = OrderBook::new(market_id);
        book.process(&place(1, maker))
            .expect("maker order should apply");

        let taker = intent(market_id, OrderSide::Buy, 100, 5, timestamp(2));
        let taker_order_id = taker.order_id;
        let taker_command = place(2, taker.clone());
        let events = book
            .decide_place_limit_order(&taker_command, &taker)
            .expect("crossing order should decide");
        assert_eq!(events.len(), 2);
        book.apply(&events[0])
            .expect("taker acceptance should replay");
        let state_before = book.state_hash().expect("book should hash");

        let missing_taker_id = OrderId::new();
        let mut missing_taker = events[1].clone();
        let MatchingEvent::TradeExecuted { trade } = &mut missing_taker.payload else {
            panic!("second event should be a trade");
        };
        trade.taker_order_id = missing_taker_id;
        let error = book
            .apply(&missing_taker)
            .expect_err("trade with an unknown taker must fail atomically");
        assert_eq!(error, EngineError::OrderNotFound(missing_taker_id));
        assert_eq!(
            book.order(maker_order_id)
                .expect("maker must remain")
                .remaining_quantity,
            Quantity::new(5).expect("quantity should be valid"),
        );
        assert_eq!(
            book.order(taker_order_id)
                .expect("taker must remain")
                .remaining_quantity,
            Quantity::new(5).expect("quantity should be valid"),
        );
        assert_eq!(book.state_hash().expect("book should hash"), state_before);

        let mut foreign_tenant = events[1].clone();
        let MatchingEvent::TradeExecuted { trade } = &mut foreign_tenant.payload else {
            panic!("second event should be a trade");
        };
        trade.tenant_id = TenantId::new();
        let error = book
            .apply(&foreign_tenant)
            .expect_err("cross-tenant trade must fail atomically");
        assert!(matches!(error, EngineError::EventInvariant(_)));
        assert_eq!(book.state_hash().expect("book should hash"), state_before);

        let mut reversed_priority = events[1].clone();
        let MatchingEvent::TradeExecuted { trade } = &mut reversed_priority.payload else {
            panic!("second event should be a trade");
        };
        trade.maker_order_id = taker_order_id;
        trade.taker_order_id = maker_order_id;
        let error = book
            .apply(&reversed_priority)
            .expect_err("a newer order cannot be replayed as the maker");
        assert!(matches!(error, EngineError::EventInvariant(_)));
        assert_eq!(book.state_hash().expect("book should hash"), state_before);
    }

    #[test]
    fn apply_should_reject_a_trade_that_does_not_cross_the_taker_limit() {
        let market_id = MarketId::new();
        let maker = intent(market_id, OrderSide::Sell, 110, 5, timestamp(1));
        let tenant_id = maker.tenant_id;
        let domain_id = maker.domain_id;
        let maker_order_id = maker.order_id;
        let mut book = OrderBook::new(market_id);
        book.process(&place(1, maker))
            .expect("maker order should rest");

        let taker = intent(market_id, OrderSide::Buy, 100, 5, timestamp(2));
        let taker_order_id = taker.order_id;
        let taker_command = place(2, taker);
        book.process(&taker_command)
            .expect("non-crossing taker should rest");
        let state_before = book.state_hash().expect("book should hash");
        let corrupt_trade = OrderBook::event(
            &taker_command,
            1,
            MatchingEvent::TradeExecuted {
                trade: Trade {
                    id: TradeId::new(),
                    tenant_id,
                    domain_id,
                    market_id,
                    maker_order_id,
                    taker_order_id,
                    buy_order_id: taker_order_id,
                    sell_order_id: maker_order_id,
                    price: Price::new(110).expect("maker price should be valid"),
                    quantity: Quantity::new(1).expect("trade quantity should be valid"),
                    occurred_at: timestamp(2),
                },
            },
        );

        let error = book
            .apply(&corrupt_trade)
            .expect_err("non-crossing trade must be rejected");
        assert!(matches!(error, EngineError::EventInvariant(_)));
        assert_eq!(book.state_hash().expect("book should hash"), state_before);
    }

    #[test]
    fn process_should_prevent_cancelled_order_from_trading() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let sell = intent(market_id, OrderSide::Sell, 100, 5, timestamp(1));
        let sell_id = sell.order_id;
        book.process(&place(1, sell)).expect("sell should rest");
        let cancel = EngineCommand {
            command_id: EventId::new(),
            shard_sequence: 2,
            occurred_at: timestamp(2),
            kind: EngineCommandKind::CancelOrder { order_id: sell_id },
        };
        book.process(&cancel).expect("cancel should apply");
        let buy = intent(market_id, OrderSide::Buy, 100, 5, timestamp(3));

        let events = book.process(&place(3, buy)).expect("buy should rest");
        let trade_count = events
            .iter()
            .filter(|event| matches!(event.payload, MatchingEvent::TradeExecuted { .. }))
            .count();

        assert_eq!(trade_count, 0);
    }

    #[test]
    fn process_should_expire_order_only_after_expiry_time() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        let mut sell = intent(market_id, OrderSide::Sell, 100, 5, timestamp(1));
        sell.expires_at = Some(timestamp(1) + Duration::seconds(10));
        let sell_id = sell.order_id;
        book.process(&place(1, sell)).expect("sell should rest");
        let expire = EngineCommand {
            command_id: EventId::new(),
            shard_sequence: 2,
            occurred_at: timestamp(20),
            kind: EngineCommandKind::ExpireOrder { order_id: sell_id },
        };

        book.process(&expire).expect("expiry should apply");

        assert_eq!(
            book.order(sell_id).expect("order should exist").status,
            OrderStatus::Expired
        );
    }

    #[test]
    fn replay_should_produce_identical_state_hash() {
        let market_id = MarketId::new();
        let commands = vec![
            place(1, intent(market_id, OrderSide::Sell, 100, 5, timestamp(1))),
            place(2, intent(market_id, OrderSide::Buy, 100, 3, timestamp(2))),
        ];
        let mut live = OrderBook::new(market_id);
        let mut all_events = Vec::new();
        for command in &commands {
            all_events.extend(live.process(command).expect("command should apply"));
        }
        let mut replayed = OrderBook::new(market_id);
        for event in &all_events {
            replayed.apply(event).expect("event should replay");
        }

        assert_eq!(
            live.state_hash().expect("live state should hash"),
            replayed.state_hash().expect("replayed state should hash")
        );
    }

    #[test]
    fn apply_should_ignore_duplicate_trade_event() {
        let market_id = MarketId::new();
        let mut live = OrderBook::new(market_id);
        let sell = place(1, intent(market_id, OrderSide::Sell, 100, 5, timestamp(1)));
        let buy = place(2, intent(market_id, OrderSide::Buy, 100, 3, timestamp(2)));
        live.process(&sell).expect("sell should rest");
        let events = live.process(&buy).expect("buy should match");
        let trade_event = events
            .iter()
            .find(|event| matches!(event.payload, MatchingEvent::TradeExecuted { .. }))
            .expect("trade event should exist");

        let applied = live.apply(trade_event).expect("duplicate should be safe");

        assert!(!applied);
    }

    #[test]
    fn snapshot_should_restore_exact_state() {
        let market_id = MarketId::new();
        let mut book = OrderBook::new(market_id);
        book.process(&place(
            1,
            intent(market_id, OrderSide::Buy, 90, 7, timestamp(1)),
        ))
        .expect("buy should rest");
        let bytes = book.snapshot_bytes().expect("snapshot should serialize");

        let restored = OrderBook::from_snapshot_bytes(&bytes).expect("snapshot should restore");

        assert_eq!(
            book.state_hash().expect("book should hash"),
            restored.state_hash().expect("restored book should hash")
        );
    }
}
