import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../src/lib/auth";
import { isUuid, jsonError, requireFederationAdmin } from "../../../../../src/federation-admin";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List only the public operational projection of remote platform bindings. */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  const result = await authDatabase.query(
    `SELECT b.id::text, b.invite_id::text AS "inviteId", b.organization_id::text AS "organizationId",
            b.registration_id::text AS "registrationId", b.node_id::text AS "nodeId", b.slug,
            b.display_name AS "displayName", b.endpoint, b.mcp_server_key AS "mcpServerKey",
            b.token_env AS "tokenEnv", b.status, b.last_health_at AS "lastHealthAt",
            b.last_error AS "lastError", encode(b.manifest_digest, 'hex') AS "manifestDigest",
            b.created_at AS "createdAt", b.activated_at AS "activatedAt",
            r.state AS "registrationState"
       FROM platform_federation_bindings b
       LEFT JOIN subplatform_registrations r ON r.id = b.registration_id
      WHERE b.tenant_id = $1::uuid
      ORDER BY b.created_at DESC
      LIMIT 200`,
    [guard.admin.rootTenantId],
  );
  return NextResponse.json({ bindings: result.rows }, { headers: { "cache-control": "no-store" } });
}

/** Revoke a remote node and disable its local routing projection; reactivation needs a new invite. */
export async function PATCH(request: Request): Promise<Response> {
  const guard = await requireFederationAdmin(request);
  if (guard.response) return guard.response;
  let body: BindingRequest;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("object required");
    body = value as BindingRequest;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError ? "联邦绑定请求过大" : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (!isUuid(body.bindingId)) return jsonError("bindingId 必须是 UUID", 400);
  if (body.status !== "revoked") return jsonError("当前只支持将联邦绑定撤销", 400);
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE platform_federation_bindings
          SET status = 'revoked', last_error = 'revoked by root administrator', updated_at = clock_timestamp()
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'revoked'
        RETURNING id::text, registration_id::text AS "registrationId", status`,
      [body.bindingId, guard.admin.rootTenantId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return jsonError("联邦绑定不存在或已经撤销", 404);
    }
    await client.query(
      `UPDATE subplatform_registrations
          SET state = 'disabled', version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1::uuid AND state = 'active'`,
      [result.rows[0].registrationId],
    );
    await client.query("COMMIT");
    return NextResponse.json({ ...result.rows[0], routing: "disabled" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("federation binding revocation failed", error);
    return jsonError("联邦绑定撤销失败", 409);
  } finally {
    client.release();
  }
}

interface BindingRequest {
  bindingId?: unknown;
  status?: unknown;
}
