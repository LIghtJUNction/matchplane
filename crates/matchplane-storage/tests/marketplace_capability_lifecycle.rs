use matchplane_domain::{
    DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId, MatchIntroductionId,
    TenantId,
};
use matchplane_storage::{
    CreateMarketplaceIntroduction, MatchMarketplaceDemands, MatchMarketplaceOffers, PgStore,
    StorageError,
};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
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

struct DiscoveryFixture {
    store: PgStore,
    tenant_id: TenantId,
    domain_id: DomainId,
    demand_party_id: MarketplacePartyId,
    supply_party_id: MarketplacePartyId,
    store_id: Uuid,
    intent_id: MarketplaceIntentId,
    offer_id: MarketplaceOfferId,
}

async fn discovery_fixture(pool: PgPool) -> Result<DiscoveryFixture, StorageError> {
    let supply = legacy_store_party(pool, "seller", "supply").await?;
    let demand_party_id = MarketplacePartyId::new();
    let intent_id = MarketplaceIntentId::new();
    let offer_id = MarketplaceOfferId::new();

    sqlx::query(
        "INSERT INTO marketplace_parties
         (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role,
          marketplace_sides, access_token_hash, access_token_expires_at, contact_ciphertext,
          contact_nonce, contact_key_version)
         VALUES ($1, $2, $3, '/legacy-demand', 'demand-party', 'Demand party', 'buyer',
                 ARRAY['demand']::text[], decode(repeat('08', 32), 'hex'),
                 clock_timestamp() + INTERVAL '15 minutes', decode('00', 'hex'),
                 decode('000000000000000000000000', 'hex'), 1)",
    )
    .bind(demand_party_id.into_uuid())
    .bind(supply.tenant_id.into_uuid())
    .bind(supply.domain_id.into_uuid())
    .execute(supply.store.pool())
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_intents
         (id, tenant_id, domain_id, participant_id, side, narrative, attributes, terms,
          supply_discovery_enabled, idempotency_key, status)
         VALUES ($1, $2, $3, $4, 'demand', 'electric bicycle',
                 '{\"category\":\"electric bicycle\"}'::jsonb, '{}'::jsonb,
                 true, 'discovery-intent', 'active')",
    )
    .bind(intent_id.into_uuid())
    .bind(supply.tenant_id.into_uuid())
    .bind(supply.domain_id.into_uuid())
    .bind(demand_party_id.into_uuid())
    .execute(supply.store.pool())
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_offers
         (id, tenant_id, domain_id, supply_party_id, external_key, display_name, attributes,
          terms, status, published_at)
         VALUES ($1, $2, $3, $4, 'electric-bike-1', 'Electric bicycle',
                 '{\"description\":\"Electric bicycle\"}'::jsonb,
                 '{\"pricing_mode\":\"fixed\",\"amount_minor\":\"10000\",\"currency\":\"CNY\",\"currency_scale\":\"2\"}'::jsonb,
                 'active', clock_timestamp())",
    )
    .bind(offer_id.into_uuid())
    .bind(supply.tenant_id.into_uuid())
    .bind(supply.domain_id.into_uuid())
    .bind(supply.party_id.into_uuid())
    .execute(supply.store.pool())
    .await?;

    let assigned_store_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT store_id FROM marketplace_offers WHERE tenant_id = $1 AND id = $2",
    )
    .bind(supply.tenant_id.into_uuid())
    .bind(offer_id.into_uuid())
    .fetch_one(supply.store.pool())
    .await?;
    assert_eq!(assigned_store_id, Some(supply.store_id));

    Ok(DiscoveryFixture {
        store: supply.store,
        tenant_id: supply.tenant_id,
        domain_id: supply.domain_id,
        demand_party_id,
        supply_party_id: supply.party_id,
        store_id: supply.store_id,
        intent_id,
        offer_id,
    })
}

async fn assert_store_offer_is_not_discoverable(
    fixture: &DiscoveryFixture,
    lifecycle: &str,
) -> Result<(), StorageError> {
    let offers = fixture
        .store
        .match_marketplace_offers(&MatchMarketplaceOffers {
            tenant_id: fixture.tenant_id,
            intent_id: fixture.intent_id,
            participant_id: fixture.demand_party_id,
            limit: 10,
        })
        .await?;
    assert!(
        offers.is_empty(),
        "{lifecycle} store offer leaked to demand matching"
    );

    let demands = fixture
        .store
        .match_marketplace_demands(&MatchMarketplaceDemands {
            tenant_id: fixture.tenant_id,
            domain_id: fixture.domain_id,
            offer_id: fixture.offer_id,
            participant_id: fixture.supply_party_id,
            limit: 10,
        })
        .await;
    assert!(
        matches!(demands, Err(StorageError::Conflict(_))),
        "{lifecycle} store offer remained open for supply discovery: {demands:?}"
    );

    let introduction = fixture
        .store
        .create_marketplace_introduction(&CreateMarketplaceIntroduction {
            introduction_id: MatchIntroductionId::new(),
            tenant_id: fixture.tenant_id,
            intent_id: fixture.intent_id,
            offer_id: fixture.offer_id,
            participant_id: fixture.demand_party_id,
            score: 0.9,
            reasons: vec!["matching test attributes".to_owned()],
            idempotency_key: format!("{lifecycle}-introduction"),
            expires_at: OffsetDateTime::now_utc() + Duration::hours(1),
        })
        .await;
    assert!(
        matches!(introduction, Err(StorageError::Conflict(_))),
        "{lifecycle} store offer allowed a new introduction: {introduction:?}"
    );
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn store_lifecycle_should_gate_offer_matching_and_new_introductions(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = discovery_fixture(pool).await?;

    let offers = fixture
        .store
        .match_marketplace_offers(&MatchMarketplaceOffers {
            tenant_id: fixture.tenant_id,
            intent_id: fixture.intent_id,
            participant_id: fixture.demand_party_id,
            limit: 10,
        })
        .await?;
    assert_eq!(offers.len(), 1);
    let demands = fixture
        .store
        .match_marketplace_demands(&MatchMarketplaceDemands {
            tenant_id: fixture.tenant_id,
            domain_id: fixture.domain_id,
            offer_id: fixture.offer_id,
            participant_id: fixture.supply_party_id,
            limit: 10,
        })
        .await?;
    assert_eq!(demands.len(), 1);

    sqlx::query("UPDATE stores SET visibility = 'private' WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.store_id)
        .execute(fixture.store.pool())
        .await?;
    assert_store_offer_is_not_discoverable(&fixture, "private").await?;

    sqlx::query(
        "UPDATE stores SET visibility = 'public', status = 'suspended'
         WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;
    assert_store_offer_is_not_discoverable(&fixture, "suspended").await?;

    sqlx::query("UPDATE stores SET status = 'active' WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.store_id)
        .execute(fixture.store.pool())
        .await?;
    sqlx::query("UPDATE domains SET status = 'disabled' WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.domain_id.into_uuid())
        .execute(fixture.store.pool())
        .await?;
    assert_store_offer_is_not_discoverable(&fixture, "disabled-domain").await?;
    Ok(())
}
