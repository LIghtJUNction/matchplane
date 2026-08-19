import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the root tenant's generic offer queue for the platform workspace.
 *
 * This is deliberately a control-plane read.  The root never interprets `attributes` or
 * `terms`; the active subplatform owns those fields and renders them in its own moderation UI.
 * The route is kept separate from the party-scoped offer API so a seller can never inspect a
 * different seller's draft records.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await requireRootManager(request);
  if (guard) return guard;
  const tenantId = configuredTenantId();
  if (!tenantId) return jsonError("根平台 tenant 尚未配置", 503);

  const query = new URL(request.url).searchParams;
  const domainId = query.get("domain_id")?.trim() || null;
  if (domainId && !isUuid(domainId)) return jsonError("domain_id 必须是 UUID", 400);
  const status = query.get("status")?.trim() || null;
  if (status && !OFFER_STATUSES.has(status)) return jsonError("status 不是受支持的供给状态", 400);
  const parsedLimit = Number.parseInt(query.get("limit") ?? "50", 10);
  const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;

  const result = await authDatabase.query<MarketplaceOfferAdminRow>(
    `SELECT id::text AS offer_id,
            tenant_id::text AS tenant_id,
            domain_id::text AS domain_id,
            supply_party_id::text AS supply_party_id,
            asset_id::text AS asset_id,
            external_key,
            display_name,
            attributes,
            terms,
            status,
            published_at,
            expires_at,
            version,
            created_at,
            updated_at
       FROM marketplace_offers
      WHERE tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR domain_id = $2::uuid)
        AND ($3::text IS NULL OR status = $3::text)
      ORDER BY updated_at DESC, id DESC
      LIMIT $4`,
    [tenantId, domainId, status, limit],
  );

  return NextResponse.json({ offers: result.rows }, {
    headers: { "cache-control": "no-store" },
  });
}

interface MarketplaceOfferAdminRow {
  offer_id: string;
  tenant_id: string;
  domain_id: string;
  supply_party_id: string;
  asset_id: string | null;
  external_key: string;
  display_name: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
  status: string;
  published_at: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const OFFER_STATUSES = new Set(["draft", "active", "reserved", "sold", "withdrawn", "expired"]);

async function requireRootManager(request: Request): Promise<Response | null> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return jsonError("只有根平台管理员可以审核供给", 403);
  }
  return null;
}

function configuredTenantId(): string | null {
  const value = process.env.MATCHPLANE_ROOT_TENANT_ID?.trim();
  return value && isUuid(value) ? value : null;
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
