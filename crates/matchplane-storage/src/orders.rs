use matchplane_domain::{
    CausationId, EngineCommand, EngineCommandKind, EventEnvelope, EventId, OrderSide, OrderStatus,
    PayloadHash, StreamKind,
};
use matchplane_events::topics;
use matchplane_protocol::{encode_event_envelope, timestamp_to_proto, v1};
use prost::Message;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;

use crate::{
    PgStore, StorageError, StoredOrder, StoredTrade, SubmitOrder, SubmitOrderOutcome,
    types::MarketContext,
};

impl PgStore {
    /// Persists a new order and its command outbox record in one serializable transaction.
    ///
    /// An identical tenant/idempotency-key request returns the original result. Reusing the key
    /// with different payload bytes is rejected.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for invalid scope, an idempotency conflict, or a failed database
    /// transaction.
    pub async fn submit_order(
        &self,
        request: &SubmitOrder,
    ) -> Result<SubmitOrderOutcome, StorageError> {
        validate_reservation(request)?;
        if request.idempotency_key.is_empty() || request.idempotency_key.len() > 200 {
            return Err(StorageError::InvalidData(
                "idempotency key length must be in 1..=200".to_owned(),
            ));
        }

        let matching_command = matching_command(request);
        let command_payload = matching_command.encode_to_vec();
        let request_hash = PayloadHash::from_bytes(&command_payload);
        let mut transaction = self.pool().begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!(
                "{}:{}",
                request.intent.tenant_id, request.idempotency_key
            ))
            .execute(&mut *transaction)
            .await?;

        if let Some(existing) = sqlx::query(
            "SELECT id, command_event_id, command_sequence, idempotency_payload_hash \
             FROM orders WHERE tenant_id = $1 AND idempotency_key = $2",
        )
        .bind(request.intent.tenant_id.into_uuid())
        .bind(&request.idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash: Vec<u8> = existing.try_get("idempotency_payload_hash")?;
            if stored_hash.as_slice() != request_hash.into_bytes() {
                return Err(StorageError::IdempotencyConflict);
            }
            let result = SubmitOrderOutcome {
                order_id: matchplane_domain::OrderId::from_uuid(existing.try_get("id")?),
                command_id: EventId::from_uuid(existing.try_get("command_event_id")?),
                shard_sequence: positive_u64(existing.try_get("command_sequence")?)?,
                duplicate: true,
            };
            transaction.commit().await?;
            return Ok(result);
        }

        let market = allocate_command_sequence(
            &mut transaction,
            request.intent.tenant_id.into_uuid(),
            request.intent.domain_id.into_uuid(),
            request.intent.market_id.into_uuid(),
        )
        .await?;
        ensure_account_scope(
            &mut transaction,
            request.intent.tenant_id.into_uuid(),
            request.reservation_account_id.into_uuid(),
            request.settlement_account_id.into_uuid(),
            request.intent.side,
            &market.0,
        )
        .await?;
        let command_id = EventId::new();
        let command = EngineCommand {
            command_id,
            shard_sequence: market.1,
            occurred_at: request.intent.submitted_at,
            kind: EngineCommandKind::PlaceLimitOrder {
                intent: request.intent.clone(),
            },
        };
        let envelope = EventEnvelope {
            event_id: command_id,
            correlation_id: request.correlation_id,
            causation_id: CausationId::from(command_id),
            source_node_id: request.source_node_id,
            tenant_id: market.0.tenant_id,
            domain_id: market.0.domain_id,
            market_id: market.0.market_id,
            shard_id: market.0.shard_id,
            shard_sequence: market.1,
            schema_version: 1,
            stream_kind: StreamKind::Command,
            occurred_at: request.intent.submitted_at,
            payload_hash: request_hash,
            payload: command_payload,
        };
        let wire_payload = encode_event_envelope(&envelope, "matchplane.v1.MatchingCommand");

        sqlx::query(
            "INSERT INTO orders \
             (id, tenant_id, domain_id, market_id, reservation_account_id, settlement_account_id, \
              side, price, original_quantity, remaining_quantity, status, command_event_id, \
              command_sequence, idempotency_key, idempotency_payload_hash, submitted_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $9::numeric, \
                     'pending', $10, $11, $12, $13, $14, $15)",
        )
        .bind(request.intent.order_id.into_uuid())
        .bind(request.intent.tenant_id.into_uuid())
        .bind(request.intent.domain_id.into_uuid())
        .bind(request.intent.market_id.into_uuid())
        .bind(request.reservation_account_id.into_uuid())
        .bind(request.settlement_account_id.into_uuid())
        .bind(side_text(request.intent.side))
        .bind(request.intent.price.to_string())
        .bind(request.intent.quantity.to_string())
        .bind(command_id.into_uuid())
        .bind(i64_sequence(market.1)?)
        .bind(&request.idempotency_key)
        .bind(request_hash.into_bytes().to_vec())
        .bind(request.intent.submitted_at)
        .bind(request.intent.expires_at)
        .execute(&mut *transaction)
        .await?;

        hold_submission_reservation(
            &mut transaction,
            request,
            command_id,
            request
                .intent
                .expires_at
                .unwrap_or_else(|| OffsetDateTime::now_utc() + time::Duration::hours(24)),
        )
        .await?;

        sqlx::query(
            "INSERT INTO command_log \
             (event_id, correlation_id, causation_id, source_node_id, tenant_id, domain_id, \
              market_id, shard_id, shard_sequence, schema_version, occurred_at, payload_hash, \
              command_type, payload) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, \
                     'place_limit_order', $12)",
        )
        .bind(command_id.into_uuid())
        .bind(request.correlation_id.into_uuid())
        .bind(command_id.into_uuid())
        .bind(request.source_node_id.into_uuid())
        .bind(request.intent.tenant_id.into_uuid())
        .bind(request.intent.domain_id.into_uuid())
        .bind(request.intent.market_id.into_uuid())
        .bind(market.0.shard_id.into_uuid())
        .bind(i64_sequence(market.1)?)
        .bind(request.intent.submitted_at)
        .bind(request_hash.into_bytes().to_vec())
        .bind(serde_json::to_value(&command)?)
        .execute(&mut *transaction)
        .await?;

        insert_outbox(
            &mut transaction,
            &envelope,
            topics::COMMANDS,
            &request.intent.market_id.to_string(),
            &wire_payload,
        )
        .await?;
        transaction.commit().await?;
        Ok(SubmitOrderOutcome {
            order_id: request.intent.order_id,
            command_id,
            shard_sequence: market.1,
            duplicate: false,
        })
    }

    /// Loads one authoritative order projection.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::NotFound`] for an unknown order.
    pub async fn order(
        &self,
        order_id: matchplane_domain::OrderId,
    ) -> Result<StoredOrder, StorageError> {
        let row = sqlx::query(
            "SELECT id, tenant_id, domain_id, market_id, side, price::text AS price, \
                    original_quantity::text AS original_quantity, \
                    (original_quantity - remaining_quantity)::text AS filled_quantity, \
                    remaining_quantity::text AS remaining_quantity, status, accepted_sequence, \
                    federated_reserved_quantity::text AS federated_reserved_quantity, \
                    (remaining_quantity - federated_reserved_quantity)::text \
                        AS locally_available_quantity, \
                    idempotency_key, submitted_at \
             FROM orders WHERE id = $1",
        )
        .bind(order_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::NotFound("order"))?;
        stored_order(&row)
    }

    /// Loads an exact buyer or seller balance from PostgreSQL.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::NotFound`] for an unknown account.
    pub async fn account(
        &self,
        account_id: matchplane_domain::AccountId,
    ) -> Result<crate::StoredAccount, StorageError> {
        let row = sqlx::query(
            "SELECT id, tenant_id, owner_key, asset_key, available_amount::text AS available_amount, \
                    reserved_amount::text AS reserved_amount, version \
             FROM accounts WHERE id = $1",
        )
        .bind(account_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or(StorageError::NotFound("account"))?;
        Ok(crate::StoredAccount {
            account_id: matchplane_domain::AccountId::from_uuid(row.try_get("id")?),
            tenant_id: matchplane_domain::TenantId::from_uuid(row.try_get("tenant_id")?),
            owner_key: row.try_get("owner_key")?,
            asset_key: row.try_get("asset_key")?,
            available_amount: row.try_get("available_amount")?,
            reserved_amount: row.try_get("reserved_amount")?,
            version: row.try_get("version")?,
        })
    }

    /// Returns recent immutable trade facts for a market.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] if the query or stored value conversion fails.
    pub async fn recent_trades(
        &self,
        market_id: matchplane_domain::MarketId,
        limit: i64,
    ) -> Result<Vec<StoredTrade>, StorageError> {
        let rows = sqlx::query(
            "SELECT id, maker_order_id, taker_order_id, buy_order_id, sell_order_id, \
                    price::text AS price, quantity::text AS quantity, \
                    gross_amount::text AS gross_amount, commission_bps, \
                    commission_amount::text AS commission_amount, \
                    seller_net_amount::text AS seller_net_amount, occurred_at \
             FROM trades WHERE market_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2",
        )
        .bind(market_id.into_uuid())
        .bind(limit.clamp(1, 500))
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(stored_trade).collect()
    }
}

fn matching_command(request: &SubmitOrder) -> v1::MatchingCommand {
    v1::MatchingCommand {
        command: Some(v1::matching_command::Command::PlaceLimitOrder(
            v1::PlaceLimitOrder {
                order_id: request.intent.order_id.to_string(),
                tenant_id: request.intent.tenant_id.to_string(),
                domain_id: request.intent.domain_id.to_string(),
                market_id: request.intent.market_id.to_string(),
                side: match request.intent.side {
                    OrderSide::Buy => v1::OrderSide::Buy as i32,
                    OrderSide::Sell => v1::OrderSide::Sell as i32,
                },
                price: request.intent.price.to_string(),
                quantity: request.intent.quantity.to_string(),
                submitted_at: Some(timestamp_to_proto(request.intent.submitted_at)),
                expires_at: request.intent.expires_at.map(timestamp_to_proto),
                idempotency_key: request.idempotency_key.clone(),
                reservation_account_id: request.reservation_account_id.to_string(),
                settlement_account_id: request.settlement_account_id.to_string(),
                reservation_amount: request.reservation_amount.to_string(),
            },
        )),
    }
}

fn validate_reservation(request: &SubmitOrder) -> Result<(), StorageError> {
    let expected = match request.intent.side {
        OrderSide::Buy => request
            .intent
            .price
            .checked_mul(request.intent.quantity)
            .map_err(|error| StorageError::InvalidData(error.to_string()))?
            .value(),
        OrderSide::Sell => request.intent.quantity.value(),
    };
    if request.reservation_amount.value() != expected {
        return Err(StorageError::InvalidData(format!(
            "reservation amount must be {expected} for this order"
        )));
    }
    Ok(())
}

async fn ensure_account_scope(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: uuid::Uuid,
    reservation_account_id: uuid::Uuid,
    settlement_account_id: uuid::Uuid,
    side: OrderSide,
    market: &MarketContext,
) -> Result<(), StorageError> {
    if reservation_account_id == settlement_account_id {
        return Err(StorageError::InvalidData(
            "reservation and settlement accounts must be distinct accounts in the tenant"
                .to_owned(),
        ));
    }
    let rows = sqlx::query(
        "SELECT id, asset_key FROM accounts WHERE tenant_id = $1 AND id = ANY($2) FOR UPDATE",
    )
    .bind(tenant_id)
    .bind(vec![reservation_account_id, settlement_account_id])
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != 2 {
        return Err(StorageError::InvalidData(
            "both order accounts must belong to the tenant".to_owned(),
        ));
    }
    let asset_for = |account_id| {
        rows.iter().find_map(|row| {
            let id: uuid::Uuid = row.try_get("id").ok()?;
            (id == account_id).then(|| row.try_get::<String, _>("asset_key").ok())?
        })
    };
    let reservation_asset = asset_for(reservation_account_id).ok_or_else(|| {
        StorageError::InvalidData("reservation account is outside the tenant".to_owned())
    })?;
    let settlement_asset = asset_for(settlement_account_id).ok_or_else(|| {
        StorageError::InvalidData("settlement account is outside the tenant".to_owned())
    })?;
    let (expected_reservation, expected_settlement) = match side {
        OrderSide::Buy => (&market.quote_asset_key, &market.base_asset_key),
        OrderSide::Sell => (&market.base_asset_key, &market.quote_asset_key),
    };
    if &reservation_asset != expected_reservation || &settlement_asset != expected_settlement {
        return Err(StorageError::InvalidData(format!(
            "{side:?} order requires {expected_reservation} reservation and \
             {expected_settlement} settlement accounts"
        )));
    }
    Ok(())
}

async fn hold_submission_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    request: &SubmitOrder,
    command_id: EventId,
    expires_at: OffsetDateTime,
) -> Result<(), StorageError> {
    let updated = sqlx::query(
        "UPDATE accounts SET available_amount = available_amount - $3::numeric, \
                reserved_amount = reserved_amount + $3::numeric, version = version + 1 \
         WHERE id = $1 AND tenant_id = $2 AND available_amount >= $3::numeric",
    )
    .bind(request.reservation_account_id.into_uuid())
    .bind(request.intent.tenant_id.into_uuid())
    .bind(request.reservation_amount.to_string())
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StorageError::InsufficientBalance);
    }
    sqlx::query(
        "INSERT INTO reservations \
         (id, tenant_id, order_id, account_id, quantity, remaining_quantity, status, \
          idempotency_key, fencing_token, expires_at) \
         VALUES ($1, $2, $3, $4, $5::numeric, $5::numeric, 'pending', $6, 0, $7)",
    )
    .bind(matchplane_domain::ReservationId::derive(command_id).into_uuid())
    .bind(request.intent.tenant_id.into_uuid())
    .bind(request.intent.order_id.into_uuid())
    .bind(request.reservation_account_id.into_uuid())
    .bind(request.reservation_amount.to_string())
    .bind(&request.idempotency_key)
    .bind(expires_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn allocate_command_sequence(
    transaction: &mut Transaction<'_, Postgres>,
    tenant_id: uuid::Uuid,
    domain_id: uuid::Uuid,
    market_id: uuid::Uuid,
) -> Result<(MarketContext, u64), StorageError> {
    let row = sqlx::query(
        "UPDATE markets SET next_command_sequence = next_command_sequence + 1, version = version + 1 \
         WHERE id = $1 AND tenant_id = $2 AND domain_id = $3 AND status = 'active' \
         RETURNING tenant_id, domain_id, id, shard_id, base_asset_key, quote_asset_key, \
                   next_command_sequence - 1 AS sequence",
    )
    .bind(market_id)
    .bind(tenant_id)
    .bind(domain_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("active market"))?;
    Ok((
        MarketContext {
            tenant_id: matchplane_domain::TenantId::from_uuid(row.try_get("tenant_id")?),
            domain_id: matchplane_domain::DomainId::from_uuid(row.try_get("domain_id")?),
            market_id: matchplane_domain::MarketId::from_uuid(row.try_get("id")?),
            shard_id: matchplane_domain::ShardId::from_uuid(row.try_get("shard_id")?),
            base_asset_key: row.try_get("base_asset_key")?,
            quote_asset_key: row.try_get("quote_asset_key")?,
        },
        positive_u64(row.try_get("sequence")?)?,
    ))
}

pub(crate) async fn insert_outbox(
    transaction: &mut Transaction<'_, Postgres>,
    envelope: &EventEnvelope<Vec<u8>>,
    topic: &str,
    message_key: &str,
    wire_payload: &[u8],
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO outbox_events \
         (event_id, correlation_id, causation_id, source_node_id, tenant_id, domain_id, market_id, \
          shard_id, shard_sequence, stream_kind, schema_version, occurred_at, payload_hash, topic, \
          message_key, payload) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
    )
    .bind(envelope.event_id.into_uuid())
    .bind(envelope.correlation_id.into_uuid())
    .bind(envelope.causation_id.into_uuid())
    .bind(envelope.source_node_id.into_uuid())
    .bind(envelope.tenant_id.into_uuid())
    .bind(envelope.domain_id.into_uuid())
    .bind(envelope.market_id.into_uuid())
    .bind(envelope.shard_id.into_uuid())
    .bind(i64_sequence(envelope.shard_sequence)?)
    .bind(stream_kind_text(envelope.stream_kind))
    .bind(i32::try_from(envelope.schema_version).map_err(|_| {
        StorageError::InvalidData("schema version exceeds PostgreSQL integer".to_owned())
    })?)
    .bind(envelope.occurred_at)
    .bind(envelope.payload_hash.into_bytes().to_vec())
    .bind(topic)
    .bind(message_key)
    .bind(wire_payload)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(crate) const fn stream_kind_text(kind: StreamKind) -> &'static str {
    match kind {
        StreamKind::Command => "command",
        StreamKind::DomainEvent => "domain_event",
        StreamKind::OrderBookDelta => "order_book_delta",
        StreamKind::MarketSummary => "market_summary",
        StreamKind::Federation => "federation",
        StreamKind::NodeHealth => "node_health",
    }
}

pub(crate) fn i64_sequence(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value)
        .map_err(|_| StorageError::InvalidData("sequence exceeds PostgreSQL bigint".to_owned()))
}

pub(crate) fn positive_u64(value: i64) -> Result<u64, StorageError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| StorageError::InvalidData("sequence is not positive".to_owned()))
}

fn side_text(side: OrderSide) -> &'static str {
    match side {
        OrderSide::Buy => "buy",
        OrderSide::Sell => "sell",
    }
}

fn stored_order(row: &sqlx::postgres::PgRow) -> Result<StoredOrder, StorageError> {
    let accepted_sequence: Option<i64> = row.try_get("accepted_sequence")?;
    Ok(StoredOrder {
        order_id: matchplane_domain::OrderId::from_uuid(row.try_get("id")?),
        tenant_id: matchplane_domain::TenantId::from_uuid(row.try_get("tenant_id")?),
        domain_id: matchplane_domain::DomainId::from_uuid(row.try_get("domain_id")?),
        market_id: matchplane_domain::MarketId::from_uuid(row.try_get("market_id")?),
        side: parse_side(row.try_get("side")?)?,
        price: row.try_get("price")?,
        original_quantity: row.try_get("original_quantity")?,
        filled_quantity: row.try_get("filled_quantity")?,
        remaining_quantity: row.try_get("remaining_quantity")?,
        federated_reserved_quantity: row.try_get("federated_reserved_quantity")?,
        locally_available_quantity: row.try_get("locally_available_quantity")?,
        status: parse_status(row.try_get("status")?)?,
        accepted_sequence: accepted_sequence.map(positive_u64).transpose()?,
        idempotency_key: row.try_get("idempotency_key")?,
        submitted_at: row.try_get("submitted_at")?,
    })
}

fn stored_trade(row: &sqlx::postgres::PgRow) -> Result<StoredTrade, StorageError> {
    Ok(StoredTrade {
        trade_id: matchplane_domain::TradeId::from_uuid(row.try_get("id")?),
        maker_order_id: matchplane_domain::OrderId::from_uuid(row.try_get("maker_order_id")?),
        taker_order_id: matchplane_domain::OrderId::from_uuid(row.try_get("taker_order_id")?),
        buy_order_id: matchplane_domain::OrderId::from_uuid(row.try_get("buy_order_id")?),
        sell_order_id: matchplane_domain::OrderId::from_uuid(row.try_get("sell_order_id")?),
        price: row.try_get("price")?,
        quantity: row.try_get("quantity")?,
        gross_amount: row.try_get("gross_amount")?,
        commission_bps: row.try_get("commission_bps")?,
        commission_amount: row.try_get("commission_amount")?,
        seller_net_amount: row.try_get("seller_net_amount")?,
        occurred_at: row.try_get("occurred_at")?,
    })
}

fn parse_side(value: &str) -> Result<OrderSide, StorageError> {
    match value {
        "buy" => Ok(OrderSide::Buy),
        "sell" => Ok(OrderSide::Sell),
        other => Err(StorageError::InvalidData(format!(
            "unknown order side {other}"
        ))),
    }
}

fn parse_status(value: &str) -> Result<OrderStatus, StorageError> {
    match value {
        "pending" => Ok(OrderStatus::Pending),
        "open" => Ok(OrderStatus::Open),
        "partially_filled" => Ok(OrderStatus::PartiallyFilled),
        "filled" => Ok(OrderStatus::Filled),
        "cancelled" => Ok(OrderStatus::Cancelled),
        "expired" => Ok(OrderStatus::Expired),
        "rejected" => Ok(OrderStatus::Rejected),
        other => Err(StorageError::InvalidData(format!(
            "unknown order status {other}"
        ))),
    }
}
