-- Test-only fixture for the public Chinese vehicle storefront.
--
-- The records intentionally use the generic marketplace contract.  The registration trigger
-- projects the child organization into the flat public store directory; product meaning stays
-- in the asset and offer JSON owned by this example vertical.

BEGIN;

INSERT INTO tenants (id, slug, name)
VALUES (
    '00000000-0000-7000-8000-000000001000',
    'good-cars-market',
    '好车线下商城'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, slug, name)
VALUES (
    '00000000-0000-7000-8000-000000001001',
    '00000000-0000-7000-8000-000000001000',
    'good-cars-domain',
    '好车线下店'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "organization"
    (id, name, slug, "createdAt", "tenantId", "domainId", "parentOrganizationId", "rootPlatform")
VALUES
    (
        '00000000-0000-7000-8000-000000001002',
        '好车线下商城',
        'good-cars-market',
        clock_timestamp(),
        '00000000-0000-7000-8000-000000001000',
        NULL,
        NULL,
        true
    ),
    (
        '00000000-0000-7000-8000-000000001003',
        '好车线下店',
        'good-cars',
        clock_timestamp(),
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001002',
        false
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO subplatform_registrations
    (id, tenant_id, domain_id, package_id, slug, source_kind, source_locator,
     pinned_revision, source_digest, manifest_digest, manifest, requested_scopes,
     membership_policy, state, version, registered_by, activated_at)
VALUES (
    '00000000-0000-7000-8000-000000001004',
    '00000000-0000-7000-8000-000000001000',
    '00000000-0000-7000-8000-000000001001',
    'good-cars',
    'good-cars',
    'git',
    'https://github.com/LIghtJUNction/matchplane',
    'bounty/good-cars',
    decode(repeat('11', 32), 'hex'),
    decode(repeat('22', 32), 'hex'),
    $good_cars_manifest$
    {
      "apiVersion": "matchplane.subplatform/v1",
      "id": "good-cars",
      "slug": "good-cars",
      "displayName": "好车线下店",
      "description": "先在线了解车况，再和店员预约线下看车。",
      "marketplaceContract": "generic-v1",
      "pricing": {"mode": "fixed", "currency": "CNY", "currencyScale": 2, "label": "售价"},
      "ui": {
        "chat": {
          "buyerHeadlines": ["先说预算和用途，我帮你缩小范围", "可以从家庭人数、里程和车况开始"],
          "buyerHeadlinesEn": ["Start with your budget and how you will use the car", "Tell me about passengers, mileage, and condition"]
        },
        "copy": {
          "listingEyebrow": "真实车源",
          "listingLabel": "车辆",
          "emptyBuyerTitle": "这家店暂时没有在售车辆",
          "emptyBuyerDescription": "可以继续描述预算和用途，或浏览其他公开店铺。"
        },
        "filters": [
          {"key": "brand", "label": "品牌", "source": "attribute", "attribute": "brand"},
          {"key": "condition", "label": "车况", "source": "attribute", "attribute": "condition"},
          {"key": "location", "label": "看车地点", "source": "attribute", "attribute": "location"},
          {"key": "fuel_type", "label": "能源类型", "source": "attribute", "attribute": "fuel_type"}
        ],
        "supplyFields": [
          {"key": "brand", "label": "品牌", "type": "text", "required": true},
          {"key": "model", "label": "车型", "type": "text", "required": true},
          {"key": "model_year", "label": "上牌年份", "type": "number", "required": true},
          {"key": "mileage_km", "label": "行驶里程（公里）", "type": "number", "required": true},
          {"key": "condition", "label": "车况", "type": "select", "required": true, "options": ["used", "refurbished"]},
          {"key": "location", "label": "看车地点", "type": "text", "required": true},
          {"key": "fuel_type", "label": "能源类型", "type": "select", "required": true, "options": ["燃油", "插混", "纯电"]},
          {"key": "seats", "label": "座位数", "type": "number", "required": true},
          {"key": "delivery_mode", "label": "交易方式", "type": "select", "required": true, "options": ["local_pickup"]}
        ]
      },
      "rootApiVersion": "v1",
      "entry": "src/index.ts",
      "routes": ["/good-cars"],
      "capabilities": ["demand", "supply", "public_catalog", "explainable_matching", "contact_exchange"],
      "requiredScopes": ["marketplace:read", "marketplace:write"],
      "agent": {
        "protocol": "matchplane.agent/v1",
        "stages": ["browse", "qualify", "viewing", "offline_deal"],
        "skills": ["catalog.search", "vehicle.explain", "viewing.schedule"],
        "mcpTools": ["catalog.search", "catalog.explain", "viewing.schedule"],
        "mcpServerKey": "good-cars"
      },
      "assets": {"staticDirectory": "dist", "buildCommand": "bun run build", "dependencyPolicy": "locked"}
    }
    $good_cars_manifest$::jsonb,
    ARRAY['marketplace:read', 'marketplace:write'],
    'public',
    'active',
    1,
    'bounty-good-cars',
    clock_timestamp()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO asset_schemas
    (id, tenant_id, domain_id, schema_version, schema_document, schema_hash)
VALUES (
    '00000000-0000-7000-8000-000000001005',
    '00000000-0000-7000-8000-000000001000',
    '00000000-0000-7000-8000-000000001001',
    1,
    $good_cars_schema$
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["brand", "model", "model_year", "mileage_km", "condition", "location", "fuel_type", "seats", "delivery_mode", "description", "stock_quantity", "attachments"],
      "properties": {
        "brand": {"type": "string"},
        "model": {"type": "string"},
        "model_year": {"type": "integer"},
        "mileage_km": {"type": "integer", "minimum": 0},
        "condition": {"enum": ["used", "refurbished"]},
        "location": {"type": "string"},
        "fuel_type": {"enum": ["燃油", "插混", "纯电"]},
        "seats": {"type": "integer", "minimum": 2},
        "delivery_mode": {"const": "local_pickup"},
        "description": {"type": "string"},
        "stock_quantity": {"type": "integer", "minimum": 0},
        "attachments": {"type": "array"}
      }
    }
    $good_cars_schema$::jsonb,
    decode(repeat('33', 32), 'hex')
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO assets
    (id, tenant_id, domain_id, asset_schema_id, external_key, display_name, attributes)
VALUES
    (
        '00000000-0000-7000-8000-000000001011',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001005',
        'good-cars-qin-plus-dmi-2024',
        '比亚迪 秦 PLUS DM-i 2024款',
        '{"brand":"比亚迪","model":"秦 PLUS DM-i","model_year":2024,"mileage_km":18000,"condition":"used","location":"深圳龙岗","fuel_type":"插混","seats":5,"delivery_mode":"local_pickup","description":"2024 年上牌，适合城市通勤和家庭出行，支持到店验车。","stock_quantity":1}'::jsonb
    ),
    (
        '00000000-0000-7000-8000-000000001012',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001005',
        'good-cars-camry-2022',
        '丰田 凯美瑞 2022款 2.0G',
        '{"brand":"丰田","model":"凯美瑞 2.0G","model_year":2022,"mileage_km":36000,"condition":"used","location":"深圳南山","fuel_type":"燃油","seats":5,"delivery_mode":"local_pickup","description":"保养记录齐全，空间舒适，适合家庭通勤和周末出行。","stock_quantity":1}'::jsonb
    ),
    (
        '00000000-0000-7000-8000-000000001013',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001005',
        'good-cars-model-3-2023',
        '特斯拉 Model 3 2023款',
        '{"brand":"特斯拉","model":"Model 3","model_year":2023,"mileage_km":22000,"condition":"used","location":"深圳宝安","fuel_type":"纯电","seats":5,"delivery_mode":"local_pickup","description":"纯电后轮驱动，车况透明，适合日常通勤，支持线下试驾。","stock_quantity":1}'::jsonb
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO "user"
    (id, name, email, "emailVerified", "createdAt", "updatedAt", "marketplaceRole")
VALUES
    (
        '00000000-0000-7000-8000-000000001030',
        '好车买家测试账号',
        'good-cars-buyer@example.invalid',
        true,
        clock_timestamp(),
        clock_timestamp(),
        'buyer'
    ),
    (
        '00000000-0000-7000-8000-000000001031',
        '好车店主测试账号',
        'good-cars-seller@example.invalid',
        true,
        clock_timestamp(),
        clock_timestamp(),
        'seller'
    )
ON CONFLICT (id) DO NOTHING;

-- Better Auth resolves the smoke-test cookies from these deterministic session rows.  The
-- contact values remain the users' verified email bindings; the browser never submits them.
INSERT INTO "session"
    (id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId")
VALUES
    (
        '00000000-0000-7000-8000-000000001032',
        clock_timestamp() + interval '1 hour',
        'good-cars-buyer-session-token-000000000000000000000000000000',
        clock_timestamp(),
        clock_timestamp(),
        '127.0.0.1',
        'good-cars-integration-smoke',
        '00000000-0000-7000-8000-000000001030'
    ),
    (
        '00000000-0000-7000-8000-000000001033',
        clock_timestamp() + interval '1 hour',
        'good-cars-seller-session-token-000000000000000000000000000000',
        clock_timestamp(),
        clock_timestamp(),
        '127.0.0.1',
        'good-cars-integration-smoke',
        '00000000-0000-7000-8000-000000001031'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO "member"
    (id, "organizationId", "userId", role, "createdAt", labels)
VALUES (
    '00000000-0000-7000-8000-000000001050',
    '00000000-0000-7000-8000-000000001003',
    '00000000-0000-7000-8000-000000001031',
    'owner',
    clock_timestamp(),
    '["good-cars-owner"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO marketplace_parties
    (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role,
     marketplace_sides, access_token_hash, access_token_expires_at,
     contact_ciphertext, contact_nonce, contact_key_version, status)
VALUES (
    '00000000-0000-7000-8000-000000001020',
    '00000000-0000-7000-8000-000000001000',
    '00000000-0000-7000-8000-000000001001',
    '/good-cars',
    'good-cars-seller',
    '好车线下店店主',
    'seller',
    ARRAY['supply'],
    decode(repeat('44', 32), 'hex'),
    clock_timestamp() + interval '1 hour',
    decode(repeat('55', 32), 'hex'),
    decode(repeat('66', 12), 'hex'),
    1,
    'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO marketplace_party_auth_links
    (tenant_id, auth_user_id, party_id, platform_path)
VALUES (
    '00000000-0000-7000-8000-000000001000',
    '00000000-0000-7000-8000-000000001031',
    '00000000-0000-7000-8000-000000001020',
    '/good-cars'
)
ON CONFLICT (tenant_id, auth_user_id, platform_path) DO NOTHING;

INSERT INTO marketplace_offers
    (id, tenant_id, domain_id, supply_party_id, asset_id, external_key, display_name,
     attributes, terms, status, published_at, available_quantity, inventory_version)
VALUES
    (
        '00000000-0000-7000-8000-000000001111',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001020',
        '00000000-0000-7000-8000-000000001011',
        'good-cars-qin-plus-dmi-2024',
        '比亚迪 秦 PLUS DM-i 2024款',
        '{"brand":"比亚迪","model":"秦 PLUS DM-i","model_year":2024,"mileage_km":18000,"condition":"used","location":"深圳龙岗","fuel_type":"插混","seats":5,"delivery_mode":"local_pickup","description":"2024 年上牌，适合城市通勤和家庭出行，支持到店验车。","stock_quantity":1,"attachments":[{"kind":"image","file_name":"qin.webp","media_type":"image/webp","metadata":{"public_url":"/good-cars/cars/qin.webp"}}]}'::jsonb,
        '{"pricing_mode":"fixed","amount_minor":"10980000","currency":"CNY","currency_scale":2}'::jsonb,
        'active',
        clock_timestamp() - interval '3 minutes',
        1,
        1
    ),
    (
        '00000000-0000-7000-8000-000000001112',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001020',
        '00000000-0000-7000-8000-000000001012',
        'good-cars-camry-2022',
        '丰田 凯美瑞 2022款 2.0G',
        '{"brand":"丰田","model":"凯美瑞 2.0G","model_year":2022,"mileage_km":36000,"condition":"used","location":"深圳南山","fuel_type":"燃油","seats":5,"delivery_mode":"local_pickup","description":"保养记录齐全，空间舒适，适合家庭通勤和周末出行。","stock_quantity":1,"attachments":[{"kind":"image","file_name":"camry.webp","media_type":"image/webp","metadata":{"public_url":"/good-cars/cars/camry.webp"}}]}'::jsonb,
        '{"pricing_mode":"fixed","amount_minor":"16980000","currency":"CNY","currency_scale":2}'::jsonb,
        'active',
        clock_timestamp() - interval '2 minutes',
        1,
        1
    ),
    (
        '00000000-0000-7000-8000-000000001113',
        '00000000-0000-7000-8000-000000001000',
        '00000000-0000-7000-8000-000000001001',
        '00000000-0000-7000-8000-000000001020',
        '00000000-0000-7000-8000-000000001013',
        'good-cars-model-3-2023',
        '特斯拉 Model 3 2023款',
        '{"brand":"特斯拉","model":"Model 3","model_year":2023,"mileage_km":22000,"condition":"used","location":"深圳宝安","fuel_type":"纯电","seats":5,"delivery_mode":"local_pickup","description":"纯电后轮驱动，车况透明，适合日常通勤，支持线下试驾。","stock_quantity":1,"attachments":[{"kind":"image","file_name":"model3.webp","media_type":"image/webp","metadata":{"public_url":"/good-cars/cars/model3.webp"}}]}'::jsonb,
        '{"pricing_mode":"fixed","amount_minor":"21580000","currency":"CNY","currency_scale":2}'::jsonb,
        'active',
        clock_timestamp() - interval '1 minute',
        1,
        1
    )
ON CONFLICT (id) DO NOTHING;

COMMIT;
