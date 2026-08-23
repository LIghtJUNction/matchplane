import { NextResponse } from "next/server";

import { authDatabase } from "../../../../../../../src/lib/auth";
import {
  readJsonBody,
  readResponseTextBody,
} from "../../../../../../../src/lib/body-limit";
import { loadInternalBearer } from "../../../../../../../src/lib/internal-auth";
import { jsonError } from "../../../../../../../src/lib/json-error";
import { requireRootManager } from "../../../../../../../src/lib/session";
import { configuredTenantId } from "../../../../../../../src/lib/store-access";
import { notifyPartyUsers } from "../../../../../../../src/lib/user-notifications";
import { syncCanonicalMarketplaceOffer } from "../../../../../../../src/catalog-sync";
import { validateStorefrontPublication } from "../../../../../../../src/storefront-publication";
import { isUuid } from "../../../../../../../src/lib/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Activate one generic offer through the Rust gateway's operator boundary.
 *
 * The web admin session authorizes the action, but it never receives the gateway bearer.  The
 * Rust storage layer remains the authority for the draft -> active state transition and its
 * audit/invariant checks.
 */
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
    return jsonError("供给审核请求必须是有效 JSON", 400);
  }
  if (body.tenant_id !== undefined && body.tenant_id !== tenantId) {
    return jsonError("供给审核只能访问当前根平台 tenant", 403);
  }
  const expectedVersion = Number(body.expected_version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return jsonError("expected_version 必须是正整数", 400);
  }

  const publication = await readPublicationCandidate(tenantId, offerId).catch(
    (error) => {
      console.error("storefront publication validation failed", error);
      return null;
    },
  );
  if (!publication) return jsonError("商品不存在或审核资料暂时不可用", 404);
  if (publication.version !== expectedVersion) {
    return jsonError("商品已被店铺更新，请重新读取后再审核", 409);
  }
  const validation = validateStorefrontPublication(publication);
  if (!validation.ok) return jsonError(validation.error, 409);

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
      `${process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8080"}/v1/admin/marketplace/offers/${encodeURIComponent(offerId)}/activate`,
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
    console.error("marketplace offer activation bridge unavailable", error);
    return jsonError("网关审核服务暂时不可用", 503);
  }

  const responseText = await readResponseTextBody(upstream, 256 * 1024).catch(
    () => null,
  );
  if (responseText === null)
    return jsonError("网关审核服务返回内容过大或无效", 502);
  if (!upstream.ok) {
    return new Response(responseText, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  // Activation is authoritative in Rust.  The optional child index is synchronized only after
  // the state transition; a missing/degraded adapter is reported explicitly and never turns a
  // draft into an unverified buyer result.
  let activated: Record<string, unknown>;
  try {
    const parsed = JSON.parse(responseText) as unknown;
    activated =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return new Response(responseText, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  }
  const sync = await syncCanonicalMarketplaceOffer({
    request,
    offerId,
    tenantId,
  });
  if (validation.hostedMediaIds.length) {
    await authDatabase.query(
      `UPDATE hosted_store_media media
          SET status = 'published'
         FROM marketplace_offers offer
        WHERE offer.tenant_id = $1::uuid
          AND offer.id = $2::uuid
          AND offer.status = 'active'
          AND media.tenant_id = offer.tenant_id
          AND media.store_id = offer.store_id
          AND media.id = ANY($3::uuid[])
          AND media.status IN ('pending', 'published')`,
      [tenantId, offerId, validation.hostedMediaIds],
    );
  }
  activated.catalog_sync = {
    synced: sync.synced,
    platform_path: sync.platformPath,
    ...(sync.synced
      ? {}
      : { error: readError(sync.payload) ?? "子平台目录尚未同步" }),
  };
  await notifyPartyUsers({
    tenantId,
    partyId: publication.supplyPartyId,
    kind: "offer_activated",
    sourceType: "marketplace_offer",
    sourceId: `${offerId}:${expectedVersion}`,
    title: "商品已通过审核",
    body: publication.displayName,
    platformPath: publication.storePath,
    actionPath: `${publication.storePath}?console=products&offer=${encodeURIComponent(offerId)}`,
    payload: { offerId },
  }).catch((error) =>
    console.error("offer activation notification failed", error),
  );
  return NextResponse.json(activated, {
    status: upstream.status,
    headers: { "cache-control": "no-store" },
  });
}

async function readPublicationCandidate(tenantId: string, offerId: string) {
  const result = await authDatabase.query<{
    storeId: string | null;
    storeStatus: string | null;
    storeVisibility: string | null;
    integrationKind: string | null;
    domainMatches: boolean;
    displayName: string;
    supplyPartyId: string;
    storePath: string;
    attributes: unknown;
    terms: unknown;
    availableHostedMediaIds: string[];
    version: number;
  }>(
    `SELECT offer.store_id::text AS "storeId",
            store.status AS "storeStatus",
            store.visibility AS "storeVisibility",
            store.integration_kind AS "integrationKind",
            (store.domain_id = offer.domain_id) AS "domainMatches",
            offer.display_name AS "displayName",
            offer.supply_party_id::text AS "supplyPartyId",
            alias.path AS "storePath",
            offer.attributes,
            offer.terms,
            offer.version,
            COALESCE(array_agg(media.id::text) FILTER (WHERE media.id IS NOT NULL), '{}') AS "availableHostedMediaIds"
       FROM marketplace_offers offer
       LEFT JOIN stores store
         ON store.tenant_id = offer.tenant_id AND store.id = offer.store_id
       LEFT JOIN hosted_store_media media
         ON media.tenant_id = store.tenant_id
        AND media.store_id = store.id
        AND media.status IN ('pending', 'published')
       LEFT JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
      WHERE offer.tenant_id = $1::uuid
        AND offer.id = $2::uuid
        AND offer.status IN ('draft', 'withdrawn')
      GROUP BY offer.id, store.id, alias.path`,
    [tenantId, offerId],
  );
  const row = result.rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}


function readError(payload: Record<string, unknown>): string | null {
  return typeof payload.error === "string" && payload.error.length <= 500
    ? payload.error
    : null;
}
