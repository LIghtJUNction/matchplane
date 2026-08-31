use std::collections::HashMap;

use std::borrow::Cow;

use sqlx::migrate::{Migration, MigrationType, Migrator};
use sqlx::{PgPool, SqlSafeStr};

const CURRENCY_SETTINGS_V1: &str =
    include_str!("../../../migrations/202608280001_mall_currency_exchange_rate.sql");
const CURRENCY_SETTINGS_V2: &str =
    include_str!("../../../migrations/202608280002_upgrade_mall_currency_exchange_rate.sql");
const OFFER_PRODUCT_TEMPLATES: &str =
    include_str!("../../../migrations/202608300001_marketplace_offer_product_templates.sql");
const ACQUISITION_LINKS_V1: &str =
    include_str!("../../../migrations/202608300002_marketplace_acquisition_links.sql");
const ACQUISITION_TOUCHPOINT_BOUNDS: &str =
    include_str!("../../../migrations/202608310001_acquisition_touchpoint_bounds.sql");
const CURRENCY_SETTINGS_V1_SQLX_CHECKSUM: &str = "5cfd4a04c6f2f0ea139d8fd0c073c98e5535df7fc961c674ce32b12abb5826245e794f67f67d723d577e34c11b2c0dc0";
const CURRENCY_SETTINGS_V2_SQLX_CHECKSUM: &str = "e1e63455ab259a79d88faf5e317ffec2ccc8013ec3d3abb07abcf73e6bff2a48590b69acad0335b01a95b10076fd8ae3";
const ACQUISITION_LINKS_V1_SQLX_CHECKSUM: &str = "98ee731d315ccea6a39ad575dc489f70763beac0ee3f1e367576d6dbcf3074a0ea1d7686a45c4d07efecd12a68823a0b";

fn currency_settings_migration(
    version: i64,
    description: &'static str,
    sql: &'static str,
) -> Migration {
    Migration::new(
        version,
        Cow::Borrowed(description),
        MigrationType::Simple,
        sql.into_sql_str(),
        false,
    )
}

#[derive(sqlx::FromRow)]
struct ColumnMetadata {
    name: String,
    data_type: String,
    nullable: String,
    precision: Option<i32>,
    scale: Option<i32>,
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires PostgreSQL with the MatchPlane extensions; CI runs this target explicitly"]
async fn fresh_install_should_apply_every_embedded_migration(
    pool: PgPool,
) -> Result<(), sqlx::Error> {
    let latest_applied: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
           SELECT 1 FROM _sqlx_migrations \
            WHERE version = 202608310001 AND success\
         )",
    )
    .fetch_one(&pool)
    .await?;
    assert!(latest_applied, "latest migration was not applied");

    // This migration deliberately owns idempotent DDL boundaries so recovery tooling may replay
    // the file without changing or weakening the nullable legacy contract.
    sqlx::raw_sql(OFFER_PRODUCT_TEMPLATES)
        .execute(&pool)
        .await?;
    let product_template_column: (String, String) = sqlx::query_as(
        "SELECT data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'marketplace_offers'
            AND column_name = 'product_template_id'",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(
        product_template_column,
        ("text".to_owned(), "YES".to_owned())
    );
    let product_template_check: String = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conrelid = 'marketplace_offers'::regclass
            AND conname = 'marketplace_offers_product_template_id_format'",
    )
    .fetch_one(&pool)
    .await?;
    assert!(product_template_check.contains("^[a-z][a-z0-9._-]{0,63}$"));
    let product_template_index: String = sqlx::query_scalar(
        "SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'marketplace_offers'
            AND indexname = 'idx_marketplace_offers_tenant_store_template_status'",
    )
    .fetch_one(&pool)
    .await?;
    assert!(product_template_index.contains("(tenant_id, store_id, product_template_id, status)"));

    let acquisition_link_columns: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'marketplace_acquisition_links'
          ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await?;
    let acquisition_link_columns: HashMap<_, _> = acquisition_link_columns
        .into_iter()
        .map(|(name, data_type, nullable)| (name, (data_type, nullable)))
        .collect();
    for (name, data_type, nullable) in [
        ("id", "uuid", "NO"),
        ("tenant_id", "uuid", "NO"),
        ("domain_id", "uuid", "NO"),
        ("store_id", "uuid", "NO"),
        ("offer_id", "uuid", "NO"),
        ("token_digest", "bytea", "NO"),
        ("channel_key", "text", "NO"),
        ("source_ref", "text", "YES"),
        ("campaign_ref", "text", "YES"),
        ("status", "text", "NO"),
        ("expires_at", "timestamp with time zone", "YES"),
        ("version", "bigint", "NO"),
        ("created_at", "timestamp with time zone", "NO"),
        ("updated_at", "timestamp with time zone", "NO"),
    ] {
        assert_eq!(
            acquisition_link_columns.get(name),
            Some(&(data_type.to_owned(), nullable.to_owned())),
            "missing or malformed acquisition link column {name}",
        );
    }
    for forbidden in [
        "token",
        "raw_token",
        "phone",
        "phone_number",
        "wechat_id",
        "ip",
        "ip_address",
        "user_agent",
        "user_id",
        "auth_user_id",
    ] {
        assert!(
            !acquisition_link_columns.contains_key(forbidden),
            "privacy-forbidden acquisition link column {forbidden}",
        );
    }

    let acquisition_link_constraints: HashMap<String, String> = sqlx::query_as(
        "SELECT conname, pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conrelid = 'marketplace_acquisition_links'::regclass",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();
    for required in [
        "marketplace_acquisition_links_channel_key_format",
        "marketplace_acquisition_links_source_ref_bounds",
        "marketplace_acquisition_links_campaign_ref_bounds",
        "marketplace_acquisition_links_status_check",
        "marketplace_acquisition_links_expiry_check",
        "marketplace_acquisition_links_version_check",
        "marketplace_acquisition_links_domain_fk",
        "marketplace_acquisition_links_store_scope_fk",
    ] {
        assert!(
            acquisition_link_constraints.contains_key(required),
            "missing acquisition link constraint {required}",
        );
    }
    assert!(
        acquisition_link_constraints
            .get("marketplace_acquisition_links_token_digest_size")
            .is_some_and(|definition| definition.contains("octet_length(token_digest) = 32")),
        "link tokens must remain fixed-size SHA-256 digests",
    );
    assert!(
        acquisition_link_constraints
            .get("marketplace_acquisition_links_offer_scope_fk")
            .is_some_and(|definition| definition.contains(
                "FOREIGN KEY (tenant_id, domain_id, store_id, offer_id) REFERENCES marketplace_offers(tenant_id, domain_id, store_id, id)",
            )),
        "acquisition offers must prove their complete canonical store scope",
    );
    assert!(
        acquisition_link_constraints
            .get("marketplace_acquisition_links_token_digest_unique")
            .is_some_and(|definition| definition.contains("UNIQUE (token_digest)")),
        "each public acquisition token digest must be globally unique",
    );

    let touchpoint_columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'marketplace_acquisition_touchpoints'
          ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await?;
    assert_eq!(
        touchpoint_columns,
        vec![
            "id",
            "tenant_id",
            "link_id",
            "anonymous_subject_digest",
            "event_type",
            "occurred_at",
            "occurred_on",
        ],
        "touchpoints must not acquire identity, request-header, or free-form payload columns",
    );
    let touchpoint_constraints: HashMap<String, String> = sqlx::query_as(
        "SELECT conname, pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conrelid = 'marketplace_acquisition_touchpoints'::regclass",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();
    assert!(
        touchpoint_constraints
            .get("marketplace_acquisition_touchpoints_subject_digest_size")
            .is_some_and(|definition| {
                definition.contains("octet_length(anonymous_subject_digest) = 32")
            }),
        "anonymous subjects must remain fixed-size SHA-256 digests",
    );
    assert!(
        touchpoint_constraints
            .get("marketplace_acquisition_touchpoints_event_type_check")
            .is_some_and(|definition| definition.contains("landing_viewed")),
        "phase-one touchpoint events must remain allow-listed",
    );
    let landing_idempotency = touchpoint_constraints
        .get("marketplace_acquisition_touchpoints_landing_idempotency")
        .expect("missing landing idempotency constraint");
    assert!(
        landing_idempotency
            .contains("UNIQUE (tenant_id, link_id, anonymous_subject_digest, event_type)"),
        "landing attribution must be idempotent per link and anonymous subject",
    );
    assert!(
        touchpoint_constraints
            .get("marketplace_acquisition_touchpoints_occurred_on_utc_check")
            .is_some_and(|definition| {
                definition.contains("occurred_on")
                    && definition.contains("occurred_at")
                    && definition.contains("UTC")
            }),
        "the stored capacity day must remain bound to occurred_at in UTC",
    );
    let occurred_on_column: (String, String, Option<String>) = sqlx::query_as(
        "SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'marketplace_acquisition_touchpoints'
            AND column_name = 'occurred_on'",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(
        occurred_on_column,
        ("date".to_owned(), "NO".to_owned(), None),
        "occurred_on must be an explicitly supplied stable UTC date",
    );
    let touchpoint_index_present: bool = sqlx::query_scalar(
        "SELECT to_regclass(
             'public.marketplace_acquisition_touchpoints_link_time_idx'
         ) IS NOT NULL",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        touchpoint_index_present,
        "acquisition touchpoint reporting index was not installed",
    );
    let touchpoint_day_index: String = sqlx::query_scalar(
        "SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'marketplace_acquisition_touchpoints'
            AND indexname = 'marketplace_acquisition_touchpoints_link_day_idx'",
    )
    .fetch_one(&pool)
    .await?;
    assert!(
        touchpoint_day_index.contains("(tenant_id, link_id, occurred_on)"),
        "the capacity count must have a usable link/day index",
    );

    let columns: Vec<ColumnMetadata> = sqlx::query_as(
        "SELECT column_name AS name, data_type, is_nullable AS nullable, \
                numeric_precision AS precision, numeric_scale AS scale \
           FROM information_schema.columns \
          WHERE table_schema = current_schema() \
            AND table_name = 'mall_currency_settings'",
    )
    .fetch_all(&pool)
    .await?;
    let columns: HashMap<_, _> = columns
        .into_iter()
        .map(|column| (column.name.clone(), column))
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
    let rate_column = columns
        .get("usd_to_local_rate")
        .expect("missing usd_to_local_rate column");
    assert_eq!(rate_column.data_type, "numeric");
    assert_eq!(rate_column.nullable, "YES");
    assert_eq!(rate_column.precision, None);
    assert_eq!(rate_column.scale, None);
    assert_eq!(
        columns
            .get("rate_effective_date")
            .map(|column| column.data_type.as_str()),
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

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this target explicitly"]
async fn currency_settings_upgrade_should_migrate_the_original_snapshot_without_fabrication(
    pool: PgPool,
) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE tenants (id uuid PRIMARY KEY)")
        .execute(&pool)
        .await?;

    let v1 = currency_settings_migration(
        202608280001,
        "mall currency exchange rate",
        CURRENCY_SETTINGS_V1,
    );
    assert_eq!(
        hex::encode(v1.checksum.as_ref()),
        CURRENCY_SETTINGS_V1_SQLX_CHECKSUM,
        "the immutable 001 migration no longer has its released SQLx checksum",
    );
    Migrator::with_migrations(vec![v1.clone()])
        .run(&pool)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;

    let tenant_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO tenants (id) VALUES ($1)")
        .bind(tenant_id)
        .execute(&pool)
        .await?;
    sqlx::query(
        "INSERT INTO mall_currency_settings \
             (tenant_id, local_currency, usd_to_local_rate, rate_source, rate_updated_at, version) \
         VALUES ($1, 'JPY', 146.123456789012, 'legacy.example', \
                 '2026-08-27T12:00:00Z'::timestamptz, 7)",
    )
    .bind(tenant_id)
    .execute(&pool)
    .await?;

    let v2 = currency_settings_migration(
        202608280002,
        "upgrade mall currency exchange rate",
        CURRENCY_SETTINGS_V2,
    );
    assert_eq!(
        hex::encode(v2.checksum.as_ref()),
        CURRENCY_SETTINGS_V2_SQLX_CHECKSUM,
        "the immutable 002 migration no longer has its released SQLx checksum",
    );
    let v2_checksum = v2.checksum.to_vec();
    let migrator = Migrator::with_migrations(vec![v1.clone(), v2]);
    migrator
        .run(&pool)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;
    migrator
        .run(&pool)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;

    let applied_checksums: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version, checksum FROM _sqlx_migrations \
         WHERE version IN (202608280001, 202608280002) ORDER BY version",
    )
    .fetch_all(&pool)
    .await?;
    assert_eq!(
        applied_checksums,
        vec![
            (202608280001, v1.checksum.to_vec()),
            (202608280002, v2_checksum),
        ],
        "SQLx must validate the released 001 checksum before recording 002",
    );

    let preserved: (uuid::Uuid, String, i64, bool) = sqlx::query_as(
        "SELECT tenant_id, local_currency, version, \
                usd_to_local_rate IS NULL \
                AND rate_source IS NULL \
                AND rate_provider IS NULL \
                AND rate_effective_date IS NULL \
                AND rate_response_digest IS NULL \
                AND rate_updated_at IS NULL AS snapshot_cleared \
           FROM mall_currency_settings WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(preserved, (tenant_id, "JPY".to_owned(), 7, true));

    let columns: Vec<(String, String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT column_name, data_type, numeric_precision, numeric_scale \
           FROM information_schema.columns \
          WHERE table_schema = 'public' AND table_name = 'mall_currency_settings' \
          ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await?;
    assert_eq!(
        columns,
        vec![
            ("tenant_id".to_owned(), "uuid".to_owned(), None, None),
            ("local_currency".to_owned(), "text".to_owned(), None, None),
            (
                "usd_to_local_rate".to_owned(),
                "numeric".to_owned(),
                None,
                None
            ),
            ("rate_source".to_owned(), "text".to_owned(), None, None),
            (
                "rate_updated_at".to_owned(),
                "timestamp with time zone".to_owned(),
                None,
                None,
            ),
            ("version".to_owned(), "bigint".to_owned(), Some(64), Some(0)),
            (
                "created_at".to_owned(),
                "timestamp with time zone".to_owned(),
                None,
                None,
            ),
            (
                "updated_at".to_owned(),
                "timestamp with time zone".to_owned(),
                None,
                None,
            ),
            ("rate_provider".to_owned(), "text".to_owned(), None, None),
            (
                "rate_effective_date".to_owned(),
                "date".to_owned(),
                None,
                None
            ),
            (
                "rate_response_digest".to_owned(),
                "text".to_owned(),
                None,
                None,
            ),
        ],
        "002 must expose unbounded exact numeric and all snapshot provenance columns",
    );

    let constraints: Vec<String> = sqlx::query_scalar(
        "SELECT conname FROM pg_constraint \
          WHERE conrelid = 'mall_currency_settings'::regclass \
            AND contype IN ('c', 'f', 'p') ORDER BY conname",
    )
    .fetch_all(&pool)
    .await?;
    assert_eq!(
        constraints,
        vec![
            "mall_currency_settings_local_currency_check",
            "mall_currency_settings_pkey",
            "mall_currency_settings_rate_provider_check",
            "mall_currency_settings_rate_range_check",
            "mall_currency_settings_rate_response_digest_check",
            "mall_currency_settings_rate_source_check",
            "mall_currency_settings_snapshot_coherence_check",
            "mall_currency_settings_tenant_id_fkey",
            "mall_currency_settings_version_check",
        ],
    );

    let foreign_key: (String, String, String) = sqlx::query_as(
        "SELECT a.attname, confrelid::regclass::text, confdeltype::text \
           FROM pg_constraint c \
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] \
          WHERE c.conrelid = 'mall_currency_settings'::regclass AND c.contype = 'f'",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(
        foreign_key,
        ("tenant_id".to_owned(), "tenants".to_owned(), "c".to_owned()),
        "the tenant foreign key must retain ON DELETE CASCADE",
    );

    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes \
          WHERE schemaname = 'public' AND tablename = 'mall_currency_settings' \
          ORDER BY indexname",
    )
    .fetch_all(&pool)
    .await?;
    assert_eq!(
        indexes,
        vec![
            "mall_currency_settings_pkey",
            "mall_currency_settings_provider_effective_date_idx",
            "mall_currency_settings_updated_at_idx",
        ],
    );

    sqlx::query(
        "UPDATE mall_currency_settings SET \
             usd_to_local_rate = 146.123456789012345678901234567891, \
             rate_source = 'https://provider.example/rates', \
             rate_provider = 'provider', \
             rate_effective_date = '2026-08-28', \
             rate_response_digest = \
                 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', \
             rate_updated_at = '2026-08-28T12:00:00Z' \
         WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .execute(&pool)
    .await?;
    let exact_rate: String = sqlx::query_scalar(
        "SELECT usd_to_local_rate::text FROM mall_currency_settings WHERE tenant_id = $1",
    )
    .bind(tenant_id)
    .fetch_one(&pool)
    .await?;
    assert_eq!(exact_rate, "146.123456789012345678901234567891");

    Ok(())
}

#[sqlx::test]
#[ignore = "requires PostgreSQL; CI runs this target explicitly"]
async fn acquisition_touchpoint_bounds_upgrade_should_preserve_v1_and_backfill_utc_day(
    pool: PgPool,
) -> Result<(), sqlx::Error> {
    let mut connection = pool.acquire().await?;
    sqlx::raw_sql(
        r#"
        CREATE TABLE tenants (
            id uuid PRIMARY KEY,
            status text NOT NULL DEFAULT 'active'
        );
        CREATE TABLE domains (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants(id),
            status text NOT NULL DEFAULT 'active',
            UNIQUE (tenant_id, id)
        );
        CREATE TABLE stores (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants(id),
            domain_id uuid NOT NULL,
            status text NOT NULL DEFAULT 'active',
            visibility text NOT NULL DEFAULT 'public',
            UNIQUE (tenant_id, domain_id, id)
        );
        CREATE TABLE marketplace_offers (
            id uuid PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants(id),
            domain_id uuid NOT NULL,
            store_id uuid NOT NULL,
            status text NOT NULL DEFAULT 'active',
            expires_at timestamptz
        );
        CREATE FUNCTION matchplane_set_updated_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            NEW.updated_at = clock_timestamp();
            RETURN NEW;
        END;
        $$;
        "#,
    )
    .execute(&mut *connection)
    .await?;

    let v1 = currency_settings_migration(
        202608300002,
        "marketplace acquisition links",
        ACQUISITION_LINKS_V1,
    );
    assert_eq!(
        hex::encode(v1.checksum.as_ref()),
        ACQUISITION_LINKS_V1_SQLX_CHECKSUM,
        "the production-applied acquisition migration must remain byte-for-byte immutable",
    );
    Migrator::with_migrations(vec![v1.clone()])
        .run(&mut *connection)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;

    let tenant_id = uuid::Uuid::now_v7();
    let domain_id = uuid::Uuid::now_v7();
    let store_id = uuid::Uuid::now_v7();
    let offer_id = uuid::Uuid::now_v7();
    let link_id = uuid::Uuid::now_v7();
    sqlx::query("INSERT INTO tenants (id) VALUES ($1)")
        .bind(tenant_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query("INSERT INTO domains (id, tenant_id) VALUES ($1, $2)")
        .bind(domain_id)
        .bind(tenant_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query("INSERT INTO stores (id, tenant_id, domain_id) VALUES ($1, $2, $3)")
        .bind(store_id)
        .bind(tenant_id)
        .bind(domain_id)
        .execute(&mut *connection)
        .await?;
    sqlx::query(
        "INSERT INTO marketplace_offers (id, tenant_id, domain_id, store_id)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(offer_id)
    .bind(tenant_id)
    .bind(domain_id)
    .bind(store_id)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_acquisition_links
             (id, tenant_id, domain_id, store_id, offer_id, token_digest, channel_key)
         VALUES ($1, $2, $3, $4, $5, decode(repeat('11', 32), 'hex'), 'test')",
    )
    .bind(link_id)
    .bind(tenant_id)
    .bind(domain_id)
    .bind(store_id)
    .bind(offer_id)
    .execute(&mut *connection)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_acquisition_touchpoints
             (id, tenant_id, link_id, anonymous_subject_digest, event_type, occurred_at)
         VALUES ($1, $2, $3, decode(repeat('22', 32), 'hex'), 'landing_viewed',
                 '2026-08-30T23:30:00Z'::timestamptz)",
    )
    .bind(uuid::Uuid::now_v7())
    .bind(tenant_id)
    .bind(link_id)
    .execute(&mut *connection)
    .await?;

    // A session-local date cast would incorrectly backfill 2026-08-31 here.
    sqlx::query("SET TIME ZONE 'Pacific/Kiritimati'")
        .execute(&mut *connection)
        .await?;
    let v2 = currency_settings_migration(
        202608310001,
        "acquisition touchpoint bounds",
        ACQUISITION_TOUCHPOINT_BOUNDS,
    );
    let v2_checksum = v2.checksum.to_vec();
    let migrator = Migrator::with_migrations(vec![v1.clone(), v2]);
    migrator
        .run(&mut *connection)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;
    migrator
        .run(&mut *connection)
        .await
        .map_err(|error| sqlx::Error::Migrate(Box::new(error)))?;

    let applied_checksums: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT version, checksum FROM _sqlx_migrations
          WHERE version IN (202608300002, 202608310001) ORDER BY version",
    )
    .fetch_all(&mut *connection)
    .await?;
    assert_eq!(
        applied_checksums,
        vec![
            (202608300002, v1.checksum.to_vec()),
            (202608310001, v2_checksum),
        ],
        "the bounds migration must append after the immutable production migration",
    );

    let occurred_on: String = sqlx::query_scalar(
        "SELECT occurred_on::text FROM marketplace_acquisition_touchpoints WHERE link_id = $1",
    )
    .bind(link_id)
    .fetch_one(&mut *connection)
    .await?;
    assert_eq!(
        occurred_on, "2026-08-30",
        "the upgrade backfill must use UTC rather than the session timezone",
    );

    let occurred_on_column: (String, String, Option<String>) = sqlx::query_as(
        "SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'marketplace_acquisition_touchpoints'
            AND column_name = 'occurred_on'",
    )
    .fetch_one(&mut *connection)
    .await?;
    assert_eq!(
        occurred_on_column,
        ("date".to_owned(), "NO".to_owned(), None),
    );
    let utc_check: String = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conrelid = 'marketplace_acquisition_touchpoints'::regclass
            AND conname = 'marketplace_acquisition_touchpoints_occurred_on_utc_check'",
    )
    .fetch_one(&mut *connection)
    .await?;
    assert!(utc_check.contains("UTC") && utc_check.contains("occurred_at"));
    let day_index: String = sqlx::query_scalar(
        "SELECT indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'marketplace_acquisition_touchpoints'
            AND indexname = 'marketplace_acquisition_touchpoints_link_day_idx'",
    )
    .fetch_one(&mut *connection)
    .await?;
    assert!(day_index.contains("(tenant_id, link_id, occurred_on)"));
    let idempotency_constraint: String = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conrelid = 'marketplace_acquisition_touchpoints'::regclass
            AND conname = 'marketplace_acquisition_touchpoints_landing_idempotency'",
    )
    .fetch_one(&mut *connection)
    .await?;
    assert!(
        idempotency_constraint
            .contains("UNIQUE (tenant_id, link_id, anonymous_subject_digest, event_type)")
    );

    Ok(())
}
