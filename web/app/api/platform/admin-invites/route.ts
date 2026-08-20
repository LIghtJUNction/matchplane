import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A root super administrator can issue a one-time, email-bound root-admin registration link. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return error("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("需要登录", 401);
  if ((session.user as { role?: string | null }).role !== "rootSuperAdmin") return error("只有超级管理员可以创建平台管理员邀请", 403);
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) return error("请求必须是对象", 400);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(cause instanceof RequestBodyTooLargeError ? "请求过大" : "请求必须是有效 JSON", cause instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const expiresHours = typeof body.expiresHours === "number" && Number.isInteger(body.expiresHours) ? body.expiresHours : 24;
  if (!isEmail(email) || !(1 <= expiresHours && expiresHours <= 168)) return error("邮箱或邀请有效期无效", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!isUuid(tenantId)) return error("root tenant 尚未配置", 503);
  const organization = await authDatabase.query<{ id: string }>(
    `SELECT id::text FROM "organization"
      WHERE "tenantId" = $1 AND "rootPlatform" = true
      ORDER BY "createdAt" ASC LIMIT 1`,
    [tenantId],
  );
  const organizationId = organization.rows[0]?.id;
  if (!organizationId) return error("根平台组织尚未建立", 409);
  const token = `mpa_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000);
  try {
    await authDatabase.query(
      `INSERT INTO platform_admin_invites
         (id, token_hash, organization_id, role, created_by, target_email, expires_at)
       VALUES ($1::uuid, $2, $3::uuid, 'rootAdmin', $4, $5, $6)`,
      [randomUUID(), digest(token), organizationId, session.user.id, email, expiresAt],
    );
  } catch {
    return error("平台管理员邀请创建失败", 503);
  }
  const baseUrl = configuredPublicOrigin();
  if (!baseUrl) return error("平台公开地址尚未配置", 503);
  const next = encodeURIComponent("/?role=platform");
  return NextResponse.json({
    email,
    expiresAt: expiresAt.toISOString(),
    registrationUrl: `${baseUrl}/admin/register?token=${token}&next=${next}`,
  }, { headers: { "cache-control": "no-store" } });
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isEmail(value: string): boolean { return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value); }
function error(message: string, status: number): Response { return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } }); }

function configuredPublicOrigin(): string | null {
  const value = process.env.BETTER_AUTH_URL?.trim() || process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
