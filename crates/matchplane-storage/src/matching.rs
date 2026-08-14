use std::collections::BTreeSet;

use matchplane_domain::{
    CausationId, EngineEvent, EventEnvelope, EventId, FederationNodeId, LedgerEntryId,
    MatchingEvent, OrderId, OrderSide, OrderStatus, PayloadHash, StreamKind, Trade,
};
use matchplane_engine::OrderBook;
use matchplane_events::topics;
use matchplane_payments::calculate_commission;
use matchplane_protocol::{
    DecodedCommand, encode_event_envelope, encode_matching_fact, encode_order_book_delta, v1,
};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::{
    BookSnapshot, MatchCommitOutcome, PgStore, StorageError,
    federation::expire_federated_reservations,
    orders::{i64_sequence, insert_outbox, positive_u64},
};

impl PgStore {
    /// Restores a market from its latest verified snapshot and any later durable engine events.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when a checksum is invalid, event JSON is corrupt, or replay
    /// violates an engine invariant.
    pub async fn recover_order_book(
        &self,
        market_id: matchplane_domain::MarketId,
    ) -> Result<(OrderBook, u64), StorageError> {
        let snapshot = self.latest_snapshot(market_id).await?;
        let (mut book, event_sequence) = if let Some(snapshot) = snapshot {
            let actual = PayloadHash::from_bytes(&snapshot.state);
            if actual != snapshot.checksum {
                return Err(StorageError::InvalidData(
                    "order-book snapshot checksum mismatch".to_owned(),
                ));
            }
            (
                OrderBook::from_snapshot_bytes(&snapshot.state)?,
                snapshot.last_event_sequence,
            )
        } else {
            (OrderBook::new(market_id), 0)
        };

        let rows = sqlx::query(
            "SELECT shard_sequence, payload FROM domain_events \
             WHERE market_id = $1 AND stream_kind = 'domain_event' AND shard_sequence > $2 \
             ORDER BY shard_sequence",
        )
        .bind(market_id.into_uuid())
        .bind(i64::try_from(event_sequence).map_err(|_| {
            StorageError::InvalidData("snapshot event sequence exceeds bigint".to_owned())
        })?)
        .fetch_all(self.pool())
        .await?;
        let mut expected = event_sequence.saturating_add(1);
        let mut last = event_sequence;
        for row in rows {
            let sequence = positive_u64(row.try_get("shard_sequence")?)?;
            if sequence != expected {
                return Err(StorageError::InvalidData(format!(
                    "domain-event replay gap: expected {expected}, found {sequence}"
                )));
            }
            let payload: serde_json::Value = row.try_get("payload")?;
            let event: EngineEvent = serde_json::from_value(payload)?;
            let _ = book.apply(&event)?;
            last = sequence;
            expected = expected.saturating_add(1);
        }
        Ok((book, last))
    }

    /// Atomically commits one consumed command, its reservation/settlement effects, authoritative
    /// events, outbox messages, and a checksum-protected snapshot.
    ///
    /// The caller must pass the cloned engine state *after* applying `events`; database failure
    /// therefore leaves the service free to discard the clone without diverging from PostgreSQL.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] on an inbox mismatch, a lost shard lease, insufficient reserved
    /// capacity, or any failed transaction.
    pub async fn commit_matching(
        &self,
        consumer_name: &str,
        owner_instance_id: &str,
        owner_node_id: FederationNodeId,
        decoded: &DecodedCommand,
        book: &OrderBook,
        events: &[EngineEvent],
    ) -> Result<MatchCommitOutcome, StorageError> {
        if events.is_empty() {
            return self.duplicate_inbox_result(consumer_name, decoded).await;
        }
        let mut transaction = self.pool().begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *transaction)
            .await?;
        expire_federated_reservations(&mut transaction, decoded.envelope.market_id.into_uuid())
            .await?;
        let inbox_inserted = sqlx::query(
            "INSERT INTO consumer_inbox \
             (consumer_name, event_id, source_node_id, shard_id, shard_sequence, stream_kind, payload_hash) \
             VALUES ($1, $2, $3, $4, $5, 'command', $6) ON CONFLICT DO NOTHING",
        )
        .bind(consumer_name)
        .bind(decoded.envelope.event_id.into_uuid())
        .bind(decoded.envelope.source_node_id.into_uuid())
        .bind(decoded.envelope.shard_id.into_uuid())
        .bind(i64_sequence(decoded.envelope.shard_sequence)?)
        .bind(decoded.envelope.payload_hash.into_bytes().to_vec())
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if inbox_inserted == 0 {
            let duplicate = verify_existing_inbox(&mut transaction, consumer_name, decoded).await?;
            transaction.commit().await?;
            return Ok(duplicate);
        }

        verify_pending_command(&mut transaction, decoded).await?;
        let fencing_token =
            acquire_lease(&mut transaction, decoded, owner_instance_id, owner_node_id).await?;
        if let Some(placement) = &decoded.placement {
            hold_reservation(&mut transaction, decoded, placement, fencing_token).await?;
        }

        for event in events {
            if let MatchingEvent::TradeExecuted { trade } = &event.payload {
                settle_trade(&mut transaction, event.event_id, trade).await?;
            }
        }
        if let Some((order_id, reservation_status)) = closing_order(events) {
            release_reservation(&mut transaction, order_id, reservation_status).await?;
        }
        persist_order_projections(&mut transaction, book, events).await?;

        let fact_start = allocate_event_sequences(
            &mut transaction,
            decoded.envelope.market_id.into_uuid(),
            i64::try_from(events.len()).map_err(|_| {
                StorageError::InvalidData("too many events in one command".to_owned())
            })?,
        )
        .await?;
        for (ordinal, event) in events.iter().enumerate() {
            let sequence = fact_start
                .checked_add(u64::try_from(ordinal).map_err(|_| {
                    StorageError::InvalidData("event ordinal exceeds u64".to_owned())
                })?)
                .ok_or_else(|| StorageError::InvalidData("event sequence overflow".to_owned()))?;
            persist_domain_event(
                &mut transaction,
                decoded,
                owner_node_id,
                fencing_token,
                sequence,
                event,
            )
            .await?;
        }

        let last_event_sequence = fact_start
            .checked_add(
                u64::try_from(events.len() - 1)
                    .map_err(|_| StorageError::InvalidData("event count exceeds u64".to_owned()))?,
            )
            .ok_or_else(|| StorageError::InvalidData("event sequence overflow".to_owned()))?;
        persist_book_delta(
            &mut transaction,
            decoded,
            owner_node_id,
            fencing_token,
            book,
        )
        .await?;
        persist_snapshot(&mut transaction, decoded, last_event_sequence, book).await?;

        sqlx::query(
            "UPDATE command_log SET status = 'applied' WHERE event_id = $1 AND status = 'pending'",
        )
        .bind(decoded.envelope.event_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE consumer_inbox SET status = 'applied', applied_at = clock_timestamp() \
             WHERE consumer_name = $1 AND event_id = $2 AND status = 'processing'",
        )
        .bind(consumer_name)
        .bind(decoded.envelope.event_id.into_uuid())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(MatchCommitOutcome::Applied)
    }

    async fn duplicate_inbox_result(
        &self,
        consumer_name: &str,
        decoded: &DecodedCommand,
    ) -> Result<MatchCommitOutcome, StorageError> {
        let row = sqlx::query(
            "SELECT payload_hash, status FROM consumer_inbox \
             WHERE consumer_name = $1 AND event_id = $2",
        )
        .bind(consumer_name)
        .bind(decoded.envelope.event_id.into_uuid())
        .fetch_optional(self.pool())
        .await?
        .ok_or_else(|| {
            StorageError::InvalidData(
                "engine returned no events but consumer inbox has no applied command".to_owned(),
            )
        })?;
        let hash: Vec<u8> = row.try_get("payload_hash")?;
        let status: String = row.try_get("status")?;
        if hash.as_slice() != decoded.envelope.payload_hash.into_bytes() || status != "applied" {
            return Err(StorageError::InvalidData(
                "duplicate command does not match an applied inbox record".to_owned(),
            ));
        }
        Ok(MatchCommitOutcome::Duplicate)
    }

    async fn latest_snapshot(
        &self,
        market_id: matchplane_domain::MarketId,
    ) -> Result<Option<BookSnapshot>, StorageError> {
        let row = sqlx::query(
            "SELECT last_event_sequence, state, checksum FROM order_book_snapshots \
             WHERE market_id = $1 ORDER BY last_event_sequence DESC LIMIT 1",
        )
        .bind(market_id.into_uuid())
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| {
            let checksum: Vec<u8> = row.try_get("checksum")?;
            let checksum: [u8; 32] = checksum.try_into().map_err(|_| {
                StorageError::InvalidData("snapshot checksum is not 32 bytes".to_owned())
            })?;
            Ok(BookSnapshot {
                last_event_sequence: positive_u64(row.try_get("last_event_sequence")?)?,
                state: row.try_get("state")?,
                checksum: PayloadHash::from_digest(checksum),
            })
        })
        .transpose()
    }
}

async fn verify_existing_inbox(
    transaction: &mut Transaction<'_, Postgres>,
    consumer_name: &str,
    decoded: &DecodedCommand,
) -> Result<MatchCommitOutcome, StorageError> {
    let row = sqlx::query(
        "SELECT payload_hash, status FROM consumer_inbox \
         WHERE consumer_name = $1 AND event_id = $2 FOR UPDATE",
    )
    .bind(consumer_name)
    .bind(decoded.envelope.event_id.into_uuid())
    .fetch_one(&mut **transaction)
    .await?;
    let hash: Vec<u8> = row.try_get("payload_hash")?;
    let status: String = row.try_get("status")?;
    if hash.as_slice() != decoded.envelope.payload_hash.into_bytes() {
        return Err(StorageError::InvalidData(
            "inbox event ID was reused with a different payload".to_owned(),
        ));
    }
    if status != "applied" {
        return Err(StorageError::InvalidData(format!(
            "existing inbox record is unexpectedly {status}"
        )));
    }
    Ok(MatchCommitOutcome::Duplicate)
}

async fn verify_pending_command(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
) -> Result<(), StorageError> {
    let row = sqlx::query(
        "SELECT payload_hash, shard_sequence, status FROM command_log WHERE event_id = $1 FOR UPDATE",
    )
    .bind(decoded.envelope.event_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("command log entry"))?;
    let hash: Vec<u8> = row.try_get("payload_hash")?;
    let sequence = positive_u64(row.try_get("shard_sequence")?)?;
    let status: String = row.try_get("status")?;
    if hash.as_slice() != decoded.envelope.payload_hash.into_bytes()
        || sequence != decoded.envelope.shard_sequence
        || status != "pending"
    {
        return Err(StorageError::InvalidData(
            "Kafka command does not match its pending PostgreSQL command log".to_owned(),
        ));
    }
    Ok(())
}

async fn acquire_lease(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
    owner_instance_id: &str,
    owner_node_id: FederationNodeId,
) -> Result<i64, StorageError> {
    let row = sqlx::query(
        "INSERT INTO shard_leases \
         (market_id, shard_id, owner_node_id, owner_instance_id, fencing_token, routing_epoch, expires_at) \
         SELECT id, shard_id, $3, $4, 1, routing_epoch, clock_timestamp() + INTERVAL '15 seconds' \
         FROM markets WHERE id = $1 AND shard_id = $2 \
         ON CONFLICT (market_id) DO UPDATE SET \
             owner_node_id = EXCLUDED.owner_node_id, \
             owner_instance_id = EXCLUDED.owner_instance_id, \
             fencing_token = CASE \
                 WHEN shard_leases.owner_instance_id = EXCLUDED.owner_instance_id \
                  AND shard_leases.owner_node_id = EXCLUDED.owner_node_id \
                 THEN shard_leases.fencing_token ELSE shard_leases.fencing_token + 1 END, \
             routing_epoch = EXCLUDED.routing_epoch, heartbeat_at = clock_timestamp(), \
             expires_at = clock_timestamp() + INTERVAL '15 seconds' \
         WHERE (shard_leases.owner_instance_id = EXCLUDED.owner_instance_id \
                AND shard_leases.owner_node_id = EXCLUDED.owner_node_id) \
            OR shard_leases.expires_at <= clock_timestamp() \
         RETURNING fencing_token",
    )
    .bind(decoded.envelope.market_id.into_uuid())
    .bind(decoded.envelope.shard_id.into_uuid())
    .bind(owner_node_id.into_uuid())
    .bind(owner_instance_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::LeaseUnavailable)?;
    let fencing_token: i64 = row.try_get("fencing_token")?;
    if fencing_token <= 0 {
        return Err(StorageError::InvalidData(
            "lease returned a non-positive fencing token".to_owned(),
        ));
    }
    Ok(fencing_token)
}

async fn hold_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
    placement: &matchplane_protocol::PlacementContext,
    fencing_token: i64,
) -> Result<(), StorageError> {
    let updated = sqlx::query(
        "UPDATE reservations SET status = 'held', fencing_token = $5, version = version + 1 \
         WHERE tenant_id = $1 AND order_id = $2 AND account_id = $3 \
           AND quantity = $4::numeric AND remaining_quantity = $4::numeric \
           AND idempotency_key = $6 AND status = 'pending' AND fencing_token = 0",
    )
    .bind(decoded.envelope.tenant_id.into_uuid())
    .bind(match &decoded.engine_command.kind {
        matchplane_domain::EngineCommandKind::PlaceLimitOrder { intent } => {
            intent.order_id.into_uuid()
        }
        _ => unreachable_for_validated_placement()?,
    })
    .bind(placement.reservation_account_id.into_uuid())
    .bind(placement.reservation_amount.to_string())
    .bind(fencing_token)
    .bind(&placement.idempotency_key)
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StorageError::InvalidData(
            "pending order reservation is missing or does not match the command".to_owned(),
        ));
    }
    Ok(())
}

fn unreachable_for_validated_placement() -> Result<Uuid, StorageError> {
    Err(StorageError::InvalidData(
        "validated placement command changed variants".to_owned(),
    ))
}

async fn settle_trade(
    transaction: &mut Transaction<'_, Postgres>,
    event_id: EventId,
    trade: &Trade,
) -> Result<(), StorageError> {
    let actual_amount = trade
        .price
        .checked_mul(trade.quantity)
        .map_err(|error| StorageError::InvalidData(error.to_string()))?
        .value();
    let buy = settlement_accounts(transaction, trade.buy_order_id).await?;
    let sell = settlement_accounts(transaction, trade.sell_order_id).await?;
    if buy.side != OrderSide::Buy || sell.side != OrderSide::Sell {
        return Err(StorageError::InvalidData(
            "trade order sides contradict buy/sell identifiers".to_owned(),
        ));
    }
    let buy_hold = buy
        .limit_price
        .checked_mul(trade.quantity.value())
        .ok_or_else(|| StorageError::InvalidData("buy hold arithmetic overflow".to_owned()))?;
    let improvement = buy_hold
        .checked_sub(actual_amount)
        .filter(|value| *value >= 0)
        .ok_or_else(|| StorageError::InvalidData("execution exceeded buy limit".to_owned()))?;
    let commission_policy = sqlx::query(
        "SELECT commission_bps, platform_commission_account_id FROM markets \
         WHERE tenant_id = $1 AND id = $2 FOR SHARE",
    )
    .bind(trade.tenant_id.into_uuid())
    .bind(trade.market_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("trade commission policy"))?;
    let commission_bps: i32 = commission_policy.try_get("commission_bps")?;
    let commission_amount = calculate_commission(
        actual_amount,
        u16::try_from(commission_bps).map_err(|_| {
            StorageError::InvalidData("commission basis points are out of range".to_owned())
        })?,
    )
    .map_err(|error| StorageError::InvalidData(error.to_string()))?;
    let seller_net_amount = actual_amount
        .checked_sub(commission_amount)
        .ok_or_else(|| StorageError::InvalidData("commission exceeds trade gross".to_owned()))?;
    let platform_commission_account_id: Option<Uuid> =
        commission_policy.try_get("platform_commission_account_id")?;
    if commission_amount > 0 && platform_commission_account_id.is_none() {
        return Err(StorageError::InvalidData(
            "positive commission requires a platform commission account".to_owned(),
        ));
    }

    consume_reservation(
        transaction,
        trade.buy_order_id,
        buy.reservation_account_id,
        buy_hold,
        improvement,
    )
    .await?;
    credit_account(
        transaction,
        buy.settlement_account_id,
        trade.quantity.value(),
    )
    .await?;
    consume_reservation(
        transaction,
        trade.sell_order_id,
        sell.reservation_account_id,
        trade.quantity.value(),
        0,
    )
    .await?;
    if seller_net_amount > 0 {
        credit_account(transaction, sell.settlement_account_id, seller_net_amount).await?;
    }
    if let Some(platform_account_id) = platform_commission_account_id
        && commission_amount > 0
    {
        if platform_account_id == sell.settlement_account_id {
            return Err(StorageError::InvalidData(
                "platform commission account must differ from seller settlement account".to_owned(),
            ));
        }
        credit_account(transaction, platform_account_id, commission_amount).await?;
    }

    sqlx::query(
        "INSERT INTO trades \
         (id, tenant_id, domain_id, market_id, event_id, maker_order_id, taker_order_id, \
          buy_order_id, sell_order_id, price, quantity, gross_amount, commission_bps, \
          commission_amount, seller_net_amount, platform_commission_account_id, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, \
                 $12::numeric, $13, $14::numeric, $15::numeric, $16, $17)",
    )
    .bind(trade.id.into_uuid())
    .bind(trade.tenant_id.into_uuid())
    .bind(trade.domain_id.into_uuid())
    .bind(trade.market_id.into_uuid())
    .bind(event_id.into_uuid())
    .bind(trade.maker_order_id.into_uuid())
    .bind(trade.taker_order_id.into_uuid())
    .bind(trade.buy_order_id.into_uuid())
    .bind(trade.sell_order_id.into_uuid())
    .bind(trade.price.to_string())
    .bind(trade.quantity.to_string())
    .bind(actual_amount.to_string())
    .bind(commission_bps)
    .bind(commission_amount.to_string())
    .bind(seller_net_amount.to_string())
    .bind(platform_commission_account_id)
    .bind(trade.occurred_at)
    .execute(&mut **transaction)
    .await?;

    let mut postings = vec![
        (
            "buyer-quote-debit",
            buy.reservation_account_id,
            "debit",
            actual_amount,
        ),
        (
            "seller-base-debit",
            sell.reservation_account_id,
            "debit",
            trade.quantity.value(),
        ),
        (
            "buyer-base-credit",
            buy.settlement_account_id,
            "credit",
            trade.quantity.value(),
        ),
    ];
    if seller_net_amount > 0 {
        postings.push((
            "seller-quote-net-credit",
            sell.settlement_account_id,
            "credit",
            seller_net_amount,
        ));
    }
    if let Some(platform_account_id) = platform_commission_account_id
        && commission_amount > 0
    {
        postings.push((
            "platform-commission-credit",
            platform_account_id,
            "credit",
            commission_amount,
        ));
    }
    for (label, account_id, kind, amount) in postings {
        sqlx::query(
            "INSERT INTO ledger_entries \
             (id, tenant_id, trade_id, account_id, entry_group_id, entry_kind, amount, occurred_at) \
             VALUES ($1, $2, $3, $4, $3, $5, $6::numeric, $7)",
        )
        .bind(LedgerEntryId::derive(trade.id, label).into_uuid())
        .bind(trade.tenant_id.into_uuid())
        .bind(trade.id.into_uuid())
        .bind(account_id)
        .bind(kind)
        .bind(amount.to_string())
        .bind(trade.occurred_at)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[derive(Debug)]
struct SettlementAccounts {
    side: OrderSide,
    limit_price: i128,
    reservation_account_id: Uuid,
    settlement_account_id: Uuid,
}

async fn settlement_accounts(
    transaction: &mut Transaction<'_, Postgres>,
    order_id: OrderId,
) -> Result<SettlementAccounts, StorageError> {
    let row = sqlx::query(
        "SELECT side, price::text AS price, reservation_account_id, settlement_account_id \
         FROM orders WHERE id = $1 FOR UPDATE",
    )
    .bind(order_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("trade order"))?;
    let side: String = row.try_get("side")?;
    Ok(SettlementAccounts {
        side: match side.as_str() {
            "buy" => OrderSide::Buy,
            "sell" => OrderSide::Sell,
            _ => {
                return Err(StorageError::InvalidData(
                    "invalid stored order side".to_owned(),
                ));
            }
        },
        limit_price: parse_i128(row.try_get("price")?)?,
        reservation_account_id: row.try_get("reservation_account_id")?,
        settlement_account_id: row.try_get("settlement_account_id")?,
    })
}

async fn consume_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    order_id: OrderId,
    account_id: Uuid,
    consumed: i128,
    release: i128,
) -> Result<(), StorageError> {
    let account = sqlx::query(
        "UPDATE accounts SET reserved_amount = reserved_amount - $2::numeric, \
                available_amount = available_amount + $3::numeric, version = version + 1 \
         WHERE id = $1 AND reserved_amount >= $2::numeric",
    )
    .bind(account_id)
    .bind(consumed.to_string())
    .bind(release.to_string())
    .execute(&mut **transaction)
    .await?;
    let reservation = sqlx::query(
        "UPDATE reservations SET remaining_quantity = remaining_quantity - $2::numeric, \
                status = CASE WHEN remaining_quantity = $2::numeric THEN 'confirmed' ELSE 'held' END, \
                version = version + 1 \
         WHERE order_id = $1 AND status = 'held' AND remaining_quantity >= $2::numeric",
    )
    .bind(order_id.into_uuid())
    .bind(consumed.to_string())
    .execute(&mut **transaction)
    .await?;
    if account.rows_affected() != 1 || reservation.rows_affected() != 1 {
        return Err(StorageError::InvalidData(
            "reservation consumption would overdraw held capacity".to_owned(),
        ));
    }
    Ok(())
}

async fn credit_account(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    amount: i128,
) -> Result<(), StorageError> {
    let result = sqlx::query(
        "UPDATE accounts SET available_amount = available_amount + $2::numeric, version = version + 1 \
         WHERE id = $1",
    )
    .bind(account_id)
    .bind(amount.to_string())
    .execute(&mut **transaction)
    .await?;
    if result.rows_affected() != 1 {
        return Err(StorageError::NotFound("settlement account"));
    }
    Ok(())
}

fn closing_order(events: &[EngineEvent]) -> Option<(OrderId, &'static str)> {
    events.iter().find_map(|event| match &event.payload {
        MatchingEvent::OrderCancelled { order_id, .. } => Some((*order_id, "aborted")),
        MatchingEvent::OrderExpired { order_id, .. } => Some((*order_id, "expired")),
        _ => None,
    })
}

async fn release_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    order_id: OrderId,
    status: &str,
) -> Result<(), StorageError> {
    let row = sqlx::query(
        "SELECT account_id, remaining_quantity::text AS remaining_quantity \
         FROM reservations WHERE order_id = $1 AND status = 'held' FOR UPDATE",
    )
    .bind(order_id.into_uuid())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::NotFound("held reservation"))?;
    let account_id: Uuid = row.try_get("account_id")?;
    let remaining = parse_i128(row.try_get("remaining_quantity")?)?;
    sqlx::query(
        "UPDATE accounts SET reserved_amount = reserved_amount - $2::numeric, \
                available_amount = available_amount + $2::numeric, version = version + 1 \
         WHERE id = $1 AND reserved_amount >= $2::numeric",
    )
    .bind(account_id)
    .bind(remaining.to_string())
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "UPDATE reservations SET remaining_quantity = 0, status = $2, version = version + 1 \
         WHERE order_id = $1 AND status = 'held'",
    )
    .bind(order_id.into_uuid())
    .bind(status)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn persist_order_projections(
    transaction: &mut Transaction<'_, Postgres>,
    book: &OrderBook,
    events: &[EngineEvent],
) -> Result<(), StorageError> {
    let mut order_ids = BTreeSet::new();
    for event in events {
        match &event.payload {
            MatchingEvent::OrderAccepted { intent, .. } => {
                order_ids.insert(intent.order_id);
            }
            MatchingEvent::TradeExecuted { trade } => {
                order_ids.insert(trade.maker_order_id);
                order_ids.insert(trade.taker_order_id);
            }
            MatchingEvent::OrderCancelled { order_id, .. }
            | MatchingEvent::OrderExpired { order_id, .. } => {
                order_ids.insert(*order_id);
            }
        }
    }
    for order_id in order_ids {
        let view = book.order(order_id).ok_or_else(|| {
            StorageError::InvalidData(format!("engine projection omitted order {order_id}"))
        })?;
        let result = sqlx::query(
            "UPDATE orders SET remaining_quantity = $2::numeric, status = $3, \
                    accepted_sequence = $4, version = version + 1 \
             WHERE id = $1 AND federated_reserved_quantity <= $2::numeric",
        )
        .bind(order_id.into_uuid())
        .bind(view.remaining_quantity.to_string())
        .bind(status_text(view.status))
        .bind(i64_sequence(view.accepted_sequence)?)
        .execute(&mut **transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::ReservationUnavailable);
        }
    }
    Ok(())
}

async fn allocate_event_sequences(
    transaction: &mut Transaction<'_, Postgres>,
    market_id: Uuid,
    count: i64,
) -> Result<u64, StorageError> {
    let row = sqlx::query(
        "UPDATE markets SET next_event_sequence = next_event_sequence + $2, version = version + 1 \
         WHERE id = $1 RETURNING next_event_sequence - $2 AS first_sequence",
    )
    .bind(market_id)
    .bind(count)
    .fetch_one(&mut **transaction)
    .await?;
    positive_u64(row.try_get("first_sequence")?)
}

async fn persist_domain_event(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
    source_node_id: FederationNodeId,
    fencing_token: i64,
    sequence: u64,
    event: &EngineEvent,
) -> Result<(), StorageError> {
    let payload = encode_matching_fact(event);
    let envelope = EventEnvelope {
        event_id: event.event_id,
        correlation_id: decoded.envelope.correlation_id,
        causation_id: CausationId::from(event.causation_id),
        source_node_id,
        tenant_id: decoded.envelope.tenant_id,
        domain_id: decoded.envelope.domain_id,
        market_id: decoded.envelope.market_id,
        shard_id: decoded.envelope.shard_id,
        shard_sequence: sequence,
        schema_version: 1,
        stream_kind: StreamKind::DomainEvent,
        occurred_at: event.occurred_at,
        payload_hash: PayloadHash::from_bytes(&payload),
        payload,
    };
    sqlx::query(
        "INSERT INTO domain_events \
         (event_id, correlation_id, causation_id, source_node_id, tenant_id, domain_id, market_id, \
          shard_id, shard_sequence, stream_kind, schema_version, event_type, occurred_at, \
          payload_hash, payload, fencing_token) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'domain_event', 1, $10, $11, $12, $13, $14)",
    )
    .bind(envelope.event_id.into_uuid())
    .bind(envelope.correlation_id.into_uuid())
    .bind(envelope.causation_id.into_uuid())
    .bind(envelope.source_node_id.into_uuid())
    .bind(envelope.tenant_id.into_uuid())
    .bind(envelope.domain_id.into_uuid())
    .bind(envelope.market_id.into_uuid())
    .bind(envelope.shard_id.into_uuid())
    .bind(i64_sequence(sequence)?)
    .bind(event_type(&event.payload))
    .bind(envelope.occurred_at)
    .bind(envelope.payload_hash.into_bytes().to_vec())
    .bind(serde_json::to_value(event)?)
    .bind(fencing_token)
    .execute(&mut **transaction)
    .await?;
    let wire = encode_event_envelope(&envelope, "matchplane.v1.MatchingFact");
    insert_outbox(
        transaction,
        &envelope,
        topics::DOMAIN_EVENTS,
        &envelope.market_id.to_string(),
        &wire,
    )
    .await
}

async fn persist_book_delta(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
    source_node_id: FederationNodeId,
    fencing_token: i64,
    book: &OrderBook,
) -> Result<(), StorageError> {
    let state_hash = book.state_hash()?;
    let bids = book
        .bids()?
        .into_iter()
        .map(|level| v1::PriceLevel {
            price: level.price.to_string(),
            quantity: level.quantity.to_string(),
        })
        .collect();
    let asks = book
        .asks()?
        .into_iter()
        .map(|level| v1::PriceLevel {
            price: level.price.to_string(),
            quantity: level.quantity.to_string(),
        })
        .collect();
    let delta = v1::OrderBookDelta {
        market_id: decoded.envelope.market_id.to_string(),
        command_sequence: decoded.envelope.shard_sequence,
        bids,
        asks,
        state_hash: state_hash.into_bytes().to_vec(),
    };
    let payload = encode_order_book_delta(&delta);
    let event_id = decoded.envelope.event_id.derive("order-book-delta", 0);
    let envelope = EventEnvelope {
        event_id,
        correlation_id: decoded.envelope.correlation_id,
        causation_id: CausationId::from(decoded.envelope.event_id),
        source_node_id,
        tenant_id: decoded.envelope.tenant_id,
        domain_id: decoded.envelope.domain_id,
        market_id: decoded.envelope.market_id,
        shard_id: decoded.envelope.shard_id,
        shard_sequence: decoded.envelope.shard_sequence,
        schema_version: 1,
        stream_kind: StreamKind::OrderBookDelta,
        occurred_at: decoded.envelope.occurred_at,
        payload_hash: PayloadHash::from_bytes(&payload),
        payload,
    };
    let delta_json = serde_json::json!({
        "market_id": delta.market_id,
        "command_sequence": delta.command_sequence,
        "bids": delta.bids.iter().map(|level| serde_json::json!({"price": level.price, "quantity": level.quantity})).collect::<Vec<_>>(),
        "asks": delta.asks.iter().map(|level| serde_json::json!({"price": level.price, "quantity": level.quantity})).collect::<Vec<_>>(),
        "state_hash": state_hash.to_hex(),
    });
    sqlx::query(
        "INSERT INTO domain_events \
         (event_id, correlation_id, causation_id, source_node_id, tenant_id, domain_id, market_id, \
          shard_id, shard_sequence, stream_kind, schema_version, event_type, occurred_at, \
          payload_hash, payload, fencing_token) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'order_book_delta', 1, \
                 'order_book_replaced', $10, $11, $12, $13)",
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
    .bind(envelope.occurred_at)
    .bind(envelope.payload_hash.into_bytes().to_vec())
    .bind(delta_json)
    .bind(fencing_token)
    .execute(&mut **transaction)
    .await?;
    let wire = encode_event_envelope(&envelope, "matchplane.v1.OrderBookDelta");
    insert_outbox(
        transaction,
        &envelope,
        topics::ORDER_BOOK_DELTAS,
        &envelope.market_id.to_string(),
        &wire,
    )
    .await
}

async fn persist_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    decoded: &DecodedCommand,
    last_event_sequence: u64,
    book: &OrderBook,
) -> Result<(), StorageError> {
    let state = book.snapshot_bytes()?;
    let checksum = PayloadHash::from_bytes(&state);
    sqlx::query(
        "INSERT INTO order_book_snapshots \
         (id, market_id, shard_id, last_event_sequence, schema_version, engine_version, state, checksum) \
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(decoded.envelope.market_id.into_uuid())
    .bind(decoded.envelope.shard_id.into_uuid())
    .bind(i64_sequence(last_event_sequence)?)
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(state)
    .bind(checksum.into_bytes().to_vec())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

const fn event_type(event: &MatchingEvent) -> &'static str {
    match event {
        MatchingEvent::OrderAccepted { .. } => "order_accepted",
        MatchingEvent::TradeExecuted { .. } => "trade_executed",
        MatchingEvent::OrderCancelled { .. } => "order_cancelled",
        MatchingEvent::OrderExpired { .. } => "order_expired",
    }
}

const fn status_text(status: OrderStatus) -> &'static str {
    match status {
        OrderStatus::Pending => "pending",
        OrderStatus::Open => "open",
        OrderStatus::PartiallyFilled => "partially_filled",
        OrderStatus::Filled => "filled",
        OrderStatus::Cancelled => "cancelled",
        OrderStatus::Expired => "expired",
        OrderStatus::Rejected => "rejected",
    }
}

fn parse_i128(value: String) -> Result<i128, StorageError> {
    value
        .parse()
        .map_err(|_| StorageError::InvalidData("numeric value exceeds exact i128".to_owned()))
}
