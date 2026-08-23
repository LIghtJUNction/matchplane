import type { PoolClient } from "pg";
import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../src/lib/auth";
import {
  RequestBodyTooLargeError,
  readJsonBody,
} from "../../../../../../src/lib/body-limit";
import { jsonError as sharedJsonError } from "../../../../../../src/lib/json-error";
import { hasTrustedBrowserOrigin } from "../../../../../../src/lib/request-origin";
import { authenticatedUserId } from "../../../../../../src/lib/session";
import { configuredTenantId } from "../../../../../../src/lib/store-access";
import { notifyPartyUsers } from "../../../../../../src/lib/user-notifications";
import { isUuid } from "../../../../../../src/lib/uuid";

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

interface PublicOfferRow {
  supplyPartyId: string;
  displayName: string;
  storePath: string;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request))
    return jsonError("请求来源不可信", 403);
  const userId = await authenticatedUserId(
    request,
    "like session verification failed",
  );
  if (userId === "unavailable") return jsonError("点赞服务暂时不可用", 503);
  if (!userId) return jsonError("请先登录", 401);
  const { offerId } = await context.params;
  if (!isUuid(offerId)) return jsonError("商品编号无效", 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("商城尚未初始化", 503);

  let input: { count?: unknown; expectedCount?: unknown };
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
  const count = typeof input.count === "number" ? input.count : Number.NaN;
  const expectedCount =
    typeof input.expectedCount === "number" ? input.expectedCount : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0 || count > 5) {
    return jsonError("每件商品最多点赞 5 次", 400);
  }
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > 5
  ) {
    return jsonError("当前点赞次数无效", 400);
  }

  let client: PoolClient | undefined;
  try {
    client = await authDatabase.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${tenantId}:${offerId}:${userId}`],
    );
    const offerResult = await client.query<PublicOfferRow>(
      `SELECT offer.supply_party_id::text AS "supplyPartyId",
              offer.display_name AS "displayName",
              alias.path AS "storePath"
         FROM marketplace_offers offer
         JOIN stores store
           ON store.tenant_id = offer.tenant_id
          AND store.id = offer.store_id
          AND store.status = 'active'
          AND store.visibility = 'public'
         JOIN store_path_aliases alias
           ON alias.tenant_id = store.tenant_id
          AND alias.store_id = store.id
          AND alias.is_canonical = true
        WHERE offer.tenant_id = $1::uuid
          AND offer.id = $2::uuid
          AND offer.status = 'active'
          AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
        LIMIT 1`,
      [tenantId, offerId],
    );
    const offer = offerResult.rows[0];
    if (!offer) {
      await client.query("ROLLBACK");
      return jsonError("商品不存在", 404);
    }
    const currentResult = await client.query<{ likeCount: number }>(
      `SELECT like_count::int AS "likeCount"
         FROM marketplace_offer_likes
        WHERE tenant_id = $1::uuid
          AND offer_id = $2::uuid
          AND auth_user_id = $3::uuid
        FOR UPDATE`,
      [tenantId, offerId, userId],
    );
    const currentCount = currentResult.rows[0]?.likeCount ?? 0;
    if (currentCount !== expectedCount) {
      const likeTotal = await readLikeTotal(client, tenantId, offerId);
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error: "点赞状态已更新",
          offerId,
          viewerLikeCount: currentCount,
          likeTotal,
        },
        { status: 409, headers: { "cache-control": "private, no-store" } },
      );
    }
    if (count === 0) {
      await client.query(
        `DELETE FROM marketplace_offer_likes
          WHERE tenant_id = $1::uuid
            AND offer_id = $2::uuid
            AND auth_user_id = $3::uuid`,
        [tenantId, offerId, userId],
      );
    } else {
      await client.query(
        `INSERT INTO marketplace_offer_likes
           (tenant_id, offer_id, auth_user_id, like_count)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
         ON CONFLICT (tenant_id, offer_id, auth_user_id)
         DO UPDATE SET like_count = EXCLUDED.like_count`,
        [tenantId, offerId, userId, count],
      );
    }
    const likeTotal = await readLikeTotal(client, tenantId, offerId);
    await client.query("COMMIT");

    if (count > currentCount) {
      await notifyPartyUsers({
        tenantId,
        partyId: offer.supplyPartyId,
        kind: "offer_liked",
        sourceType: "marketplace_offer_like",
        sourceId: `${offerId}:${userId}`,
        title: "商品收到新的赞",
        body: offer.displayName,
        platformPath: offer.storePath,
        actionPath: `${offer.storePath}?console=products&offer=${encodeURIComponent(offerId)}`,
        payload: { offerId, likeTotal },
        excludeAuthUserId: userId,
      }).catch((error) => console.error("like notification failed", error));
    }

    return NextResponse.json(
      { offerId, viewerLikeCount: count, likeTotal },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("marketplace like mutation failed", error);
    return jsonError("点赞失败", 500);
  } finally {
    client?.release();
  }
}

async function readLikeTotal(
  client: PoolClient,
  tenantId: string,
  offerId: string,
): Promise<string> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(like_count), 0)::text AS total
       FROM marketplace_offer_likes
      WHERE tenant_id = $1::uuid AND offer_id = $2::uuid`,
    [tenantId, offerId],
  );
  return result.rows[0]?.total ?? "0";
}
