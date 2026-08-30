use std::str::FromStr;

use matchplane_domain::{
    AccountId, EngineCommand, EngineCommandKind, EngineEvent, EventEnvelope, MatchingEvent,
    NumericError, OrderIntent, OrderSide, PayloadHash, Price, Quantity, StreamKind,
};
use prost::Message;
use thiserror::Error;
use time::OffsetDateTime;

use crate::v1;

/// Placement-only persistence fields carried beside the pure engine command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementContext {
    /// Gateway idempotency key.
    pub idempotency_key: String,
    /// Account whose available balance is reserved.
    pub reservation_account_id: AccountId,
    /// Account credited when settlement completes.
    pub settlement_account_id: AccountId,
    /// Exact amount held by the reservation.
    pub reservation_amount: Quantity,
}

/// Validated wire command and its mandatory envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedCommand {
    /// Mandatory distributed message metadata.
    pub envelope: EventEnvelope<Vec<u8>>,
    /// Infrastructure-independent engine command.
    pub engine_command: EngineCommand,
    /// Placement context; absent for cancellation and expiry.
    pub placement: Option<PlacementContext>,
}

/// Invalid Protobuf, identifiers, exact numbers, timestamps, or payload hashes.
#[derive(Debug, Error)]
pub enum WireError {
    /// Protobuf decoding failed.
    #[error("Protobuf decoding failed: {0}")]
    Decode(#[from] prost::DecodeError),
    /// UUID text was malformed.
    #[error("field {field} contains an invalid UUID: {source}")]
    Uuid {
        /// Field name.
        field: &'static str,
        /// UUID parser error.
        source: uuid::Error,
    },
    /// A required oneof or timestamp was absent.
    #[error("required field {0} is missing")]
    Missing(&'static str),
    /// An exact decimal integer string was malformed.
    #[error("field {field} is not a valid exact integer")]
    Integer {
        /// Field name.
        field: &'static str,
    },
    /// An exact numeric invariant failed.
    #[error(transparent)]
    Numeric(#[from] NumericError),
    /// A Protobuf timestamp is outside the supported range.
    #[error("timestamp is invalid: {0}")]
    Timestamp(String),
    /// Payload bytes do not match the mandatory digest.
    #[error("event envelope payload hash does not match payload bytes")]
    PayloadHashMismatch,
    /// The declared Protobuf message type does not match the subscribed protocol.
    #[error("message type {actual:?} does not match expected type {expected}")]
    MessageType {
        /// Expected fully qualified Protobuf message name.
        expected: &'static str,
        /// Message name declared by the envelope.
        actual: String,
    },
    /// The stream-kind enum is unknown or inappropriate.
    #[error("stream kind {0} is invalid")]
    StreamKind(i32),
    /// The order side enum is unspecified or unknown.
    #[error("order side {0} is invalid")]
    OrderSide(i32),
}

/// Encodes a domain envelope and matching command as deterministic Protobuf bytes.
#[must_use]
pub fn encode_command_envelope(
    envelope: &EventEnvelope<Vec<u8>>,
    command: &v1::MatchingCommand,
) -> Vec<u8> {
    let payload = command.encode_to_vec();
    let wire = envelope_to_wire(envelope, payload, "matchplane.v1.MatchingCommand");
    wire.encode_to_vec()
}

/// Encodes arbitrary versioned payload bytes in the mandatory Protobuf envelope.
#[must_use]
pub fn encode_event_envelope(envelope: &EventEnvelope<Vec<u8>>, message_type: &str) -> Vec<u8> {
    envelope_to_wire(envelope, envelope.payload.clone(), message_type).encode_to_vec()
}

/// Decodes and validates the mandatory Protobuf envelope without interpreting its payload.
///
/// # Errors
///
/// Returns [`WireError`] when metadata, timestamp, or payload hash validation fails.
pub fn decode_event_envelope(bytes: &[u8]) -> Result<EventEnvelope<Vec<u8>>, WireError> {
    let wire = v1::EventEnvelope::decode(bytes)?;
    envelope_from_wire(&wire)
}

/// Decodes an envelope and requires one fully qualified Protobuf payload type.
///
/// # Errors
///
/// Returns [`WireError`] when metadata, timestamp, payload hash, or the declared message type is
/// invalid.
pub fn decode_event_envelope_as(
    bytes: &[u8],
    expected_message_type: &'static str,
) -> Result<EventEnvelope<Vec<u8>>, WireError> {
    let wire = v1::EventEnvelope::decode(bytes)?;
    ensure_message_type(&wire, expected_message_type)?;
    envelope_from_wire(&wire)
}

/// Decodes and validates a matching command envelope.
///
/// # Errors
///
/// Returns [`WireError`] for malformed metadata, payload hashes, or command fields.
pub fn decode_command_envelope(bytes: &[u8]) -> Result<DecodedCommand, WireError> {
    const MESSAGE_TYPE: &str = "matchplane.v1.MatchingCommand";
    let wire = v1::EventEnvelope::decode(bytes)?;
    ensure_message_type(&wire, MESSAGE_TYPE)?;
    let envelope = envelope_from_wire(&wire)?;
    let matching = v1::MatchingCommand::decode(wire.payload.as_slice())?;
    let command = matching.command.ok_or(WireError::Missing("command"))?;

    let (kind, placement) = match command {
        v1::matching_command::Command::PlaceLimitOrder(place) => {
            let side = match place.side {
                value if value == v1::OrderSide::Buy as i32 => OrderSide::Buy,
                value if value == v1::OrderSide::Sell as i32 => OrderSide::Sell,
                value => return Err(WireError::OrderSide(value)),
            };
            let intent = OrderIntent {
                order_id: parse_id("order_id", &place.order_id)?,
                tenant_id: parse_id("tenant_id", &place.tenant_id)?,
                domain_id: parse_id("domain_id", &place.domain_id)?,
                market_id: parse_id("market_id", &place.market_id)?,
                side,
                price: Price::new(parse_i128("price", &place.price)?)?,
                quantity: Quantity::new(parse_i128("quantity", &place.quantity)?)?,
                submitted_at: timestamp_from_proto(
                    place
                        .submitted_at
                        .as_ref()
                        .ok_or(WireError::Missing("submitted_at"))?,
                )?,
                expires_at: place
                    .expires_at
                    .as_ref()
                    .map(timestamp_from_proto)
                    .transpose()?,
            };
            let placement = PlacementContext {
                idempotency_key: place.idempotency_key,
                reservation_account_id: parse_id(
                    "reservation_account_id",
                    &place.reservation_account_id,
                )?,
                settlement_account_id: parse_id(
                    "settlement_account_id",
                    &place.settlement_account_id,
                )?,
                reservation_amount: Quantity::new(parse_i128(
                    "reservation_amount",
                    &place.reservation_amount,
                )?)?,
            };
            (
                EngineCommandKind::PlaceLimitOrder { intent },
                Some(placement),
            )
        }
        v1::matching_command::Command::CancelOrder(cancel) => (
            EngineCommandKind::CancelOrder {
                order_id: parse_id("order_id", &cancel.order_id)?,
            },
            None,
        ),
        v1::matching_command::Command::ExpireOrder(expire) => (
            EngineCommandKind::ExpireOrder {
                order_id: parse_id("order_id", &expire.order_id)?,
            },
            None,
        ),
    };

    Ok(DecodedCommand {
        engine_command: EngineCommand {
            command_id: envelope.event_id,
            shard_sequence: envelope.shard_sequence,
            occurred_at: envelope.occurred_at,
            kind,
        },
        envelope,
        placement,
    })
}

/// Encodes one matching fact payload for a domain-event envelope.
#[must_use]
pub fn encode_matching_fact(event: &EngineEvent) -> Vec<u8> {
    let fact = match &event.payload {
        MatchingEvent::OrderAccepted {
            intent,
            accepted_sequence,
        } => v1::matching_fact::Fact::OrderAccepted(v1::OrderAccepted {
            order_id: intent.order_id.to_string(),
            accepted_sequence: *accepted_sequence,
        }),
        MatchingEvent::TradeExecuted { trade } => {
            v1::matching_fact::Fact::TradeExecuted(v1::TradeExecuted {
                trade_id: trade.id.to_string(),
                tenant_id: trade.tenant_id.to_string(),
                domain_id: trade.domain_id.to_string(),
                market_id: trade.market_id.to_string(),
                maker_order_id: trade.maker_order_id.to_string(),
                taker_order_id: trade.taker_order_id.to_string(),
                buy_order_id: trade.buy_order_id.to_string(),
                sell_order_id: trade.sell_order_id.to_string(),
                price: trade.price.to_string(),
                quantity: trade.quantity.to_string(),
                occurred_at: Some(timestamp_to_proto(trade.occurred_at)),
            })
        }
        MatchingEvent::OrderCancelled {
            order_id,
            released_quantity,
        } => v1::matching_fact::Fact::OrderClosed(v1::OrderClosed {
            order_id: order_id.to_string(),
            released_quantity: released_quantity.to_string(),
            status: "cancelled".to_owned(),
        }),
        MatchingEvent::OrderExpired {
            order_id,
            released_quantity,
        } => v1::matching_fact::Fact::OrderClosed(v1::OrderClosed {
            order_id: order_id.to_string(),
            released_quantity: released_quantity.to_string(),
            status: "expired".to_owned(),
        }),
    };
    v1::MatchingFact { fact: Some(fact) }.encode_to_vec()
}

/// Encodes a complete level delta payload.
#[must_use]
pub fn encode_order_book_delta(delta: &v1::OrderBookDelta) -> Vec<u8> {
    delta.encode_to_vec()
}

/// Converts an application timestamp to its Protobuf representation.
#[must_use]
pub fn timestamp_to_proto(value: OffsetDateTime) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: value.unix_timestamp(),
        nanos: i32::try_from(value.nanosecond()).unwrap_or_default(),
    }
}

/// Validates and converts a Protobuf timestamp.
///
/// # Errors
///
/// Returns [`WireError::Timestamp`] when seconds or nanoseconds are outside supported ranges.
pub fn timestamp_from_proto(value: &prost_types::Timestamp) -> Result<OffsetDateTime, WireError> {
    let nanos = u32::try_from(value.nanos)
        .ok()
        .filter(|nanos| *nanos < 1_000_000_000)
        .ok_or_else(|| {
            WireError::Timestamp("nanoseconds must be in 0..1_000_000_000".to_owned())
        })?;
    OffsetDateTime::from_unix_timestamp(value.seconds)
        .and_then(|timestamp| timestamp.replace_nanosecond(nanos))
        .map_err(|error| WireError::Timestamp(error.to_string()))
}

fn envelope_to_wire(
    envelope: &EventEnvelope<Vec<u8>>,
    payload: Vec<u8>,
    message_type: &str,
) -> v1::EventEnvelope {
    v1::EventEnvelope {
        event_id: envelope.event_id.to_string(),
        correlation_id: envelope.correlation_id.to_string(),
        causation_id: envelope.causation_id.to_string(),
        source_node_id: envelope.source_node_id.to_string(),
        tenant_id: envelope.tenant_id.to_string(),
        domain_id: envelope.domain_id.to_string(),
        market_id: envelope.market_id.to_string(),
        shard_id: envelope.shard_id.to_string(),
        shard_sequence: envelope.shard_sequence,
        schema_version: envelope.schema_version,
        occurred_at: Some(timestamp_to_proto(envelope.occurred_at)),
        payload_hash: PayloadHash::from_bytes(&payload).into_bytes().to_vec(),
        stream_kind: stream_kind_to_wire(envelope.stream_kind) as i32,
        message_type: message_type.to_owned(),
        payload,
        traceparent: String::new(),
    }
}

fn ensure_message_type(wire: &v1::EventEnvelope, expected: &'static str) -> Result<(), WireError> {
    if wire.message_type == expected {
        return Ok(());
    }
    Err(WireError::MessageType {
        expected,
        actual: wire.message_type.clone(),
    })
}

fn envelope_from_wire(wire: &v1::EventEnvelope) -> Result<EventEnvelope<Vec<u8>>, WireError> {
    let actual_hash = PayloadHash::from_bytes(&wire.payload);
    if wire.payload_hash.as_slice() != actual_hash.into_bytes() {
        return Err(WireError::PayloadHashMismatch);
    }
    Ok(EventEnvelope {
        event_id: parse_id("event_id", &wire.event_id)?,
        correlation_id: parse_id("correlation_id", &wire.correlation_id)?,
        causation_id: parse_id("causation_id", &wire.causation_id)?,
        source_node_id: parse_id("source_node_id", &wire.source_node_id)?,
        tenant_id: parse_id("tenant_id", &wire.tenant_id)?,
        domain_id: parse_id("domain_id", &wire.domain_id)?,
        market_id: parse_id("market_id", &wire.market_id)?,
        shard_id: parse_id("shard_id", &wire.shard_id)?,
        shard_sequence: wire.shard_sequence,
        schema_version: wire.schema_version,
        stream_kind: stream_kind_from_wire(wire.stream_kind)?,
        occurred_at: timestamp_from_proto(
            wire.occurred_at
                .as_ref()
                .ok_or(WireError::Missing("occurred_at"))?,
        )?,
        payload_hash: actual_hash,
        payload: wire.payload.clone(),
    })
}

fn stream_kind_to_wire(value: StreamKind) -> v1::StreamKind {
    match value {
        StreamKind::Command => v1::StreamKind::Command,
        StreamKind::DomainEvent => v1::StreamKind::DomainEvent,
        StreamKind::OrderBookDelta => v1::StreamKind::OrderBookDelta,
        StreamKind::MarketSummary => v1::StreamKind::MarketSummary,
        StreamKind::Federation => v1::StreamKind::Federation,
        StreamKind::NodeHealth => v1::StreamKind::NodeHealth,
    }
}

fn stream_kind_from_wire(value: i32) -> Result<StreamKind, WireError> {
    match v1::StreamKind::try_from(value).map_err(|_| WireError::StreamKind(value))? {
        v1::StreamKind::Command => Ok(StreamKind::Command),
        v1::StreamKind::DomainEvent => Ok(StreamKind::DomainEvent),
        v1::StreamKind::OrderBookDelta => Ok(StreamKind::OrderBookDelta),
        v1::StreamKind::MarketSummary => Ok(StreamKind::MarketSummary),
        v1::StreamKind::Federation => Ok(StreamKind::Federation),
        v1::StreamKind::NodeHealth => Ok(StreamKind::NodeHealth),
        v1::StreamKind::Unspecified => Err(WireError::StreamKind(value)),
    }
}

fn parse_id<T>(field: &'static str, value: &str) -> Result<T, WireError>
where
    T: FromStr<Err = uuid::Error>,
{
    value
        .parse()
        .map_err(|source| WireError::Uuid { field, source })
}

fn parse_i128(field: &'static str, value: &str) -> Result<i128, WireError> {
    value.parse().map_err(|_| WireError::Integer { field })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_decoder_should_reject_a_different_declared_message_type() {
        let bytes = v1::EventEnvelope {
            message_type: "matchplane.v1.OrderBookDelta".to_owned(),
            ..v1::EventEnvelope::default()
        }
        .encode_to_vec();

        assert!(matches!(
            decode_command_envelope(&bytes),
            Err(WireError::MessageType {
                expected: "matchplane.v1.MatchingCommand",
                ..
            })
        ));
    }

    #[test]
    fn typed_event_decoder_should_check_type_before_domain_metadata() {
        let bytes = v1::EventEnvelope {
            message_type: "matchplane.v1.MatchingFact".to_owned(),
            ..v1::EventEnvelope::default()
        }
        .encode_to_vec();

        assert!(matches!(
            decode_event_envelope_as(&bytes, "matchplane.v1.OrderBookDelta"),
            Err(WireError::MessageType {
                expected: "matchplane.v1.OrderBookDelta",
                ..
            })
        ));
    }
}
