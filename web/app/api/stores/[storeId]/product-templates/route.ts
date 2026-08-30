import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { NextResponse } from "next/server";

import {
  defaultProductTemplate,
  parseProductTemplateCatalog,
  type ProductTemplateConfig,
} from "../../../../../src/product-templates";
import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  createProductTemplateCatalog,
  parseProductTemplateSettingsUpdate,
  resolveProductTemplateSettings,
  storedProductTemplateSettings,
  synthesizeHostedStoreManifest,
  validateProductTemplateSettingsCatalog,
  type ProductTemplateCatalog,
  type ProductTemplateSettings,
} from "../../../../../src/lib/store-product-template-settings";
import {
  configuredTenantId,
  isUuid,
  readStoreAccess,
  roleOf,
  type StoreAccessRow,
} from "../../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

type StoreCatalog = ProductTemplateCatalog<ProductTemplateConfig>;

export async function GET(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("请先登录", 401);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canOperate) {
    return error("当前账号不能查看这家店铺的商品模板设置", 403);
  }

  try {
    const catalog = await readCatalog(authDatabase, access.store);
    return response(
      catalog,
      resolveProductTemplateSettings(access.store.metadata, catalog),
      access.store.version,
      access.canManageStore,
    );
  } catch (cause) {
    console.error("store product template settings lookup failed", cause);
    return error("商品模板设置读取失败，请稍后重试", 500);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return error("请求来源未被商城信任", 403);
  }
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("请先登录", 401);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canManageStore) {
    return error("只有店长或商城后台可以修改商品模板设置", 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request, 16 * 1024);
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "请求体不能超过 16 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const parsed = parseProductTemplateSettingsUpdate(rawBody);
  if (!parsed.ok) return error(parsed.error, 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);

  let client: PoolClient | undefined;
  try {
    const connected = await authDatabase.connect();
    client = connected;
    await connected.query("BEGIN");
    const locked = await lockStore(connected, tenantId, storeId);
    if (!locked) {
      await connected.query("ROLLBACK");
      return error("店铺已被其他操作更新，请刷新后重试", 409);
    }
    const catalog = await readCatalog(connected, locked);
    if (
      Number(locked.version) !== parsed.value.expectedStoreVersion ||
      catalog.revision !== parsed.value.expectedCatalogRevision
    ) {
      await connected.query("ROLLBACK");
      return error("店铺或商品模板目录已更新，请刷新后重试", 409);
    }
    const catalogError = validateProductTemplateSettingsCatalog(
      parsed.value,
      catalog,
    );
    if (catalogError) {
      await connected.query("ROLLBACK");
      return error(catalogError, 400);
    }

    const settings: ProductTemplateSettings = {
      enabledTemplateIds: parsed.value.enabledTemplateIds,
      defaultTemplateId: parsed.value.defaultTemplateId,
    };
    const updated = await connected.query<{ version: number }>(
      `UPDATE stores store
          SET metadata = jsonb_set(
                store.metadata,
                '{product_templates}',
                $3::jsonb,
                true
              ),
              version = store.version + 1,
              updated_at = clock_timestamp()
        WHERE store.tenant_id = $1::uuid
          AND store.id = $2::uuid
          AND store.version = $4::bigint
      RETURNING store.version`,
      [
        tenantId,
        storeId,
        JSON.stringify(storedProductTemplateSettings(settings)),
        parsed.value.expectedStoreVersion,
      ],
    );
    const storeVersion = Number(updated.rows[0]?.version);
    if (!Number.isSafeInteger(storeVersion)) {
      throw new Error("locked store product template update returned no row");
    }
    await connected.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
               'store.product_templates.updated', 'success', $6::jsonb)`,
      [
        randomUUID(),
        tenantId,
        locked.domainId,
        locked.path,
        session.user.id,
        JSON.stringify({
          store_id: storeId,
          enabled_template_ids: settings.enabledTemplateIds,
          default_template_id: settings.defaultTemplateId,
          version: storeVersion,
          catalog_revision: catalog.revision,
          registration_id: catalog.registrationId,
        }),
      ],
    );
    await connected.query("COMMIT");

    const responseCatalog =
      locked.integrationKind === "hosted"
        ? catalogForManifest(
            synthesizeHostedStoreManifest({ ...locked, version: storeVersion }),
            null,
          )
        : catalog;
    return response(responseCatalog, settings, storeVersion, true);
  } catch (cause) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("store product template settings update failed", cause);
    return error("商品模板设置保存失败，请稍后重试", 500);
  } finally {
    client?.release();
  }
}

async function lockStore(
  client: Queryable,
  tenantId: string,
  storeId: string,
): Promise<StoreAccessRow | null> {
  const result = await client.query<StoreAccessRow>(
    `SELECT store.id::text,
            store.tenant_id::text AS "tenantId",
            store.slug,
            ('/' || store.slug) AS path,
            store.display_name AS "displayName",
            store.description,
            store.integration_kind AS "integrationKind",
            store.status,
            store.version,
            store.domain_id::text AS "domainId",
            store.organization_id::text AS "organizationId",
            store.metadata,
            store.current_registration_id::text AS "currentRegistrationId"
       FROM stores store
      WHERE store.tenant_id = $1::uuid
        AND store.id = $2::uuid
      FOR UPDATE`,
    [tenantId, storeId],
  );
  return result.rows[0] ?? null;
}

async function readCatalog(
  queryable: Queryable,
  store: StoreAccessRow,
): Promise<StoreCatalog> {
  if (store.integrationKind === "hosted") {
    return catalogForManifest(synthesizeHostedStoreManifest(store), null);
  }
  const result = await queryable.query<{
    manifest: unknown;
    registrationId: string;
  }>(
    `SELECT registration.id::text AS "registrationId",
            registration.manifest
       FROM stores active_store
       JOIN domains domain
         ON domain.tenant_id = active_store.tenant_id
        AND domain.id = active_store.domain_id
        AND domain.status = 'active'
       JOIN subplatform_registrations registration
         ON registration.id = active_store.current_registration_id
        AND registration.tenant_id = active_store.tenant_id
        AND registration.domain_id = active_store.domain_id
        AND registration.slug = active_store.slug
        AND registration.state = 'active'
      WHERE active_store.tenant_id = $1::uuid
        AND active_store.id = $2::uuid
        AND active_store.integration_kind IN ('package', 'external')
        AND (
          active_store.integration_kind <> 'external'
          OR EXISTS (
            SELECT 1
              FROM platform_federation_bindings binding
             WHERE binding.id = active_store.federation_binding_id
               AND binding.tenant_id = active_store.tenant_id
               AND binding.domain_id = active_store.domain_id
               AND binding.status = 'active'
          )
        )
      LIMIT 1`,
    [store.tenantId, store.id],
  );
  const active = result.rows[0];
  return catalogForManifest(
    active?.manifest ?? {},
    active?.registrationId ?? null,
  );
}

function catalogForManifest(
  manifest: unknown,
  registrationId: string | null,
): StoreCatalog {
  const parsed = parseProductTemplateCatalog(manifest);
  if (!parsed) throw new Error("active store product template catalog is invalid");
  return createProductTemplateCatalog(
    manifest,
    registrationId,
    parsed.productTemplates,
    defaultProductTemplate(parsed)?.id ?? null,
  );
}

function response(
  catalog: StoreCatalog,
  settings: ProductTemplateSettings,
  storeVersion: number,
  canManageStore: boolean,
): Response {
  return NextResponse.json(
    {
      catalog,
      settings,
      storeVersion: Number(storeVersion),
      canManageStore,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
