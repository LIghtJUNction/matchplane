import { authDatabase } from "./lib/auth";
import type { RecommendedBackendListing } from "./api";
import type { PublicStore } from "./store-directory";

interface PublicOfferRow {
  id: string;
  tenantId: string;
  domainId: string;
  displayName: string;
  attributes: unknown;
  terms: unknown;
  storeName: string;
  storeSlug: string;
  storePath: string;
  integrationKind: string;
  publishedAt: string | null;
}

const HOSTED_MEDIA_REFERENCE = /^media:\/\/hosted\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Read only active, store-owned product projections; no party or contact field is selected. */
export async function searchPublicStoreOffers(input: {
  stores: PublicStore[];
  narrative: string;
  limit?: number;
}): Promise<RecommendedBackendListing[]> {
  if (!input.stores.length) return [];
  const storeIds = input.stores.map((store) => store.id);
  const result = await authDatabase.query<PublicOfferRow>(
    `WITH ranked_offers AS (
       SELECT offer.id::text,
            offer.tenant_id::text AS "tenantId",
            offer.domain_id::text AS "domainId",
            offer.display_name AS "displayName",
            offer.attributes,
            offer.terms,
            store.display_name AS "storeName",
            store.slug AS "storeSlug",
            alias.path AS "storePath",
            store.integration_kind AS "integrationKind",
            offer.published_at::text AS "publishedAt",
            CASE WHEN length(trim($2::text)) = 0 THEN 0::real
                 ELSE ts_rank_cd(
                   to_tsvector('simple', offer.display_name || ' ' || coalesce(offer.attributes ->> 'description', '')),
                   websearch_to_tsquery('simple', $2::text)
                 ) END AS relevance,
            row_number() OVER (
              PARTITION BY store.id
              ORDER BY
                CASE WHEN length(trim($2::text)) = 0 THEN 0::real
                     ELSE ts_rank_cd(
                       to_tsvector('simple', offer.display_name || ' ' || coalesce(offer.attributes ->> 'description', '')),
                       websearch_to_tsquery('simple', $2::text)
                     ) END DESC,
                offer.published_at DESC NULLS LAST,
                offer.id
            ) AS store_rank
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
      WHERE offer.store_id = ANY($1::uuid[])
        AND offer.status = 'active'
        AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
    )
     SELECT id, "tenantId", "domainId", "displayName", attributes, terms,
            "storeName", "storeSlug", "storePath", "integrationKind", "publishedAt"
       FROM ranked_offers
      WHERE store_rank <= 100
      ORDER BY relevance DESC, "publishedAt" DESC NULLS LAST, id
      LIMIT 2000`,
    [storeIds, input.narrative.slice(0, 8_000)],
  );

  const maximum = Math.max(1, Math.min(48, input.limit ?? 24));
  return rankRows(result.rows, input.narrative).flatMap(({ row, score, overlapLabels }): RecommendedBackendListing[] => {
    const attributes = publicAttributes(row.attributes, row.integrationKind);
    const terms = publicTerms(row.terms);
    const imageUrl = firstPublicImageUrl(attributes.attachments);
    if (!text(attributes.description) || !imageUrl || !hasFixedPublicPrice(terms)) return [];
    return [{
      offer_id: row.id,
      tenant_id: row.tenantId,
      domain_id: row.domainId,
      display_name: row.displayName,
      attributes,
      terms,
      platform_path: row.storePath,
      subplatform: row.storeSlug,
      store_name: row.storeName,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      match_score: score,
      match_reasons: overlapLabels.length
        ? [`在${row.storeName}找到，名称或介绍与“${overlapLabels.slice(0, 4).join("、")}”相关`]
        : [`来自${row.storeName}的在售商品`],
      match_risks: [],
      status: "active",
    }];
  }).slice(0, maximum);
}

function rankRows(rows: PublicOfferRow[], narrative: string): Array<{
  row: PublicOfferRow;
  score: number;
  overlapLabels: string[];
}> {
  const queryTokens = tokenize(narrative);
  return rows.map((row, index) => {
    const attributes = record(row.attributes);
    const description = text(attributes.description);
    const haystackTokens = new Set(tokenize(`${row.displayName}\n${description}`));
    const overlapLabels = queryTokens.filter((token) => haystackTokens.has(token));
    const score = queryTokens.length
      ? Math.min(0.99, 0.45 + overlapLabels.length / Math.max(4, queryTokens.length))
      : 0.45;
    return { row, score, overlapLabels, index };
  }).sort((left, right) => (
    right.overlapLabels.length - left.overlapLabels.length
    || right.score - left.score
    || left.index - right.index
  ));
}

function publicAttributes(value: unknown, integrationKind: string): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  const description = text(source.description).slice(0, 4_000);
  if (description) result.description = description;
  for (const key of ["brand", "model", "category", "condition", "location"] as const) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim()) result[key] = candidate.trim().slice(0, 300);
    else if (typeof candidate === "number" && Number.isFinite(candidate)) result[key] = candidate;
  }
  const attachments = publicImageAttachments(source.attachments, integrationKind);
  if (attachments.length) result.attachments = attachments;
  return result;
}

function publicImageAttachments(value: unknown, integrationKind: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Record<string, unknown>[] => {
    const attachment = record(item);
    if (attachment.kind !== "image") return [];
    const hostedReference = typeof attachment.attachment_ref === "string"
      ? HOSTED_MEDIA_REFERENCE.exec(attachment.attachment_ref)
      : null;
    const publicUrl = integrationKind === "hosted"
      ? hostedReference ? `/api/store-media/${hostedReference[1].toLowerCase()}` : undefined
      : safePublicUrl(record(attachment.metadata).public_url);
    if (!publicUrl) return [];
    return [{
      kind: "image",
      file_name: text(attachment.file_name).slice(0, 255),
      media_type: text(attachment.media_type).slice(0, 255),
      public_url: publicUrl,
    }];
  }).slice(0, 8);
}

function publicTerms(value: unknown): Record<string, unknown> {
  const source = record(value);
  const amountMinor = unsignedIntegerString(source.amount_minor);
  const currency = typeof source.currency === "string" && /^[A-Z]{3}$/.test(source.currency)
    ? source.currency
    : null;
  const currencyScale = typeof source.currency_scale === "number"
    && Number.isSafeInteger(source.currency_scale)
    && source.currency_scale >= 0
    && source.currency_scale <= 18
    ? source.currency_scale
    : null;
  if (!amountMinor || BigInt(amountMinor) <= 0n || !currency || currencyScale === null) return {};
  return {
    pricing_mode: "fixed",
    amount_minor: amountMinor,
    currency,
    currency_scale: currencyScale,
  };
}

function hasFixedPublicPrice(terms: Record<string, unknown>): boolean {
  return terms.pricing_mode === "fixed"
    && typeof terms.amount_minor === "string"
    && typeof terms.currency === "string"
    && typeof terms.currency_scale === "number";
}

function unsignedIntegerString(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,38}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function firstPublicImageUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const url = safePublicUrl(record(item).public_url);
    if (url) return url;
  }
  return undefined;
}

function safePublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().slice(0, 8_000);
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [];
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]/g)].map(([character]) => character);
  return [...new Set([...words, ...cjk])].slice(0, 512);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
