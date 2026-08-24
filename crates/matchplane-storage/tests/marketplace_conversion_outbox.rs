use matchplane_storage::StorageError;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this test target explicitly"]
async fn conversion_outbox_should_capture_new_facts_without_backfilling_history(
    pool: PgPool,
) -> Result<(), StorageError> {
    create_source_tables(&pool).await?;
    let tenant_id = Uuid::now_v7();
    let historical_contact_id = Uuid::now_v7();
    let historical_handoff_id = Uuid::now_v7();
    sqlx::query("INSERT INTO tenants (id) VALUES ($1)")
        .bind(tenant_id)
        .execute(&pool)
        .await?;
    insert_contact_event(
        &pool,
        historical_contact_id,
        tenant_id,
        Uuid::now_v7(),
        "contact_requested",
        "allowed",
    )
    .await?;
    insert_handoff(&pool, historical_handoff_id, tenant_id).await?;

    sqlx::raw_sql(include_str!(
        "../../../migrations/202608240004_marketplace_conversion_outbox.sql"
    ))
    .execute(&pool)
    .await?;
    let historical_jobs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM marketplace_conversion_outbox")
            .fetch_one(&pool)
            .await?;
    assert_eq!(historical_jobs, 0);

    let introduction_id = Uuid::now_v7();
    let contact_event_id = Uuid::now_v7();
    let handoff_id = Uuid::now_v7();
    insert_contact_event(
        &pool,
        contact_event_id,
        tenant_id,
        introduction_id,
        "contact_requested",
        "allowed",
    )
    .await?;
    insert_handoff(&pool, handoff_id, tenant_id).await?;
    let rows = sqlx::query(
        "SELECT source_type, source_id, aggregate_id, event_type, status
           FROM marketplace_conversion_outbox
          ORDER BY source_type",
    )
    .fetch_all(&pool)
    .await?;

    assert_eq!(rows.len(), 2);
    let contact = rows
        .iter()
        .find(|row| row.get::<String, _>("source_type") == "introduction_contact_event")
        .expect("contact outbox row");
    assert_eq!(contact.get::<Uuid, _>("source_id"), contact_event_id);
    assert_eq!(contact.get::<Uuid, _>("aggregate_id"), introduction_id);
    assert_eq!(
        contact.get::<String, _>("event_type"),
        "marketplace_contact_requested_allowed"
    );
    assert_eq!(contact.get::<String, _>("status"), "pending");
    let handoff = rows
        .iter()
        .find(|row| row.get::<String, _>("source_type") == "sales_handoff")
        .expect("handoff outbox row");
    assert_eq!(handoff.get::<Uuid, _>("source_id"), handoff_id);
    assert_eq!(
        handoff.get::<String, _>("event_type"),
        "marketplace_sales_handoff_requested"
    );
    Ok(())
}

async fn create_source_tables(pool: &PgPool) -> Result<(), StorageError> {
    sqlx::raw_sql(
        "CREATE TABLE tenants (id uuid PRIMARY KEY);
         CREATE TABLE marketplace_introduction_contact_events (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL,
             introduction_id uuid NOT NULL,
             event_type text NOT NULL,
             decision text NOT NULL
         );
         CREATE TABLE marketplace_sales_handoffs (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL
         );",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_contact_event(
    pool: &PgPool,
    id: Uuid,
    tenant_id: Uuid,
    introduction_id: Uuid,
    event_type: &str,
    decision: &str,
) -> Result<(), StorageError> {
    sqlx::query(
        "INSERT INTO marketplace_introduction_contact_events
            (id, tenant_id, introduction_id, event_type, decision)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(tenant_id)
    .bind(introduction_id)
    .bind(event_type)
    .bind(decision)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_handoff(pool: &PgPool, id: Uuid, tenant_id: Uuid) -> Result<(), StorageError> {
    sqlx::query("INSERT INTO marketplace_sales_handoffs (id, tenant_id) VALUES ($1, $2)")
        .bind(id)
        .bind(tenant_id)
        .execute(pool)
        .await?;
    Ok(())
}
