import { createHash, randomBytes, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { requestOrigin } from "../../../../../src/lib/request-url";
import {
  isUuid,
  readStoreAccess,
  roleOf,
} from "../../../../../src/lib/store-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INVITES_PER_HOUR = 10;

/** Create a one-time link that lets one person join the store as an operator. */
export async function POST(
  request: Request,
  context: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return error("请求来源未被商城信任", 403);
  const { storeId } = await context.params;
  if (!isUuid(storeId)) return error("店铺编号无效", 400);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error("请先登录", 401);
  const access = await readStoreAccess(
    storeId,
    session.user.id,
    roleOf(session.user),
  );
  if (!access.store || !access.canManageStore)
    return error("只有店主或商城后台可以邀请店铺协作者", 403);

  const publicOrigin = configuredPublicOrigin(request);
  if (!publicOrigin)
    return error("商城公开地址尚未安全配置，暂时不能创建邀请链接", 503);

  const rawToken = `mpa_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  try {
    const inserted = await authDatabase.query<{ id: string }>(
      `INSERT INTO platform_admin_invites
        (id, token_hash, organization_id, role, created_by, expires_at, target_email)
       SELECT $1::uuid, $2, $3::uuid, 'subplatform_admin', $4, $5::timestamptz, NULL
       WHERE (
         SELECT count(*)
           FROM platform_admin_invites
          WHERE organization_id = $3::uuid
            AND created_by = $4
            AND created_at > clock_timestamp() - interval '1 hour'
       ) < $6
       RETURNING id::text`,
      [
        randomUUID(),
        digest(rawToken),
        access.store.organizationId,
        session.user.id,
        expiresAt,
        MAX_INVITES_PER_HOUR,
      ],
    );
    if (inserted.rowCount !== 1)
      return error("邀请链接创建过于频繁，请稍后再试", 429);
  } catch (cause) {
    console.error("store collaborator invite creation failed", cause);
    return error("邀请链接创建失败，请稍后重试", 500);
  }

  const registrationUrl = new URL("/admin/register", publicOrigin);
  registrationUrl.searchParams.set("token", rawToken);
  registrationUrl.searchParams.set(
    "next",
    `${access.store.path}?console=products`,
  );
  return NextResponse.json(
    {
      invite: {
        storeId,
        registrationUrl: registrationUrl.toString(),
        expiresAt,
      },
    },
    {
      status: 201,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredPublicOrigin(request: Request): string | null {
  const configured =
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim();
  const value =
    configured ||
    (process.env.NODE_ENV === "production"
      ? ""
      : (requestOrigin(request) ?? ""));
  if (!value) return null;
  try {
    const url = new URL(value);
    const localDevelopment =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !localDevelopment) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function error(message: string, status: number): Response {
  return NextResponse.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
