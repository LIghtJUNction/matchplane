use matchplane_domain::{
    DomainId, MarketplaceIntentId, MarketplaceOfferId, MarketplacePartyId, MatchIntroductionId,
    TenantId,
};
use matchplane_storage::{
    CreateMarketplaceIntroduction, CreateMarketplaceOffer, MatchMarketplaceDemands,
    MatchMarketplaceOffers, PgStore, StorageError, UpdateMarketplaceOffer,
};
use serde_json::{Value, json};
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
    assert_eq!(
        offers[0].offer.attributes,
        json!({"description": "Electric bicycle"})
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

async fn install_store_registration(
    fixture: &LegacyStoreParty,
    manifest: Value,
) -> Result<(), StorageError> {
    let registration_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO subplatform_registrations
         (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
          pinned_revision, source_digest, manifest_digest, manifest, state, registered_by,
          activated_at)
         VALUES ($1, $2, $3, 'test.product-templates', 'test-store', 'git',
                 'https://example.test/store.git', 'test-revision', decode(repeat('11', 32), 'hex'),
                 decode(repeat('22', 32), 'hex'), $4, 'active', 'integration-test',
                 clock_timestamp())",
    )
    .bind(registration_id)
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.domain_id.into_uuid())
    .bind(manifest)
    .execute(fixture.store.pool())
    .await?;
    sqlx::query(
        "UPDATE stores
            SET current_registration_id = $3, integration_kind = 'external'
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .bind(registration_id)
    .execute(fixture.store.pool())
    .await?;
    Ok(())
}

async fn install_demand_intent(
    fixture: &LegacyStoreParty,
    narrative: &str,
    attributes: Value,
) -> Result<(MarketplacePartyId, MarketplaceIntentId), StorageError> {
    let demand_party_id = MarketplacePartyId::new();
    let intent_id = MarketplaceIntentId::new();
    sqlx::query(
        "INSERT INTO marketplace_parties
         (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role,
          marketplace_sides, access_token_hash, access_token_expires_at, contact_ciphertext,
          contact_nonce, contact_key_version)
         VALUES ($1, $2, $3, '/template-demand', $4, 'Template demand', 'buyer',
                 ARRAY['demand']::text[], decode(repeat('09', 32), 'hex'),
                 clock_timestamp() + INTERVAL '15 minutes', decode('00', 'hex'),
                 decode('000000000000000000000000', 'hex'), 1)",
    )
    .bind(demand_party_id.into_uuid())
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.domain_id.into_uuid())
    .bind(format!("template-demand-{demand_party_id}"))
    .execute(fixture.store.pool())
    .await?;
    sqlx::query(
        "INSERT INTO marketplace_intents
         (id, tenant_id, domain_id, participant_id, side, narrative, attributes, terms,
          supply_discovery_enabled, idempotency_key, status)
         VALUES ($1, $2, $3, $4, 'demand', $5, $6, '{}'::jsonb, true, $7, 'active')",
    )
    .bind(intent_id.into_uuid())
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.domain_id.into_uuid())
    .bind(demand_party_id.into_uuid())
    .bind(narrative)
    .bind(attributes)
    .bind(format!("template-intent-{intent_id}"))
    .execute(fixture.store.pool())
    .await?;
    Ok((demand_party_id, intent_id))
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn template_matching_should_project_attributes_before_scoring_and_returning(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    install_store_registration(
        &fixture,
        json!({
            "productTemplates": [{
                "id": "camera",
                "label": "Camera",
                "supplyFields": [{"key": "public_model", "label": "Public model"}]
            }]
        }),
    )
    .await?;
    let (demand_party_id, intent_id) = install_demand_intent(
        &fixture,
        "Test camera visible-model secret-token",
        json!({
            "public_model": "visible-model",
            "internal_secret": "secret-token"
        }),
    )
    .await?;

    let offer_id = MarketplaceOfferId::new();
    let mut command = offer_command(&fixture, offer_id, "projected-camera", Some("camera"));
    command.attributes = json!({
        "description": "Test camera",
        "attachments": [{
            "kind": "image",
            "metadata": {"public_url": "https://images.example.test/camera.jpg"}
        }],
        "public_model": "visible-model",
        "internal_secret": "secret-token"
    });
    fixture.store.create_marketplace_offer(&command).await?;
    fixture
        .store
        .activate_marketplace_offer(fixture.tenant_id, offer_id, 1)
        .await?;

    let matches = fixture
        .store
        .match_marketplace_offers(&MatchMarketplaceOffers {
            tenant_id: fixture.tenant_id,
            intent_id,
            participant_id: demand_party_id,
            limit: 10,
        })
        .await?;
    assert_eq!(matches.len(), 1);
    assert_eq!(
        matches[0].offer.attributes,
        json!({"public_model": "visible-model"})
    );
    assert!(
        matches[0]
            .reasons
            .iter()
            .all(|reason| !reason.contains("internal_secret") && !reason.contains("secret-token"))
    );

    sqlx::query(
        "UPDATE subplatform_registrations registration
            SET manifest = '{\"productTemplates\":[{\"id\":\"lens\",\"label\":\"Lens\",\"supplyFields\":[]}]}'::jsonb
           FROM stores store
          WHERE store.tenant_id = $1
            AND store.id = $2
            AND registration.tenant_id = store.tenant_id
            AND registration.id = store.current_registration_id",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;

    let matches = fixture
        .store
        .match_marketplace_offers(&MatchMarketplaceOffers {
            tenant_id: fixture.tenant_id,
            intent_id,
            participant_id: demand_party_id,
            limit: 10,
        })
        .await?;
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].offer.attributes, json!({}));
    assert!(
        matches[0]
            .reasons
            .iter()
            .all(|reason| !reason.contains("internal_secret") && !reason.contains("secret-token"))
    );
    Ok(())
}

fn offer_command(
    fixture: &LegacyStoreParty,
    offer_id: MarketplaceOfferId,
    external_key: &str,
    product_template_id: Option<&str>,
) -> CreateMarketplaceOffer {
    CreateMarketplaceOffer {
        offer_id,
        tenant_id: fixture.tenant_id,
        domain_id: fixture.domain_id,
        supply_party_id: fixture.party_id,
        asset_id: None,
        product_template_id: product_template_id.map(str::to_owned),
        external_key: external_key.to_owned(),
        display_name: "Test camera".to_owned(),
        attributes: json!({
            "description": "A complete public camera offer",
            "attachments": [{
                "kind": "image",
                "metadata": {"public_url": "https://images.example.test/camera.jpg"}
            }]
        }),
        terms: json!({
            "pricing_mode": "fixed",
            "amount_minor": "10000",
            "currency": "CNY",
            "currency_scale": "2"
        }),
        expires_at: None,
    }
}

fn update_command(
    fixture: &LegacyStoreParty,
    offer_id: MarketplaceOfferId,
    product_template_id: Option<&str>,
    expected_version: i64,
) -> UpdateMarketplaceOffer {
    let create = offer_command(fixture, offer_id, "unused-update-key", product_template_id);
    UpdateMarketplaceOffer {
        tenant_id: fixture.tenant_id,
        domain_id: fixture.domain_id,
        actor_party_id: fixture.party_id,
        can_manage_domain: false,
        platform_path: "/test-store".to_owned(),
        request_id: Some(format!("update-{expected_version}")),
        offer_id,
        product_template_id: create.product_template_id,
        display_name: create.display_name,
        attributes: create.attributes,
        terms: create.terms,
        expected_version,
    }
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn product_template_binding_should_cover_create_update_idempotency_and_activation(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    install_store_registration(
        &fixture,
        json!({
            "productTemplates": [
                {"id": "camera", "label": "Camera", "supplyFields": []},
                {"id": "lens", "label": "Lens", "supplyFields": []}
            ],
            "defaultProductTemplateId": "camera"
        }),
    )
    .await?;

    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&offer_command(
                &fixture,
                MarketplaceOfferId::new(),
                "missing-template",
                None,
            ))
            .await,
        Err(StorageError::Conflict(_))
    ));

    let offer_id = MarketplaceOfferId::new();
    let create = offer_command(&fixture, offer_id, "camera-1", Some("camera"));
    let created = fixture.store.create_marketplace_offer(&create).await?;
    assert!(!created.duplicate);
    assert_eq!(created.offer.product_template_id.as_deref(), Some("camera"));
    assert_eq!(created.offer.version, 1);

    let duplicate = fixture.store.create_marketplace_offer(&create).await?;
    assert!(duplicate.duplicate);
    let different_template = offer_command(&fixture, offer_id, "camera-1", Some("lens"));
    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&different_template)
            .await,
        Err(StorageError::IdempotencyConflict)
    ));
    let replay_after_disable = offer_command(
        &fixture,
        MarketplaceOfferId::new(),
        "camera-replay-after-disable",
        Some("camera"),
    );
    fixture
        .store
        .create_marketplace_offer(&replay_after_disable)
        .await?;

    let active = fixture
        .store
        .activate_marketplace_offer(fixture.tenant_id, offer_id, 1)
        .await?;
    assert_eq!(active.version, 2);
    assert_eq!(active.product_template_id.as_deref(), Some("camera"));

    assert!(matches!(
        fixture
            .store
            .update_marketplace_offer(&update_command(&fixture, offer_id, Some("lens"), 1))
            .await,
        Err(StorageError::Conflict(_))
    ));
    let updated = fixture
        .store
        .update_marketplace_offer(&update_command(&fixture, offer_id, Some("lens"), 2))
        .await?;
    assert_eq!(updated.version, 3);
    assert_eq!(updated.status, "draft");
    assert_eq!(updated.product_template_id.as_deref(), Some("lens"));
    assert!(matches!(
        fixture
            .store
            .update_marketplace_offer(&update_command(&fixture, offer_id, None, 3))
            .await,
        Err(StorageError::Conflict(_))
    ));

    sqlx::query(
        "UPDATE stores
            SET metadata = jsonb_set(
                metadata,
                '{product_templates}',
                '{\"schema_version\":1,\"enabled_template_ids\":[],\"default_template_id\":null}'::jsonb
            )
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;

    let duplicate_after_disable = fixture
        .store
        .create_marketplace_offer(&replay_after_disable)
        .await?;
    assert!(duplicate_after_disable.duplicate);
    assert_eq!(
        duplicate_after_disable.offer.product_template_id.as_deref(),
        Some("camera")
    );

    for rejected_template in ["lens", "other-store-only"] {
        assert!(matches!(
            fixture
                .store
                .update_marketplace_offer(&update_command(
                    &fixture,
                    offer_id,
                    Some(rejected_template),
                    3,
                ))
                .await,
            Err(StorageError::Conflict(_))
        ));
    }
    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&offer_command(
                &fixture,
                MarketplaceOfferId::new(),
                "disabled-lens",
                Some("lens"),
            ))
            .await,
        Err(StorageError::Conflict(_))
    ));
    assert!(matches!(
        fixture
            .store
            .activate_marketplace_offer(fixture.tenant_id, offer_id, 3)
            .await,
        Err(StorageError::Conflict(_))
    ));

    sqlx::query(
        "UPDATE stores
            SET metadata = jsonb_set(
                metadata,
                '{product_templates}',
                '{\"schema_version\":1,\"enabled_template_ids\":[\"camera\",\"camera\"],\"default_template_id\":\"camera\"}'::jsonb
            )
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;
    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&offer_command(
                &fixture,
                MarketplaceOfferId::new(),
                "malformed-template-settings",
                Some("camera"),
            ))
            .await,
        Err(StorageError::Conflict(_))
    ));

    sqlx::query("UPDATE stores SET metadata = '{}'::jsonb WHERE tenant_id = $1 AND id = $2")
        .bind(fixture.tenant_id.into_uuid())
        .bind(fixture.store_id)
        .execute(fixture.store.pool())
        .await?;
    let active = fixture
        .store
        .activate_marketplace_offer(fixture.tenant_id, offer_id, 3)
        .await?;
    assert_eq!(active.product_template_id.as_deref(), Some("lens"));
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn product_template_settings_should_fail_closed_after_catalog_drift(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    install_store_registration(
        &fixture,
        json!({
            "productTemplates": [
                {"id": "camera", "label": "Camera", "supplyFields": []},
                {"id": "lens", "label": "Lens", "supplyFields": []}
            ],
            "defaultProductTemplateId": "lens"
        }),
    )
    .await?;
    sqlx::query(
        "UPDATE stores
            SET metadata = jsonb_set(
                metadata,
                '{product_templates}',
                '{\"schema_version\":1,\"enabled_template_ids\":[\"camera\",\"lens\"],\"default_template_id\":\"lens\"}'::jsonb
            )
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;
    sqlx::query(
        "UPDATE subplatform_registrations registration
            SET manifest = '{\"productTemplates\":[{\"id\":\"camera\",\"label\":\"Camera\",\"supplyFields\":[]}]}'::jsonb
           FROM stores store
          WHERE store.tenant_id = $1
            AND store.id = $2
            AND registration.tenant_id = store.tenant_id
            AND registration.id = store.current_registration_id",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;

    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&offer_command(
                &fixture,
                MarketplaceOfferId::new(),
                "stale-default",
                Some("camera"),
            ))
            .await,
        Err(StorageError::Conflict(_))
    ));

    sqlx::query(
        "UPDATE stores
            SET metadata = jsonb_set(
                metadata,
                '{product_templates}',
                '{\"schema_version\":1,\"enabled_template_ids\":[\"camera\",\"lens\"],\"default_template_id\":\"camera\"}'::jsonb
            )
          WHERE tenant_id = $1 AND id = $2",
    )
    .bind(fixture.tenant_id.into_uuid())
    .bind(fixture.store_id)
    .execute(fixture.store.pool())
    .await?;
    let created = fixture
        .store
        .create_marketplace_offer(&offer_command(
            &fixture,
            MarketplaceOfferId::new(),
            "filtered-enabled-catalog",
            Some("camera"),
        ))
        .await?;
    assert!(!created.duplicate);
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn concurrent_offer_create_should_serialize_idempotency_keys(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    install_store_registration(
        &fixture,
        json!({
            "productTemplates": [{"id": "camera", "label": "Camera", "supplyFields": []}]
        }),
    )
    .await?;

    let identical_offer_id = MarketplaceOfferId::new();
    let identical_left = offer_command(
        &fixture,
        identical_offer_id,
        "concurrent-identical",
        Some("camera"),
    );
    let identical_right = offer_command(
        &fixture,
        identical_offer_id,
        "concurrent-identical",
        Some("camera"),
    );
    let left_store = fixture.store.clone();
    let right_store = fixture.store.clone();
    let (left, right) = tokio::join!(
        left_store.create_marketplace_offer(&identical_left),
        right_store.create_marketplace_offer(&identical_right),
    );
    let left = left?;
    let right = right?;
    assert_ne!(left.duplicate, right.duplicate);
    assert_eq!(left.offer.offer_id, identical_offer_id);
    assert_eq!(right.offer.offer_id, identical_offer_id);

    let conflicting_offer_id = MarketplaceOfferId::new();
    let conflicting_left = offer_command(
        &fixture,
        conflicting_offer_id,
        "concurrent-conflict",
        Some("camera"),
    );
    let mut conflicting_right = offer_command(
        &fixture,
        conflicting_offer_id,
        "concurrent-conflict",
        Some("camera"),
    );
    conflicting_right.display_name = "Different camera payload".to_owned();
    let left_store = fixture.store.clone();
    let right_store = fixture.store.clone();
    let (left, right) = tokio::join!(
        left_store.create_marketplace_offer(&conflicting_left),
        right_store.create_marketplace_offer(&conflicting_right),
    );
    match (left, right) {
        (Ok(created), Err(StorageError::IdempotencyConflict))
        | (Err(StorageError::IdempotencyConflict), Ok(created)) => {
            assert!(!created.duplicate);
            assert_eq!(created.offer.offer_id, conflicting_offer_id);
        }
        outcomes => panic!("unexpected concurrent create outcomes: {outcomes:?}"),
    }
    Ok(())
}

#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires a PostgreSQL server with the MatchPlane extensions"]
async fn legacy_manifest_should_require_a_null_binding_and_remain_activatable(
    pool: PgPool,
) -> Result<(), StorageError> {
    let fixture = legacy_store_party(pool, "seller", "supply").await?;
    install_store_registration(&fixture, json!({"name": "Legacy store"})).await?;

    let offer_id = MarketplaceOfferId::new();
    let created = fixture
        .store
        .create_marketplace_offer(&offer_command(&fixture, offer_id, "legacy-1", None))
        .await?;
    assert!(created.offer.product_template_id.is_none());
    let active = fixture
        .store
        .activate_marketplace_offer(fixture.tenant_id, offer_id, 1)
        .await?;
    assert_eq!(active.status, "active");
    assert!(active.product_template_id.is_none());

    assert!(matches!(
        fixture
            .store
            .create_marketplace_offer(&offer_command(
                &fixture,
                MarketplaceOfferId::new(),
                "legacy-invalid-template",
                Some("camera"),
            ))
            .await,
        Err(StorageError::Conflict(_))
    ));
    Ok(())
}
