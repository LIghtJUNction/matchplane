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
    `SELECT offer.id::text AS offer_id,
            offer.tenant_id::text AS tenant_id,
            offer.domain_id::text AS domain_id,
            offer.supply_party_id::text AS supply_party_id,
            offer.asset_id::text AS asset_id,
            offer.external_key,
            offer.display_name,
            offer.status,
            offer.published_at,
            offer.expires_at,
            offer.version,
            offer.created_at,
            offer.updated_at,
            offer.store_id::text,
            store.display_name AS store_name,
            alias.path AS store_path,
            offer.attributes,
            offer.terms
       FROM marketplace_offers offer
       LEFT JOIN stores store
         ON store.tenant_id = offer.tenant_id AND store.id = offer.store_id
       LEFT JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id AND alias.store_id = store.id AND alias.is_canonical = true
      WHERE offer.tenant_id = $1::uuid
        AND offer.store_id IS NOT NULL
        AND ($2::uuid IS NULL OR offer.domain_id = $2::uuid)
        AND ($3::text IS NULL OR offer.status = $3::text)
      ORDER BY offer.updated_at DESC, offer.id DESC
      LIMIT $4`,
    [tenantId, domainId, status, limit],
  );

  return NextResponse.json({ offers: result.rows.map(publicModerationRecord) }, {
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
  status: string;
  published_at: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  store_id: string | null;
  store_name: string | null;
  store_path: string | null;
  attributes: unknown;
  terms: unknown;
}

function publicModerationRecord(row: MarketplaceOfferAdminRow): Record<string, unknown> {
  const attributes = record(row.attributes);
  const terms = record(row.terms);
  return {
    offer_id: row.offer_id,
    tenant_id: row.tenant_id,
    domain_id: row.domain_id,
    supply_party_id: row.supply_party_id,
    asset_id: row.asset_id,
    external_key: row.external_key,
    display_name: row.display_name,
    status: row.status,
    published_at: row.published_at,
    expires_at: row.expires_at,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    store_id: row.store_id,
    store_name: row.store_name,
    store_path: row.store_path,
    description: boundedText(attributes.description, 4_000),
    image_url: firstSafeImage(attributes.attachments),
    amount_minor: integerText(terms.amount_minor),
    currency: typeof terms.currency === "string" && /^[A-Z]{3}$/.test(terms.currency) ? terms.currency : null,
    currency_scale: Number.isInteger(terms.currency_scale) && Number(terms.currency_scale) >= 0 && Number(terms.currency_scale) <= 18
      ? Number(terms.currency_scale)
      : null,
  };
}

function firstSafeImage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const attachment = record(item);
    if (attachment.kind !== "image") continue;
    const metadata = record(attachment.metadata);
    const candidate = typeof metadata.public_url === "string" ? metadata.public_url : null;
    if (!candidate || candidate.length > 2_048) continue;
    if (candidate.startsWith("/") && !candidate.startsWith("//") && !candidate.includes("\\")) return candidate;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
    } catch {
      // Keep searching for another safe image.
    }
  }
  return null;
}

function integerText(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,38}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const OFFER_STATUSES = new Set(["draft", "active", "reserved", "sold", "withdrawn", "expired"]);

async function requireRootManager(request: Request): Promise<Response | null> {
  if (!hasTrustedBrowserOrigin(request)) return jsonError("请求来源未被平台信任", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  const role = (session?.user as { role?: unknown } | undefined)?.role;
  if (!session || (role !== "rootSuperAdmin" && role !== "rootAdmin")) {
    return jsonError("当前账号没有商城商品审核权限", 403);
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
