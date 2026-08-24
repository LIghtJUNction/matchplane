use sqlx::PgPool;

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires PostgreSQL with the MatchPlane extensions; CI runs this target explicitly"]
async fn fresh_install_should_apply_every_embedded_migration(
    pool: PgPool,
) -> Result<(), sqlx::Error> {
    let latest_applied: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
             SELECT 1 FROM _sqlx_migrations \
              WHERE version = 202608240005 AND success\
         )",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        latest_applied,
        "the latest embedded migration was not applied"
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

    Ok(())
}
