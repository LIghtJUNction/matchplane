import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);
  const result = await authDatabase.query<{ name: string; slug: string; version: string }>(
    `SELECT name, slug, version::text FROM tenants WHERE id = $1::uuid AND status = 'active' LIMIT 1`,
    [tenantId],
  );
  const mall = result.rows[0];
  return mall
    ? NextResponse.json({ mall: { ...mall, version: Number(mall.version) } }, { headers: { "cache-control": "no-store" } })
    : jsonError("商城不存在", 404);
}

export async function PATCH(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  if ((session.user as { role?: unknown }).role !== "rootSuperAdmin") {
    return jsonError("只有商城负责人可以修改商城名称", 403);
  }
  let input: { name?: unknown; expectedVersion?: unknown };
  try {
    input = await readJsonBody(request, 16 * 1024) as typeof input;
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "请求体不能超过 16 KiB" : "请求必须是有效 JSON", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const expectedVersion = typeof input.expectedVersion === "number" && Number.isSafeInteger(input.expectedVersion)
    ? input.expectedVersion
    : null;
  if (!name || name.length > 200) return jsonError("商城名称必须为 1 到 200 个字符", 400);
  if (!expectedVersion || expectedVersion < 1) return jsonError("expectedVersion 必须是正整数", 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未完成初始化", 503);

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    const current = await client.query<{ name: string }>(
      `SELECT name FROM tenants WHERE id = $1::uuid FOR UPDATE`,
      [tenantId],
    );
    const updated = await client.query<{ name: string; slug: string; version: string }>(
      `UPDATE tenants
          SET name = $2, version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1::uuid AND version = $3::bigint AND status = 'active'
        RETURNING name, slug, version::text`,
      [tenantId, name, expectedVersion],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return jsonError("商城名称已被其他人更新，请刷新后重试", 409);
    }
    await client.query(
      `UPDATE "organization" SET name = $2
        WHERE "tenantId" = $1 AND "rootPlatform" = true AND "parentOrganizationId" IS NULL`,
      [tenantId, name],
    );
    await client.query(
      `INSERT INTO platform_audit_events
        (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, '/', $3::uuid, 'mall.settings.name.updated', 'success', $4::jsonb)`,
      [randomUUID(), tenantId, session.user.id, JSON.stringify({ previous_name: current.rows[0]?.name ?? null, name })],
    );
    await client.query("COMMIT");
    const mall = updated.rows[0];
    return NextResponse.json({ mall: { ...mall, version: Number(mall.version) } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("mall settings update failed", error);
    return jsonError("商城名称保存失败", 500);
  } finally {
    client?.release();
  }
}

function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
