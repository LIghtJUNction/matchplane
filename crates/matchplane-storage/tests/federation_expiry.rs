use matchplane_domain::{
    DomainId, FederationNodeId, MarketId, OrderId, PayloadHash, Quantity, TenantId,
};
use matchplane_storage::{FederationTransition, PgStore, ReserveFederated, StorageError};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

async fn create_federation_tables(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::raw_sql(
        "CREATE TABLE federation_nodes ( \
             id uuid PRIMARY KEY, \
             status text NOT NULL, \
             fencing_token bigint NOT NULL DEFAULT 0, \
             last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(), \
             version bigint NOT NULL DEFAULT 1 \
         ); \
         CREATE TABLE orders ( \
             id uuid PRIMARY KEY, \
             tenant_id uuid NOT NULL, \
             domain_id uuid NOT NULL, \
             market_id uuid NOT NULL, \
             status text NOT NULL, \
             remaining_quantity numeric NOT NULL, \
             federated_reserved_quantity numeric NOT NULL DEFAULT 0, \
             version bigint NOT NULL DEFAULT 1 \
         ); \
         CREATE TABLE federation_saga_reservations ( \
             id uuid PRIMARY KEY, \
             source_node_id uuid NOT NULL, \
             tenant_id uuid NOT NULL, \
             domain_id uuid NOT NULL, \
             market_id uuid NOT NULL, \
             order_id uuid NOT NULL, \
             quantity numeric NOT NULL, \
             status text NOT NULL, \
             idempotency_key text NOT NULL, \
             request_hash bytea NOT NULL, \
             fencing_token bigint NOT NULL, \
             nonce text NOT NULL, \
             expires_at timestamptz NOT NULL, \
             version bigint NOT NULL DEFAULT 1, \
             created_at timestamptz NOT NULL DEFAULT clock_timestamp(), \
             UNIQUE (source_node_id, idempotency_key) \
         ); \
         CREATE TABLE federation_replay_nonces ( \
             source_node_id uuid NOT NULL, \
             nonce text NOT NULL, \
             operation text NOT NULL, \
             reservation_id uuid, \
             PRIMARY KEY (source_node_id, nonce) \
         )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn expired_reservation_should_remain_idempotently_readable_and_release_capacity(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_federation_tables(&pool).await?;
    let source_node_id = FederationNodeId::new();
    let tenant_id = TenantId::new();
    let domain_id = DomainId::new();
    let market_id = MarketId::new();
    let order_id = OrderId::new();
    sqlx::query("INSERT INTO federation_nodes (id, status) VALUES ($1, 'active')")
        .bind(source_node_id.into_uuid())
        .execute(&pool)
        .await?;
    sqlx::query(
        "INSERT INTO orders ( \
             id, tenant_id, domain_id, market_id, status, remaining_quantity \
         ) VALUES ($1, $2, $3, $4, 'open', 5)",
    )
    .bind(order_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(market_id.into_uuid())
    .execute(&pool)
    .await?;

    let request = ReserveFederated {
        source_node_id,
        tenant_id,
        domain_id,
        market_id,
        order_id,
        quantity: Quantity::new(2).expect("test quantity is positive"),
        idempotency_key: "expiring-reservation".to_owned(),
        request_hash: PayloadHash::from_bytes(b"expiring-reservation"),
        fencing_token: 1,
        nonce: "reserve-nonce-0001".to_owned(),
        expires_at: OffsetDateTime::now_utc() + Duration::seconds(1),
    };
    let store = PgStore::from_pool(pool.clone());
    let first = store.reserve_federated(&request).await?;
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;

    // An exact retry after expiry must return the durable result rather than being rejected by a
    // worker host's clock before the idempotency lookup runs.
    let duplicate = store.reserve_federated(&request).await?;
    assert_eq!(duplicate.reservation_id, first.reservation_id);
    assert_eq!(duplicate.version, first.version);

    // PostgreSQL owns both the expiry decision and the capacity protected by that decision.
    let expired = store
        .confirm_federated(&FederationTransition {
            source_node_id,
            reservation_id: first.reservation_id,
            idempotency_key: request.idempotency_key.clone(),
            expected_version: first.version,
            fencing_token: first.fencing_token,
            nonce: "confirm-nonce-0001".to_owned(),
        })
        .await?;
    assert_eq!(expired.status, "expired");
    let reserved: String =
        sqlx::query_scalar("SELECT federated_reserved_quantity::text FROM orders WHERE id = $1")
            .bind(order_id.into_uuid())
            .fetch_one(&pool)
            .await?;
    assert_eq!(reserved, "0");
    Ok(())
}
