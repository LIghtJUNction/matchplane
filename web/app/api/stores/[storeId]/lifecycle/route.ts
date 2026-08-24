import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import {
  configuredTenantId,
  readStoreAccess,
  roleOf,
  type StoreAccessRow,
} from "../../../../../src/lib/store-access";
import { isUuid } from "../../../../../src/lib/uuid";

const actions = new Set(["close", "reopen"]);

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
    return error("只有店长或商城后台可以更改营业状态", 403);

  let body: { action?: unknown; expectedVersion?: unknown };
  try {
    body = (await readJsonBody(request, 4 * 1024)) as typeof body;
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "请求体不能超过 4 KiB"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const action = typeof body.action === "string" ? body.action : "";
  const expectedVersion = Number(body.expectedVersion);
  if (!actions.has(action)) return error("营业状态操作无效", 400);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    return error("店铺资料版本无效，请刷新后重试", 400);
  if (Number(access.store.version) !== expectedVersion)
    return error("店铺状态已被其他操作更新，请刷新后重试", 409);

  const targetStatus = action === "close" ? "closed" : "active";
  if (access.store.status === targetStatus) return storeResponse(access.store);
  const sourceStatus = action === "close" ? "active" : "closed";
  if (access.store.status !== sourceStatus) {
    if (access.store.status === "suspended")
      return error("店铺已被商城暂停，不能由店主更改营业状态", 409);
    return error(
      action === "close"
        ? "只有营业中的店铺可以关闭"
        : "只有已关闭的店铺可以重新开店",
      409,
    );
  }

  const tenantId = configuredTenantId();
  if (!tenantId) return error("商城尚未完成初始化", 503);
  try {
    const result = await authDatabase.query<StoreAccessRow>(
      `WITH transitioned AS (
         UPDATE stores store
            SET status = $4,
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE store.tenant_id = $1::uuid
            AND store.id = $2::uuid
            AND store.version = $3
            AND store.status = $5
            AND (
              $4 <> 'active'
              OR store.integration_kind = 'hosted'
              OR EXISTS (
                SELECT 1
                  FROM subplatform_registrations registration
                 WHERE registration.tenant_id = store.tenant_id
                   AND registration.id = store.current_registration_id
                   AND registration.state = 'active'
              )
            )
            AND (
              $4 <> 'active'
              OR store.integration_kind <> 'external'
              OR EXISTS (
                SELECT 1
                  FROM federation_platform_bindings binding
                 WHERE binding.tenant_id = store.tenant_id
                   AND binding.id = store.federation_binding_id
                   AND binding.status = 'active'
              )
            )
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
                   store.organization_id::text AS "organizationId"
       ), audited AS (
         INSERT INTO platform_audit_events
           (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
         SELECT $6::uuid,
                $1::uuid,
                transitioned."domainId"::uuid,
                transitioned.path,
                $7::uuid,
                $8,
                'success',
                jsonb_build_object(
                  'store_id', transitioned.id,
                  'from_status', $5,
                  'to_status', $4,
                  'version', transitioned.version
                )
           FROM transitioned
         RETURNING id
       )
       SELECT transitioned.*
         FROM transitioned
        WHERE EXISTS (SELECT 1 FROM audited)`,
      [
        tenantId,
        storeId,
        expectedVersion,
        targetStatus,
        sourceStatus,
        randomUUID(),
        session.user.id,
        action === "close" ? "store.closed" : "store.reopened",
      ],
    );
    const store = result.rows[0];
    if (!store) {
      if (action === "reopen")
        return error("店铺接入尚未就绪，暂时不能重新开店", 409);
      return error("店铺状态已被其他操作更新，请刷新后重试", 409);
    }
    return storeResponse(store);
  } catch (cause) {
    console.error("store lifecycle update failed", cause);
    return error("营业状态保存失败，请稍后重试", 500);
  }
}

function storeResponse(store: StoreAccessRow): Response {
  return NextResponse.json(
    {
      store: {
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
      },
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
