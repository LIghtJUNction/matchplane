import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../src/lib/request-origin";
import { readPublicStores } from "../../../src/store-directory";
import { isUuid } from "../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, contact-free flat store directory for the marketplace shell. */
export async function GET(request: Request): Promise<Response> {
  const searchParams = new URLSearchParams(request.url.split("?", 2)[1] ?? "");
  if (searchParams.get("mine") === "1") return readOwnedStores(request);
  if (searchParams.get("manage") === "1") return readManagedStores(request);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  const stores = await readPublicStores(tenantId).catch((error) => {
    console.error("public store directory failed", error);
    return null;
  });
  if (!stores)
    return NextResponse.json({ error: "店铺目录暂时不可用" }, { status: 503 });
  return NextResponse.json(
    {
      stores: stores.map((store) => ({
        id: store.id,
        slug: store.slug,
        path: store.path,
        displayName: store.displayName,
        description: store.description,
        integrationKind: store.integrationKind,
      })),
    },
    {
      headers: {
        "cache-control": "public, max-age=30, stale-while-revalidate=120",
      },
    },
  );
}

async function readManagedStores(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin"))
    return jsonError("当前账号没有商城运营权限", 403);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);
  const result = await authDatabase.query(
    `SELECT store.id::text,
            store.slug,
            alias.path,
            store.display_name AS "displayName",
            store.description,
            store.integration_kind AS "integrationKind",
            store.status,
            jsonb_build_object(
              'pricingModel', terms.pricing_model,
              'recurringFeeMinor', terms.recurring_fee_minor::text,
              'currency', terms.currency,
              'billingInterval', terms.billing_interval,
              'commissionBps', terms.commission_bps,
              'status', terms.status,
              'version', terms.version
            ) AS "commercialTerms"
       FROM stores store
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id AND alias.is_canonical = true
       JOIN store_commercial_terms terms
         ON terms.tenant_id = store.tenant_id AND terms.store_id = store.id
      WHERE store.tenant_id = $1::uuid
        AND store.status <> 'closed'
      ORDER BY store.created_at DESC`,
    [tenantId],
  );
  return NextResponse.json(
    { stores: result.rows },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Open a native hosted store for the current account. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录后开店", 401);
  const sessionUser = session.user as typeof session.user & {
    role?: unknown;
    phoneNumberVerified?: unknown;
  };
  const mallOperator =
    sessionUser.role === "rootSuperAdmin" || sessionUser.role === "rootAdmin";
  if (
    !mallOperator &&
    sessionUser.emailVerified !== true &&
    sessionUser.phoneNumberVerified !== true
  ) {
    return jsonError("验证邮箱或手机号后才能开店", 403);
  }

  let input: { name?: unknown; description?: unknown };
  try {
    const body = await readJsonBody(request, 16 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return jsonError("请求必须是对象", 400);
    input = body as typeof input;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "请求体不能超过 16 KiB"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const name = normalizeName(input.name);
  const description = normalizeDescription(input.description);
  if (!name) return jsonError("店铺名称必须为 1 到 200 个字符", 400);
  if (description === null)
    return jsonError("店铺简介不能超过 2000 个字符", 400);
  const slug = generateStoreSlug();
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  const root = await authDatabase.query<{ id: string }>(
    `SELECT id::text FROM "organization"
      WHERE "tenantId" = $1 AND "rootPlatform" = true AND "parentOrganizationId" IS NULL
      LIMIT 1`,
    [tenantId],
  );
  const rootOrganizationId = root.rows[0]?.id;
  if (!rootOrganizationId) return jsonError("商城组织尚未初始化", 503);
  const eligibility = await authDatabase.query<{
    owned: number;
    recent: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM stores WHERE tenant_id = $1::uuid AND created_by = $2 AND integration_kind = 'hosted' AND status <> 'closed') AS owned,
       (SELECT count(*)::int FROM stores WHERE tenant_id = $1::uuid AND created_by = $2 AND integration_kind = 'hosted' AND created_at > clock_timestamp() - interval '1 hour') AS recent`,
    [tenantId, session.user.id],
  );
  if (Number(eligibility.rows[0]?.owned ?? 0) >= 5)
    return jsonError("每个账号最多创建 5 家托管店铺", 409);
  if (Number(eligibility.rows[0]?.recent ?? 0) >= 2)
    return jsonError("每小时最多创建 2 家店铺，请稍后再试", 429);

  let organization: { id: string; name: string; slug: string };
  try {
    organization = (await auth.api.createOrganization({
      body: {
        name,
        slug,
        userId: session.user.id,
        metadata: {
          tenantId,
          integrationKind: "hosted",
          parentOrganizationId: rootOrganizationId,
        },
      },
    })) as { id: string; name: string; slug: string };
  } catch (error) {
    console.error("hosted store organization creation failed", error);
    return jsonError("店铺初始化失败，请稍后重试", 500);
  }

  const storeId = randomUUID();
  const domainId = randomUUID();
  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `matchplane:hosted-store:${session.user.id}`,
    ]);
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM stores
        WHERE tenant_id = $1::uuid AND created_by = $2 AND integration_kind = 'hosted' AND status <> 'closed'`,
      [tenantId, session.user.id],
    );
    if (Number(count.rows[0]?.count ?? 0) >= 5)
      throw new StoreCreationConflict("每个账号最多创建 5 家托管店铺");
    const recent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM stores
        WHERE tenant_id = $1::uuid AND created_by = $2 AND integration_kind = 'hosted'
          AND created_at > clock_timestamp() - interval '1 hour'`,
      [tenantId, session.user.id],
    );
    if (Number(recent.rows[0]?.count ?? 0) >= 2)
      throw new StoreCreationConflict(
        "每小时最多创建 2 家店铺，请稍后再试",
        429,
      );
    await client.query(
      `INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [domainId, tenantId, `store-${storeId.slice(0, 8)}`, name],
    );
    const projected = await client.query(
      `UPDATE "organization"
          SET "tenantId" = $2,
              "domainId" = $3,
              "parentOrganizationId" = $4::uuid,
              "rootPlatform" = false,
              "metadata" = $5
        WHERE id = $1::uuid
        RETURNING id`,
      [
        organization.id,
        tenantId,
        domainId,
        rootOrganizationId,
        JSON.stringify({ storeId, integrationKind: "hosted" }),
      ],
    );
    if (projected.rowCount !== 1)
      throw new Error("hosted store organization projection failed");
    await client.query(
      `INSERT INTO stores
        (id, tenant_id, organization_id, domain_id, slug, display_name, description,
         status, visibility, integration_kind, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
               'active', 'public', 'hosted', $8)`,
      [
        storeId,
        tenantId,
        organization.id,
        domainId,
        slug,
        name,
        description,
        session.user.id,
      ],
    );
    await client.query(
      `INSERT INTO store_path_aliases (tenant_id, store_id, path, is_canonical)
       VALUES ($1::uuid, $2::uuid, $3, true)`,
      [tenantId, storeId, `/${slug}`],
    );
    await client.query(
      `INSERT INTO store_commercial_terms (tenant_id, store_id) VALUES ($1::uuid, $2::uuid)`,
      [tenantId, storeId],
    );
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'store.hosted.created', 'success', $6::jsonb)`,
      [
        randomUUID(),
        tenantId,
        domainId,
        `/${slug}`,
        session.user.id,
        JSON.stringify({ store_id: storeId, slug }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    await authDatabase
      .query('DELETE FROM "organization" WHERE id = $1::uuid', [
        organization.id,
      ])
      .catch(() => undefined);
    if (error instanceof StoreCreationConflict)
      return jsonError(error.message, error.status);
    if (isUniqueViolation(error))
      return jsonError("店铺初始化遇到冲突，请重试", 409);
    console.error("hosted store persistence failed", error);
    return jsonError("店铺创建失败，请稍后重试", 500);
  } finally {
    client?.release();
  }

  return NextResponse.json(
    {
      store: {
        id: storeId,
        slug,
        path: `/${slug}`,
        displayName: name,
        description,
        integrationKind: "hosted",
        status: "active",
        membershipRole: "owner",
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

async function readOwnedStores(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  const role = (session.user as { role?: unknown }).role;
  const mallOperator = role === "rootSuperAdmin" || role === "rootAdmin";
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);
  const result = await authDatabase.query(
    `SELECT DISTINCT store.id::text,
            store.slug,
            alias.path,
            store.display_name AS "displayName",
            store.description,
            store.integration_kind AS "integrationKind",
            store.status,
            store.version,
            store.created_at AS "createdAt",
            CASE WHEN $3::boolean IS TRUE THEN 'mall_operator' ELSE membership.role END AS "membershipRole"
       FROM stores store
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id AND alias.is_canonical = true
       LEFT JOIN "member" membership
         ON membership."organizationId" = store.organization_id
        AND membership."userId" = $2::uuid
      WHERE store.tenant_id = $1::uuid
        AND ($3::boolean IS TRUE OR membership.role = ANY($4::text[]))
        AND store.status <> 'closed'
      ORDER BY store.created_at DESC`,
    [
      tenantId,
      session.user.id,
      mallOperator,
      ["owner", "admin", "subplatform_admin"],
    ],
  );
  return NextResponse.json(
    { stores: result.rows },
    { headers: { "cache-control": "no-store" } },
  );
}

function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return isUuid(value) ? value : null;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 200 ? normalized : null;
}

function generateStoreSlug(): string {
  return `store-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function normalizeDescription(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

class StoreCreationConflict extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}
