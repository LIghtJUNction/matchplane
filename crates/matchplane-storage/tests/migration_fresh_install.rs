use std::collections::HashMap;

use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires PostgreSQL with the MatchPlane extensions; CI runs this target explicitly"]
async fn fresh_install_should_apply_every_embedded_migration(
    pool: PgPool,
) -> Result<(), sqlx::Error> {
    let latest_applied: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
           SELECT 1 FROM _sqlx_migrations \
           WHERE version = 202608280001 AND success\
         )",
    )
    .fetch_one(&pool)
    .await?;
    assert!(latest_applied, "latest migration was not applied");

    let columns: Vec<(String, String, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale \
           FROM information_schema.columns \
          WHERE table_schema = current_schema() \
            AND table_name = 'mall_currency_settings'",
    )
    .fetch_all(&pool)
    .await?;
    let columns: HashMap<_, _> = columns
        .into_iter()
        .map(|(name, data_type, nullable, precision, scale)| {
            (name, (data_type, nullable, precision, scale))
        })
        .collect();
    for required in [
        "tenant_id",
        "local_currency",
        "usd_to_local_rate",
        "rate_source",
        "rate_provider",
        "rate_effective_date",
        "rate_response_digest",
        "rate_updated_at",
        "version",
        "created_at",
        "updated_at",
    ] {
        assert!(columns.contains_key(required), "missing column {required}");
    }
    assert_eq!(
        columns.get("usd_to_local_rate"),
        Some(&("numeric".to_owned(), "YES".to_owned(), None, None)),
        "the exchange-rate numeric must remain unbounded and exact",
    );
    assert_eq!(
        columns
            .get("rate_effective_date")
            .map(|column| column.0.as_str()),
        Some("date"),
    );

    let constraints: Vec<(String, String)> = sqlx::query_as(
        "SELECT conname, pg_get_constraintdef(oid) \
           FROM pg_constraint \
          WHERE conrelid = 'mall_currency_settings'::regclass",
    )
    .fetch_all(&pool)
    .await?;
    let constraints: HashMap<_, _> = constraints.into_iter().collect();
    for required in [
        "mall_currency_settings_local_currency_check",
        "mall_currency_settings_rate_range_check",
        "mall_currency_settings_rate_source_check",
        "mall_currency_settings_rate_provider_check",
        "mall_currency_settings_rate_response_digest_check",
        "mall_currency_settings_version_check",
        "mall_currency_settings_snapshot_coherence_check",
    ] {
        assert!(
            constraints.contains_key(required),
            "missing constraint {required}"
        );
    }
    let foreign_key = constraints
        .get("mall_currency_settings_tenant_id_fkey")
        .expect("missing tenant foreign key");
    assert!(foreign_key.contains("FOREIGN KEY (tenant_id) REFERENCES tenants(id)"));
    assert!(foreign_key.contains("ON DELETE CASCADE"));
    assert!(
        constraints
            .get("mall_currency_settings_pkey")
            .is_some_and(|definition| definition.contains("PRIMARY KEY (tenant_id)")),
        "tenant-scoped primary key is missing",
    );

    let indexes: Vec<(String, String)> = sqlx::query_as(
        "SELECT indexname, indexdef \
           FROM pg_indexes \
          WHERE schemaname = current_schema() \
            AND tablename = 'mall_currency_settings'",
    )
    .fetch_all(&pool)
    .await?;
    let indexes: HashMap<_, _> = indexes.into_iter().collect();
    assert!(indexes.contains_key("mall_currency_settings_updated_at_idx"));
    assert!(
        indexes
            .get("mall_currency_settings_provider_effective_date_idx")
            .is_some_and(|definition| {
                definition.contains("rate_provider, rate_effective_date DESC")
                    && definition.contains("WHERE (usd_to_local_rate IS NOT NULL)")
            }),
        "provider/effective-date partial index is missing or malformed",
    );

    let tenant_key_present: bool = sqlx::query_scalar(
        "SELECT to_regclass(\
             'public.marketplace_sales_handoffs_tenant_id_id_idx'\
         ) IS NOT NULL",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        tenant_key_present,
        "tenant-scoped handoff references require a composite unique key",
    );

    let projection_table_present: bool = sqlx::query_scalar(
        "SELECT to_regclass('public.marketplace_sales_opportunities') IS NOT NULL",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        projection_table_present,
        "the conversion projection schema was not installed",
    );

    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.tables \
         WHERE table_schema = current_schema()",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        table_count > 20,
        "expected the complete schema, found {table_count} tables"
    );
    Ok(())
}
