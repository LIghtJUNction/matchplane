use matchplane_storage::{PgStore, StorageError};
use sqlx::PgPool;
use uuid::Uuid;

async fn create_outbox_table(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::query(
        "CREATE TABLE outbox_events ( \
             event_id uuid PRIMARY KEY, \
             topic text NOT NULL, \
             message_key text NOT NULL, \
             shard_sequence bigint NOT NULL, \
             payload bytea NOT NULL, \
             status text NOT NULL DEFAULT 'pending', \
             attempts integer NOT NULL DEFAULT 0, \
             claimed_at timestamptz, \
             claim_token uuid, \
             available_at timestamptz NOT NULL DEFAULT clock_timestamp(), \
             published_at timestamptz, \
             last_error text, \
             created_at timestamptz NOT NULL DEFAULT clock_timestamp() \
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_message(
    pool: &PgPool,
    message_key: &str,
    shard_sequence: i64,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO outbox_events \
         (event_id, topic, message_key, shard_sequence, payload) \
         VALUES ($1, 'matchplane.commands.v1', $2, $3, $4)",
    )
    .bind(Uuid::now_v7())
    .bind(message_key)
    .bind(shard_sequence)
    .bind(vec![u8::try_from(shard_sequence).unwrap_or_default()])
    .execute(pool)
    .await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn claim_outbox_should_claim_only_each_key_head(pool: PgPool) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;
    insert_message(&pool, "market-b", 1).await?;

    let store = PgStore::from_pool(pool);
    let mut claimed = store.claim_outbox(10).await?;
    claimed.sort_by(|left, right| left.message_key.cmp(&right.message_key));
    let claimed_keys_and_sequences = claimed
        .into_iter()
        .map(|message| (message.message_key, message.shard_sequence))
        .collect::<Vec<_>>();

    assert_eq!(
        claimed_keys_and_sequences,
        vec![("market-a".to_owned(), 1), ("market-b".to_owned(), 1)]
    );
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn concurrent_claims_should_not_claim_two_records_for_one_key(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;

    let store = PgStore::from_pool(pool);
    let (first, second) = tokio::join!(store.claim_outbox(10), store.claim_outbox(10));
    let claimed_sequences = first?
        .into_iter()
        .chain(second?)
        .map(|message| message.shard_sequence)
        .collect::<Vec<_>>();

    assert_eq!(claimed_sequences, vec![1]);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn failed_head_should_block_later_records_during_backoff(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;

    let store = PgStore::from_pool(pool);
    let first = store.claim_outbox(10).await?.remove(0);
    store
        .mark_outbox_failed(
            first.event_id,
            first.claim_token,
            first.attempts,
            "broker unavailable",
        )
        .await?;

    assert!(store.claim_outbox(10).await?.is_empty());
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn exhausted_poison_head_should_not_retry_or_release_its_key(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;
    insert_message(&pool, "market-b", 1).await?;
    sqlx::query(
        "UPDATE outbox_events SET attempts = 11 \
         WHERE message_key = 'market-a' AND shard_sequence = 1",
    )
    .execute(&pool)
    .await?;

    let store = PgStore::from_pool(pool.clone());
    let mut claimed = store.claim_outbox(10).await?;
    let poison_index = claimed
        .iter()
        .position(|message| message.message_key == "market-a")
        .expect("the poison head should receive its final claim");
    let poison = claimed.swap_remove(poison_index);
    assert_eq!(poison.attempts, 12);
    store
        .mark_outbox_failed(
            poison.event_id,
            poison.claim_token,
            poison.attempts,
            "broker rejected the record permanently",
        )
        .await?;

    let other = claimed
        .pop()
        .expect("the independent key should have been claimed");
    store
        .mark_outbox_published(other.event_id, other.claim_token)
        .await?;
    insert_message(&pool, "market-b", 2).await?;

    let next = store.claim_outbox(10).await?;
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].message_key, "market-b");
    assert_eq!(next[0].shard_sequence, 2);
    let poison_state: (String, i32) =
        sqlx::query_as("SELECT status, attempts FROM outbox_events WHERE event_id = $1")
            .bind(poison.event_id.into_uuid())
            .fetch_one(&pool)
            .await?;
    assert_eq!(poison_state, ("failed".to_owned(), 12));
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn exhausted_stale_claim_should_become_terminal_failed(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;
    sqlx::query(
        "UPDATE outbox_events \
         SET status = 'publishing', attempts = 12, \
             claimed_at = clock_timestamp() - INTERVAL '61 seconds', claim_token = $1 \
         WHERE message_key = 'market-a' AND shard_sequence = 1",
    )
    .bind(Uuid::now_v7())
    .execute(&pool)
    .await?;

    let store = PgStore::from_pool(pool.clone());
    assert!(store.claim_outbox(10).await?.is_empty());

    let poison_state: (String, Option<Uuid>, Option<String>) = sqlx::query_as(
        "SELECT status, claim_token, last_error FROM outbox_events \
         WHERE message_key = 'market-a' AND shard_sequence = 1",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(poison_state.0, "failed");
    assert!(poison_state.1.is_none());
    assert_eq!(
        poison_state.2.as_deref(),
        Some("delivery claim lease expired after attempt limit")
    );
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn published_head_should_release_the_next_sequence(pool: PgPool) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;
    insert_message(&pool, "market-a", 2).await?;

    let store = PgStore::from_pool(pool);
    let first = store.claim_outbox(10).await?.remove(0);
    store
        .mark_outbox_published(first.event_id, first.claim_token)
        .await?;
    let next = store.claim_outbox(10).await?.remove(0);

    assert_eq!(next.shard_sequence, 2);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn stale_acknowledgement_should_not_complete_a_reclaimed_record(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_outbox_table(&pool).await?;
    insert_message(&pool, "market-a", 1).await?;

    let store = PgStore::from_pool(pool.clone());
    let stale = store.claim_outbox(10).await?.remove(0);
    sqlx::query(
        "UPDATE outbox_events \
         SET claimed_at = clock_timestamp() - INTERVAL '61 seconds' \
         WHERE event_id = $1",
    )
    .bind(stale.event_id.into_uuid())
    .execute(&pool)
    .await?;
    let current = store.claim_outbox(10).await?.remove(0);

    let result = store
        .mark_outbox_published(stale.event_id, stale.claim_token)
        .await;
    assert!(matches!(result, Err(StorageError::Conflict(_))));

    store
        .mark_outbox_published(current.event_id, current.claim_token)
        .await?;
    Ok(())
}
