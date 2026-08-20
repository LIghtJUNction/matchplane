import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../../../src/lib/auth";
import { readJsonBody, readResponseTextBody } from "../../../../../../../src/lib/body-limit";
import { loadInternalBearer } from "../../../../../../../src/lib/internal-auth";
import { hasTrustedBrowserOrigin } from "../../../../../../../src/lib/request-origin";
import { syncCanonicalMarketplaceOffer } from "../../../../../../../src/catalog-sync";
import { validateStorefrontPublication } from "../../../../../../../src/storefront-publication";

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
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return jsonError("当前账号没有商城商品审核权限", 403);
  }

  const { offerId } = await context.params;
  if (!isUuid(offerId)) return jsonError("offerId 必须是 UUID", 400);
  const tenantId = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (!tenantId || !isUuid(tenantId)) return jsonError("根平台 tenant 尚未配置", 503);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await readJsonBody<unknown>(request, 32 * 1024);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonError("供给审核请求必须是有效 JSON", 400);
  }
  if (body.tenant_id !== undefined && body.tenant_id !== tenantId) {
    return jsonError("供给审核只能访问当前根平台 tenant", 403);
  }

  const publication = await readPublicationCandidate(tenantId, offerId).catch((error) => {
    console.error("storefront publication validation failed", error);
    return null;
  });
  if (!publication) return jsonError("商品不存在或审核资料暂时不可用", 404);
  const validation = validateStorefrontPublication(publication);
  if (!validation.ok) return jsonError(validation.error, 409);

  let bearer: string;
  try {
    bearer = await loadInternalBearer("MATCHPLANE_GATEWAY_ADMIN_TOKEN", "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE");
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
        body: JSON.stringify({ tenant_id: tenantId }),
        cache: "no-store",
      },
    );
  } catch (error) {
    console.error("marketplace offer activation bridge unavailable", error);
    return jsonError("网关审核服务暂时不可用", 503);
  }

  const responseText = await readResponseTextBody(upstream, 256 * 1024).catch(() => null);
  if (responseText === null) return jsonError("网关审核服务返回内容过大或无效", 502);
  if (!upstream.ok) {
    return new Response(responseText, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
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
    activated = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return new Response(responseText, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  const sync = await syncCanonicalMarketplaceOffer({ request, offerId, tenantId });
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
    ...(sync.synced ? {} : { error: readError(sync.payload) ?? "子平台目录尚未同步" }),
  };
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
    attributes: unknown;
    terms: unknown;
    availableHostedMediaIds: string[];
  }>(
    `SELECT offer.store_id::text AS "storeId",
            store.status AS "storeStatus",
            store.visibility AS "storeVisibility",
            store.integration_kind AS "integrationKind",
            (store.domain_id = offer.domain_id) AS "domainMatches",
            offer.display_name AS "displayName",
            offer.attributes,
            offer.terms,
            COALESCE(array_agg(media.id::text) FILTER (WHERE media.id IS NOT NULL), '{}') AS "availableHostedMediaIds"
       FROM marketplace_offers offer
       LEFT JOIN stores store
         ON store.tenant_id = offer.tenant_id AND store.id = offer.store_id
       LEFT JOIN hosted_store_media media
         ON media.tenant_id = store.tenant_id
        AND media.store_id = store.id
        AND media.status IN ('pending', 'published')
      WHERE offer.tenant_id = $1::uuid
        AND offer.id = $2::uuid
        AND offer.status IN ('draft', 'withdrawn')
      GROUP BY offer.id, store.id`,
    [tenantId, offerId],
  );
  return result.rows[0] ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function readError(payload: Record<string, unknown>): string | null {
  return typeof payload.error === "string" && payload.error.length <= 500 ? payload.error : null;
}
