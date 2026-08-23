import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import {
  isUuid,
  jsonError,
  requireFederationAdmin,
  validateFederationParent,
} from "../../../../../src/federation-admin";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../../src/lib/body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issue a one-time token for a remote platform's signed enrollment document. */
export async function POST(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  let body: InviteRequest;
  try {
    const value = await readJsonBody<unknown>(request, 32 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SyntaxError("object required");
    body = value as InviteRequest;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "联邦邀请请求过大"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const domainId = typeof body.domainId === "string" ? body.domainId : "";
  if (!isUuid(domainId)) return jsonError("domainId 必须是 UUID", 400);
  const requestedParentOrganizationId =
    typeof body.parentOrganizationId === "string" && body.parentOrganizationId
      ? body.parentOrganizationId
      : null;
  const parentOrganizationId = await readRootOrganizationId(
    guard.admin.rootTenantId,
  );
  if (!parentOrganizationId || !isUuid(parentOrganizationId)) {
    return jsonError("商城初始化完成后即可邀请外部店铺", 409);
  }
  if (
    requestedParentOrganizationId &&
    requestedParentOrganizationId !== parentOrganizationId
  ) {
    return jsonError("外部店铺只能直接接入商城，不能嵌套在其他店铺中", 400);
  }
  const parentError = await validateFederationParent(
    guard.admin.rootTenantId,
    parentOrganizationId,
    domainId,
  );
  if (parentError) return jsonError(parentError, 400);
  const expiresInHours = boundedInteger(body.expiresInHours, 24, 1, 168);
  const token = `mpf_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const inviteId = randomUUID();
  const result = await authDatabase.query(
    `INSERT INTO platform_federation_invites
       (id, tenant_id, parent_organization_id, domain_id, token_hash, expires_at, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, decode($5, 'hex'),
             clock_timestamp() + make_interval(hours => $6::int), $7)
     RETURNING id::text, expires_at AS "expiresAt"`,
    [
      inviteId,
      guard.admin.rootTenantId,
      parentOrganizationId,
      domainId,
      tokenHash,
      expiresInHours,
      guard.admin.userId,
    ],
  );
  const expiresAt = result.rows[0]?.expiresAt;
  const baseUrl = normalizeBaseUrl(
    process.env.BETTER_AUTH_URL?.trim() ||
      process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
      "http://localhost:4173",
  );
  return NextResponse.json(
    {
      inviteId,
      parentOrganizationId,
      domainId,
      expiresAt,
      enrollmentToken: token,
      enrollmentUrl: `${baseUrl}/api/platform/federation/enroll`,
      secretHandling:
        "enrollmentToken 只在本次响应返回；交给远端平台管理员后不要写入仓库或日志。",
    },
    {
      status: 201,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    },
  );
}

/** List invite and binding state without returning any token or secret. */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  const [invites, bindings] = await Promise.all([
    authDatabase.query(
      `SELECT id::text, parent_organization_id::text AS "parentOrganizationId", domain_id::text AS "domainId",
              expires_at AS "expiresAt", used_at AS "usedAt", used_by_node_id::text AS "usedByNodeId", created_at AS "createdAt"
         FROM platform_federation_invites
        WHERE tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 100`,
      [guard.admin.rootTenantId],
    ),
    authDatabase.query(
      `SELECT id::text, invite_id::text AS "inviteId", organization_id::text AS "organizationId",
              registration_id::text AS "registrationId", node_id::text AS "nodeId", slug, display_name AS "displayName",
              endpoint, mcp_server_key AS "mcpServerKey", token_env AS "tokenEnv", status,
              last_health_at AS "lastHealthAt", last_error AS "lastError", created_at AS "createdAt", activated_at AS "activatedAt"
         FROM platform_federation_bindings
        WHERE tenant_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 100`,
      [guard.admin.rootTenantId],
    ),
  ]);
  return NextResponse.json(
    { invites: invites.rows, bindings: bindings.rows },
    { headers: { "cache-control": "no-store" } },
  );
}

interface InviteRequest {
  domainId?: unknown;
  parentOrganizationId?: unknown;
  expiresInHours?: unknown;
}

async function readRootOrganizationId(
  tenantId: string,
): Promise<string | null> {
  const result = await authDatabase.query<{ id: string }>(
    `SELECT id::text FROM "organization"
      WHERE "tenantId" = $1 AND "rootPlatform" = true AND "parentOrganizationId" IS NULL
      LIMIT 1`,
    [tenantId],
  );
  return result.rows[0]?.id ?? null;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "localhost")
      )
    ) {
      return "http://localhost:4173";
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:4173";
  }
}
