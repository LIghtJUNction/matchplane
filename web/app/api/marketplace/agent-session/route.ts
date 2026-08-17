import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { loadInternalBearer } from "../../../../src/lib/internal-auth";
import { isMountedPlatformPath, isPlatformPathAccessibleByOrganization, readActivePlatformScope } from "../../../../src/platform-mount";
import { isAgentKeyRole, isAgentKeySide, keyCanActAsNeutralSide, keyCanActAsSide, parseAgentSessionRequest, stableAgentPrincipalId } from "../../../../src/platform-agent-session";
import { verifyPlatformApiKey } from "../../../../src/lib/platform-api-key";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { isProductionEnvironment } from "../../../../src/lib/runtime";

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
  const configuredSide = apiKey.metadata?.agentSide;
  if (configuredSide !== undefined && configuredSide !== null && !isAgentKeySide(configuredSide)) {
    return NextResponse.json({ error: "API Key 的 agentSide 无效，请重新签发" }, { status: 403 });
  }
  const legacySide = isAgentKeyRole(configuredRole)
    ? (configuredRole === "both" ? "both" : configuredRole === "buyer" ? "demand" : "supply")
    : null;
  if (isAgentKeySide(configuredSide) && legacySide && configuredSide !== legacySide) {
    return NextResponse.json({ error: "API Key 的 agentSide 与兼容字段 agentRole 不一致，请重新签发" }, { status: 403 });
  }
  const keySide = isAgentKeySide(configuredSide) ? configuredSide : legacySide;
  if (!keySide) {
    return NextResponse.json(
      { error: "该 API Key 尚未绑定 agentSide；请为 demand/supply Agent 创建最小权限 Key" },
      { status: 403 },
    );
  }

  let requestBody: unknown;
  try {
    requestBody = await readJsonBody<unknown>(request, 128 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "Agent 会话请求过大" : "请求必须是有效 JSON" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const parsed = parseAgentSessionRequest(requestBody);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.value;
  if (!(isAgentKeySide(configuredSide) ? keyCanActAsNeutralSide(keySide, input.side) : keyCanActAsSide(configuredRole as "buyer" | "seller" | "both", input.side))) {
    return NextResponse.json({ error: "API Key 的 agentSide 不允许当前 marketplace side" }, { status: 403 });
  }
  if (!(await isMountedPlatformPath(input.platformPath))) {
    return NextResponse.json({ error: "平台路径尚未激活" }, { status: 404 });
  }
  if (!(await isPlatformPathAccessibleByOrganization(input.platformPath, apiKey.referenceId))) {
    return NextResponse.json({ error: "API Key 不能访问该平台节点" }, { status: 403 });
  }

  const resolvedScope = await readActivePlatformScope(input.platformPath);
  const scopeMatchesNode = input.platformPath === "/"
    ? await isActiveRootScope(input.tenantId, input.domainId)
    : await isActiveChildScope(input.platformPath, input.tenantId, input.domainId);
  if (
    (isProductionEnvironment()
      && input.platformPath !== "/"
      && (!resolvedScope || resolvedScope.tenantId !== input.tenantId || resolvedScope.domainId !== input.domainId))
    || !scopeMatchesNode
  ) {
    return NextResponse.json({ error: "tenant/domain 与 API Key 的激活平台路径不匹配" }, { status: 403 });
  }

  const principalId = stableAgentPrincipalId(apiKey.id, input.tenantId);
  const existingMembership = await readMachineMembershipStatus(input.tenantId, input.domainId, principalId);
  if (existingMembership && existingMembership !== "active") {
    return NextResponse.json({ error: "该 Agent 成员已被管理员停用；请重新授权后再交换 capability" }, { status: 403 });
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
          auth_user_id: principalId,
          tenant_id: input.tenantId,
          domain_id: input.domainId,
          platform_path: input.platformPath,
          external_key: `better-auth-api-key:${apiKey.id}:${input.tenantId}:${input.platformPath}`,
          display_name: input.displayName,
          role: input.role,
          marketplace_sides: [input.side],
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

  const gatewayBody = (await gatewayResponse.json()) as {
    tenant_id: string;
    party_id: string;
    role: "buyer" | "seller" | "both";
    access_token: string;
    access_token_expires_at: string;
  };
  if (!isUuid(gatewayBody.party_id) || gatewayBody.tenant_id !== input.tenantId) {
    return NextResponse.json({ error: "撮合 Agent 会话服务返回了无效的平台身份" }, { status: 502 });
  }
  try {
    // Keep machine-agent authorization in the same Rust projection as human sessions.  The
    // Better Auth organization/API-key record remains the identity authority, while this row is
    // the gateway's revocation/checkpoint for the short-lived party capability.
    await upsertMachineMembershipProjection({
      tenantId: input.tenantId,
      domainId: input.domainId,
      partyId: gatewayBody.party_id,
      approvedBy: `api-key:${apiKey.id}`,
      role: input.role,
    });
    await recordMachineCapabilityAudit({
      tenantId: input.tenantId,
      domainId: input.domainId,
      platformPath: input.platformPath,
      partyId: gatewayBody.party_id,
      apiKeyId: apiKey.id,
      organizationId: apiKey.referenceId,
      requestId: request.headers.get("x-request-id"),
    });
  } catch (error) {
    console.error("machine marketplace membership projection/audit failed", error);
    return NextResponse.json(
      { error: "Agent 成员授权投影暂时不可用；未返回撮合 capability" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      tenant_id: gatewayBody.tenant_id,
      party_id: gatewayBody.party_id,
      role: gatewayBody.role,
      side: input.side,
      access_token: gatewayBody.access_token,
      access_token_expires_at: gatewayBody.access_token_expires_at,
      platform_path: input.platformPath,
      domain_id: input.domainId,
      cost_bearer: "caller",
      restrictions: [
        "capability is scoped to one platform path, domain, tenant, and role",
        "contact values are not included",
        "rotate the Better Auth API key to revoke future exchanges",
      ],
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function upsertMachineMembershipProjection(input: {
  tenantId: string;
  domainId: string;
  partyId: string;
  approvedBy: string;
  role: "buyer" | "seller";
}): Promise<void> {
  await authDatabase.query(
    `INSERT INTO marketplace_subplatform_memberships
       (tenant_id, domain_id, party_id, role, labels, status, approved_at, approved_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY['better-auth:api-key'], 'active', clock_timestamp(), $5)
     ON CONFLICT (tenant_id, domain_id, party_id) DO UPDATE
       SET role = CASE
                    WHEN marketplace_subplatform_memberships.role = 'admin' THEN 'admin'
                    WHEN marketplace_subplatform_memberships.role = EXCLUDED.role THEN EXCLUDED.role
                    ELSE 'both'
                  END,
           labels = ARRAY['better-auth:api-key'],
           status = marketplace_subplatform_memberships.status,
           approved_at = COALESCE(marketplace_subplatform_memberships.approved_at, clock_timestamp()),
           approved_by = EXCLUDED.approved_by,
           version = marketplace_subplatform_memberships.version + 1,
           updated_at = clock_timestamp()`,
    [input.tenantId, input.domainId, input.partyId, input.role, input.approvedBy],
  );
}

async function readMachineMembershipStatus(
  tenantId: string,
  domainId: string,
  partyId: string,
): Promise<string | null> {
  const result = await authDatabase.query<{ status: string }>(
    `SELECT status
       FROM marketplace_subplatform_memberships
      WHERE tenant_id = $1::uuid
        AND domain_id = $2::uuid
        AND party_id = $3::uuid
      LIMIT 1`,
    [tenantId, domainId, partyId],
  );
  return result.rows[0]?.status ?? null;
}

async function recordMachineCapabilityAudit(input: {
  tenantId: string;
  domainId: string;
  platformPath: string;
  partyId: string;
  apiKeyId: string;
  organizationId: string;
  requestId: string | null;
}): Promise<void> {
  const requestId = input.requestId?.trim();
  await authDatabase.query(
    `INSERT INTO platform_audit_events
       (id, tenant_id, domain_id, platform_path, actor_auth_user_id, actor_party_id,
        event_type, outcome, request_id, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, NULL, $5::uuid,
             'marketplace.agent_capability.issued', 'success', $6, $7::jsonb)`,
    [
      randomUUID(),
      input.tenantId,
      input.domainId,
      input.platformPath,
      input.partyId,
      requestId && requestId.length <= 200 ? requestId : null,
      JSON.stringify({
        identitySource: "better-auth-api-key",
        apiKeyId: input.apiKeyId,
        organizationId: input.organizationId,
        costBearer: "caller",
      }),
    ],
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
       JOIN domains d
         ON d.id = r.domain_id
        AND d.tenant_id = r.tenant_id
        AND d.status = 'active'
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

async function isActiveRootScope(tenantId: string, domainId: string): Promise<boolean> {
  const configuredRootTenant = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (isProductionEnvironment() && configuredRootTenant !== tenantId) return false;
  const result = await authDatabase.query(
    `SELECT 1
       FROM domains
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND status = 'active'
      LIMIT 1`,
    [tenantId, domainId],
  );
  return result.rowCount === 1;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
