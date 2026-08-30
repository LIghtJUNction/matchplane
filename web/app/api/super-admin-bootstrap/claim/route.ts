import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import {
  readJsonBody,
  RequestBodyTooLargeError,
} from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { isProductionEnvironment } from "../../../../src/lib/runtime";
import {
  SUPER_ADMIN_BOOTSTRAP_COOKIE,
  SUPER_ADMIN_BOOTSTRAP_COOKIE_TTL_SECONDS,
  superAdminBootstrapDigest,
} from "../../../../src/lib/super-admin-bootstrap";
import { isUuid } from "../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reserve a CLI-issued first-super-admin link for exactly one registration email. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被平台信任", 403);
  let body: Record<string, unknown>;
  try {
    const value = await readJsonBody<unknown>(request, 16 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return error("请求必须是对象", 400);
    body = value as Record<string, unknown>;
  } catch (cause) {
    return error(
      cause instanceof RequestBodyTooLargeError
        ? "请求过大"
        : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const token =
    typeof body.token === "string" && /^mpsa_[0-9a-f]{64}$/.test(body.token)
      ? body.token
      : null;
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!token || !isEmail(email))
    return error("超级管理员注册链接无效或已过期", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!isUuid(tenantId)) return error("root tenant 尚未配置", 503);

  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user" WHERE role = 'rootSuperAdmin'`,
    );
    if (Number(existing.rows[0]?.count ?? "0") > 0) {
      await client.query("ROLLBACK");
      return error("超级管理员已经存在，注册链接不再可用", 409);
    }
    const inviteResult = await client.query<{
      target_email: string | null;
      registration_email: string | null;
    }>(
      `SELECT target_email, registration_email
         FROM root_superadmin_invites
        WHERE tenant_id = $1::uuid
          AND token_hash = $2
          AND used_at IS NULL
          AND expires_at > clock_timestamp()
        FOR UPDATE`,
      [tenantId, superAdminBootstrapDigest(token)],
    );
    const invite = inviteResult.rows[0];
    if (
      !invite ||
      (invite.target_email && invite.target_email.toLowerCase() !== email)
    ) {
      await client.query("ROLLBACK");
      return error("超级管理员注册链接无效或已过期", 410);
    }
    if (
      invite.registration_email &&
      invite.registration_email.toLowerCase() !== email
    ) {
      await client.query("ROLLBACK");
      return error("注册链接已绑定到其他邮箱", 409);
    }
    await client.query(
      `UPDATE root_superadmin_invites
          SET registration_email = $2
        WHERE tenant_id = $1::uuid AND used_at IS NULL`,
      [tenantId, email],
    );
    await client.query("COMMIT");
    const response = NextResponse.json(
      { claimed: true },
      { headers: { "cache-control": "no-store" } },
    );
    // The reservation email is guessable. Bind its privilege-bearing signup to the browser
    // that proved possession of the CLI token instead of promoting whichever account races to
    // register that email first.
    response.cookies.set({
      name: SUPER_ADMIN_BOOTSTRAP_COOKIE,
      // Keep the database's one-way token hash from becoming a pass-the-hash credential.
      // The short-lived HttpOnly cookie carries the original bearer only to Better Auth.
      value: token,
      httpOnly: true,
      sameSite: "strict",
      secure: isProductionEnvironment(),
      path: "/api/auth",
      maxAge: SUPER_ADMIN_BOOTSTRAP_COOKIE_TTL_SECONDS,
    });
    return response;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return error("超级管理员注册链接暂时不可用", 503);
  } finally {
    client.release();
  }
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
