import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../../../src/lib/auth";
import {
  readJsonBody,
  readResponseTextBody,
} from "../../../../../../../src/lib/body-limit";
import { loadInternalBearer } from "../../../../../../../src/lib/internal-auth";
import { jsonError } from "../../../../../../../src/lib/json-error";
import { requireRootManager } from "../../../../../../../src/lib/session";
import { configuredTenantId } from "../../../../../../../src/lib/store-access";
import { notifyPartyUsers } from "../../../../../../../src/lib/user-notifications";
import { isUuid } from "../../../../../../../src/lib/uuid";
import { syncCanonicalMarketplaceOffer } from "../../../../../../../src/catalog-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject one draft offer through the Rust gateway's operator boundary. */
export async function POST(
  request: Request,
  context: { params: Promise<{ offerId: string }> },
): Promise<Response> {
  const denied = await requireRootManager(
    request,
    "当前账号没有商城商品审核权限",
  );
  if (denied) return denied;
  const { offerId } = await context.params;
  if (!isUuid(offerId)) return jsonError("offerId 必须是 UUID", 400);
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("根平台 tenant 尚未配置", 503);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await readJsonBody<unknown>(request, 32 * 1024);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("商品审核请求必须是有效 JSON", 400);
  }
  if (body.tenant_id !== undefined && body.tenant_id !== tenantId)
    return jsonError("商品审核只能访问当前根平台 tenant", 403);
  const expectedVersion = Number(body.expected_version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    return jsonError("expected_version 必须是正整数", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 2 || reason.length > 500)
    return jsonError("退回原因必须是 2 到 500 个字符", 400);

  const candidate = await readRejectionCandidate(tenantId, offerId).catch(
    (error) => {
      console.error("offer rejection candidate lookup failed", error);
      return null;
    },
  );
  if (!candidate) return jsonError("商品不存在或已经完成审核", 404);
  if (candidate.version !== expectedVersion)
    return jsonError("商品已被店铺更新，请重新读取后再审核", 409);

  let bearer: string;
  try {
    bearer = await loadInternalBearer(
      "MATCHPLANE_GATEWAY_ADMIN_TOKEN",
      "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE",
    );
  } catch {
    return jsonError("网关管理员密钥尚未配置", 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8080"}/v1/admin/marketplace/offers/${encodeURIComponent(offerId)}/reject`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          expected_version: expectedVersion,
        }),
        cache: "no-store",
      },
    );
  } catch (error) {
    console.error("marketplace offer rejection bridge unavailable", error);
    return jsonError("网关审核服务暂时不可用", 503);
  }

  const responseText = await readResponseTextBody(upstream, 256 * 1024).catch(
    () => null,
  );
  if (responseText === null)
    return jsonError("网关审核服务返回内容过大或无效", 502);
  if (!upstream.ok)
    return new Response(responseText, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });

  let rejected: Record<string, unknown>;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    rejected =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return jsonError("网关审核服务返回了无效 JSON", 502);
  }
  const sync = await syncCanonicalMarketplaceOffer({
    request,
    offerId,
    tenantId,
  });
  rejected.catalog_sync = {
    synced: sync.synced,
    platform_path: sync.platformPath,
  };
  rejected.review_reason = reason;

  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    await authDatabase
      .query(
        `INSERT INTO platform_audit_events
           (id, tenant_id, domain_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
                 'marketplace.offer.rejected', 'success',
                 jsonb_build_object('offer_id', $6::uuid, 'reason', $7, 'version', $8))`,
        [
          randomUUID(),
          tenantId,
          candidate.domainId,
          candidate.storePath,
          session.user.id,
          offerId,
          reason,
          expectedVersion,
        ],
      )
      .catch((error) => console.error("offer rejection audit failed", error));
  }
  await notifyPartyUsers({
    tenantId,
    partyId: candidate.supplyPartyId,
    kind: "offer_rejected",
    sourceType: "marketplace_offer",
    sourceId: `${offerId}:${expectedVersion}`,
    title: "商品需要修改",
    body: `${candidate.displayName}：${reason}`,
    platformPath: candidate.storePath,
    actionPath: `${candidate.storePath}?console=products&offer=${encodeURIComponent(offerId)}`,
    payload: { offerId, reason },
  }).catch((error) => console.error("offer rejection notification failed", error));

  return NextResponse.json(rejected, {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });
}

async function readRejectionCandidate(tenantId: string, offerId: string) {
  const result = await authDatabase.query<{
    displayName: string;
    domainId: string;
    supplyPartyId: string;
    storePath: string;
    version: number;
  }>(
    `SELECT offer.display_name AS "displayName",
            offer.domain_id::text AS "domainId",
            offer.supply_party_id::text AS "supplyPartyId",
            COALESCE(alias.path, '/') AS "storePath",
            offer.version
       FROM marketplace_offers offer
       LEFT JOIN stores store
         ON store.tenant_id = offer.tenant_id AND store.id = offer.store_id
       LEFT JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
      WHERE offer.tenant_id = $1::uuid
        AND offer.id = $2::uuid
        AND offer.status = 'draft'`,
    [tenantId, offerId],
  );
  const row = result.rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}
