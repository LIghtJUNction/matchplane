import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";

export const runtime = "nodejs";

/**
 * Explicitly activates an immutable, built subplatform release. Registration and activation are
 * separate so an untrusted repository can never become routable merely because its manifest was
 * accepted. The build digest must already have been attached by the isolated builder (or supplied
 * during registration) and must match this activation request byte-for-byte.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });

  const input = await parseBody(request);
  if (!input.registrationId || !isUuid(input.registrationId)) {
    return NextResponse.json({ error: "registrationId must be a UUID" }, { status: 400 });
  }
  if (!input.buildDigest || !/^[0-9a-f]{64}$/i.test(input.buildDigest)) {
    return NextResponse.json({ error: "buildDigest must be a SHA-256 digest" }, { status: 400 });
  }

  const registration = await authDatabase.query(
    `SELECT r.id,
            r.slug,
            r.state,
            encode(r.build_digest, 'hex') AS "buildDigest",
            encode(r.manifest_digest, 'hex') AS "manifestDigest",
            r.tenant_id AS "tenantId",
            r.domain_id AS "domainId",
            o.id AS "organizationId",
            o."parentOrganizationId" AS "parentOrganizationId"
       FROM subplatform_registrations r
       JOIN "organization" o
         ON o.slug = r.slug AND o."tenantId" = r.tenant_id::text
      WHERE r.id = $1::uuid
      ORDER BY r.version DESC
      LIMIT 1`,
    [input.registrationId],
  );
  const row = registration.rows[0] as RegistrationRow | undefined;
  if (!row) return NextResponse.json({ error: "子平台注册记录不存在" }, { status: 404 });

  if (!(await canManageParent(session.user.id, session.user.role, row.parentOrganizationId))) {
    return NextResponse.json({ error: "当前账号没有激活该平台节点的权限" }, { status: 403 });
  }
  if (row.state === "active") {
    if (row.buildDigest?.toLowerCase() !== input.buildDigest.toLowerCase()) {
      return NextResponse.json({ error: "已激活版本的 buildDigest 不匹配，不能覆盖不可变发布" }, { status: 409 });
    }
    return NextResponse.json(toResponse(row), { headers: { "cache-control": "no-store" } });
  }
  if (!new Set(["validated", "building", "ready"]).has(row.state)) {
    return NextResponse.json({ error: `当前状态 ${row.state} 不允许激活` }, { status: 409 });
  }
  if (!row.buildDigest) {
    return NextResponse.json({ error: "隔离构建器尚未附加 buildDigest" }, { status: 409 });
  }
  if (row.buildDigest.toLowerCase() !== input.buildDigest.toLowerCase()) {
    return NextResponse.json({ error: "buildDigest 与已验证构建产物不一致" }, { status: 409 });
  }

  const activated = await authDatabase.query(
    `UPDATE subplatform_registrations
        SET state = 'active',
            activated_at = COALESCE(activated_at, clock_timestamp()),
            version = version + 1
      WHERE id = $1::uuid
        AND state IN ('validated', 'building', 'ready')
        AND build_digest = decode($2, 'hex')
      RETURNING id,
                slug,
                state,
                encode(build_digest, 'hex') AS "buildDigest",
                encode(manifest_digest, 'hex') AS "manifestDigest",
                tenant_id AS "tenantId",
                domain_id AS "domainId",
                activated_at AS "activatedAt"`,
    [input.registrationId, input.buildDigest.toLowerCase()],
  );
  if (activated.rowCount !== 1) {
    return NextResponse.json({ error: "注册版本已被其他操作修改，请重新读取后再试" }, { status: 409 });
  }
  return NextResponse.json({
    ...activated.rows[0],
    routing: "enabled",
  }, { headers: { "cache-control": "no-store" } });
}

interface ActivationRequest {
  registrationId?: string;
  buildDigest?: string;
}

interface RegistrationRow {
  id: string;
  slug: string;
  state: string;
  buildDigest: string | null;
  manifestDigest: string;
  tenantId: string;
  domainId: string;
  organizationId: string;
  parentOrganizationId: string | null;
}

async function parseBody(request: Request): Promise<ActivationRequest> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as ActivationRequest : {};
  } catch {
    return {};
  }
}

async function canManageParent(userId: string, role: string | null | undefined, parentId: string | null): Promise<boolean> {
  if (!parentId) return role === "rootSuperAdmin" || role === "rootAdmin";
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const result = await authDatabase.query(
    `SELECT 1
       FROM member
      WHERE "organizationId" = $1::uuid
        AND "userId" = $2::uuid
        AND role = ANY($3::text[])
      LIMIT 1`,
    [parentId, userId, ["owner", "admin", "subplatform_admin"]],
  );
  return result.rowCount === 1;
}

function toResponse(row: RegistrationRow): Record<string, unknown> {
  return {
    registrationId: row.id,
    slug: row.slug,
    state: row.state,
    buildDigest: row.buildDigest,
    manifestDigest: row.manifestDigest,
    tenantId: row.tenantId,
    domainId: row.domainId,
    routing: "enabled",
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
