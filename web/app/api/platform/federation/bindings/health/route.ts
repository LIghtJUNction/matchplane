import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import { isUuid, jsonError, requireFederationAdmin } from "../../../../../../src/federation-admin";
import { probeSubplatformMcpEndpoint, resolveSubplatformMcpEndpointForHealth } from "../../../../../../src/platform-agent-tool";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../../src/lib/body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Perform an explicit MCP initialize probe and persist the operational health state. */
export async function POST(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  let body: HealthRequest;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
    body = value as HealthRequest;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "联邦健康检查请求过大" : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (!isUuid(body.bindingId)) return jsonError("bindingId 必须是 UUID", 400);
  const binding = await authDatabase.query<{ id: string; mcpServerKey: string; status: string }>(
    `SELECT id::text, mcp_server_key AS "mcpServerKey", status
       FROM platform_federation_bindings
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [body.bindingId, guard.admin.rootTenantId],
  );
  const row = binding.rows[0];
  if (!row) return jsonError("联邦绑定不存在", 404);
  if (row.status === "revoked") return jsonError("已撤销的联邦绑定不能探测", 409);
  // A degraded binding must remain probeable so a recovered remote service can return to active;
  // the normal child-tool resolver still rejects every non-active binding.
  const endpoint = await resolveSubplatformMcpEndpointForHealth(row.mcpServerKey);
  const probe = endpoint
    ? await probeSubplatformMcpEndpoint({ endpoint })
    : { ok: false, status: 503, error: "MCP endpoint 或 tokenEnv 尚未配置" };
  const result = await authDatabase.query(
    `UPDATE platform_federation_bindings
        SET status = $3,
            last_health_at = clock_timestamp(),
            last_error = $4,
            updated_at = clock_timestamp()
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'revoked'
      RETURNING id::text, status, last_health_at AS "lastHealthAt", last_error AS "lastError"`,
    [body.bindingId, guard.admin.rootTenantId, probe.ok ? "active" : "degraded", probe.error ?? null],
  );
  if (result.rowCount !== 1) return jsonError("联邦绑定已被撤销", 409);
  return NextResponse.json({ ...result.rows[0], probe }, { headers: { "cache-control": "no-store" } });
}

interface HealthRequest { bindingId?: unknown }
