import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";
import { isMountedPlatformPath, readActivePlatformScope } from "../../../../src/platform-mount";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";

type RequestedRole = "buyer" | "seller" | "subplatform_admin";

interface SessionRequest {
  tenantId?: string;
  domainId?: string;
  subplatform?: string;
  platformPath?: string;
  role?: RequestedRole;
  /** Server-to-server OIDC exchange for a child hosted on another origin. */
  federated?: {
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

interface MarketplaceIdentity {
  user: {
    id: string;
    name: string;
    email: string;
    role?: string | null;
  };
  federated: boolean;
}

/**
 * Converts a verified Better Auth session into the narrowly scoped capability expected by the
 * Rust marketplace API. The operator credential never leaves this server route.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await parseBody(request);
  const isFederatedRequest = Boolean(input.federated);
  if (!isFederatedRequest && !hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }

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

  const resolvedIdentity = await resolveMarketplaceIdentity(request, input);
  if (!resolvedIdentity.ok) return resolvedIdentity.response;
  const identity = resolvedIdentity.identity;
  if (identity.federated && input.role === "subplatform_admin") {
    return NextResponse.json(
      { error: "跨域 OIDC 登录只可交换买家或卖家 capability；管理员必须在根平台会话中操作" },
      { status: 403 },
    );
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

  // Resolve membership from the same tenant/domain registration that authorized the path.  Do
  // not let a same-origin cookie turn a slug collision or a stale Better Auth organization into
  // access to a different node.  The request origin is only a transport boundary; the database
  // scope is the authorization boundary.
  let membership = input.subplatform === "root"
    ? await readOrganizationMembership(request, input.subplatform, identity.user.id)
    : await readOrganizationMembershipByScope(input.tenantId, input.domainId, input.subplatform, identity.user.id);
  const userRole = identity.user.role;
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
        input.tenantId,
        input.domainId,
        input.subplatform,
        identity.user.id,
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
          auth_user_id: identity.user.id,
          tenant_id: input.tenantId,
          domain_id: input.domainId ?? null,
          platform_path: platformPath,
          external_key: `better-auth:${identity.user.id}:${input.tenantId}:${platformPath}`,
          display_name: identity.user.name,
          role: input.role === "subplatform_admin" ? "both" : input.role,
          contact: { email: identity.user.email },
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
  if (!isUuid(body.party_id) || body.tenant_id !== input.tenantId) {
    return NextResponse.json({ error: "撮合会话服务返回了无效的平台身份" }, { status: 502 });
  }
  if (input.subplatform !== "root") {
    try {
      await upsertMarketplaceMembershipProjection({
        tenantId: input.tenantId,
        domainId: input.domainId!,
        partyId: body.party_id,
        authUserId: identity.user.id,
        requestedRole: input.role,
      });
    } catch (error) {
      console.error("marketplace membership projection failed", error);
      return NextResponse.json(
        { error: "平台成员授权投影暂时不可用；未返回撮合 capability" },
        { status: 503 },
      );
    }
  }
  try {
    await recordPlatformAuditEvent({
      tenantId: input.tenantId,
      domainId: input.domainId ?? null,
      platformPath,
      actorAuthUserId: identity.user.id,
      actorPartyId: body.party_id,
      eventType: "marketplace.capability.issued",
      metadata: {
        role: input.role,
        identitySource: identity.federated ? "root-oidc" : "better-auth-session",
        membershipProjection: input.subplatform === "root" ? "root" : "active",
        expiresAt: body.access_token_expires_at,
      },
      requestId: request.headers.get("x-request-id"),
    });
  } catch (error) {
    console.error("marketplace capability audit failed", error);
    return NextResponse.json(
      { error: "撮合 capability 审计暂时不可用；未返回凭据" },
      { status: 503 },
    );
  }
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Resolves either the same-origin Better Auth cookie or a server-to-server OIDC access token.
 * The latter is deliberately not a browser login shortcut: the child must prove possession of
 * its registered client secret, and the token must be active for that exact child registration.
 */
async function resolveMarketplaceIdentity(
  request: Request,
  input: SessionRequest,
): Promise<
  | { ok: true; identity: MarketplaceIdentity }
  | { ok: false; response: Response }
> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session && input.federated) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "同一个请求不能同时携带 Better Auth cookie 和跨域 OIDC 凭据" },
        { status: 400 },
      ),
    };
  }
  if (session) {
    return {
      ok: true,
      identity: {
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          role: (session.user as { role?: string | null }).role,
        },
        federated: false,
      },
    };
  }

  const federated = input.federated;
  if (!federated) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Better Auth session is required" }, { status: 401 }),
    };
  }
  if (input.subplatform === "root") {
    return {
      ok: false,
      response: NextResponse.json({ error: "跨域 OIDC capability 必须绑定到具体子平台" }, { status: 400 }),
    };
  }
  if (!input.domainId || !input.subplatform) {
    return {
      ok: false,
      response: NextResponse.json({ error: "跨域 OIDC capability 缺少子平台作用域" }, { status: 400 }),
    };
  }

  const token = boundedString(federated.accessToken, 4096);
  const clientId = boundedString(federated.clientId, 256);
  const clientSecret = boundedString(federated.clientSecret, 512);
  if (!token || !clientId || !clientSecret) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "跨域 OIDC 交换需要 accessToken、clientId 和 clientSecret" },
        { status: 400 },
      ),
    };
  }

  const introspection = await introspectRootAccessToken(request, token, clientId, clientSecret);
  if (!introspection || introspection.active !== true || introspection.client_id !== clientId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "根平台 OIDC access token 无效或已撤销" }, { status: 401 }),
    };
  }
  const subject = introspection.sub;
  if (!introspection.scope?.split(" ").includes("openid") || !subject || !isUuid(subject)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "根平台 OIDC token 缺少有效的 openid 身份" }, { status: 401 }),
    };
  }

  const registration = await authDatabase.query(
    `SELECT 1
       FROM "oauthClient" c
       JOIN subplatform_registrations r
         ON r.id::text = c."metadata"->>'matchplane_subplatform_registration_id'
      WHERE c."clientId" = $1
        AND c."referenceId" = 'root-platform'
        AND c."disabled" IS NOT TRUE
        AND r.tenant_id = $2::uuid
        AND r.domain_id = $3::uuid
        AND r.slug = $4
        AND r.state = 'active'
      LIMIT 1`,
    [clientId, input.tenantId, input.domainId, input.subplatform],
  );
  if (registration.rowCount !== 1) {
    return {
      ok: false,
      response: NextResponse.json({ error: "OIDC 客户端没有绑定当前 active 子平台" }, { status: 403 }),
    };
  }

  const userResult = await authDatabase.query<MarketplaceIdentity["user"]>(
    `SELECT id::text, name, email, role
       FROM "user"
      WHERE id = $1::uuid
        AND banned IS NOT TRUE
      LIMIT 1`,
    [subject],
  );
  const user = userResult.rows[0];
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "根平台身份不存在或已停用" }, { status: 401 }),
    };
  }
  return { ok: true, identity: { user, federated: true } };
}

async function introspectRootAccessToken(
  request: Request,
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{
  active?: boolean;
  client_id?: string;
  sub?: string;
  scope?: string;
} | null> {
  try {
    const url = new URL("/api/auth/oauth2/introspect", request.url);
    const credentials = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const response = await auth.handler(new Request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }).toString(),
    }));
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as {
      active?: boolean;
      client_id?: string;
      sub?: string;
      scope?: string;
    };
  } catch (error) {
    console.error("root OIDC token introspection failed", error);
    return null;
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

async function upsertMarketplaceMembershipProjection(input: {
  tenantId: string;
  domainId: string;
  partyId: string;
  authUserId: string;
  requestedRole: RequestedRole;
}): Promise<void> {
  const role = input.requestedRole === "subplatform_admin" ? "admin" : input.requestedRole;
  await authDatabase.query(
    `INSERT INTO marketplace_subplatform_memberships
       (tenant_id, domain_id, party_id, role, labels, status, approved_at, approved_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY['better-auth:member'], 'active', clock_timestamp(), $5)
     ON CONFLICT (tenant_id, domain_id, party_id) DO UPDATE
       SET role = CASE
                    WHEN marketplace_subplatform_memberships.role = 'admin' OR EXCLUDED.role = 'admin'
                      THEN 'admin'
                    WHEN marketplace_subplatform_memberships.role = EXCLUDED.role
                      THEN EXCLUDED.role
                    ELSE 'both'
                  END,
           labels = ARRAY['better-auth:member'],
           status = 'active',
           approved_at = COALESCE(marketplace_subplatform_memberships.approved_at, clock_timestamp()),
           approved_by = COALESCE(marketplace_subplatform_memberships.approved_by, EXCLUDED.approved_by),
           version = marketplace_subplatform_memberships.version + 1,
           updated_at = clock_timestamp()`,
    [input.tenantId, input.domainId, input.partyId, role, input.authUserId],
  );
}

async function recordPlatformAuditEvent(input: {
  tenantId: string;
  domainId: string | null;
  platformPath: string;
  actorAuthUserId: string | null;
  actorPartyId: string;
  eventType: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
}): Promise<void> {
  const requestId = input.requestId?.trim();
  await authDatabase.query(
    `INSERT INTO platform_audit_events
       (id, tenant_id, domain_id, platform_path, actor_auth_user_id, actor_party_id,
        event_type, outcome, request_id, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
             $7, 'success', $8, $9::jsonb)`,
    [
      randomUUID(),
      input.tenantId,
      input.domainId,
      input.platformPath,
      input.actorAuthUserId,
      input.actorPartyId,
      input.eventType,
      requestId && requestId.length <= 200 ? requestId : null,
      JSON.stringify(input.metadata),
    ],
  );
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

/** Read the Better Auth member projection without requiring a root-domain cookie. */
async function readOrganizationMembershipByScope(
  tenantId: string,
  domainId: string | undefined,
  slug: string,
  userId: string,
): Promise<{ role: string } | null> {
  const result = await authDatabase.query<{ role: string }>(
    `SELECT m.role
       FROM "member" m
       JOIN "organization" o ON o.id = m."organizationId"
       JOIN subplatform_registrations r ON r.slug = o.slug
                                            AND r.tenant_id = $1::uuid
                                            AND r.domain_id = $2::uuid
                                            AND r.state = 'active'
      WHERE o.slug = $3
        AND o."tenantId" = $1::text
        AND o."domainId" = $2::text
        AND m."userId" = $4::uuid
      ORDER BY r.version DESC
      LIMIT 1`,
    [tenantId, domainId, slug, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Public buyer/seller access is a one-account SSO flow: the first authenticated visit claims a
 * member projection for the active child platform. Admin roles never use this path and still
 * require an explicit owner/admin invitation.
 */
async function claimPublicSubplatformMembership(
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
        AND o."tenantId" = $2::text
        AND ($3::uuid IS NULL OR o."domainId" = $3::text)
        AND r.state = 'active'
        AND r.membership_policy = 'public'
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
  return readOrganizationMembershipByScope(tenantId, domainId, slug, userId);
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
