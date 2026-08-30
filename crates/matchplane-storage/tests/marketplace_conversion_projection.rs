use matchplane_storage::{
    MarketplaceConversionFailureDisposition, MarketplaceConversionJob,
    MarketplaceConversionRecoveryAction, PgStore, StorageError, VerifiedHostOperator,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
struct Fixture {
    tenant_id: Uuid,
    domain_id: Uuid,
    store_id: Uuid,
    buyer_party_id: Uuid,
    seller_party_id: Uuid,
    intent_id: Uuid,
    offer_id: Uuid,
    introduction_id: Uuid,
    organization_id: Uuid,
    seller_user_id: Uuid,
    buyer_user_id: Uuid,
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn projection_migration_should_normalize_every_004_legal_status(
    pool: PgPool,
) -> Result<(), StorageError> {
    const EXHAUSTED_ERROR: &str =
        "migration dead-lettered 004 row at or above maximum delivery attempts";

    create_source_schema(&pool).await?;
    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240004_marketplace_conversion_outbox.sql"
    ))
    .execute(&pool)
    .await?;

    let tenant_id = Uuid::now_v7();
    sqlx::query("INSERT INTO tenants (id) VALUES ($1)")
        .bind(tenant_id)
        .execute(&pool)
        .await?;
    let claimed_at = time::OffsetDateTime::now_utc();
    let mut seeded = Vec::new();
    for (status, attempts, expected_status) in [
        ("pending", 0, "pending"),
        ("publishing", 0, "publishing"),
        ("published", 0, "published"),
        ("failed", 2, "failed"),
        ("dead", 0, "dead"),
        ("pending", 12, "dead"),
        ("failed", 13, "dead"),
        ("pending", i32::MAX, "dead"),
        ("pending", 11, "pending"),
    ] {
        let id = Uuid::now_v7();
        let publishing = status == "publishing";
        sqlx::query(
            "INSERT INTO marketplace_conversion_outbox ( \
                 id, tenant_id, source_type, source_id, aggregate_type, aggregate_id, \
                 event_type, status, attempts, claimed_at, claim_token, published_at \
             ) VALUES ($1, $2, 'sales_handoff', $3, 'marketplace_sales_handoff', $4, \
                       'legacy_004_state', $5, $6, $7, $8, NULL)",
        )
        .bind(id)
        .bind(tenant_id)
        .bind(Uuid::now_v7())
        .bind(Uuid::now_v7())
        .bind(status)
        .bind(attempts)
        .bind(publishing.then_some(claimed_at))
        .bind(publishing.then(Uuid::now_v7))
        .execute(&pool)
        .await?;
        seeded.push((id, status, attempts, expected_status));
    }

    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240005_marketplace_conversion_projection.sql"
    ))
    .execute(&pool)
    .await?;
    // A manually resumed deployment must be able to repeat 005 without changing normalized rows.
    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240005_marketplace_conversion_projection.sql"
    ))
    .execute(&pool)
    .await?;

    let validated_checks: i64 = sqlx::query_scalar(
        "SELECT count(*) \
           FROM pg_constraint \
          WHERE conrelid = 'marketplace_conversion_outbox'::regclass \
            AND conname IN ( \
                'marketplace_conversion_outbox_status_check', \
                'marketplace_conversion_outbox_schema_version_check', \
                'marketplace_conversion_outbox_aggregate_version_check', \
                'marketplace_conversion_outbox_claim_state_check', \
                'marketplace_conversion_outbox_publication_state_check', \
                'marketplace_conversion_outbox_dead_state_check', \
                'marketplace_conversion_outbox_resolution_state_check', \
                'marketplace_conversion_outbox_attempt_audit_check' \
            ) \
            AND convalidated",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(validated_checks, 8);

    for (id, status, original_attempts, expected_status) in &seeded {
        let row = sqlx::query(
            "SELECT status, attempts, claimed_at IS NOT NULL AS claimed, \
                    claim_token IS NOT NULL AS claim_token, \
                    claim_expires_at IS NOT NULL AS claim_expires, \
                    published_at IS NOT NULL AS published, \
                    dead_at IS NOT NULL AS dead, \
                    resolved_at IS NOT NULL AS resolved, \
                    last_attempt_at IS NOT NULL AS attempted, last_error \
               FROM marketplace_conversion_outbox \
              WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await?;
        assert_eq!(row.get::<String, _>("status"), *expected_status);
        let publishing = *status == "publishing";
        assert_eq!(row.get::<bool, _>("claimed"), publishing);
        assert_eq!(row.get::<bool, _>("claim_token"), publishing);
        assert_eq!(row.get::<bool, _>("claim_expires"), publishing);
        assert_eq!(row.get::<bool, _>("published"), *status == "published");
        assert_eq!(row.get::<bool, _>("dead"), *expected_status == "dead");
        assert!(!row.get::<bool, _>("resolved"));
        let expected_attempts = if publishing { 1 } else { *original_attempts };
        assert_eq!(row.get::<i32, _>("attempts"), expected_attempts);
        assert_eq!(row.get::<bool, _>("attempted"), expected_attempts > 0);
        if matches!(*status, "pending" | "failed") && *original_attempts >= 12 {
            assert_eq!(row.get::<String, _>("last_error"), EXHAUSTED_ERROR);
        }
    }

    let store = PgStore::from_pool(pool);
    let claimed = store.claim_marketplace_conversions(100).await?;
    assert!(claimed.iter().all(|job| job.attempts <= 12));
    for (id, status, attempts, _) in &seeded {
        if matches!(*status, "pending" | "failed") && *attempts >= 12 {
            assert!(claimed.iter().all(|job| job.id != *id));
        }
    }
    let at_limit_id = seeded
        .iter()
        .find_map(|(id, status, attempts, _)| {
            (*status == "pending" && *attempts == 11).then_some(*id)
        })
        .ok_or_else(|| {
            StorageError::InvalidData("attempt-11 migration fixture must exist".to_owned())
        })?;
    assert_eq!(
        claimed
            .iter()
            .find(|job| job.id == at_limit_id)
            .map(|job| job.attempts),
        Some(12)
    );
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn claim_should_defensively_dead_letter_exhausted_pending_and_failed_rows(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let mut poisoned_ids = Vec::new();
    for (status, attempts) in [("pending", 12), ("failed", 13), ("pending", i32::MAX)] {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO marketplace_conversion_outbox ( \
                 id, tenant_id, schema_version, source_type, source_id, aggregate_type, \
                 aggregate_id, aggregate_version, event_type, status, attempts, last_attempt_at \
             ) VALUES ($1, $2, 1, 'sales_handoff', $3, 'marketplace_sales_handoff', \
                       $4, 1, 'defensive_claim_fixture', $5, $6, clock_timestamp())",
        )
        .bind(id)
        .bind(fixture.tenant_id)
        .bind(Uuid::now_v7())
        .bind(Uuid::now_v7())
        .bind(status)
        .bind(attempts)
        .execute(&pool)
        .await?;
        poisoned_ids.push(id);
    }

    let store = PgStore::from_pool(pool.clone());
    let batch = store.claim_marketplace_conversion_batch(100).await?;
    assert!(batch.jobs.is_empty());
    assert_eq!(batch.exhausted_dead, 3);

    let rows = sqlx::query(
        "SELECT id, status, attempts, dead_at IS NOT NULL AS has_dead_at, last_error \
           FROM marketplace_conversion_outbox \
          WHERE id = ANY($1)",
    )
    .bind(&poisoned_ids)
    .fetch_all(&pool)
    .await?;
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!(row.get::<String, _>("status"), "dead");
        assert!(row.get::<i32, _>("attempts") >= 12);
        assert!(row.get::<bool, _>("has_dead_at"));
        assert_eq!(
            row.get::<String, _>("last_error"),
            "worker dead-lettered row at or above maximum delivery attempts"
        );
    }
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn expired_claim_should_recover_and_projection_should_be_idempotent(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let long_store_name = "店".repeat(200);
    sqlx::query("UPDATE stores SET display_name = $1 WHERE tenant_id = $2 AND id = $3")
        .bind(&long_store_name)
        .bind(fixture.tenant_id)
        .bind(fixture.store_id)
        .execute(&pool)
        .await?;
    let handoff_id = insert_handoff(&pool, fixture).await?;
    let store = PgStore::from_pool(pool.clone());

    let stale = store.claim_marketplace_conversions(10).await?.remove(0);
    sqlx::query(
        "UPDATE marketplace_conversion_outbox \
            SET claim_expires_at = clock_timestamp() - INTERVAL '1 second' \
          WHERE id = $1",
    )
    .bind(stale.id)
    .execute(&pool)
    .await?;
    let current = store.claim_marketplace_conversions(10).await?.remove(0);
    assert_eq!(stale.id, current.id);
    assert_ne!(stale.claim_token, current.claim_token);

    let stale_result = store.project_marketplace_conversion(&stale).await;
    assert!(matches!(stale_result, Err(StorageError::Conflict(_))));
    let stale_failure = store
        .fail_marketplace_conversion(&stale, "stale worker failure")
        .await;
    assert!(matches!(stale_failure, Err(StorageError::Conflict(_))));
    let projected = store.project_marketplace_conversion(&current).await?;
    assert!(projected.opportunity_id.is_some());
    assert_eq!(projected.notifications_written, 1);
    assert_projection_counts(&pool, 1, 1, 1).await?;

    let projected_offer: Uuid =
        sqlx::query_scalar("SELECT offer_id FROM marketplace_sales_opportunity_offers LIMIT 1")
            .fetch_one(&pool)
            .await?;
    assert_eq!(projected_offer, fixture.offer_id);
    let notification = sqlx::query(
        "SELECT source_id, tenant_id, char_length(title)::bigint AS title_chars \
           FROM user_notifications WHERE source_type = 'store_ai_handoff'",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(
        notification.get::<String, _>("source_id"),
        handoff_id.to_string()
    );
    assert_eq!(notification.get::<Uuid, _>("tenant_id"), fixture.tenant_id);
    assert_eq!(notification.get::<i64, _>("title_chars"), 200);
    let before_replay = projection_snapshot(&pool).await?;

    sqlx::query(
        "UPDATE marketplace_conversion_outbox \
            SET status = 'pending', published_at = NULL, available_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(current.id)
    .execute(&pool)
    .await?;
    let replay = store.claim_marketplace_conversions(10).await?.remove(0);
    store.project_marketplace_conversion(&replay).await?;
    assert_projection_counts(&pool, 1, 1, 1).await?;
    assert_eq!(projection_snapshot(&pool).await?, before_replay);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn contact_projection_should_preserve_order_and_not_regress_on_replay(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let requested_event_id = Uuid::now_v7();
    sqlx::query(
        "UPDATE marketplace_introductions \
            SET status = 'contact_requested' \
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id)
    .bind(fixture.introduction_id)
    .execute(&pool)
    .await?;
    insert_contact_event(
        &pool,
        fixture,
        requested_event_id,
        "contact_requested",
        fixture.buyer_party_id,
        fixture.seller_party_id,
    )
    .await?;

    let consent_event_id = Uuid::now_v7();
    sqlx::query(
        "UPDATE marketplace_introductions \
            SET status = 'contact_released', supply_contact_consent_at = clock_timestamp() \
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id)
    .bind(fixture.introduction_id)
    .execute(&pool)
    .await?;
    insert_contact_event(
        &pool,
        fixture,
        consent_event_id,
        "contact_consent",
        fixture.seller_party_id,
        fixture.buyer_party_id,
    )
    .await?;

    let store = PgStore::from_pool(pool.clone());
    let first_batch = store.claim_marketplace_conversions(10).await?;
    assert_eq!(first_batch.len(), 1);
    assert_eq!(first_batch[0].source_id, requested_event_id);
    assert_eq!(first_batch[0].aggregate_version, 1);
    store
        .project_marketplace_conversion(&first_batch[0])
        .await?;

    let second_batch = store.claim_marketplace_conversions(10).await?;
    assert_eq!(second_batch.len(), 1);
    assert_eq!(second_batch[0].source_id, consent_event_id);
    assert_eq!(second_batch[0].aggregate_version, 2);
    store
        .project_marketplace_conversion(&second_batch[0])
        .await?;

    let release_event_id = Uuid::now_v7();
    sqlx::query(
        "UPDATE marketplace_introductions \
            SET contact_released_at = clock_timestamp() \
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id)
    .bind(fixture.introduction_id)
    .execute(&pool)
    .await?;
    insert_contact_event(
        &pool,
        fixture,
        release_event_id,
        "contact_release",
        fixture.buyer_party_id,
        fixture.seller_party_id,
    )
    .await?;
    let release = store.claim_marketplace_conversions(10).await?.remove(0);
    assert_eq!(release.aggregate_version, 3);
    store.project_marketplace_conversion(&release).await?;

    assert_contact_projection(&pool, "contact_exchanged", "accepted", 3).await?;
    assert_projection_counts(&pool, 1, 1, 2).await?;
    let scoped_notifications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_notifications WHERE tenant_id = $1")
            .bind(fixture.tenant_id)
            .fetch_one(&pool)
            .await?;
    assert_eq!(scoped_notifications, 2);
    let unscoped_notifications: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_notifications WHERE tenant_id IS NULL")
            .fetch_one(&pool)
            .await?;
    assert_eq!(unscoped_notifications, 0);
    let before_replay = projection_snapshot(&pool).await?;

    sqlx::query(
        "UPDATE marketplace_conversion_outbox \
            SET status = 'pending', published_at = NULL, available_at = clock_timestamp() \
          WHERE source_id = $1",
    )
    .bind(requested_event_id)
    .execute(&pool)
    .await?;
    let replay = store.claim_marketplace_conversions(10).await?.remove(0);
    assert_eq!(replay.aggregate_version, 1);
    store.project_marketplace_conversion(&replay).await?;

    assert_contact_projection(&pool, "contact_exchanged", "accepted", 3).await?;
    assert_projection_counts(&pool, 1, 1, 2).await?;
    assert_eq!(projection_snapshot(&pool).await?, before_replay);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn dead_aggregate_head_should_block_later_versions(pool: PgPool) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    insert_contact_event(
        &pool,
        fixture,
        Uuid::now_v7(),
        "contact_requested",
        fixture.buyer_party_id,
        fixture.seller_party_id,
    )
    .await?;
    insert_contact_event(
        &pool,
        fixture,
        Uuid::now_v7(),
        "contact_consent",
        fixture.seller_party_id,
        fixture.buyer_party_id,
    )
    .await?;
    let store = PgStore::from_pool(pool.clone());
    let mut head = store.claim_marketplace_conversions(10).await?.remove(0);
    sqlx::query("UPDATE marketplace_conversion_outbox SET attempts = 12 WHERE id = $1")
        .bind(head.id)
        .execute(&pool)
        .await?;
    head.attempts = 12;
    store
        .fail_marketplace_conversion(&head, "deterministic projection failure")
        .await?;

    assert!(store.claim_marketplace_conversions(10).await?.is_empty());
    let backlog = store.marketplace_conversion_backlog().await?;
    assert_eq!(backlog.dead, 1);
    assert_eq!(backlog.pending, 1);
    assert!(backlog.oldest_unresolved_seconds.is_some());
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn customer_activity_bounds_should_survive_cross_aggregate_order(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let store = PgStore::from_pool(pool.clone());

    let later_handoff = insert_handoff(&pool, fixture).await?;
    sqlx::query(
        "UPDATE marketplace_sales_handoffs \
            SET created_at = TIMESTAMPTZ '2030-01-02 00:00:00+00', \
                updated_at = TIMESTAMPTZ '2030-01-02 00:00:00+00' \
          WHERE id = $1",
    )
    .bind(later_handoff)
    .execute(&pool)
    .await?;
    let later_job = store.claim_marketplace_conversions(1).await?.remove(0);
    store.project_marketplace_conversion(&later_job).await?;

    let wider_handoff = insert_handoff(&pool, fixture).await?;
    sqlx::query(
        "UPDATE marketplace_sales_handoffs \
            SET created_at = TIMESTAMPTZ '2030-01-01 00:00:00+00', \
                updated_at = TIMESTAMPTZ '2030-01-03 00:00:00+00' \
          WHERE id = $1",
    )
    .bind(wider_handoff)
    .execute(&pool)
    .await?;
    let wider_job = store.claim_marketplace_conversions(1).await?.remove(0);
    store.project_marketplace_conversion(&wider_job).await?;

    let customer = sqlx::query(
        "SELECT first_seen_at = TIMESTAMPTZ '2030-01-01 00:00:00+00' AS first_matches, \
                last_activity_at = TIMESTAMPTZ '2030-01-03 00:00:00+00' AS last_matches, \
                version \
           FROM marketplace_store_customers \
          WHERE tenant_id = $1 AND store_id = $2 AND demand_party_id = $3",
    )
    .bind(fixture.tenant_id)
    .bind(fixture.store_id)
    .bind(fixture.buyer_party_id)
    .fetch_one(&pool)
    .await?;
    assert!(customer.get::<bool, _>("first_matches"));
    assert!(customer.get::<bool, _>("last_matches"));
    assert_eq!(customer.get::<i64, _>("version"), 2);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn twelfth_expired_lease_should_be_atomically_dead_lettered(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    insert_handoff(&pool, fixture).await?;
    let store = PgStore::from_pool(pool.clone());
    let mut job = store.claim_marketplace_conversions(1).await?.remove(0);

    for expected_attempts in 1..=12 {
        assert_eq!(job.attempts, expected_attempts);
        sqlx::query(
            "UPDATE marketplace_conversion_outbox \
                SET claim_expires_at = clock_timestamp() - INTERVAL '1 second' \
              WHERE id = $1",
        )
        .bind(job.id)
        .execute(&pool)
        .await?;
        if expected_attempts < 12 {
            job = store.claim_marketplace_conversions(1).await?.remove(0);
        }
    }

    assert!(store.claim_marketplace_conversions(1).await?.is_empty());
    let row = sqlx::query(
        "SELECT status, attempts, dead_at IS NOT NULL AS has_dead_at, last_error \
           FROM marketplace_conversion_outbox WHERE id = $1",
    )
    .bind(job.id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(row.get::<String, _>("status"), "dead");
    assert_eq!(row.get::<i32, _>("attempts"), 12);
    assert!(row.get::<bool, _>("has_dead_at"));
    assert_eq!(
        row.get::<String, _>("last_error"),
        "worker claim expired after maximum delivery attempts"
    );
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn unknown_schema_version_should_fail_closed_and_dead_letter(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let handoff_id = insert_handoff(&pool, fixture).await?;
    sqlx::query("UPDATE marketplace_conversion_outbox SET schema_version = 2 WHERE source_id = $1")
        .bind(handoff_id)
        .execute(&pool)
        .await?;
    let store = PgStore::from_pool(pool.clone());
    let job = store.claim_marketplace_conversions(1).await?.remove(0);
    assert_eq!(job.schema_version, 2);

    let error = store
        .project_marketplace_conversion(&job)
        .await
        .expect_err("unknown schema version must not project");
    assert!(matches!(error, StorageError::InvalidData(_)));
    let error_message = error.to_string();
    assert!(error_message.contains("unsupported marketplace conversion schema version 2"));
    store
        .fail_marketplace_conversion(&job, &error_message)
        .await?;

    let row = sqlx::query(
        "SELECT status, attempts, last_error FROM marketplace_conversion_outbox WHERE id = $1",
    )
    .bind(job.id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(row.get::<String, _>("status"), "dead");
    assert_eq!(row.get::<i32, _>("attempts"), 1);
    assert!(
        row.get::<String, _>("last_error")
            .contains("unsupported marketplace conversion schema version 2")
    );
    assert_projection_counts(&pool, 0, 0, 0).await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn notifications_should_remain_scoped_across_tenants(
    pool: PgPool,
) -> Result<(), StorageError> {
    let first = setup(&pool).await?;
    let second = seed_fixture(
        &pool,
        Some(first.seller_user_id),
        Some(first.buyer_user_id),
        "store-a",
    )
    .await?;
    let first_handoff = insert_handoff(&pool, first).await?;
    let second_handoff = insert_handoff(&pool, second).await?;
    let store = PgStore::from_pool(pool.clone());

    let jobs = store.claim_marketplace_conversions(10).await?;
    assert_eq!(jobs.len(), 2);
    for job in jobs {
        store.project_marketplace_conversion(&job).await?;
    }

    let rows = sqlx::query(
        "SELECT tenant_id, platform_path, source_id, char_length(title)::bigint AS title_chars \
           FROM user_notifications \
          WHERE recipient_auth_user_id = $1 AND source_type = 'store_ai_handoff'",
    )
    .bind(first.seller_user_id)
    .fetch_all(&pool)
    .await?;
    assert_eq!(rows.len(), 2);
    for row in rows {
        let source_id = row.get::<String, _>("source_id");
        let tenant_id = row.get::<Uuid, _>("tenant_id");
        if source_id == first_handoff.to_string() {
            assert_eq!(tenant_id, first.tenant_id);
        } else if source_id == second_handoff.to_string() {
            assert_eq!(tenant_id, second.tenant_id);
        } else {
            panic!("unexpected notification source {source_id}");
        }
        assert_eq!(row.get::<String, _>("platform_path"), "/store-a");
        assert!(row.get::<i64, _>("title_chars") <= 200);
    }
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn concurrent_workers_should_not_duplicate_claims(pool: PgPool) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    insert_handoff(&pool, fixture).await?;
    let first = PgStore::from_pool(pool.clone());
    let second = PgStore::from_pool(pool.clone());

    let (first_claim, second_claim) = tokio::join!(
        first.claim_marketplace_conversions(10),
        second.claim_marketplace_conversions(10)
    );
    let first_claim = first_claim?;
    let second_claim = second_claim?;
    assert_eq!(first_claim.len() + second_claim.len(), 1);
    if let (Some(first_job), Some(second_job)) = (first_claim.first(), second_claim.first()) {
        assert_ne!(first_job.id, second_job.id);
    }
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn retry_available_at_should_use_bounded_deterministic_jitter(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    insert_handoff(&pool, fixture).await?;
    let store = PgStore::from_pool(pool.clone());
    let job = store.claim_marketplace_conversions(1).await?.remove(0);
    let before: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await?;
    let failure = store
        .fail_marketplace_conversion(&job, "safe deterministic failure")
        .await?;
    let after: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await?;

    assert_eq!(
        failure.disposition,
        MarketplaceConversionFailureDisposition::Retry
    );
    let retry_delay_ms = failure.retry_delay_ms.ok_or_else(|| {
        StorageError::InvalidData("retry delay must be present for retry disposition".to_owned())
    })?;
    assert!((1_600..=2_400).contains(&retry_delay_ms));
    let within_transition_bounds: bool = sqlx::query_scalar(
        "SELECT available_at >= $2 + make_interval(secs => $4) \
                AND available_at <= $3 + make_interval(secs => $4) \
           FROM marketplace_conversion_outbox WHERE id = $1",
    )
    .bind(job.id)
    .bind(before)
    .bind(after)
    .bind(retry_delay_ms as f64 / 1_000.0)
    .fetch_one(&pool)
    .await?;
    assert!(within_transition_bounds);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn replay_recovery_should_audit_and_unlock_successor(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let store = PgStore::from_pool(pool.clone());
    let (head, successor_id) = dead_contact_head_with_successor(&pool, fixture, &store).await?;

    let dry_run = store
        .recover_marketplace_conversion(
            head.id,
            MarketplaceConversionRecoveryAction::Replay,
            false,
            None,
            "conversion-replay-dry-run",
            "canonical source repaired",
        )
        .await?;
    assert!(!dry_run.applied);
    assert_eq!(dry_run.resulting_status, "pending");
    assert_eq!(dry_run.blocked_successors, 1);
    let status: String =
        sqlx::query_scalar("SELECT status FROM marketplace_conversion_outbox WHERE id = $1")
            .bind(head.id)
            .fetch_one(&pool)
            .await?;
    assert_eq!(status, "dead");
    let dry_run_audits: i64 = sqlx::query_scalar("SELECT count(*) FROM platform_audit_events")
        .fetch_one(&pool)
        .await?;
    assert_eq!(dry_run_audits, 0);

    let Some(host_operator) = current_verified_host_operator()? else {
        let denied = store
            .recover_marketplace_conversion(
                head.id,
                MarketplaceConversionRecoveryAction::Replay,
                true,
                None,
                "conversion-replay-apply",
                "canonical source repaired",
            )
            .await;
        assert!(matches!(denied, Err(StorageError::Forbidden(_))));
        return Ok(());
    };
    let applied = store
        .recover_marketplace_conversion(
            head.id,
            MarketplaceConversionRecoveryAction::Replay,
            true,
            Some(host_operator),
            "conversion-replay-apply",
            "canonical source repaired",
        )
        .await?;
    assert!(applied.applied);
    assert_eq!(applied.resulting_status, "pending");
    assert_recovery_audit(
        &pool,
        "marketplace.conversion.projection.replayed",
        "conversion-replay-apply",
        "canonical source repaired",
    )
    .await?;

    let replay = store.claim_marketplace_conversions(1).await?.remove(0);
    assert_eq!(replay.id, head.id);
    store.project_marketplace_conversion(&replay).await?;
    let successor = store.claim_marketplace_conversions(1).await?.remove(0);
    assert_eq!(successor.source_id, successor_id);
    assert_eq!(successor.aggregate_version, 2);
    store.project_marketplace_conversion(&successor).await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn resolve_recovery_should_audit_and_unlock_successor(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    let store = PgStore::from_pool(pool.clone());
    let (head, successor_id) = dead_contact_head_with_successor(&pool, fixture, &store).await?;
    sqlx::query("DELETE FROM marketplace_introduction_contact_events WHERE id = $1")
        .bind(head.source_id)
        .execute(&pool)
        .await?;

    let Some(host_operator) = current_verified_host_operator()? else {
        let denied = store
            .recover_marketplace_conversion(
                head.id,
                MarketplaceConversionRecoveryAction::Resolve,
                true,
                None,
                "conversion-resolve-apply",
                "event intentionally skipped by root operator",
            )
            .await;
        assert!(matches!(denied, Err(StorageError::Forbidden(_))));
        return Ok(());
    };
    let applied = store
        .recover_marketplace_conversion(
            head.id,
            MarketplaceConversionRecoveryAction::Resolve,
            true,
            Some(host_operator),
            "conversion-resolve-apply",
            "event intentionally skipped by root operator",
        )
        .await?;
    assert!(applied.applied);
    assert_eq!(applied.resulting_status, "resolved");
    assert_recovery_audit(
        &pool,
        "marketplace.conversion.projection.resolved",
        "conversion-resolve-apply",
        "event intentionally skipped by root operator",
    )
    .await?;
    let audit_scope = sqlx::query(
        "SELECT domain_id IS NULL AS root_domain, platform_path FROM platform_audit_events",
    )
    .fetch_one(&pool)
    .await?;
    assert!(audit_scope.get::<bool, _>("root_domain"));
    assert_eq!(audit_scope.get::<String, _>("platform_path"), "/");

    let successor = store.claim_marketplace_conversions(1).await?.remove(0);
    assert_eq!(successor.source_id, successor_id);
    assert_eq!(successor.aggregate_version, 2);
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn active_claim_should_reject_dead_recovery(pool: PgPool) -> Result<(), StorageError> {
    let fixture = setup(&pool).await?;
    insert_handoff(&pool, fixture).await?;
    let store = PgStore::from_pool(pool.clone());
    let job = store.claim_marketplace_conversions(1).await?.remove(0);

    let Some(host_operator) = current_verified_host_operator()? else {
        let denied = store
            .recover_marketplace_conversion(
                job.id,
                MarketplaceConversionRecoveryAction::Resolve,
                true,
                None,
                "active-claim-recovery",
                "must remain fenced",
            )
            .await;
        assert!(matches!(denied, Err(StorageError::Forbidden(_))));
        return Ok(());
    };
    let recovery = store
        .recover_marketplace_conversion(
            job.id,
            MarketplaceConversionRecoveryAction::Resolve,
            true,
            Some(host_operator),
            "active-claim-recovery",
            "must remain fenced",
        )
        .await;
    assert!(matches!(recovery, Err(StorageError::Conflict(_))));
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM platform_audit_events")
        .fetch_one(&pool)
        .await?;
    assert_eq!(audits, 0);
    Ok(())
}

async fn dead_contact_head_with_successor(
    pool: &PgPool,
    fixture: Fixture,
    store: &PgStore,
) -> Result<(MarketplaceConversionJob, Uuid), StorageError> {
    let head_id = Uuid::now_v7();
    insert_contact_event(
        pool,
        fixture,
        head_id,
        "contact_requested",
        fixture.buyer_party_id,
        fixture.seller_party_id,
    )
    .await?;
    let successor_id = Uuid::now_v7();
    insert_contact_event(
        pool,
        fixture,
        successor_id,
        "contact_requested",
        fixture.buyer_party_id,
        fixture.seller_party_id,
    )
    .await?;
    let mut head = store.claim_marketplace_conversions(1).await?.remove(0);
    assert_eq!(head.source_id, head_id);
    sqlx::query("UPDATE marketplace_conversion_outbox SET attempts = 12 WHERE id = $1")
        .bind(head.id)
        .execute(pool)
        .await?;
    head.attempts = 12;
    let failure = store
        .fail_marketplace_conversion(&head, "deterministic projection failure")
        .await?;
    assert_eq!(
        failure.disposition,
        MarketplaceConversionFailureDisposition::Dead
    );
    Ok((head, successor_id))
}

fn current_verified_host_operator() -> Result<Option<VerifiedHostOperator>, StorageError> {
    match VerifiedHostOperator::verify_current_process() {
        Ok(host_operator) => Ok(Some(host_operator)),
        Err(StorageError::Forbidden(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn assert_recovery_audit(
    pool: &PgPool,
    event_type: &str,
    request_id: &str,
    reason: &str,
) -> Result<(), StorageError> {
    let row = sqlx::query(
        "SELECT event_type, request_id, metadata->>'reason' AS reason, \
                metadata->>'host_operator' AS host_operator, \
                metadata->>'host_operator_uid' AS host_operator_uid \
           FROM platform_audit_events",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(row.get::<String, _>("event_type"), event_type);
    assert_eq!(row.get::<String, _>("request_id"), request_id);
    assert_eq!(row.get::<String, _>("reason"), reason);
    assert_eq!(row.get::<String, _>("host_operator"), "true");
    assert_eq!(row.get::<String, _>("host_operator_uid"), "0");
    Ok(())
}

async fn setup(pool: &PgPool) -> Result<Fixture, StorageError> {
    create_source_schema(pool).await?;
    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240004_marketplace_conversion_outbox.sql"
    ))
    .execute(pool)
    .await?;
    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240005_marketplace_conversion_projection.sql"
    ))
    .execute(pool)
    .await?;
    seed_fixture(pool, None, None, "store-a").await
}

async fn seed_fixture(
    pool: &PgPool,
    seller_user_id: Option<Uuid>,
    buyer_user_id: Option<Uuid>,
    slug: &str,
) -> Result<Fixture, StorageError> {
    let organization_id = Uuid::now_v7();
    let seller_user_id = seller_user_id.unwrap_or_else(Uuid::now_v7);
    let buyer_user_id = buyer_user_id.unwrap_or_else(Uuid::now_v7);
    let fixture = Fixture {
        tenant_id: Uuid::now_v7(),
        domain_id: Uuid::now_v7(),
        store_id: Uuid::now_v7(),
        buyer_party_id: Uuid::now_v7(),
        seller_party_id: Uuid::now_v7(),
        intent_id: Uuid::now_v7(),
        offer_id: Uuid::now_v7(),
        introduction_id: Uuid::now_v7(),
        organization_id,
        seller_user_id,
        buyer_user_id,
    };
    let platform_path = format!("/{slug}");

    sqlx::query("INSERT INTO tenants (id) VALUES ($1)")
        .bind(fixture.tenant_id)
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO domains (id, tenant_id) VALUES ($1, $2)")
        .bind(fixture.domain_id)
        .bind(fixture.tenant_id)
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO \"organization\" (id) VALUES ($1)")
        .bind(fixture.organization_id)
        .execute(pool)
        .await?;
    sqlx::query("INSERT INTO \"user\" (id) VALUES ($1), ($2) ON CONFLICT (id) DO NOTHING")
        .bind(fixture.seller_user_id)
        .bind(fixture.buyer_user_id)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO \"member\" (id, \"organizationId\", \"userId\", role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(Uuid::now_v7())
    .bind(fixture.organization_id)
    .bind(fixture.seller_user_id)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO stores \
             (id, tenant_id, domain_id, organization_id, slug, display_name) \
         VALUES ($1, $2, $3, $4, $5, '测试车行')",
    )
    .bind(fixture.store_id)
    .bind(fixture.tenant_id)
    .bind(fixture.domain_id)
    .bind(fixture.organization_id)
    .bind(slug)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_parties (id, tenant_id, store_id, platform_path) \
         VALUES ($1, $3, $4, $5), ($2, $3, $4, $5)",
    )
    .bind(fixture.buyer_party_id)
    .bind(fixture.seller_party_id)
    .bind(fixture.tenant_id)
    .bind(fixture.store_id)
    .bind(&platform_path)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_party_auth_links (tenant_id, party_id, auth_user_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(fixture.tenant_id)
    .bind(fixture.buyer_party_id)
    .bind(fixture.buyer_user_id)
    .execute(pool)
    .await?;
    sqlx::query("INSERT INTO marketplace_intents (id, tenant_id, domain_id) VALUES ($1, $2, $3)")
        .bind(fixture.intent_id)
        .bind(fixture.tenant_id)
        .bind(fixture.domain_id)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO marketplace_offers \
             (id, tenant_id, domain_id, supply_party_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(fixture.offer_id)
    .bind(fixture.tenant_id)
    .bind(fixture.domain_id)
    .bind(fixture.seller_party_id)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_introductions \
             (id, tenant_id, demand_intent_id, supply_offer_id, demand_party_id, \
              supply_party_id, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'proposed')",
    )
    .bind(fixture.introduction_id)
    .bind(fixture.tenant_id)
    .bind(fixture.intent_id)
    .bind(fixture.offer_id)
    .bind(fixture.buyer_party_id)
    .bind(fixture.seller_party_id)
    .execute(pool)
    .await?;
    Ok(fixture)
}

async fn create_source_schema(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::raw_sql(
        "CREATE TABLE tenants (id uuid PRIMARY KEY);
         CREATE TABLE domains (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL REFERENCES tenants(id),
             UNIQUE (tenant_id, id)
         );
         CREATE TABLE \"user\" (id uuid PRIMARY KEY);
         CREATE TABLE \"organization\" (id uuid PRIMARY KEY);
         CREATE TABLE \"member\" (
             id uuid PRIMARY KEY,
             \"organizationId\" uuid NOT NULL REFERENCES \"organization\"(id),
             \"userId\" uuid NOT NULL REFERENCES \"user\"(id),
             role text NOT NULL
         );
         CREATE TABLE stores (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL REFERENCES tenants(id),
             domain_id uuid NOT NULL,
             organization_id uuid NOT NULL REFERENCES \"organization\"(id),
             slug text NOT NULL,
             display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
             UNIQUE (tenant_id, id)
         );
         CREATE TABLE marketplace_parties (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL REFERENCES tenants(id),
             store_id uuid,
             platform_path text NOT NULL,
             UNIQUE (tenant_id, id),
             FOREIGN KEY (tenant_id, store_id) REFERENCES stores(tenant_id, id)
         );
         CREATE TABLE marketplace_party_auth_links (
             tenant_id uuid NOT NULL,
             party_id uuid NOT NULL,
             auth_user_id uuid NOT NULL REFERENCES \"user\"(id),
             PRIMARY KEY (tenant_id, party_id, auth_user_id),
             FOREIGN KEY (tenant_id, party_id) REFERENCES marketplace_parties(tenant_id, id)
         );
         CREATE TABLE marketplace_intents (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             domain_id uuid NOT NULL,
             UNIQUE (tenant_id, id),
             FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id)
         );
         CREATE TABLE marketplace_offers (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             domain_id uuid NOT NULL,
             supply_party_id uuid NOT NULL,
             UNIQUE (tenant_id, id),
             FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
             FOREIGN KEY (tenant_id, supply_party_id) REFERENCES marketplace_parties(tenant_id, id)
         );
         CREATE TABLE marketplace_introductions (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             demand_intent_id uuid NOT NULL,
             supply_offer_id uuid NOT NULL,
             demand_party_id uuid NOT NULL,
             supply_party_id uuid NOT NULL,
             status text NOT NULL,
             supply_contact_consent_at timestamptz,
             contact_released_at timestamptz,
             UNIQUE (tenant_id, id),
             FOREIGN KEY (tenant_id, demand_intent_id) REFERENCES marketplace_intents(tenant_id, id),
             FOREIGN KEY (tenant_id, supply_offer_id) REFERENCES marketplace_offers(tenant_id, id),
             FOREIGN KEY (tenant_id, demand_party_id) REFERENCES marketplace_parties(tenant_id, id),
             FOREIGN KEY (tenant_id, supply_party_id) REFERENCES marketplace_parties(tenant_id, id)
         );
         CREATE TABLE marketplace_introduction_contact_events (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             introduction_id uuid NOT NULL,
             actor_party_id uuid NOT NULL,
             target_party_id uuid NOT NULL,
             event_type text NOT NULL,
             decision text NOT NULL,
             occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             FOREIGN KEY (tenant_id, introduction_id)
                 REFERENCES marketplace_introductions(tenant_id, id)
         );
         CREATE TABLE marketplace_sales_handoffs (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             domain_id uuid NOT NULL,
             participant_id uuid NOT NULL,
             summary jsonb NOT NULL,
             status text NOT NULL DEFAULT 'requested',
             lead_stage text NOT NULL DEFAULT 'new',
             favorite boolean NOT NULL DEFAULT false,
             staff_notes text,
             contact_consent_status text NOT NULL DEFAULT 'not_requested',
             created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             FOREIGN KEY (tenant_id, domain_id) REFERENCES domains(tenant_id, id),
             FOREIGN KEY (tenant_id, participant_id) REFERENCES marketplace_parties(tenant_id, id)
         );
         CREATE TABLE platform_audit_events (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL REFERENCES tenants(id),
             domain_id uuid REFERENCES domains(id),
             platform_path text NOT NULL,
             event_type text NOT NULL,
             outcome text NOT NULL,
             request_id text,
             metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
             occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
         );
         CREATE TABLE user_notifications (
             id uuid PRIMARY KEY,
             recipient_auth_user_id uuid NOT NULL REFERENCES \"user\"(id),
             tenant_id uuid REFERENCES tenants(id),
             platform_path text NOT NULL CHECK (length(platform_path) BETWEEN 1 AND 512),
             kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
             source_type text NOT NULL CHECK (length(source_type) BETWEEN 1 AND 64),
             source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
             title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
             body text CHECK (body IS NULL OR length(body) <= 500),
             payload jsonb NOT NULL DEFAULT '{}'::jsonb,
             action_path text NOT NULL CHECK (length(action_path) BETWEEN 1 AND 1024),
             read_at timestamptz,
             created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             UNIQUE (recipient_auth_user_id, source_type, source_id, kind)
         );",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_handoff(pool: &PgPool, fixture: Fixture) -> Result<Uuid, StorageError> {
    let handoff_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO marketplace_sales_handoffs \
             (id, tenant_id, domain_id, participant_id, summary) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(handoff_id)
    .bind(fixture.tenant_id)
    .bind(fixture.domain_id)
    .bind(fixture.buyer_party_id)
    .bind(json!({
        "analysis": "去敏后的客户意向",
        "product_ids": [fixture.offer_id, Uuid::now_v7()],
    }))
    .execute(pool)
    .await?;
    Ok(handoff_id)
}

async fn insert_contact_event(
    pool: &PgPool,
    fixture: Fixture,
    event_id: Uuid,
    event_type: &str,
    actor_party_id: Uuid,
    target_party_id: Uuid,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO marketplace_introduction_contact_events \
             (id, tenant_id, introduction_id, actor_party_id, target_party_id, \
              event_type, decision) \
         VALUES ($1, $2, $3, $4, $5, $6, 'allowed')",
    )
    .bind(event_id)
    .bind(fixture.tenant_id)
    .bind(fixture.introduction_id)
    .bind(actor_party_id)
    .bind(target_party_id)
    .bind(event_type)
    .execute(pool)
    .await?;
    Ok(())
}

async fn projection_snapshot(pool: &PgPool) -> Result<Value, StorageError> {
    let snapshot = sqlx::query_scalar(
        "SELECT jsonb_build_object( \
             'customers', COALESCE(( \
                 SELECT jsonb_agg(to_jsonb(customer) ORDER BY customer.id) \
                   FROM marketplace_store_customers AS customer \
             ), '[]'::jsonb), \
             'opportunities', COALESCE(( \
                 SELECT jsonb_agg(to_jsonb(opportunity) ORDER BY opportunity.id) \
                   FROM marketplace_sales_opportunities AS opportunity \
             ), '[]'::jsonb), \
             'offers', COALESCE(( \
                 SELECT jsonb_agg(to_jsonb(opportunity_offer) \
                                  ORDER BY opportunity_offer.opportunity_id, \
                                           opportunity_offer.ordinal, opportunity_offer.offer_id) \
                   FROM marketplace_sales_opportunity_offers AS opportunity_offer \
             ), '[]'::jsonb), \
             'notifications', COALESCE(( \
                 SELECT jsonb_agg(to_jsonb(notification) ORDER BY notification.id) \
                   FROM user_notifications AS notification \
             ), '[]'::jsonb) \
         )",
    )
    .fetch_one(pool)
    .await?;
    Ok(snapshot)
}

async fn assert_projection_counts(
    pool: &PgPool,
    customers: i64,
    opportunities: i64,
    notifications: i64,
) -> Result<(), StorageError> {
    let actual_customers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM marketplace_store_customers")
            .fetch_one(pool)
            .await?;
    let actual_opportunities: i64 =
        sqlx::query_scalar("SELECT count(*) FROM marketplace_sales_opportunities")
            .fetch_one(pool)
            .await?;
    let actual_notifications: i64 = sqlx::query_scalar("SELECT count(*) FROM user_notifications")
        .fetch_one(pool)
        .await?;
    assert_eq!(actual_customers, customers);
    assert_eq!(actual_opportunities, opportunities);
    assert_eq!(actual_notifications, notifications);
    Ok(())
}

async fn assert_contact_projection(
    pool: &PgPool,
    lead_stage: &str,
    consent_status: &str,
    last_version: i64,
) -> Result<(), StorageError> {
    let row = sqlx::query(
        "SELECT lead_stage, contact_consent_status, last_applied_version \
           FROM marketplace_sales_opportunities \
          WHERE source_type = 'marketplace_introduction'",
    )
    .fetch_one(pool)
    .await?;
    assert_eq!(row.get::<String, _>("lead_stage"), lead_stage);
    assert_eq!(
        row.get::<String, _>("contact_consent_status"),
        consent_status
    );
    assert_eq!(row.get::<i64, _>("last_applied_version"), last_version);
    Ok(())
}
