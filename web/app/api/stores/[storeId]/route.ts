import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import {
  configuredTenantId,
  isUuid,
  readStoreAccess,
  roleOf,
  type StoreAccessRow,
} from "../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!access.store || !access.canOperate)
    return error("当前账号不能查看这家店铺的管理资料", 403);
  return NextResponse.json(
    {
      store: responseStore(access.store),
      canManageStore: access.canManageStore,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被商城信任", 403);
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("请先登录", 401);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canManageStore)
    return error("只有店长或商城后台可以修改店铺资料", 403);
  let body: {
    displayName?: unknown;
    description?: unknown;
    expectedVersion?: unknown;
  };
  try {
    body = (await readJsonBody(request, 16 * 1024)) as typeof body;
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "请求体不能超过 16 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const displayName = text(body.displayName, 200);
  const description = optionalText(body.description, 2_000);
  const expectedVersion = body.expectedVersion;
  if (!displayName || description === null)
    return error("请填写店铺名称；店铺简介不能超过 2000 个字符", 400);
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)
    return error("店铺资料版本无效，请刷新后重试", 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);
  try {
    const result = await authDatabase.query<StoreAccessRow>(
      `UPDATE stores store
          SET display_name = $3,
              description = $4,
              version = version + 1,
              updated_at = clock_timestamp()
        WHERE store.tenant_id = $1::uuid
          AND store.id = $2::uuid
          AND store.version = $5
        RETURNING store.id::text,
                  store.tenant_id::text AS "tenantId",
                  store.slug,
                  ('/' || store.slug) AS path,
                  store.display_name AS "displayName",
                  store.description,
                  store.integration_kind AS "integrationKind",
                  store.status,
                  store.version,
                  store.domain_id::text AS "domainId",
                  store.organization_id::text AS "organizationId"`,
      [tenantId, storeId, displayName, description, expectedVersion],
    );
    const store = result.rows[0];
    if (!store) return error("店铺资料已被其他操作更新，请刷新后重试", 409);
    await authDatabase.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'store.profile.updated', 'success', $6::jsonb)`,
      [
        randomUUID(),
        tenantId,
        store.domainId,
        store.path,
        session.user.id,
        JSON.stringify({ store_id: store.id, version: store.version }),
      ],
    );
    return NextResponse.json(
      { store: responseStore(store) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (cause) {
    console.error("store profile update failed", cause);
    return error("店铺资料保存失败，请稍后重试", 500);
  }
}

function responseStore(store: StoreAccessRow) {
  return {
    id: store.id,
    tenantId: store.tenantId,
    slug: store.slug,
    path: store.path,
    displayName: store.displayName,
    description: store.description,
    integrationKind: store.integrationKind,
    status: store.status,
    version: Number(store.version),
    domainId: store.domainId,
    organizationId: store.organizationId,
  };
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : null;
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
