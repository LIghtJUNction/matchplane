use matchplane_domain::{
    MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId, MatchIntroductionId, TenantId,
};
use matchplane_storage::{
    AcceptMarketplaceContact, PgStore, RequestMarketplaceContact, StorageError,
};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs storage integration tests explicitly"]
async fn denied_contact_consent_key_cannot_later_commit_an_allowed_transition(
    pool: PgPool,
) -> Result<(), StorageError> {
    sqlx::raw_sql(
        "CREATE TABLE marketplace_introductions (
             id uuid NOT NULL,
             tenant_id uuid NOT NULL,
             demand_intent_id uuid NOT NULL,
             supply_offer_id uuid NOT NULL,
             demand_party_id uuid NOT NULL,
             supply_party_id uuid NOT NULL,
             score double precision NOT NULL,
             reasons jsonb NOT NULL,
             status text NOT NULL,
             supply_contact_consent_at timestamptz,
             contact_released_at timestamptz,
             idempotency_key text NOT NULL,
             expires_at timestamptz NOT NULL,
             version bigint NOT NULL DEFAULT 1,
             created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             PRIMARY KEY (tenant_id, id)
         );
         CREATE TABLE marketplace_introduction_contact_events (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             introduction_id uuid NOT NULL,
             actor_party_id uuid NOT NULL,
             target_party_id uuid NOT NULL,
             event_type text NOT NULL,
             decision text NOT NULL,
             request_fingerprint bytea,
             idempotency_key text NOT NULL,
             created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
             UNIQUE (tenant_id, introduction_id, actor_party_id, event_type, idempotency_key)
         );",
    )
    .execute(&pool)
    .await?;

    let tenant_id = TenantId::new();
    let introduction_id = MatchIntroductionId::new();
    let demand_party_id = MarketplacePartyId::new();
    let supply_party_id = MarketplacePartyId::new();
    sqlx::query(
        "INSERT INTO marketplace_introductions
             (id, tenant_id, demand_intent_id, supply_offer_id, demand_party_id,
              supply_party_id, score, reasons, status, idempotency_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0.9, '[]'::jsonb, 'proposed', $7, $8)",
    )
    .bind(introduction_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .bind(MarketplaceIntentId::new().into_uuid())
    .bind(MarketplaceOfferId::new().into_uuid())
    .bind(demand_party_id.into_uuid())
    .bind(supply_party_id.into_uuid())
    .bind("introduction-key")
    .bind(OffsetDateTime::now_utc() + Duration::hours(1))
    .execute(&pool)
    .await?;

    let store = PgStore::from_pool(pool.clone());
    let consent = AcceptMarketplaceContact {
        tenant_id,
        introduction_id,
        supply_party_id,
        idempotency_key: "consent-key".to_owned(),
    };
    assert!(matches!(
        store.accept_marketplace_contact(&consent).await,
        Err(StorageError::Conflict(_))
    ));

    store
        .request_marketplace_contact(&RequestMarketplaceContact {
            tenant_id,
            introduction_id,
            demand_party_id,
            idempotency_key: "request-key".to_owned(),
            request_fingerprint: Some(vec![1; 32]),
        })
        .await?;

    assert!(matches!(
        store.accept_marketplace_contact(&consent).await,
        Err(StorageError::Conflict(_))
    ));

    let status: String = sqlx::query_scalar(
        "SELECT status FROM marketplace_introductions WHERE tenant_id = $1 AND id = $2",
    )
    .bind(tenant_id.into_uuid())
    .bind(introduction_id.into_uuid())
    .fetch_one(&pool)
    .await?;
    assert_eq!(status, "contact_requested");

    let event = sqlx::query(
        "SELECT decision, count(*) OVER () AS event_count
           FROM marketplace_introduction_contact_events
          WHERE tenant_id = $1 AND introduction_id = $2
            AND actor_party_id = $3 AND event_type = 'contact_consent'",
    )
    .bind(tenant_id.into_uuid())
    .bind(introduction_id.into_uuid())
    .bind(supply_party_id.into_uuid())
    .fetch_one(&pool)
    .await?;
    assert_eq!(event.get::<String, _>("decision"), "denied");
    assert_eq!(event.get::<i64, _>("event_count"), 1);
    Ok(())
}
