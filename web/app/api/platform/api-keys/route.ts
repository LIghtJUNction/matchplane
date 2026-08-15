import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";

const MAX_KEY_TTL_SECONDS = 365 * 24 * 60 * 60;
const allowedPermissions: Record<string, readonly string[]> = {
  platform: ["read", "configure", "manage_children", "manage_api_keys"],
  retrieval: ["query", "write"],
  marketplace: ["read", "write", "moderate", "publish"],
  agent: ["handoff"],
};

/**
 * Platform-facing convenience endpoint around Better Auth's organization API-key plugin.
 * Better Auth remains the key owner, hasher, verifier, rate limiter, and revocation authority.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });

  const input = await parseBody(request);
  if (!input.organizationId || !isUuid(input.organizationId)) {
    return NextResponse.json({ error: "organizationId must be a UUID" }, { status: 400 });
  }
  if (!input.name || input.name.trim().length < 1 || input.name.trim().length > 32) {
    return NextResponse.json({ error: "name must contain 1..=32 characters" }, { status: 400 });
  }
  if (input.expiresIn !== undefined &&
      (!Number.isInteger(input.expiresIn) || input.expiresIn < 24 * 60 * 60 || input.expiresIn > MAX_KEY_TTL_SECONDS)) {
    return NextResponse.json({ error: "expiresIn must be between one day and one year" }, { status: 400 });
  }

  const userRole = (session.user as { role?: string }).role;
  const globalManager = userRole === "rootSuperAdmin" || userRole === "rootAdmin";
  let organization = await readOrganization(request, input.organizationId);
  if (!organization && globalManager) {
    try {
      await auth.api.addMember({
        body: { organizationId: input.organizationId, userId: session.user.id, role: "admin" },
      });
      organization = await readOrganization(request, input.organizationId);
    } catch (error) {
      console.error("root manager membership projection failed", error);
    }
  }
  if (!organization) return NextResponse.json({ error: "platform organization not found" }, { status: 404 });
  const member = organization.members?.find((candidate) => candidate.userId === session.user.id);
  const scopedManager = member?.role
    .split(",")
    .some((role) => role === "owner" || role === "admin" || role === "subplatform_admin");
  if (!globalManager && !scopedManager) {
    return NextResponse.json({ error: "平台管理员权限不足" }, { status: 403 });
  }

  const permissions = normalizePermissions(input.permissions);
  if (permissions === null) {
    return NextResponse.json({ error: "permissions contains an unsupported action" }, { status: 400 });
  }
  if (input.agentRole !== undefined && !isAgentRole(input.agentRole)) {
    return NextResponse.json({ error: "agentRole must be buyer, seller, or both" }, { status: 400 });
  }
  if (input.agentRole !== undefined && !permissions?.marketplace?.includes("write")) {
    return NextResponse.json({ error: "agentRole requires marketplace:write permission" }, { status: 400 });
  }

  try {
    // Deliberately omit request headers: this is a server-only Better Auth call, so explicit
    // permissions and the already verified user ID stay on the server.
    const created = await auth.api.createApiKey({
      body: {
        configId: "platform",
        organizationId: input.organizationId,
        userId: session.user.id,
        name: input.name.trim(),
        expiresIn: input.expiresIn ?? null,
        permissions: permissions ?? undefined,
        metadata: {
          platformId: input.organizationId,
          audience: "platform",
          issuedBy: session.user.id,
          description: input.description?.trim().slice(0, 500) ?? null,
          agentRole: input.agentRole ?? null,
        },
      },
    });
    return NextResponse.json(created, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("platform API key creation failed", error);
    return NextResponse.json({ error: "API Key 创建失败；请确认你是该平台的成员管理员" }, { status: 403 });
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });
  const organizationId = new URL(request.url).searchParams.get("organizationId");
  if (!organizationId || !isUuid(organizationId)) {
    return NextResponse.json({ error: "organizationId must be a UUID" }, { status: 400 });
  }
  const userRole = (session.user as { role?: string }).role;
  const globalManager = userRole === "rootSuperAdmin" || userRole === "rootAdmin";
  let organization = await readOrganization(request, organizationId);
  if (!organization && globalManager) {
    try {
      await auth.api.addMember({
        body: { organizationId, userId: session.user.id, role: "admin" },
      });
      organization = await readOrganization(request, organizationId);
    } catch (error) {
      console.error("root manager membership projection failed", error);
    }
  }
  const member = organization?.members?.find((candidate) => candidate.userId === session.user.id);
  const scopedManager = member?.role
    .split(",")
    .some((role) => role === "owner" || role === "admin" || role === "subplatform_admin");
  if (!organization || (!globalManager && !scopedManager)) {
    return NextResponse.json({ error: "平台管理员权限不足" }, { status: 403 });
  }
  try {
    const result = await auth.api.listApiKeys({
      query: { configId: "platform", organizationId, limit: 100, offset: 0 },
      headers: request.headers,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("platform API key listing failed", error);
    return NextResponse.json({ error: "API Key 列表读取失败" }, { status: 403 });
  }
}

interface ApiKeyRequest {
  organizationId?: string;
  name?: string;
  description?: string;
  expiresIn?: number;
  permissions?: Record<string, string[]>;
  /** Optional least-privilege role for the external buyer/seller Agent capability exchange. */
  agentRole?: "buyer" | "seller" | "both";
}

async function parseBody(request: Request): Promise<ApiKeyRequest> {
  try {
    const body = (await request.json()) as ApiKeyRequest;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function readOrganization(
  request: Request,
  organizationId: string,
): Promise<{ members?: Array<{ userId: string; role: string }> } | null> {
  try {
    const organization = await auth.api.getFullOrganization({
      query: { organizationId, membersLimit: 1000 },
      headers: request.headers,
    });
    return organization as { members?: Array<{ userId: string; role: string }> };
  } catch {
    return null;
  }
}

function normalizePermissions(
  permissions: Record<string, string[]> | undefined,
): Record<string, string[]> | null | undefined {
  if (!permissions) return undefined;
  if (typeof permissions !== "object" || Array.isArray(permissions)) return null;
  const normalized: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(permissions)) {
    const allowed = allowedPermissions[resource];
    if (!allowed || !Array.isArray(actions) || actions.length === 0) return null;
    const unique = [...new Set(actions)];
    if (unique.some((action) => !allowed.includes(action))) return null;
    normalized[resource] = unique;
  }
  return normalized;
}

function isAgentRole(value: unknown): value is NonNullable<ApiKeyRequest["agentRole"]> {
  return value === "buyer" || value === "seller" || value === "both";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
