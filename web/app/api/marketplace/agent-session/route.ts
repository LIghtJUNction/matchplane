import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";
import { isMountedPlatformPath, isPlatformPathAccessibleByOrganization } from "../../../../src/platform-mount";
import { isAgentKeyRole, keyCanActAs, parseAgentSessionRequest, stableAgentPrincipalId } from "../../../../src/platform-agent-session";
import { verifyPlatformApiKey } from "../../../../src/lib/platform-api-key";

export const runtime = "nodejs";

/**
 * Exchange an organization-owned Better Auth API key for a tenant-scoped, short-lived
 * marketplace party capability. This is the machine-Agent counterpart to the human session
 * bridge: the key remains the caller's identity, while the returned bearer is limited to one
 * platform tenant and one buyer/seller role.
 */
export async function POST(request: Request): Promise<Response> {
  const apiKey = await verifyPlatformApiKey(request, { marketplace: ["write"] });
  if (!apiKey || !isUuid(apiKey.referenceId)) {
    return NextResponse.json({ error: "Better Auth organization API key with marketplace:write is required" }, { status: 401 });
  }

  const configuredRole = apiKey.metadata?.agentRole;
  if (!isAgentKeyRole(configuredRole)) {
    return NextResponse.json(
      { error: "该 API Key 尚未绑定 agentRole；请分别为 buyer/seller Agent 创建最小权限 Key" },
      { status: 403 },
    );
  }

  const parsed = parseAgentSessionRequest(await parseJson(request));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;
  if (!keyCanActAs(configuredRole, input.role)) {
    return NextResponse.json({ error: "API Key 的 agentRole 不允许当前 buyer/seller 身份" }, { status: 403 });
  }
  if (!(await isMountedPlatformPath(input.platformPath))) {
    return NextResponse.json({ error: "平台路径尚未激活" }, { status: 404 });
  }
  if (!(await isPlatformPathAccessibleByOrganization(input.platformPath, apiKey.referenceId))) {
    return NextResponse.json({ error: "API Key 不能访问该平台节点" }, { status: 403 });
  }

  if (!(await isActiveChildScope(input.platformPath, input.tenantId, input.domainId))) {
    return NextResponse.json({ error: "tenant/domain 与 API Key 的激活平台路径不匹配" }, { status: 403 });
  }

  const principalId = stableAgentPrincipalId(apiKey.id, input.tenantId);
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
          auth_user_id: principalId,
          party_id: principalId,
          tenant_id: input.tenantId,
          external_key: `better-auth-api-key:${apiKey.id}:${input.tenantId}`,
          display_name: input.displayName,
          role: input.role,
          // Machine Agents do not receive a contact value from the exchange. Contact release
          // remains a separate, human-consented flow and is never inferred from API-key access.
          contact: {},
        }),
      },
    );
  } catch (error) {
    console.error("machine marketplace session bridge unavailable", error);
    return NextResponse.json({ error: "撮合 Agent 会话服务暂时不可用" }, { status: 503 });
  }
  if (!gatewayResponse.ok) {
    const message = await gatewayResponse.text();
    return NextResponse.json(
      { error: message || "machine marketplace session bridge failed" },
      { status: gatewayResponse.status >= 500 ? 502 : gatewayResponse.status },
    );
  }

  const body = (await gatewayResponse.json()) as {
    tenant_id: string;
    party_id: string;
    role: "buyer" | "seller" | "both";
    access_token: string;
  };
  return NextResponse.json(
    {
      tenant_id: body.tenant_id,
      party_id: body.party_id,
      role: body.role,
      access_token: body.access_token,
      platform_path: input.platformPath,
      domain_id: input.domainId,
      cost_bearer: "caller",
      restrictions: [
        "capability is scoped to one tenant and role",
        "contact values are not included",
        "rotate the Better Auth API key to revoke future exchanges",
      ],
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function isActiveChildScope(
  platformPath: string,
  tenantId: string,
  domainId: string,
): Promise<boolean> {
  const slug = platformPath.split("/").filter(Boolean).at(-1);
  if (!slug) return false;
  const result = await authDatabase.query(
    `SELECT r.slug
       FROM subplatform_registrations r
       JOIN "organization" o
         ON o.slug = r.slug
        AND o."tenantId" = r.tenant_id::text
      WHERE r.tenant_id = $1::uuid
        AND r.domain_id = $2::uuid
        AND r.slug = $3
        AND r.state = 'active'
      ORDER BY r.version DESC
      LIMIT 1`,
    [tenantId, domainId, slug],
  );
  return result.rowCount === 1;
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
