import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform membership control plane.
 *
 * Better Auth remains the authority for invitations, membership rows and role transitions. The
 * SQL lookup below only proves that the selected organization belongs to this deployment's root
 * tenant; it never reads or writes credentials. Root operators receive a normal Better Auth
 * membership projection before calling organization APIs, so the same authorization path works
 * for root and child platforms without a second account system.
 */
export async function GET(request: Request): Promise<Response> {
  const input = readOrganizationId(request);
  if (!input) return jsonError("organizationId 必须是 UUID", 400);
  const access = await requireOrganizationManager(request, input);
  if (access.response) return access.response;

  try {
    const [memberResult, invitationResult] = await Promise.all([
      auth.api.listMembers({
        query: { organizationId: input, limit: 1000, offset: 0 },
        headers: request.headers,
      }),
      auth.api.listInvitations({
        query: { organizationId: input },
        headers: request.headers,
      }),
    ]);
    return NextResponse.json(
      {
        organization: access.organization,
        members: memberResult.members.map(toPublicMember),
        invitations: invitationResult.map(toPublicInvitation),
        canAssignOwner: access.isRootSuperAdmin,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("platform membership listing failed", error);
    return jsonError("成员列表暂时不可用；请确认 Better Auth 迁移已完成", 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const input = await parseJson(request);
  const organizationId = readUuid(input.organizationId);
  if (!organizationId) return jsonError("organizationId 必须是 UUID", 400);
  const access = await requireOrganizationManager(request, organizationId);
  if (access.response) return access.response;

  const email = normalizeEmail(input.email);
  const role = normalizeOrganizationRole(input.role);
  if (!email) return jsonError("email 必须是有效地址", 400);
  if (!role) return jsonError("role 不属于当前组织的角色清单", 400);
  if (role === "owner" && !access.isRootSuperAdmin) {
    return jsonError("只有根超级管理员可以转移平台所有权", 403);
  }
  if (role === "owner" && await hasAnotherStoreOwner(organizationId)) {
    return jsonError("每家店铺只能有一位店长；请先完成店长交接", 409);
  }

  try {
    const invitation = await auth.api.createInvitation({
      body: {
        email,
        role,
        organizationId,
        resend: input.resend === true,
      },
      headers: request.headers,
    });
    return NextResponse.json(
      { invitation: toPublicInvitation(invitation) },
      { status: 201, headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  } catch (error) {
    console.error("platform membership invitation failed", error);
    return jsonError("邀请发送失败；请确认邮箱服务和 Better Auth 配置", 409);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const input = await parseJson(request);
  const organizationId = readUuid(input.organizationId);
  const memberId = readBoundedText(input.memberId, 128);
  const role = normalizeOrganizationRole(input.role);
  if (!organizationId) return jsonError("organizationId 必须是 UUID", 400);
  if (!memberId) return jsonError("memberId 无效", 400);
  if (!role) return jsonError("role 不属于当前组织的角色清单", 400);
  const access = await requireOrganizationManager(request, organizationId);
  if (access.response) return access.response;
  if (role === "owner" && !access.isRootSuperAdmin) {
    return jsonError("只有根超级管理员可以转移平台所有权", 403);
  }
  if (role === "owner" && await hasAnotherStoreOwner(organizationId, memberId)) {
    return jsonError("每家店铺只能有一位店长；请先完成店长交接", 409);
  }

  try {
    const result = await auth.api.updateMemberRole({
      body: { organizationId, memberId, role },
      headers: request.headers,
    });
    return NextResponse.json(
      { member: toPublicMember(result) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("platform member role update failed", error);
    return jsonError("成员权限更新失败；Better Auth 拒绝了这次角色变更", 403);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const input = await parseJson(request);
  const organizationId = readUuid(input.organizationId);
  const memberIdOrEmail = readBoundedText(input.memberIdOrEmail, 320);
  const invitationId = readBoundedText(input.invitationId, 128);
  if (!organizationId) return jsonError("organizationId 必须是 UUID", 400);
  if (!memberIdOrEmail && !invitationId) return jsonError("memberIdOrEmail 或 invitationId 必须提供一个", 400);
  const access = await requireOrganizationManager(request, organizationId);
  if (access.response) return access.response;

  try {
    if (invitationId) {
      if (!(await invitationBelongsToOrganization(invitationId, organizationId))) {
        return jsonError("邀请不属于当前平台", 404);
      }
      await auth.api.cancelInvitation({
        body: { invitationId },
        headers: request.headers,
      });
      return new Response(null, { status: 204 });
    }
    await auth.api.removeMember({
      body: { organizationId, memberIdOrEmail: memberIdOrEmail! },
      headers: request.headers,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("platform member removal failed", error);
    return jsonError("成员或邀请移除失败；请确认它属于当前平台", 403);
  }
}

interface OrganizationScope {
  id: string;
  name: string;
  slug: string;
  parentOrganizationId: string | null;
  tenantId: string;
  domainId: string | null;
}

interface AccessContext {
  organization: OrganizationScope;
  isRootSuperAdmin: boolean;
  response?: undefined;
}

interface PublicMember {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  user?: { id?: string; name?: string; email?: string; image?: string | null };
}

interface PublicInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

function toPublicMember(member: PublicMember) {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt,
    user: member.user
      ? {
          id: member.user.id ?? member.userId,
          name: member.user.name ?? "",
          email: member.user.email ?? "",
          ...(member.user.image ? { image: member.user.image } : {}),
        }
      : null,
  };
}

function toPublicInvitation(invitation: PublicInvitation) {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

async function requireOrganizationManager(
  request: Request,
  organizationId: string,
): Promise<AccessContext | { response: Response }> {
  if (!hasTrustedBrowserOrigin(request)) return { response: jsonError("请求来源未被平台信任", 403) };
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { response: jsonError("Better Auth session is required", 401) };

  const organization = await findOrganization(organizationId);
  if (!organization) return { response: jsonError("平台组织不存在或不属于当前 root tenant", 404) };

  const role = (session.user as { role?: unknown }).role;
  const isRootSuperAdmin = role === "rootSuperAdmin";
  const isRootManager = isRootSuperAdmin || role === "rootAdmin";
  if (isRootManager) {
    // Root administrators are global only inside this deployment's tree. Projecting them as a
    // normal organization admin lets Better Auth enforce invitation/member rules consistently.
    try {
      await auth.api.addMember({
        body: { organizationId, userId: session.user.id, role: "admin" },
      });
    } catch {
      // Existing membership and concurrent first access are both harmless; listMembers below is
      // the authoritative check and will return a precise Better Auth error if it still fails.
    }
    return { organization, isRootSuperAdmin };
  }

  try {
    const full = await auth.api.getFullOrganization({
      query: { organizationId, membersLimit: 1000 },
      headers: request.headers,
    });
    const member = full?.members?.find((candidate) => candidate.userId === session.user.id);
    const scopedManager = member?.role
      .split(",")
      .some((value) => value === "owner" || value === "admin" || value === "subplatform_admin");
    if (!scopedManager) return { response: jsonError("当前账号没有该平台的成员管理权限", 403) };
    return { organization, isRootSuperAdmin: false };
  } catch {
    return { response: jsonError("当前账号不是该平台的 Better Auth 成员", 403) };
  }
}

async function findOrganization(organizationId: string): Promise<OrganizationScope | null> {
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!tenantId || !isUuid(tenantId)) return null;
  const result = await authDatabase.query<OrganizationScope>(
    `SELECT id::text, name, slug, "parentOrganizationId"::text AS "parentOrganizationId",
            "tenantId" AS "tenantId", "domainId" AS "domainId"
       FROM "organization"
      WHERE id = $1::uuid AND "tenantId" = $2
      LIMIT 1`,
    [organizationId, tenantId],
  );
  return result.rows[0] ?? null;
}

/** A store has one accountable manager; legacy root organizations retain their existing owner model. */
async function hasAnotherStoreOwner(organizationId: string, excludeMemberId?: string): Promise<boolean> {
  const organization = await findOrganization(organizationId);
  if (!organization || organization.parentOrganizationId === null) return false;
  try {
    const result = await authDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "member"
        WHERE "organizationId" = $1::uuid
          AND ($2::uuid IS NULL OR id <> $2::uuid)
          AND 'owner' = ANY(string_to_array(role, ','))`,
      [organizationId, excludeMemberId ?? null],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10) > 0;
  } catch {
    // Failing closed avoids a second manager when the membership authority is unavailable.
    return true;
  }
}

async function invitationBelongsToOrganization(invitationId: string, organizationId: string): Promise<boolean> {
  const result = await authDatabase.query(
    `SELECT 1 FROM "invitation" WHERE id = $1 AND "organizationId" = $2 LIMIT 1`,
    [invitationId, organizationId],
  );
  return result.rowCount === 1;
}

function readOrganizationId(request: Request): string | null {
  return readUuid(new URL(request.url).searchParams.get("organizationId"));
}

async function parseJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

type OrganizationRole = "owner" | "admin" | "subplatform_admin" | "moderator" | "member";

function normalizeOrganizationRole(value: unknown): OrganizationRole | null {
  return value === "owner" || value === "admin" || value === "subplatform_admin" || value === "moderator" || value === "member"
    ? value
    : null;
}

function readBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

function readUuid(value: unknown): string | null {
  return typeof value === "string" && isUuid(value.trim()) ? value.trim() : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
