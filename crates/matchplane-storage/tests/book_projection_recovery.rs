use matchplane_domain::{MarketId, PayloadHash};
use matchplane_protocol::{encode_order_book_delta, v1};
use matchplane_storage::{BookProjection, BookProjectionLevel, PgStore, StorageError};
use sqlx::PgPool;
use uuid::Uuid;

async fn create_domain_events_table(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::query(
        "CREATE TABLE domain_events ( \
             event_id uuid PRIMARY KEY, \
             market_id uuid NOT NULL, \
             shard_sequence bigint NOT NULL, \
             stream_kind text NOT NULL, \
             payload_hash bytea NOT NULL, \
             payload jsonb NOT NULL \
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_book_projection(
    pool: &PgPool,
    market_id: MarketId,
    sequence: u64,
    bid_price: &str,
) -> Result<(), StorageError> {
    let state_hash = [sequence.to_le_bytes()[0]; 32];
    let ask_price = (bid_price
        .parse::<u64>()
        .expect("test price should be numeric")
        + 1)
    .to_string();
    let delta = v1::OrderBookDelta {
        market_id: market_id.to_string(),
        command_sequence: sequence,
        bids: vec![v1::PriceLevel {
            price: bid_price.to_owned(),
            quantity: "2".to_owned(),
        }],
        asks: vec![v1::PriceLevel {
            price: ask_price.clone(),
            quantity: "3".to_owned(),
        }],
        state_hash: state_hash.to_vec(),
    };
    let payload = serde_json::json!({
        "market_id": delta.market_id,
        "command_sequence": delta.command_sequence,
        "bids": [{"price": bid_price, "quantity": "2"}],
        "asks": [{"price": ask_price, "quantity": "3"}],
        "state_hash": hex::encode(state_hash),
    });
    let payload_hash = PayloadHash::from_bytes(&encode_order_book_delta(&delta));

    sqlx::query(
        "INSERT INTO domain_events \
         (event_id, market_id, shard_sequence, stream_kind, payload_hash, payload) \
         VALUES ($1, $2, $3, 'order_book_delta', $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(market_id.into_uuid())
    .bind(i64::try_from(sequence).expect("test sequence should fit bigint"))
    .bind(payload_hash.into_bytes().to_vec())
    .bind(payload)
    .execute(pool)
    .await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn latest_book_projection_should_return_verified_highest_sequence(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_domain_events_table(&pool).await?;
    let market_id = MarketId::new();
    insert_book_projection(&pool, market_id, 1, "100").await?;
    insert_book_projection(&pool, market_id, 2, "102").await?;

    let projection = PgStore::from_pool(pool)
        .latest_book_projection(market_id)
        .await?;

    assert_eq!(
        projection,
        Some(BookProjection {
            market_id,
            sequence: 2,
            bids: vec![BookProjectionLevel {
                price: "102".to_owned(),
                quantity: "2".to_owned(),
            }],
            asks: vec![BookProjectionLevel {
                price: "103".to_owned(),
                quantity: "3".to_owned(),
            }],
            state_hash: PayloadHash::from_digest([2; 32]),
        })
    );
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn latest_book_projection_should_return_none_when_market_has_no_delta(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_domain_events_table(&pool).await?;

    let projection = PgStore::from_pool(pool)
        .latest_book_projection(MarketId::new())
        .await?;

    assert_eq!(projection, None);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn latest_book_projection_should_reject_payload_hash_mismatch(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_domain_events_table(&pool).await?;
    let market_id = MarketId::new();
    insert_book_projection(&pool, market_id, 1, "100").await?;
    sqlx::query("UPDATE domain_events SET payload_hash = $1 WHERE market_id = $2")
        .bind(vec![0_u8; 32])
        .bind(market_id.into_uuid())
        .execute(&pool)
        .await?;

    let result = PgStore::from_pool(pool)
        .latest_book_projection(market_id)
        .await;

    assert!(
        matches!(result, Err(StorageError::InvalidData(message)) if message.contains("payload hash mismatch"))
    );
    Ok(())
}
