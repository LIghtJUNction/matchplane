use matchplane_domain::{DomainId, MarketplacePartyId, TenantId};
use matchplane_storage::{PgStore, StorageError};
use sqlx::PgPool;
use uuid::Uuid;

struct LegacyStoreParty {
    store: PgStore,
    tenant_id: TenantId,
    domain_id: DomainId,
    party_id: MarketplacePartyId,
    store_id: Uuid,
    token_hash: Vec<u8>,
}

async fn legacy_store_party(
    pool: PgPool,
    role: &str,
    marketplace_side: &str,
) -> Result<LegacyStoreParty, StorageError> {
    let tenant_id = TenantId::new();
    let domain_id = DomainId::new();
    let party_id = MarketplacePartyId::new();
    let organization_id = Uuid::now_v7();
    let store_id = Uuid::now_v7();
    let token_hash = vec![7; 32];

    sqlx::query("INSERT INTO tenants (id, slug, name) VALUES ($1, 'test-tenant', 'Test tenant')")
        .bind(tenant_id.into_uuid())
        .execute(&pool)
        .await?;
    sqlx::query(
        "INSERT INTO domains (id, tenant_id, slug, name) \
         VALUES ($1, $2, 'test-domain', 'Test domain')",
    )
    .bind(domain_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO \"organization\" \
         (id, name, slug, \"createdAt\", \"tenantId\", \"domainId\") \
         VALUES ($1, 'Test store', 'test-store', clock_timestamp(), $2, $3)",
    )
    .bind(organization_id)
    .bind(tenant_id.to_string())
    .bind(domain_id.to_string())
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO stores \
         (id, tenant_id, organization_id, domain_id, slug, display_name, status, \
          visibility, integration_kind, created_by) \
         VALUES ($1, $2, $3, $4, 'test-store', 'Test store', 'active', \
                 'public', 'hosted', 'integration-test')",
    )
    .bind(store_id)
    .bind(tenant_id.into_uuid())
    .bind(organization_id)
    .bind(domain_id.into_uuid())
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical) \
         VALUES ($1, $2, '/test-store', true)",
    )
    .bind(tenant_id.into_uuid())
    .bind(store_id)
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_parties \
         (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role, \
          marketplace_sides, access_token_hash, access_token_expires_at, contact_ciphertext, \
          contact_nonce, contact_key_version) \
         VALUES ($1, $2, $3, '/test-store', 'legacy-party', 'Legacy party', $4, \
                 ARRAY[$5]::text[], $6, clock_timestamp() + INTERVAL '15 minutes', \
                 decode('00', 'hex'), decode('000000000000000000000000', 'hex'), 1)",
    )
    .bind(party_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(role)
    .bind(marketplace_side)
    .bind(&token_hash)
    .execute(&pool)
    .await?;

    Ok(LegacyStoreParty {
        store: PgStore::from_pool(pool),
        tenant_id,
        domain_id,
        party_id,
        store_id,
        token_hash,
    })
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn legacy_supply_capability_should_be_revoked_when_store_is_suspended(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    fixture
        .store
        .authenticate_marketplace_party(
            fixture.tenant_id,
            fixture.party_id,
            &fixture.token_hash,
            Some(fixture.domain_id),
            Some("/test-store"),
        )
        .await?;

    sqlx::query("UPDATE stores SET status = 'suspended' WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.store_id)
        .execute(fixture.store.pool())
        .await?;

    let result = fixture
        .store
        .authenticate_marketplace_party(
            fixture.tenant_id,
            fixture.party_id,
            &fixture.token_hash,
            Some(fixture.domain_id),
            Some("/test-store"),
        )
        .await;

    assert!(matches!(result, Err(StorageError::Forbidden(_))));
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn legacy_demand_capability_should_be_revoked_when_domain_is_disabled(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "buyer", "demand").await?;
    fixture
        .store
        .authenticate_marketplace_party(
            fixture.tenant_id,
            fixture.party_id,
            &fixture.token_hash,
            Some(fixture.domain_id),
            Some("/test-store"),
        )
        .await?;

    sqlx::query("UPDATE domains SET status = 'disabled' WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.domain_id.into_uuid())
        .execute(fixture.store.pool())
        .await?;

    let result = fixture
        .store
        .authenticate_marketplace_party(
            fixture.tenant_id,
            fixture.party_id,
            &fixture.token_hash,
            Some(fixture.domain_id),
            Some("/test-store"),
        )
        .await;

    assert!(matches!(result, Err(StorageError::Forbidden(_))));
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn legacy_capability_without_a_store_should_remain_compatible(
    pool: PgPool,
) -> Result<(), StorageError> {
    let tenant_id = TenantId::new();
    let domain_id = DomainId::new();
    let party_id = MarketplacePartyId::new();
    let token_hash = vec![11; 32];

    sqlx::query(
        "INSERT INTO tenants (id, slug, name) VALUES ($1, 'legacy-tenant', 'Legacy tenant')",
    )
    .bind(tenant_id.into_uuid())
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO domains (id, tenant_id, slug, name, status) \
         VALUES ($1, $2, 'legacy-domain', 'Legacy domain', 'disabled')",
    )
    .bind(domain_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .execute(&pool)
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_parties \
         (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role, \
          marketplace_sides, access_token_hash, access_token_expires_at, contact_ciphertext, \
          contact_nonce, contact_key_version) \
         VALUES ($1, $2, $3, '/legacy-direct', 'legacy-direct', 'Legacy direct party', 'buyer', \
                 ARRAY['demand']::text[], $4, clock_timestamp() + INTERVAL '15 minutes', \
                 decode('00', 'hex'), decode('000000000000000000000000', 'hex'), 1)",
    )
    .bind(party_id.into_uuid())
    .bind(tenant_id.into_uuid())
    .bind(domain_id.into_uuid())
    .bind(&token_hash)
    .execute(&pool)
    .await?;

    let result = PgStore::from_pool(pool)
        .authenticate_marketplace_party(
            tenant_id,
            party_id,
            &token_hash,
            Some(domain_id),
            Some("/legacy-direct"),
        )
        .await;

    assert!(result.is_ok(), "legacy capability failed: {result:?}");
    Ok(())
}
