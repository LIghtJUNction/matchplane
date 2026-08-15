import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";
import { isMountedPlatformPath, readActivePlatformScope } from "../../../../src/platform-mount";

export const runtime = "nodejs";

type RequestedRole = "buyer" | "seller" | "subplatform_admin";

interface SessionRequest {
  tenantId?: string;
  domainId?: string;
  subplatform?: string;
  platformPath?: string;
  role?: RequestedRole;
}

/**
 * Converts a verified Better Auth session into the narrowly scoped capability expected by the
 * Rust marketplace API. The operator credential never leaves this server route.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });
  }

  const input = await parseBody(request);
  if (!input.tenantId || !input.role || !input.subplatform) {
    return NextResponse.json(
      { error: "tenantId, subplatform, and role are required" },
      { status: 400 },
    );
  }
  if (!isRequestedRole(input.role)) {
    return NextResponse.json({ error: "role must be buyer, seller, or subplatform_admin" }, { status: 400 });
  }
  if (!isUuid(input.tenantId)) {
    return NextResponse.json({ error: "tenantId must be a UUID" }, { status: 400 });
  }
  if (input.domainId && !isUuid(input.domainId)) {
    return NextResponse.json({ error: "domainId must be a UUID when provided" }, { status: 400 });
  }
  if (input.subplatform !== "root" && !input.domainId) {
    return NextResponse.json({ error: "child platform sessions require domainId" }, { status: 400 });
  }

  const platformPath = normalizePlatformPath(
    input.platformPath ?? (input.subplatform === "root" ? "/" : `/${input.subplatform}`),
  );
  if (!platformPath || (input.subplatform !== "root" && platformPath.split("/").filter(Boolean).at(-1) !== input.subplatform)) {
    return NextResponse.json({ error: "platformPath must identify the requested platform node" }, { status: 400 });
  }
  if (!(await isMountedPlatformPath(platformPath))) {
    return NextResponse.json({ error: "当前平台路径尚未激活" }, { status: 404 });
  }

  if (input.subplatform !== "root" && process.env.MATCHPLANE_ENVIRONMENT === "production") {
    const resolved = await readActivePlatformScope(platformPath);
    if (!resolved || resolved.slug !== input.subplatform) {
      return NextResponse.json({ error: "平台路径无法解析为唯一的 active 节点" }, { status: 404 });
    }
    if (resolved.tenantId !== input.tenantId || resolved.domainId !== input.domainId) {
      return NextResponse.json({ error: "tenantId/domainId 与平台路径不匹配" }, { status: 403 });
    }
  }

  if (input.subplatform === "root") {
    const configuredRootTenant = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
    if (
      process.env.MATCHPLANE_ENVIRONMENT === "production"
      && (!configuredRootTenant || !isUuid(configuredRootTenant))
    ) {
      return NextResponse.json({ error: "根平台尚未配置 MATCHPLANE_ROOT_TENANT_ID" }, { status: 503 });
    }
    if (configuredRootTenant && configuredRootTenant !== input.tenantId) {
      return NextResponse.json({ error: "tenantId 不属于根平台" }, { status: 403 });
    }
  } else if (!(await activeSubplatformScope(input.tenantId, input.domainId, input.subplatform))) {
    return NextResponse.json({ error: "当前子平台没有可用的 active registration" }, { status: 404 });
  }

  let membership = await readOrganizationMembership(request, input.subplatform, session.user.id);
  const userRole = (session.user as { role?: string }).role;
  const rootSuperAdmin = userRole === "rootSuperAdmin";
  if (input.role === "subplatform_admin") {
    const scopedAdmin = membership?.role
      .split(",")
      .some((role) => role === "owner" || role === "admin" || role === "subplatform_admin");
    if (!rootSuperAdmin && !scopedAdmin) {
      return NextResponse.json(
        { error: "当前 Better Auth 账号没有这个子平台的管理员权限" },
        { status: 403 },
      );
    }
  } else if (!rootSuperAdmin && !membership && input.subplatform !== "root") {
    const canClaim = await subplatformAllowsPublicClaim(input.tenantId, input.domainId, input.subplatform);
    if (canClaim) {
      membership = await claimPublicSubplatformMembership(
        request,
        input.tenantId,
        input.domainId,
        input.subplatform,
        session.user.id,
      );
    }
  }
  if (!rootSuperAdmin && !membership && input.role !== "subplatform_admin" && input.subplatform !== "root") {
    return NextResponse.json(
      { error: "当前子平台尚未开放公开认领；请使用同一个 Better Auth 账号接受平台邀请" },
      { status: 403 },
    );
  }

  let gatewayResponse: Response;
  try {
    gatewayResponse = await fetch(
      `${process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8080"}/v1/admin/marketplace/parties/session`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${await loadInternalBearer(
            "MATCHPLANE_GATEWAY_ADMIN_TOKEN",
            "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE",
          )}`,
        },
        body: JSON.stringify({
          auth_user_id: session.user.id,
          tenant_id: input.tenantId,
          domain_id: input.domainId ?? null,
          platform_path: platformPath,
          external_key: `better-auth:${session.user.id}:${input.tenantId}:${platformPath}`,
          display_name: session.user.name,
          role: input.role === "subplatform_admin" ? "both" : input.role,
          contact: { email: session.user.email },
        }),
      },
    );
  } catch (error) {
    console.error("marketplace session bridge unavailable", error);
    return NextResponse.json({ error: "撮合会话服务暂时不可用" }, { status: 503 });
  }
  if (!gatewayResponse.ok) {
    const message = await gatewayResponse.text();
    return NextResponse.json(
      { error: message || "marketplace session bridge failed" },
      { status: gatewayResponse.status >= 500 ? 502 : gatewayResponse.status },
    );
  }
  const body = (await gatewayResponse.json()) as {
    tenant_id: string;
    party_id: string;
    role: "buyer" | "seller" | "both";
    access_token: string;
    access_token_expires_at: string;
  };
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
}

async function readOrganizationMembership(
  request: Request,
  slug: string,
  userId: string,
): Promise<{ role: string } | null> {
  try {
    const full = await auth.api.getFullOrganization({
      query: { organizationSlug: slug },
      headers: request.headers,
    });
    const members = (full as { members?: Array<{ userId: string; role: string }> } | null)?.members;
    return members?.find((member) => member.userId === userId) ?? null;
  } catch {
    // A not-yet-registered subplatform has no Better Auth organization. Root superadmins can
    // still provision it; ordinary identities must go through the invitation/claim flow.
    return null;
  }
}

/**
 * Public buyer/seller access is a one-account SSO flow: the first authenticated visit claims a
 * member projection for the active child platform. Admin roles never use this path and still
 * require an explicit owner/admin invitation.
 */
async function claimPublicSubplatformMembership(
  request: Request,
  tenantId: string,
  domainId: string | undefined,
  slug: string,
  userId: string,
): Promise<{ role: string } | null> {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return null;
  const result = await authDatabase.query<{ organization_id: string }>(
    `SELECT o.id AS organization_id
       FROM "organization" o
       JOIN subplatform_registrations r ON r.slug = o.slug
      WHERE o.slug = $1
        AND r.tenant_id = $2::uuid
        AND ($3::uuid IS NULL OR r.domain_id = $3::uuid)
        AND r.state = 'active'
      ORDER BY r.version DESC
      LIMIT 1`,
    [slug, tenantId, domainId ?? null],
  );
  const organizationId = result.rows[0]?.organization_id;
  if (!organizationId) return null;

  try {
    // This is a server-only Better Auth operation. The user id is taken from the verified
    // session above, never from the browser request body.
    await auth.api.addMember({
      body: { organizationId, userId, role: "member" },
    });
  } catch {
    // A concurrent request may have claimed the same membership. Read the authoritative
    // Better Auth projection below instead of treating that race as a failure.
  }
  return readOrganizationMembership(request, slug, userId);
}

async function activeSubplatformScope(
  tenantId: string,
  domainId: string | undefined,
  slug: string,
): Promise<boolean> {
  const result = await authDatabase.query(
    `SELECT 1
       FROM subplatform_registrations
      WHERE tenant_id = $1::uuid
        AND slug = $2
        AND ($3::uuid IS NULL OR domain_id = $3::uuid)
        AND state = 'active'
      LIMIT 1`,
    [tenantId, slug, domainId ?? null],
  );
  return result.rowCount === 1;
}

async function subplatformAllowsPublicClaim(
  tenantId: string,
  domainId: string | undefined,
  slug: string,
): Promise<boolean> {
  const result = await authDatabase.query(
    `SELECT 1
       FROM subplatform_registrations
      WHERE tenant_id = $1::uuid
        AND slug = $2
        AND ($3::uuid IS NULL OR domain_id = $3::uuid)
        AND state = 'active'
        AND membership_policy = 'public'
      LIMIT 1`,
    [tenantId, slug, domainId ?? null],
  );
  return result.rowCount === 1;
}

async function parseBody(request: Request): Promise<SessionRequest> {
  try {
    const body = (await request.json()) as SessionRequest;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRequestedRole(value: unknown): value is RequestedRole {
  return value === "buyer" || value === "seller" || value === "subplatform_admin";
}

function normalizePlatformPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" || /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(normalized) ? normalized : null;
}
