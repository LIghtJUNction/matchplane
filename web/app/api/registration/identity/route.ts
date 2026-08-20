import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Registration has one Better Auth identity per email.  A verified identity can
 * join another platform or the other marketplace side after it proves its
 * password; it must never be created again just because the user opened a new
 * platform's registration page.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return failure("请求来源未被平台信任", 403);

  let email = "";
  try {
    const body = await readJsonBody<unknown>(request, 8 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure("请求必须是对象", 400);
    const value = (body as { email?: unknown }).email;
    email = typeof value === "string" ? value.trim().toLowerCase() : "";
  } catch (cause) {
    return failure(
      cause instanceof RequestBodyTooLargeError ? "请求过大" : "请求必须是有效 JSON",
      cause instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  if (!isEmail(email)) return failure("请输入有效的邮箱地址", 400);

  try {
    const result = await authDatabase.query<{ emailVerified: boolean }>(
      `SELECT "emailVerified"
         FROM "user"
        WHERE lower(email) = $1
        LIMIT 1`,
      [email],
    );
    const user = result.rows[0];
    // Do not return an id, profile, role, or any platform membership data. The
    // browser only needs to choose a safe next step for the email it supplied.
    return NextResponse.json(
      { state: !user ? "new" : user.emailVerified ? "existing" : "pending_verification" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("registration identity lookup failed", error);
    return failure("注册状态暂时不可用", 503);
  }
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function failure(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
