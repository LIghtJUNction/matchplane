import { NextResponse } from "next/server";

import { authDatabase } from "../../../../src/lib/auth";
import { jsonError as sharedJsonError } from "../../../../src/lib/json-error";
import { authenticatedUserId } from "../../../../src/lib/session";
import { configuredTenantId } from "../../../../src/lib/store-access";
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

interface LikeStateRow {
  offerId: string;
  viewerLikeCount: number;
  likeTotal: string;
}

export async function GET(request: Request): Promise<Response> {
  const userId = await authenticatedUserId(
    request,
    "like session verification failed",
  );
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
    offerIds.some((offerId) => !isUuid(offerId))
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
