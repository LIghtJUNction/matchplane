//! Generated MatchPlane wire protocol and checked domain conversions.

/// Version 1 of the public and federation protocol.
pub mod v1 {
    tonic::include_proto!("matchplane.v1");
}

mod wire;

pub use wire::{
    DecodedCommand, PlacementContext, WireError, decode_command_envelope, decode_event_envelope,
    decode_event_envelope_as, encode_command_envelope, encode_event_envelope, encode_matching_fact,
    encode_order_book_delta, timestamp_from_proto, timestamp_to_proto,
};
