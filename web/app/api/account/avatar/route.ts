import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "../../../../src/lib/body-limit";
import { ManagedImageError, persistManagedImage, readManagedImage, removeManagedImage } from "../../../../src/lib/managed-image";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Private avatar delivery: profiles are not a public marketplace directory. */
export async function GET(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  const result = await authDatabase.query<{ key: string | null }>(
    `SELECT profile_avatar_key AS key FROM "user" WHERE id = $1::uuid LIMIT 1`,
    [session.user.id],
  );
  const bytes = await readManagedImage(result.rows[0]?.key ?? null, "profile");
  if (!bytes) return jsonError("头像尚未设置", 404);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(bytes.byteLength),
      "content-type": "image/webp",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被商城信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return jsonError("请先登录", 401);
  let input: { dataBase64?: unknown };
  try {
    input = await readJsonBody(request, 6 * 1024 * 1024) as typeof input;
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "头像图片不能超过 4 MiB" : "请求必须是有效 JSON", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  if (typeof input.dataBase64 !== "string") return jsonError("请上传有效的头像图片", 400);
  let image: { key: string };
  try {
    image = await persistManagedImage({ scope: "profile", ownerId: session.user.id, dataBase64: input.dataBase64 });
  } catch (error) {
    return jsonError(error instanceof ManagedImageError ? error.message : "头像保存失败", 400);
  }
  try {
    const updated = await authDatabase.query(
      `UPDATE "user"
          SET profile_avatar_key = $2, image = '/api/account/avatar', "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      [session.user.id, image.key],
    );
    if (updated.rowCount !== 1) {
      await removeManagedImage(image.key, "profile");
      return jsonError("账号不存在", 404);
    }
    return NextResponse.json({ image: `/api/account/avatar?v=${Date.now()}` }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    await removeManagedImage(image.key, "profile");
    console.error("profile avatar update failed", error);
    return jsonError("头像保存失败", 500);
  }
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
