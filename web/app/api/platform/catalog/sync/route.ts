import { NextResponse } from "next/server";

import { readJsonBody, RequestBodyTooLargeError } from "../../../../../src/lib/body-limit";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { parseCatalogSyncRequest } from "../../../../../src/catalog-protocol";
import { syncCanonicalMarketplaceOffer } from "../../../../../src/catalog-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sync a canonical root offer into the active child-owned catalog adapter. */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(request, 128 * 1024);
  } catch (error) {
    return jsonError(error instanceof RequestBodyTooLargeError ? "catalog sync 请求过大" : "catalog sync 必须是有效 JSON", error instanceof RequestBodyTooLargeError ? 413 : 400);
  }
  const parsed = parseCatalogSyncRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const outcome = await syncCanonicalMarketplaceOffer({
    request,
    offerId: parsed.value.offerId,
    tenantId: parsed.value.tenantId,
    requested: { domainId: parsed.value.domainId, platformPath: parsed.value.platformPath },
  });
  if (!outcome.ok && outcome.status >= 400 && outcome.status !== 503) {
    return NextResponse.json({ ...outcome.payload, offer_id: outcome.offerId, synced: false }, { status: outcome.status });
  }
  return NextResponse.json({ ...outcome.payload, offer_id: outcome.offerId, synced: outcome.synced, platform_path: outcome.platformPath }, {
    status: outcome.ok ? 200 : 202,
    headers: { "cache-control": "no-store" },
  });
}

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
