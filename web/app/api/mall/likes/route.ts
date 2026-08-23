import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../src/lib/auth";

interface LikeStateRow {
  offerId: string;
  viewerLikeCount: number;
  likeTotal: string;
}

export async function GET(request: Request): Promise<Response> {
  const userId = await authenticatedUserId(request);
  if (userId === "unavailable") return jsonError("点赞服务暂时不可用", 503);
  if (!userId) return jsonError("请先登录", 401);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未初始化", 503);

  let rawOfferIds = "";
  try {
    rawOfferIds = new URL(request.url).searchParams.get("offerIds") ?? "";
  } catch {
    return jsonError("请求地址无效", 400);
  }
  const offerIds = Array.from(
    new Set(
      rawOfferIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  if (
    !offerIds.length ||
    offerIds.length > 48 ||
    offerIds.some((offerId) => !UUID_PATTERN.test(offerId))
  ) {
    return jsonError("商品编号必须为 1 到 48 个 UUID", 400);
  }

  try {
    const result = await authDatabase.query<LikeStateRow>(
      `WITH requested AS (
         SELECT unnest($3::uuid[]) AS id
       )
       SELECT offer.id::text AS "offerId",
              COALESCE(viewer.like_count, 0)::int AS "viewerLikeCount",
              COALESCE(total.like_total, 0)::text AS "likeTotal"
         FROM requested
         JOIN marketplace_offers offer
           ON offer.tenant_id = $1::uuid
          AND offer.id = requested.id
          AND offer.status = 'active'
          AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
         JOIN stores store
           ON store.tenant_id = offer.tenant_id
          AND store.id = offer.store_id
          AND store.status = 'active'
          AND store.visibility = 'public'
         LEFT JOIN marketplace_offer_likes viewer
           ON viewer.tenant_id = offer.tenant_id
          AND viewer.offer_id = offer.id
          AND viewer.auth_user_id = $2::uuid
         LEFT JOIN LATERAL (
           SELECT sum(row.like_count) AS like_total
             FROM marketplace_offer_likes row
            WHERE row.tenant_id = offer.tenant_id
              AND row.offer_id = offer.id
         ) total ON true
        ORDER BY offer.id`,
      [tenantId, userId, offerIds],
    );
    return NextResponse.json(
      { likes: result.rows },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error("marketplace like state failed", error);
    return jsonError("点赞状态读取失败", 500);
  }
}

async function authenticatedUserId(
  request: Request,
): Promise<string | null | "unavailable"> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    return typeof session?.user?.id === "string" &&
      UUID_PATTERN.test(session.user.id)
      ? session.user.id
      : null;
  } catch (error) {
    console.error("like session verification failed", error);
    return "unavailable";
  }
}

function configuredTenantId(): string | null {
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim() ?? "";
  return UUID_PATTERN.test(tenantId) ? tenantId : null;
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json(
    { error },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
