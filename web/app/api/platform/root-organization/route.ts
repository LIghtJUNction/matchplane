import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";

/**
 * Create the one root Better Auth organization for this deployment.
 *
 * The tenant/domain kernel is initialized by the Rust CLI, while Better Auth owns identities and
 * memberships.  This small, authenticated bridge joins the two authorities without inserting a
 * Better Auth organization directly from SQL.  It is intentionally idempotent: once the root
 * marker exists, the existing record is returned and no second organization can be created.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });
  if (!isRootManager(session.user as { role?: string | null })) {
    return NextResponse.json({ error: "只有根平台管理员可以初始化根组织" }, { status: 403 });
  }

  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  if (!isUuid(tenantId)) return NextResponse.json({ error: "root tenant 尚未配置" }, { status: 503 });

  const tenant = await authDatabase.query<{ slug: string; name: string }>(
    "SELECT slug, name FROM tenants WHERE id = $1::uuid LIMIT 1",
    [tenantId],
  );
  const tenantRecord = tenant.rows[0];
  if (!tenantRecord) return NextResponse.json({ error: "root tenant 不存在；请先运行 initialize/provision-root" }, { status: 409 });

  const existing = await readRootOrganization(tenantId);
  if (existing) return NextResponse.json({ organization: existing, created: false }, { headers: { "cache-control": "no-store" } });

  // A previous release could only pin the Better Auth organization UUID. Adopt that exact,
  // verified top-level organization after the marker migration instead of creating a duplicate.
  // No unconfigured organization is guessed: an operator must either pin the legacy UUID or let
  // Better Auth create a new root through this endpoint.
  const configuredRootId = process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim();
  if (configuredRootId && isUuid(configuredRootId)) {
    const adopted = await adoptConfiguredRoot(tenantId, configuredRootId);
    if (!adopted) {
      return NextResponse.json({ error: "已配置的根组织 UUID 不存在、租户不匹配或不是顶层组织" }, { status: 409 });
    }
    return NextResponse.json({ organization: adopted, created: false, adopted: true }, { headers: { "cache-control": "no-store" } });
  }

  let input: { name?: string; slug?: string };
  try {
    input = await parseBody(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "根平台初始化请求体过大" : "请求必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const name = input.name?.trim() || tenantRecord.name.trim();
  const slug = input.slug?.trim().toLowerCase() || tenantRecord.slug.trim().toLowerCase();
  if (!isOrganizationName(name)) return NextResponse.json({ error: "根平台名称必须为 1..200 个字符" }, { status: 400 });
  if (!isOrganizationSlug(slug)) return NextResponse.json({ error: "根平台 slug 只能使用小写字母、数字和短横线" }, { status: 400 });

  let created: { id: string; name: string; slug: string };
  try {
    created = (await auth.api.createOrganization({
      body: {
        name,
        slug,
        userId: session.user.id,
        metadata: { tenantId, rootPlatform: true },
      },
    })) as { id: string; name: string; slug: string };
  } catch (error) {
    console.error("root organization creation failed", error);
    return NextResponse.json({ error: "根平台组织创建失败；slug 可能已被占用" }, { status: 409 });
  }

  try {
    const result = await authDatabase.query<{ id: string; name: string; slug: string; tenantId: string; domainId: string | null }>(
      `UPDATE "organization"
          SET "tenantId" = $2,
              "domainId" = NULL,
              "parentOrganizationId" = NULL,
              "rootPlatform" = true,
              "metadata" = $3
        WHERE id = $1::uuid
        RETURNING id::text, name, slug, "tenantId" AS "tenantId", NULLIF("domainId", '') AS "domainId"`,
      [created.id, tenantId, JSON.stringify({ tenantId, rootPlatform: true })],
    );
    const organization = result.rows[0];
    if (!organization) throw new Error("root organization update returned no row");
    // Older installations may have registered children before a root Better Auth organization
    // existed.  Adopt only those unparented, non-root nodes; nested trees and explicit parents
    // remain untouched.
    await authDatabase.query(
      `UPDATE "organization"
          SET "parentOrganizationId" = $1
        WHERE "tenantId" = $2
          AND id <> $1::uuid
          AND "rootPlatform" = false
          AND "parentOrganizationId" IS NULL
          AND EXISTS (
            SELECT 1
              FROM subplatform_registrations registration
             WHERE registration.tenant_id = $2::uuid
               AND registration.slug = "organization".slug
               AND registration.state IN ('validated', 'building', 'ready', 'active')
          )`,
      [organization.id, tenantId],
    );
    return NextResponse.json({ organization, created: true }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    // The Better Auth row is not useful without its root marker.  Remove only the row created by
    // this request; never touch a pre-existing organization when the idempotent lookup won a race.
    await authDatabase.query('DELETE FROM "organization" WHERE id = $1::uuid AND "rootPlatform" = false', [created.id]).catch(() => undefined);
    console.error("root organization projection failed", error);
    return NextResponse.json({ error: "根平台组织绑定 tenant 失败" }, { status: 500 });
  }
}

async function readRootOrganization(tenantId: string) {
  const configured = process.env.MATCHPLANE_ROOT_PLATFORM_ORGANIZATION_ID?.trim();
  const result = await authDatabase.query<{ id: string; name: string; slug: string; tenantId: string; domainId: string | null }>(
    `SELECT id::text, name, slug, "tenantId" AS "tenantId", NULLIF("domainId", '') AS "domainId"
       FROM "organization"
      WHERE "tenantId" = $1
        AND "parentOrganizationId" IS NULL
        AND "rootPlatform" = true
        AND ($2::uuid IS NULL OR id = $2::uuid)
      LIMIT 1`,
    [tenantId, configured && isUuid(configured) ? configured : null],
  );
  return result.rows[0] ?? null;
}

async function adoptConfiguredRoot(tenantId: string, organizationId: string) {
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const candidate = await client.query<{ id: string; name: string; slug: string; tenantId: string; domainId: string | null }>(
      `SELECT id::text, name, slug, "tenantId" AS "tenantId", NULLIF("domainId", '') AS "domainId"
         FROM "organization"
        WHERE id = $1::uuid
          AND "tenantId" = $2
          AND "parentOrganizationId" IS NULL
          AND "rootPlatform" = false
        FOR UPDATE`,
      [organizationId, tenantId],
    );
    if (!candidate.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const marked = await client.query<{ id: string; name: string; slug: string; tenantId: string; domainId: string | null }>(
      `UPDATE "organization"
          SET "rootPlatform" = true,
              "domainId" = NULL
        WHERE id = $1::uuid
        RETURNING id::text, name, slug, "tenantId" AS "tenantId", NULLIF("domainId", '') AS "domainId"`,
      [organizationId],
    );
    const organization = marked.rows[0];
    if (!organization) throw new Error("configured root adoption returned no row");
    await client.query(
      `UPDATE "organization"
          SET "parentOrganizationId" = $1
        WHERE "tenantId" = $2
          AND id <> $1::uuid
          AND "rootPlatform" = false
          AND "parentOrganizationId" IS NULL
          AND EXISTS (
            SELECT 1
              FROM subplatform_registrations registration
             WHERE registration.tenant_id = $2::uuid
               AND registration.slug = "organization".slug
               AND registration.state IN ('validated', 'building', 'ready', 'active')
          )`,
      [organization.id, tenantId],
    );
    await client.query("COMMIT");
    return organization;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("configured root organization adoption failed", error);
    return null;
  } finally {
    client.release();
  }
}

async function parseBody(request: Request): Promise<{ name?: string; slug?: string }> {
  const value = await readJsonBody<unknown>(request, 16 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.slug === "string" ? { slug: record.slug } : {}),
  };
}

function isRootManager(user: { role?: string | null }): boolean {
  return user.role === "rootSuperAdmin" || user.role === "rootAdmin";
}

function isOrganizationName(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && ![...value].some((character) => character.codePointAt(0)! < 0x20);
}

function isOrganizationSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
