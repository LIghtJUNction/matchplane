use matchplane_events::KafkaRecordLocation;
use matchplane_storage::{
    KafkaFailureClass, KafkaFailureDisposition, PgStore, QuarantineKafkaRecord, StorageError,
};
use sqlx::{PgPool, Row};

async fn create_quarantine_table(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240003_kafka_consumer_quarantine.sql"
    ))
    .execute(pool)
    .await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn terminal_policy_should_resolve_a_previously_blocked_offset(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_quarantine_table(&pool).await?;
    let store = PgStore::from_pool(pool.clone());
    let location = KafkaRecordLocation {
        topic: "matchplane.commands.v1".to_owned(),
        partition: 2,
        offset: 41,
    };
    let blocked = QuarantineKafkaRecord {
        consumer_name: "matchplane-matcher-v1",
        location: &location,
        message_key: Some(b"market-a"),
        payload: Some(b"invalid-command"),
        failure_class: KafkaFailureClass::InvalidPayload,
        error_message: "invalid command",
        disposition: KafkaFailureDisposition::Blocked,
    };
    let first = store.quarantine_kafka_record(blocked).await?;
    let resolved = store
        .quarantine_kafka_record(QuarantineKafkaRecord {
            disposition: KafkaFailureDisposition::Reconciled,
            ..blocked
        })
        .await?;
    let row = sqlx::query(
        "SELECT disposition, sightings, resolved_at IS NOT NULL AS resolved,
                message_key IS NULL AS key_redacted,
                payload IS NULL AS payload_redacted,
                octet_length(message_key_sha256) AS key_hash_bytes,
                octet_length(payload_sha256) AS payload_hash_bytes
           FROM kafka_consumer_quarantine WHERE id = $1",
    )
    .bind(first.id)
    .fetch_one(&pool)
    .await?;

    assert_eq!(resolved.id, first.id);
    assert_eq!(resolved.disposition, "reconciled");
    assert_eq!(row.try_get::<String, _>("disposition")?, "reconciled");
    assert_eq!(row.try_get::<i32, _>("sightings")?, 2);
    assert!(row.try_get::<bool, _>("resolved")?);
    assert!(row.try_get::<bool, _>("key_redacted")?);
    assert!(row.try_get::<bool, _>("payload_redacted")?);
    assert_eq!(row.try_get::<i32, _>("key_hash_bytes")?, 32);
    assert_eq!(row.try_get::<i32, _>("payload_hash_bytes")?, 32);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn immutable_offset_should_reject_different_payload_bytes(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_quarantine_table(&pool).await?;
    let store = PgStore::from_pool(pool);
    let location = KafkaRecordLocation {
        topic: "matchplane.order-book-deltas.v1".to_owned(),
        partition: 0,
        offset: 9,
    };
    store
        .quarantine_kafka_record(QuarantineKafkaRecord {
            consumer_name: "matchplane-projector-v1",
            location: &location,
            message_key: Some(b"market-a"),
            payload: Some(b"first"),
            failure_class: KafkaFailureClass::InvalidPayload,
            error_message: "invalid projection",
            disposition: KafkaFailureDisposition::Blocked,
        })
        .await?;
    let conflict = store
        .quarantine_kafka_record(QuarantineKafkaRecord {
            consumer_name: "matchplane-projector-v1",
            location: &location,
            message_key: Some(b"market-a"),
            payload: Some(b"second"),
            failure_class: KafkaFailureClass::InvalidPayload,
            error_message: "changed projection",
            disposition: KafkaFailureDisposition::Blocked,
        })
        .await;

    assert!(matches!(conflict, Err(StorageError::Conflict(_))));
    Ok(())
}
