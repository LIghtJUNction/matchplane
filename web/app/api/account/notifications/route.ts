import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import {
  RequestBodyTooLargeError,
  readJsonBody,
} from "../../../../src/lib/body-limit";
import { jsonError as sharedJsonError } from "../../../../src/lib/json-error";
import { hasTrustedBrowserOrigin } from "../../../../src/lib/request-origin";
import { authenticatedUserId } from "../../../../src/lib/session";
import { isUuid } from "../../../../src/lib/uuid";

function jsonError(
  error: string,
  status: number,
  headers: Record<string, string> = {},
): NextResponse {
  return sharedJsonError(error, status, {
    "cache-control": "private, no-store",
    ...headers,
  });
}

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  actionPath: string;
  createdAt: string;
  read: boolean;
}

export async function GET(request: Request): Promise<Response> {
  const userId = await authenticatedUserId(
    request,
    "notification session verification failed",
  );
  if (userId === "unavailable") return jsonError("通知服务暂时不可用", 503);
  if (!userId) return jsonError("请先登录", 401);
  let requestedLimit = 20;
  try {
    requestedLimit = Number(
      new URL(request.url).searchParams.get("limit") ?? 20,
    );
  } catch {
    return jsonError("请求地址无效", 400);
  }
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 50)
    : 20;
  try {
    const [items, unread] = await Promise.all([
      authDatabase.query<NotificationRow>(
        `SELECT id::text,
                kind,
                title,
                body,
                action_path AS "actionPath",
                created_at::text AS "createdAt",
                (read_at IS NOT NULL) AS read
           FROM user_notifications
          WHERE recipient_auth_user_id = $1::uuid
            AND archived_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [userId, limit],
      ),
      authDatabase.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM user_notifications
          WHERE recipient_auth_user_id = $1::uuid
            AND read_at IS NULL
            AND archived_at IS NULL`,
        [userId],
      ),
    ]);
    return NextResponse.json(
      {
        notifications: items.rows,
        unreadCount: Number(unread.rows[0]?.count ?? 0),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("notification feed failed", error);
    return jsonError("通知读取失败", 500);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源不可信", 403);
  const userId = await authenticatedUserId(
    request,
    "notification session verification failed",
  );
  if (userId === "unavailable") return jsonError("通知服务暂时不可用", 503);
  if (!userId) return jsonError("请先登录", 401);

  let input: { id?: unknown; all?: unknown };
  try {
    const value = await readJsonBody(request, 8 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be an object");
    }
    input = value;
  } catch (error) {
    return jsonError(
      error instanceof RequestBodyTooLargeError
        ? "请求体不能超过 8 KiB"
        : "请求必须是有效 JSON",
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    );
  }
  const markAll = input.all === true;
  const id =
    typeof input.id === "string" && isUuid(input.id)
      ? input.id
      : null;
  if (!markAll && !id) return jsonError("通知编号无效", 400);

  try {
    await authDatabase.query(
      markAll
        ? `UPDATE user_notifications
              SET read_at = COALESCE(read_at, clock_timestamp())
            WHERE recipient_auth_user_id = $1::uuid
              AND read_at IS NULL
              AND archived_at IS NULL`
        : `UPDATE user_notifications
              SET read_at = COALESCE(read_at, clock_timestamp())
            WHERE recipient_auth_user_id = $1::uuid
              AND id = $2::uuid
              AND archived_at IS NULL`,
      markAll ? [userId] : [userId, id],
    );
    const unread = await authDatabase.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM user_notifications
        WHERE recipient_auth_user_id = $1::uuid
          AND read_at IS NULL
          AND archived_at IS NULL`,
      [userId],
    );
    return NextResponse.json(
      { ok: true, unreadCount: Number(unread.rows[0]?.count ?? 0) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("notification read update failed", error);
    return jsonError("通知状态保存失败", 500);
  }
}
