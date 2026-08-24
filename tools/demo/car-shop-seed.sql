-- Challenge #11 car-selling shop demo seed.
--
-- MatchPlane's core never fabricates marketplace data.  Exactly like
-- tests/integration/fixture.sql, this file is an explicit development-only boundary: it creates
-- one hosted demo store ("星辰二手车行", slug `demo-car-shop`) with six publicly visible used-car
-- offers so a reviewer can click through the whole buyer path without hand-entering products.
-- Run it through tools/demo/bootstrap-car-shop-demo.sh, never against a production database.
--
-- Required psql variables (the wrapper script provides all of them):
--   tenant_id     root tenant UUID (existing, or created here with slug `demo-mall`)
--   seller_token  raw capability token for the seeded seller party (stored as SHA-256 only)
--   media1_size..media6_size / media1_sha..media6_sha
--                 byte size and hex SHA-256 of tools/demo/media/car-01.svg .. car-06.svg

\set ON_ERROR_STOP on

BEGIN;

-- Session-local copy of the tenant id so plpgsql assertion blocks can read it.
SET LOCAL matchplane.demo_tenant_id = :'tenant_id';

-- 1. Tenant and demo domain -----------------------------------------------------------------
INSERT INTO tenants (id, slug, name)
VALUES (:'tenant_id'::uuid, 'demo-mall', '星辰演示商城')
ON CONFLICT (id) DO NOTHING;

INSERT INTO domains (id, tenant_id, slug, name)
VALUES ('00000000-0000-7000-8000-000000001101', :'tenant_id'::uuid, 'demo-car-domain', '星辰二手车行')
ON CONFLICT (id) DO NOTHING;

-- 2. Default legal documents ----------------------------------------------------------------
-- Migration 202608210003 seeds these only for tenants that already exist when it runs.  A
-- tenant provisioned afterwards has none, and account registration requires both documents.
INSERT INTO mall_legal_documents (tenant_id, kind, content)
VALUES
  (:'tenant_id'::uuid, 'terms', $doc$# 用户协议

生效日期：以本页面显示的更新时间为准。

1. 服务说明
{{mall_name}} 提供商品浏览、店铺检索、撮合与相关服务。商品的展示、价格、库存和履约信息由对应店铺负责。

2. 账号使用
请使用真实、合法的信息注册和使用账号，并妥善保管登录凭据。不得利用本服务从事违法、侵权、欺诈或干扰平台正常运行的行为。

3. 商品与交易
下单、联系店铺或线下成交前，请自行核实商品信息和交易条件。除法律另有规定外，具体交易由用户与店铺按照双方确认的条件完成。

4. 平台规则
我们可以为保障安全、合规和服务质量，对违规内容、账号或店铺采取必要措施，并会在适用法律要求的范围内告知你。

5. 联系我们
如对本协议有疑问，请通过商城公开的联系方式与我们联系。$doc$),
  (:'tenant_id'::uuid, 'privacy', $doc$# 隐私政策

生效日期：以本页面显示的更新时间为准。

1. 我们收集的信息
为了提供账号、商品浏览、联系撮合和安全保障服务，{{mall_name}} 可能处理你的账号资料、设备与访问记录，以及你主动提交的商品或沟通信息。

2. 信息的使用
我们仅在提供、维护和改进服务，保障交易安全，履行法定义务以及取得你同意的范围内使用这些信息。

3. 信息的共享
我们不会公开你的联系方式。只有在你和对方均明确同意、或法律法规要求时，才会按相应流程提供必要信息。

4. 信息安全
我们采取合理的技术和管理措施保护信息安全。请勿向他人泄露密码、验证码或其他登录凭据。

5. 你的权利
你可以在账号页面更新个人资料、管理登录方式和会话；也可以通过商城公开的联系方式咨询、更正或删除相关信息。

6. 政策更新
本政策更新后会在此页面公布；重大变化会以适当方式提示。$doc$)
ON CONFLICT (tenant_id, kind) DO NOTHING;

-- 3. Root organization (development shortcut) -----------------------------------------------
-- The product path creates the root organization through the Better Auth bridge in the platform
-- readiness panel.  For a repeatable demo the seed creates a minimal marker only when the tenant
-- has none yet; an operator-initialized root organization is always reused untouched.
INSERT INTO "organization" (id, name, slug, "createdAt", metadata, "tenantId", "rootPlatform")
SELECT '00000000-0000-7000-8000-000000001102'::uuid,
       tenant.name,
       'demo-mall-root-' || left(:'tenant_id', 8),
       clock_timestamp(),
       json_build_object('tenantId', :'tenant_id', 'rootPlatform', true)::text,
       :'tenant_id',
       true
  FROM tenants tenant
 WHERE tenant.id = :'tenant_id'::uuid
   AND NOT EXISTS (
        SELECT 1 FROM "organization"
         WHERE "tenantId" = :'tenant_id' AND "rootPlatform" = true
   )
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "organization"
         WHERE "tenantId" = current_setting('matchplane.demo_tenant_id')
           AND "rootPlatform" = true
    ) THEN
        RAISE EXCEPTION 'demo seed could not find or create the root organization for tenant %',
            current_setting('matchplane.demo_tenant_id');
    END IF;
END;
$$;

-- 4. Hosted store organization, store, canonical path, commercial terms ----------------------
INSERT INTO "organization"
  (id, name, slug, "createdAt", metadata, "tenantId", "domainId", "parentOrganizationId", "rootPlatform")
SELECT '00000000-0000-7000-8000-000000001103'::uuid,
       '星辰二手车行',
       'demo-car-shop',
       clock_timestamp(),
       json_build_object('storeId', '00000000-0000-7000-8000-000000001104', 'integrationKind', 'hosted')::text,
       :'tenant_id',
       '00000000-0000-7000-8000-000000001101',
       root_org.id,
       false
  FROM "organization" root_org
 WHERE root_org."tenantId" = :'tenant_id' AND root_org."rootPlatform" = true
ON CONFLICT (id) DO NOTHING;

INSERT INTO stores
  (id, tenant_id, organization_id, domain_id, slug, display_name, description,
   status, visibility, integration_kind, created_by)
VALUES
  ('00000000-0000-7000-8000-000000001104',
   :'tenant_id'::uuid,
   '00000000-0000-7000-8000-000000001103',
   '00000000-0000-7000-8000-000000001101',
   'demo-car-shop',
   '星辰二手车行',
   '主营家用二手车与准新车：全车 268 项检测、无重大事故承诺、支持第三方复检与过户代办。到店可试驾，支持异地送车。',
   'active', 'public', 'hosted', 'challenge-11-demo-bootstrap')
ON CONFLICT (id) DO NOTHING;

INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical)
VALUES (:'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104', '/demo-car-shop', true)
ON CONFLICT (tenant_id, path) DO NOTHING;

INSERT INTO store_commercial_terms (tenant_id, store_id)
VALUES (:'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104')
ON CONFLICT (tenant_id, store_id) DO NOTHING;

-- 5. Hosted product images -------------------------------------------------------------------
-- Files are copied by the wrapper to $MATCHPLANE_HOSTED_MEDIA_ROOT/<tenant>/<store>/<storage_key>.
INSERT INTO hosted_store_media
  (id, tenant_id, store_id, uploader_subject, storage_key, file_name, media_type, size_bytes, sha256, status)
VALUES
  ('00000000-0000-7000-8000-000000001111', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001111.svg', 'car-01.svg', 'image/svg+xml',
   :'media1_size', decode(:'media1_sha', 'hex'), 'published'),
  ('00000000-0000-7000-8000-000000001112', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001112.svg', 'car-02.svg', 'image/svg+xml',
   :'media2_size', decode(:'media2_sha', 'hex'), 'published'),
  ('00000000-0000-7000-8000-000000001113', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001113.svg', 'car-03.svg', 'image/svg+xml',
   :'media3_size', decode(:'media3_sha', 'hex'), 'published'),
  ('00000000-0000-7000-8000-000000001114', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001114.svg', 'car-04.svg', 'image/svg+xml',
   :'media4_size', decode(:'media4_sha', 'hex'), 'published'),
  ('00000000-0000-7000-8000-000000001115', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001115.svg', 'car-05.svg', 'image/svg+xml',
   :'media5_size', decode(:'media5_sha', 'hex'), 'published'),
  ('00000000-0000-7000-8000-000000001116', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001104',
   'challenge-11-demo-bootstrap', '00000000-0000-7000-8000-000000001116.svg', 'car-06.svg', 'image/svg+xml',
   :'media6_size', decode(:'media6_sha', 'hex'), 'published')
ON CONFLICT (id) DO NOTHING;

-- 6. Seller party ------------------------------------------------------------------------------
-- The canonical-path trigger assigns store_id.  The contact ciphertext is an inert placeholder:
-- contact exchange must be demonstrated with real verified accounts through the UI, never with
-- this seeded record.  The capability token hash follows the marketplace bridge contract
-- (SHA-256 of the raw token), so the printed token can be used against /v1/marketplace/offers.
INSERT INTO marketplace_parties
  (id, tenant_id, scope_domain_id, platform_path, external_key, display_name, role,
   marketplace_sides, access_token_hash, contact_ciphertext, contact_nonce, contact_key_version)
VALUES
  ('00000000-0000-7000-8000-000000001105',
   :'tenant_id'::uuid,
   '00000000-0000-7000-8000-000000001101',
   '/demo-car-shop',
   'challenge-11-demo-seller',
   '星辰二手车行',
   'seller',
   ARRAY['supply']::text[],
   sha256(convert_to(:'seller_token', 'UTF8')),
   convert_to('challenge-11-demo-placeholder', 'UTF8'),
   decode('000000000000000000000000', 'hex'),
   1)
ON CONFLICT (id) DO NOTHING;

-- 7. Six publicly visible car offers -----------------------------------------------------------
-- Every offer satisfies the public storefront contract enforced by web/src/storefront-search.ts:
-- non-empty description, a hosted image reference, and fixed CNY pricing.
INSERT INTO marketplace_offers
  (id, tenant_id, domain_id, supply_party_id, external_key, display_name, attributes, terms, status, published_at)
VALUES
  ('00000000-0000-7000-8000-000000001121', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-byd-song-plus',
   '比亚迪 宋PLUS DM-i 2023款 110KM 旗舰型',
   jsonb_build_object(
     'description', '2023 年 5 月上牌，行驶 2.1 万公里，个人一手车。插电混动，市区通勤可用纯电，亏电油耗约 4.5L。全车原版原漆，无事故无泡水，支持任意第三方检测。免购置税，可协助过户与转分期。',
     'brand', '比亚迪', 'model', '宋PLUS DM-i 2023款 110KM 旗舰型', 'category', 'SUV',
     'condition', '二手 · 准新车', 'location', '北京 · 朝阳', 'delivery_mode', '到店自提 / 同城送车',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-01.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001111',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001111')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '12680000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp()),
  ('00000000-0000-7000-8000-000000001122', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-tesla-model-3',
   '特斯拉 Model 3 2022款 后轮驱动版',
   jsonb_build_object(
     'description', '2022 年 8 月上牌，行驶 3.6 万公里，纯电轿车。CLTC 续航 556 公里，电池健康度 93%，带官方质保。车机为 AMD 平台，支持免费超充额度转移。全程 4S 保养记录可查。',
     'brand', '特斯拉', 'model', 'Model 3 2022款 后轮驱动版', 'category', '轿车',
     'condition', '二手 · 车况优秀', 'location', '北京 · 朝阳', 'delivery_mode', '到店自提 / 同城送车',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-02.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001112',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001112')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '16980000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp()),
  ('00000000-0000-7000-8000-000000001123', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-vw-golf',
   '大众 高尔夫 2021款 280TSI DSG 舒适型',
   jsonb_build_object(
     'description', '2021 年 3 月上牌，行驶 4.8 万公里。1.4T 双离合，市区代步灵活省油，综合油耗约 6L。右前门有一处补漆，其余原版，内饰无烟车。适合预算 10 万以内的首购家庭。',
     'brand', '大众', 'model', '高尔夫 2021款 280TSI DSG 舒适型', 'category', '轿车',
     'condition', '二手 · 车况良好', 'location', '北京 · 海淀', 'delivery_mode', '到店自提',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-03.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001113',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001113')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '8980000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp()),
  ('00000000-0000-7000-8000-000000001124', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-toyota-corolla',
   '丰田 卡罗拉 双擎 2022款 1.8L E-CVT 精英版',
   jsonb_build_object(
     'description', '2022 年 1 月上牌，行驶 2.9 万公里，油电混动无需充电，综合油耗约 4.2L。原厂质保期内，保险到明年。家用买菜通勤首选，保值率高，落地即省心。',
     'brand', '丰田', 'model', '卡罗拉 双擎 2022款 1.8L E-CVT 精英版', 'category', '轿车',
     'condition', '二手 · 车况优秀', 'location', '北京 · 丰台', 'delivery_mode', '到店自提 / 同城送车',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-04.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001114',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001114')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '9980000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp()),
  ('00000000-0000-7000-8000-000000001125', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-lixiang-l7',
   '理想 L7 2023款 Pro',
   jsonb_build_object(
     'description', '2023 年 10 月上牌，行驶 1.2 万公里，准新车。增程式六座大五座布局，家庭出行空间充裕，带魔毯空气悬架与后排娱乐屏。首任车主权益可随车转移。',
     'brand', '理想', 'model', 'L7 2023款 Pro', 'category', 'SUV',
     'condition', '二手 · 准新车', 'location', '北京 · 顺义', 'delivery_mode', '到店自提 / 异地托运',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-05.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001115',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001115')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '25980000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp()),
  ('00000000-0000-7000-8000-000000001126', :'tenant_id'::uuid, '00000000-0000-7000-8000-000000001101',
   '00000000-0000-7000-8000-000000001105', 'demo-car-honda-crv',
   '本田 CR-V 2020款 240TURBO CVT 两驱舒适版',
   jsonb_build_object(
     'description', '2020 年 6 月上牌，行驶 6.5 万公里。1.5T 城市 SUV 标杆，空间大、油耗低、维修保养便宜。定期 4S 保养，刚换四条新胎。预算 15 万以内想要 SUV 的稳妥之选。',
     'brand', '本田', 'model', 'CR-V 2020款 240TURBO CVT 两驱舒适版', 'category', 'SUV',
     'condition', '二手 · 车况良好', 'location', '北京 · 大兴', 'delivery_mode', '到店自提 / 同城送车',
     'stock_quantity', 1,
     'attachments', jsonb_build_array(jsonb_build_object(
       'kind', 'image', 'file_name', 'car-06.svg', 'media_type', 'image/svg+xml',
       'attachment_ref', 'media://hosted/00000000-0000-7000-8000-000000001116',
       'metadata', jsonb_build_object('public_url', '/api/store-media/00000000-0000-7000-8000-000000001116')))),
   jsonb_build_object('pricing_mode', 'fixed', 'amount_minor', '13280000', 'currency', 'CNY', 'currency_scale', 2),
   'active', clock_timestamp())
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Human-readable summary for the wrapper output.
SELECT store.slug        AS demo_store_slug,
       alias.path        AS demo_store_path,
       count(offer.id)   AS active_offers
  FROM stores store
  JOIN store_path_aliases alias
    ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id AND alias.is_canonical
  LEFT JOIN marketplace_offers offer
    ON offer.tenant_id = store.tenant_id AND offer.store_id = store.id AND offer.status = 'active'
 WHERE store.id = '00000000-0000-7000-8000-000000001104'
 GROUP BY store.slug, alias.path;
