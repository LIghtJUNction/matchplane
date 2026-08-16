-- Test-only database fixture for the complete Compose smoke test.
--
-- MatchPlane never seeds tenants, domains, catalog records, accounts, or payment
-- configuration in the application.  The smoke scripts use deterministic IDs so
-- their assertions can be replayed; this file is the explicit boundary where those
-- test records are created.  No production startup path reads or executes it.

BEGIN;

INSERT INTO federation_nodes (id, name, grpc_endpoint, signing_key, protocol_major, protocol_minor)
VALUES (
    '00000000-0000-7000-8000-00000000000a',
    'ci-node',
    'http://ci-node.invalid:50051',
    'ci-signing-key',
    1,
    0
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenants (id, slug, name)
VALUES (
    '00000000-0000-7000-8000-000000000100',
    'ci-tenant',
    'Integration tenant'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, slug, name)
VALUES (
    '00000000-0000-7000-8000-000000000101',
    '00000000-0000-7000-8000-000000000100',
    'ci-domain',
    'Integration domain'
)
ON CONFLICT (id) DO NOTHING;

-- The core smoke needs a schema and one asset.  These are neutral integration values;
-- the application treats the JSON as subplatform-owned data and never interprets its keys.
INSERT INTO asset_schemas (id, tenant_id, domain_id, schema_version, schema_document, schema_hash)
VALUES (
    '00000000-0000-7000-8000-000000000201',
    '00000000-0000-7000-8000-000000000100',
    '00000000-0000-7000-8000-000000000101',
    1,
    '{"type":"object","properties":{"category":{"type":"string"},"edition":{"type":"string"}}}'::jsonb,
    decode(repeat('00', 32), 'hex')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO assets (id, tenant_id, domain_id, asset_schema_id, external_key, display_name, attributes)
VALUES (
    '00000000-0000-7000-8000-000000000601',
    '00000000-0000-7000-8000-000000000100',
    '00000000-0000-7000-8000-000000000101',
    '00000000-0000-7000-8000-000000000201',
    'ci-fixture-asset',
    'Integration fixture offer',
    '{"category":"integration-item","edition":"v1"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO embedding_models (id, tenant_id, domain_id, name, model_version, dimension, metric)
VALUES (
    '00000000-0000-7000-8000-000000000701',
    '00000000-0000-7000-8000-000000000100',
    '00000000-0000-7000-8000-000000000101',
    'ci-fixture-model',
    '1',
    3,
    'cosine'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (id, tenant_id, owner_key, asset_key, available_amount)
VALUES
    ('00000000-0000-7000-8000-000000000501', '00000000-0000-7000-8000-000000000100', 'ci-demand', 'USD', 1000),
    ('00000000-0000-7000-8000-000000000502', '00000000-0000-7000-8000-000000000100', 'ci-demand', 'BASE', 0),
    ('00000000-0000-7000-8000-000000000503', '00000000-0000-7000-8000-000000000100', 'ci-supply', 'BASE', 5),
    ('00000000-0000-7000-8000-000000000504', '00000000-0000-7000-8000-000000000100', 'ci-supply', 'USD', 0),
    ('00000000-0000-7000-8000-000000000505', '00000000-0000-7000-8000-000000000100', 'ci-platform', 'USD', 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO markets (
    id, tenant_id, domain_id, shard_id, symbol, base_asset_key, quote_asset_key,
    price_scale, quantity_scale, kafka_partition, settlement_mode, offline_commission_collection, commission_bps,
    platform_commission_account_id
)
VALUES (
    '00000000-0000-7000-8000-000000000301',
    '00000000-0000-7000-8000-000000000100',
    '00000000-0000-7000-8000-000000000101',
    '00000000-0000-7000-8000-000000000302',
    'FIXTURE/BASE',
    'BASE',
    'USD',
    2,
    0,
    0,
    'online_platform',
    'postpaid',
    100,
    '00000000-0000-7000-8000-000000000505'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO payment_gateway_configs (id, tenant_id, name, gateway_kind, mode, settings)
VALUES (
    '00000000-0000-7000-8000-000000000801',
    '00000000-0000-7000-8000-000000000100',
    'ci-test-gateway',
    'test',
    'test',
    '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO payment_settings (tenant_id, active_mode, updated_by)
VALUES ('00000000-0000-7000-8000-000000000100', 'test', 'ci-fixture')
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO payment_routes (id, tenant_id, gateway_id, method_code, currency, priority)
VALUES (
    '00000000-0000-7000-8000-000000000803',
    '00000000-0000-7000-8000-000000000100',
    '00000000-0000-7000-8000-000000000801',
    'card',
    'USD',
    1
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoice_provider_configs (id, tenant_id, provider_key, name, mode, settings)
VALUES (
    '00000000-0000-7000-8000-000000000802',
    '00000000-0000-7000-8000-000000000100',
    'local_test',
    'ci-test-invoice',
    'test',
    '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoice_settings (tenant_id, active_mode, active_provider_id, updated_by)
VALUES (
    '00000000-0000-7000-8000-000000000100',
    'test',
    '00000000-0000-7000-8000-000000000802',
    'ci-fixture'
)
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
