import { NextResponse } from "next/server";

import { auth } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";

export const runtime = "nodejs";

type RequestedRole = "buyer" | "seller" | "subplatform_admin";

interface SessionRequest {
  tenantId?: string;
  domainId?: string;
  subplatform?: string;
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

  const membership = await readOrganizationMembership(request, input.subplatform, session.user.id);
  const rootSuperAdmin = session.user.role === "rootSuperAdmin";
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
  } else if (!rootSuperAdmin && !membership) {
    return NextResponse.json(
      { error: "请先通过 Better Auth 组织邀请或认领流程加入当前子平台" },
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
          party_id: session.user.id,
          tenant_id: input.tenantId,
          external_key: `better-auth:${session.user.id}:${input.tenantId}`,
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
