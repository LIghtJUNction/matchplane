import assert from "node:assert/strict";

import { Pool } from "pg";

import {
  MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
  MAX_PUBLIC_STORES,
  PublicStoreDirectoryBudgetExceededError,
  readPublicStoresFromDatabase,
  type PublicStore,
} from "./store-directory";
import { searchPublicStoreOffersFromDatabase } from "./storefront-search";

const ids = {
  tenant: "71000000-0000-4000-8000-000000000001",
  domain: "71000000-0000-4000-8000-000000000002",
  rootOrganization: "71000000-0000-4000-8000-000000000003",
  storeOrganization: "71000000-0000-4000-8000-000000000004",
  node: "71000000-0000-4000-8000-000000000005",
  invite: "71000000-0000-4000-8000-000000000006",
  registration: "71000000-0000-4000-8000-000000000007",
  binding: "71000000-0000-4000-8000-000000000008",
  party: "71000000-0000-4000-8000-000000000009",
  offer: "71000000-0000-4000-8000-00000000000a",
} as const;

const storePath = "/lifecycle-store";

async function main(): Promise<void> {
  const connectionString = isolatedTestDatabaseUrl();
  const database = new Pool({ connectionString, max: 2 });
  try {
    await database.query("SELECT 1");
    await seedActiveExternalStore(database);

    const activeStore = await assertVisible(database);
    await exerciseLifecycleTransitions(database, activeStore);
    await exerciseStaleRegistrationAndBinding(database, activeStore);
    await exerciseDirectoryOverflow(database);

    process.stdout.write("storefront PostgreSQL lifecycle contract passed\n");
  } finally {
    await database.end();
  }
}

function isolatedTestDatabaseUrl(): string {
  const raw = process.env.MATCHPLANE_TEST_DATABASE_URL;
  const expectedDatabase = process.env.MATCHPLANE_TEST_DATABASE_NAME;
  if (!raw || !expectedDatabase) {
    throw new Error(
      "MATCHPLANE_TEST_DATABASE_URL and MATCHPLANE_TEST_DATABASE_NAME are required",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MATCHPLANE_TEST_DATABASE_URL must be a valid URL");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error(
      "storefront lifecycle tests accept only a loopback PostgreSQL host",
    );
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) {
    throw new Error(
      "storefront lifecycle test database does not match its SQLx allocation",
    );
  }
  return url.toString();
}

async function seedActiveExternalStore(database: Pool): Promise<void> {
  await database.query(
    "INSERT INTO tenants (id, slug, name) VALUES ($1, 'lifecycle-market', 'Lifecycle Market')",
    [ids.tenant],
  );
  await database.query(
    "INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1, $2, 'lifecycle-domain', 'Lifecycle Domain')",
    [ids.domain, ids.tenant],
  );
  await database.query(
    `INSERT INTO "organization"
       (id, name, slug, "createdAt", "tenantId", "domainId",
        "parentOrganizationId", "rootPlatform")
     VALUES
       ($1, 'Lifecycle Market', 'lifecycle-market', clock_timestamp(), $2::text,
        NULL, NULL, true),
       ($3, 'Lifecycle Store', 'lifecycle-store', clock_timestamp(), $2::text,
        $4::text, $1, false)`,
    [ids.rootOrganization, ids.tenant, ids.storeOrganization, ids.domain],
  );
  await database.query(
    `INSERT INTO federation_nodes
       (id, name, grpc_endpoint, signing_key, protocol_major, protocol_minor)
     VALUES ($1, 'lifecycle-node', 'https://node.test.invalid', repeat('k', 32), 1, 0)`,
    [ids.node],
  );
  await database.query(
    `INSERT INTO platform_federation_invites
       (id, tenant_id, parent_organization_id, domain_id, token_hash, expires_at,
        used_at, used_by_node_id, created_by)
     VALUES
       ($1, $2, $3, $4, decode(repeat('11', 32), 'hex'),
        clock_timestamp() + interval '1 hour', clock_timestamp(), $5, 'postgres-test')`,
    [ids.invite, ids.tenant, ids.rootOrganization, ids.domain, ids.node],
  );
  await database.query(
    `INSERT INTO platform_federation_bindings
       (id, invite_id, tenant_id, domain_id, parent_organization_id,
        organization_id, node_id, slug, display_name, endpoint, mcp_server_key,
        public_key, manifest, manifest_digest, signature, status, created_by)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, 'lifecycle-store', 'Lifecycle Store',
        'https://store.test.invalid', 'lifecycle-store', repeat('p', 32),
        '{}'::jsonb, decode(repeat('22', 32), 'hex'), repeat('s', 32),
        'pending', 'postgres-test')`,
    [
      ids.binding,
      ids.invite,
      ids.tenant,
      ids.domain,
      ids.rootOrganization,
      ids.storeOrganization,
      ids.node,
    ],
  );
  await database.query(
    `INSERT INTO subplatform_registrations
       (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
        pinned_revision, source_digest, manifest_digest, manifest,
        membership_policy, state, version, registered_by, federation_binding_id)
     VALUES
       ($1, $2, $3, 'lifecycle-store-v2', 'lifecycle-store', 'remote',
        'https://store.test.invalid/manifest.json', 'v2',
        decode(repeat('33', 32), 'hex'), decode(repeat('44', 32), 'hex'),
        '{"description":"Lifecycle fixture","capabilities":["catalog.search"],"ui":{"supplyFields":[]}}'::jsonb,
        'public', 'active', 2, 'postgres-test', $4)`,
    [ids.registration, ids.tenant, ids.domain, ids.binding],
  );
  await database.query(
    `UPDATE platform_federation_bindings
        SET registration_id = $1, status = 'active', activated_by = 'postgres-test',
            activated_at = clock_timestamp()
      WHERE id = $2`,
    [ids.registration, ids.binding],
  );

  const storeId = await database.query<{ id: string }>(
    "SELECT id::text FROM stores WHERE organization_id = $1::uuid",
    [ids.storeOrganization],
  );
  assert.equal(
    storeId.rows.length,
    1,
    "binding activation must project one store",
  );

  await database.query(
    `INSERT INTO marketplace_parties
       (id, tenant_id, external_key, display_name, role, access_token_hash,
        contact_ciphertext, contact_nonce, contact_key_version, status,
        scope_domain_id, platform_path)
     VALUES
       ($1, $2, 'lifecycle-seller', 'Lifecycle Seller', 'seller',
        decode(repeat('55', 32), 'hex'), decode('01', 'hex'),
        decode(repeat('66', 12), 'hex'), 1, 'active', $3, $4)`,
    [ids.party, ids.tenant, ids.domain, storePath],
  );
  await database.query(
    `INSERT INTO marketplace_offers
       (id, tenant_id, domain_id, supply_party_id, external_key, display_name,
        attributes, terms, status, published_at)
     VALUES
       ($1, $2, $3, $4, 'camera-1', 'Lifecycle Camera',
        '{"description":"A real lifecycle camera","stock_quantity":2,"attachments":[{"kind":"image","file_name":"camera.jpg","media_type":"image/jpeg","metadata":{"public_url":"https://assets.test.invalid/camera.jpg"}}]}'::jsonb,
        '{"pricing_mode":"fixed","amount_minor":"129900","currency":"CNY","currency_scale":2}'::jsonb,
        'active', clock_timestamp() - interval '1 hour')`,
    [ids.offer, ids.tenant, ids.domain, ids.party],
  );
}

async function assertVisible(database: Pool): Promise<PublicStore> {
  const stores = await readPublicStoresFromDatabase(database, ids.tenant, {
    path: storePath,
  });
  assert.equal(stores.length, 1, "active scoped store must be public");
  const offers = await searchPublicStoreOffersFromDatabase(database, {
    stores,
    // This harness owns lifecycle SQL; empty browse deliberately skips Rust ranking.
    narrative: "",
  });
  assert.deepEqual(
    offers.map((offer) => offer.offer_id),
    [ids.offer],
    "active offer must be visible through the production reader",
  );
  return stores[0]!;
}

async function assertStoreAndOfferHidden(
  database: Pool,
  staleStore: PublicStore,
  transition: string,
): Promise<void> {
  const stores = await readPublicStoresFromDatabase(database, ids.tenant, {
    path: storePath,
  });
  assert.equal(stores.length, 0, `${transition}: store must disappear`);
  const offers = await searchPublicStoreOffersFromDatabase(database, {
    stores: [staleStore],
    narrative: "",
  });
  assert.equal(offers.length, 0, `${transition}: stale offer must disappear`);
}

async function assertOnlyOfferHidden(
  database: Pool,
  store: PublicStore,
  transition: string,
): Promise<void> {
  const stores = await readPublicStoresFromDatabase(database, ids.tenant, {
    path: storePath,
  });
  assert.equal(stores.length, 1, `${transition}: store should remain visible`);
  const offers = await searchPublicStoreOffersFromDatabase(database, {
    stores: [store],
    narrative: "",
  });
  assert.equal(offers.length, 0, `${transition}: offer must disappear`);
}

async function exerciseLifecycleTransitions(
  database: Pool,
  store: PublicStore,
): Promise<void> {
  const storeTransitions = [
    {
      name: "store organization suspended",
      apply: "UPDATE stores SET status = 'suspended' WHERE id = $1::uuid",
      restore: "UPDATE stores SET status = 'active' WHERE id = $1::uuid",
      id: store.id,
    },
    {
      name: "store made private",
      apply: "UPDATE stores SET visibility = 'private' WHERE id = $1::uuid",
      restore: "UPDATE stores SET visibility = 'public' WHERE id = $1::uuid",
      id: store.id,
    },
    {
      name: "domain disabled",
      apply: "UPDATE domains SET status = 'disabled' WHERE id = $1::uuid",
      restore: "UPDATE domains SET status = 'active' WHERE id = $1::uuid",
      id: ids.domain,
    },
    {
      name: "current registration disabled",
      apply:
        "UPDATE subplatform_registrations SET state = 'disabled' WHERE id = $1::uuid",
      restore:
        "UPDATE subplatform_registrations SET state = 'active' WHERE id = $1::uuid",
      id: ids.registration,
    },
    {
      name: "binding disabled",
      apply:
        "UPDATE platform_federation_bindings SET status = 'degraded' WHERE id = $1::uuid",
      restore:
        "UPDATE platform_federation_bindings SET status = 'active' WHERE id = $1::uuid",
      id: ids.binding,
    },
    {
      name: "binding revoked",
      apply:
        "UPDATE platform_federation_bindings SET status = 'revoked' WHERE id = $1::uuid",
      restore:
        "UPDATE platform_federation_bindings SET status = 'active' WHERE id = $1::uuid",
      id: ids.binding,
    },
  ];

  for (const transition of storeTransitions) {
    await database.query(transition.apply, [transition.id]);
    await assertStoreAndOfferHidden(database, store, transition.name);
    await database.query(transition.restore, [transition.id]);
    await assertVisible(database);
  }

  const offerTransitions = [
    {
      name: "offer withdrawn",
      apply:
        "UPDATE marketplace_offers SET status = 'withdrawn' WHERE id = $1::uuid",
      restore:
        "UPDATE marketplace_offers SET status = 'active' WHERE id = $1::uuid",
    },
    {
      name: "offer expired",
      apply:
        "UPDATE marketplace_offers SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid",
      restore:
        "UPDATE marketplace_offers SET expires_at = NULL WHERE id = $1::uuid",
    },
  ];
  for (const transition of offerTransitions) {
    await database.query(transition.apply, [ids.offer]);
    await assertOnlyOfferHidden(database, store, transition.name);
    await database.query(transition.restore, [ids.offer]);
    await assertVisible(database);
  }
}

async function exerciseStaleRegistrationAndBinding(
  database: Pool,
  store: PublicStore,
): Promise<void> {
  const staleRegistration = "71000000-0000-4000-8000-00000000000b";
  await database.query(
    `INSERT INTO subplatform_registrations
       (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
        pinned_revision, source_digest, manifest_digest, manifest,
        membership_policy, state, version, registered_by)
     VALUES
       ($1, $2, $3, 'lifecycle-store-stale', 'lifecycle-store', 'remote',
        'https://stale.test.invalid/manifest.json', 'stale',
        decode(repeat('77', 32), 'hex'), decode(repeat('88', 32), 'hex'),
        '{}'::jsonb, 'public', 'active', 1, 'postgres-test')`,
    [staleRegistration, ids.tenant, ids.domain],
  );
  const currentBefore = await database.query<{
    current_registration_id: string;
  }>("SELECT current_registration_id::text FROM stores WHERE id = $1::uuid", [
    store.id,
  ]);
  assert.equal(
    currentBefore.rows[0]?.current_registration_id,
    ids.registration,
  );

  await database.query(
    "UPDATE subplatform_registrations SET state = 'disabled' WHERE id = $1::uuid",
    [ids.registration],
  );
  await database.query(
    `UPDATE platform_federation_bindings
        SET status = 'revoked', registration_id = $1::uuid
      WHERE id = $2::uuid`,
    [staleRegistration, ids.binding],
  );
  await database.query(
    "UPDATE platform_federation_bindings SET status = 'active' WHERE id = $1::uuid",
    [ids.binding],
  );
  await assertStoreAndOfferHidden(
    database,
    store,
    "active stale registration and replaced binding linkage",
  );
  const currentAfter = await database.query<{
    current_registration_id: string;
  }>("SELECT current_registration_id::text FROM stores WHERE id = $1::uuid", [
    store.id,
  ]);
  assert.equal(currentAfter.rows[0]?.current_registration_id, ids.registration);

  await database.query(
    `UPDATE platform_federation_bindings
        SET status = 'revoked', registration_id = $1::uuid
      WHERE id = $2::uuid`,
    [ids.registration, ids.binding],
  );
  await database.query(
    "UPDATE subplatform_registrations SET state = 'disabled' WHERE id = $1::uuid",
    [staleRegistration],
  );
  await database.query(
    "UPDATE subplatform_registrations SET state = 'active' WHERE id = $1::uuid",
    [ids.registration],
  );
  await database.query(
    "UPDATE platform_federation_bindings SET status = 'active' WHERE id = $1::uuid",
    [ids.binding],
  );
  await assertVisible(database);
}

async function exerciseDirectoryOverflow(database: Pool): Promise<void> {
  await database.query(
    `WITH overflow_organizations AS (
       INSERT INTO "organization"
         (id, name, slug, "createdAt", "tenantId", "domainId",
          "parentOrganizationId", "rootPlatform")
       SELECT gen_random_uuid(), 'Overflow ' || value,
              'overflow-' || lpad(value::text, 3, '0'), clock_timestamp(),
              $1::text, $2::text, $3::uuid, false
         FROM generate_series(1, $4::integer) value
       RETURNING id, slug, name
     ), overflow_stores AS (
       INSERT INTO stores
         (tenant_id, organization_id, domain_id, slug, display_name, status,
          visibility, integration_kind, created_by)
       SELECT $1::uuid, id, $2::uuid, slug, name, 'active', 'public', 'hosted', 'postgres-test'
         FROM overflow_organizations
       RETURNING id, slug
     )
     INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical)
     SELECT $1::uuid, id, '/' || slug, true FROM overflow_stores;`,
    [ids.tenant, ids.domain, ids.rootOrganization, MAX_PUBLIC_STORES],
  );

  const exact = await readPublicStoresFromDatabase(database, ids.tenant, {
    path: storePath,
  });
  assert.equal(exact.length, 1, "exact path must be filtered before overflow");

  const global = await readPublicStoresFromDatabase(database, ids.tenant, {
    limit: MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
  });
  assert.equal(global.length, MAX_PUBLIC_STORES + 1);
  const overflow = new PublicStoreDirectoryBudgetExceededError(global.length);
  assert.equal(overflow.code, "public_store_directory_budget_exceeded");
  assert.equal(overflow.actual, MAX_PUBLIC_STORES + 1);
  assert.equal(overflow.maximum, MAX_PUBLIC_STORES);
}

await main();
