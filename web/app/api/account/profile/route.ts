import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { jsonError } from "../../../../src/lib/json-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The account owner can read and change their own non-contact profile only. */
export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  const profile = await readProfile(session.user.id);
  return profile
    ? NextResponse.json({ profile }, { headers: { "cache-control": "no-store" } })
    : jsonError("账号不存在", 404);
}

export async function PATCH(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  let input: { bio?: unknown };
  try {
    input = await readJsonBody(request, 16 * 1024) as typeof input;
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "个人简介不能超过 500 个字符" : "请求必须是有效 JSON", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  if (typeof input.bio !== "string") return jsonError("个人简介必须是文本", 400);
  const bio = input.bio.trim();
  if (bio.length > 500) return jsonError("个人简介不能超过 500 个字符", 400);
  const result = await authDatabase.query(
    `UPDATE "user"
        SET bio = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1::uuid`,
    [session.user.id, bio],
  );
  if (result.rowCount !== 1) return jsonError("账号不存在", 404);
  const profile = await readProfile(session.user.id);
  return profile
    ? NextResponse.json({ profile }, { headers: { "cache-control": "no-store" } })
    : jsonError("账号不存在", 404);
}

async function readProfile(userId: string): Promise<{ name: string; email: string; image: string | null; bio: string } | null> {
  const result = await authDatabase.query<{ name: string; email: string; image: string | null; bio: string }>(
    `SELECT name, email, image, bio FROM "user" WHERE id = $1::uuid LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

