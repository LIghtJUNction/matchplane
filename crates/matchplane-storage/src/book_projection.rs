use std::str::FromStr;

use matchplane_domain::{MarketId, PayloadHash};
use matchplane_protocol::{encode_order_book_delta, v1};
use serde::Deserialize;
use sqlx::Row;

use crate::{BookProjection, BookProjectionLevel, PgStore, StorageError, orders::positive_u64};

#[derive(Debug, Deserialize)]
struct DurableBookProjection {
    market_id: String,
    command_sequence: u64,
    bids: Vec<DurableBookLevel>,
    asks: Vec<DurableBookLevel>,
    state_hash: String,
}

#[derive(Debug, Deserialize)]
struct DurableBookLevel {
    price: String,
    quantity: String,
}

impl PgStore {
    /// Loads the latest PostgreSQL-authoritative full order-book projection for one market.
    ///
    /// The stored JSON is checked against its row sequence, market identity, and deterministic
    /// Protobuf payload hash before it is returned for a Valkey repair.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when PostgreSQL is unavailable or the durable projection fails an
    /// integrity check.
    pub async fn latest_book_projection(
        &self,
        market_id: MarketId,
    ) -> Result<Option<BookProjection>, StorageError> {
        let row = sqlx::query(
            "SELECT shard_sequence, payload, payload_hash FROM domain_events \
             WHERE market_id = $1 AND stream_kind = 'order_book_delta' \
             ORDER BY shard_sequence DESC LIMIT 1",
        )
        .bind(market_id.into_uuid())
        .fetch_optional(self.pool())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };

        let sequence = positive_u64(row.try_get("shard_sequence")?)?;
        let payload: DurableBookProjection = serde_json::from_value(row.try_get("payload")?)
            .map_err(|error| {
                StorageError::InvalidData(format!(
                    "order-book projection payload could not be decoded: {error}"
                ))
            })?;
        if payload.command_sequence != sequence {
            return Err(StorageError::InvalidData(format!(
                "order-book projection sequence mismatch: row {sequence}, payload {}",
                payload.command_sequence
            )));
        }
        let payload_market_id = MarketId::from_str(&payload.market_id).map_err(|error| {
            StorageError::InvalidData(format!(
                "order-book projection market ID is invalid: {error}"
            ))
        })?;
        if payload_market_id != market_id {
            return Err(StorageError::InvalidData(format!(
                "order-book projection market mismatch: requested {market_id}, payload {payload_market_id}"
            )));
        }

        let state_hash: [u8; 32] = hex::decode(&payload.state_hash)
            .map_err(|error| {
                StorageError::InvalidData(format!(
                    "order-book projection state hash is invalid: {error}"
                ))
            })?
            .try_into()
            .map_err(|_| {
                StorageError::InvalidData(
                    "order-book projection state hash is not 32 bytes".to_owned(),
                )
            })?;
        let delta = v1::OrderBookDelta {
            market_id: payload.market_id,
            command_sequence: sequence,
            bids: payload
                .bids
                .iter()
                .map(|level| v1::PriceLevel {
                    price: level.price.clone(),
                    quantity: level.quantity.clone(),
                })
                .collect(),
            asks: payload
                .asks
                .iter()
                .map(|level| v1::PriceLevel {
                    price: level.price.clone(),
                    quantity: level.quantity.clone(),
                })
                .collect(),
            state_hash: state_hash.to_vec(),
        };
        let actual_payload_hash = PayloadHash::from_bytes(&encode_order_book_delta(&delta));
        let stored_payload_hash: Vec<u8> = row.try_get("payload_hash")?;
        if stored_payload_hash.as_slice() != actual_payload_hash.into_bytes() {
            return Err(StorageError::InvalidData(
                "order-book projection payload hash mismatch".to_owned(),
            ));
        }

        Ok(Some(BookProjection {
            market_id,
            sequence,
            bids: payload
                .bids
                .into_iter()
                .map(|level| BookProjectionLevel {
                    price: level.price,
                    quantity: level.quantity,
                })
                .collect(),
            asks: payload
                .asks
                .into_iter()
                .map(|level| BookProjectionLevel {
                    price: level.price,
                    quantity: level.quantity,
                })
                .collect(),
            state_hash: PayloadHash::from_digest(state_hash),
        }))
    }
}
