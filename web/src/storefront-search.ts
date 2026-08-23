import { authDatabase } from "./lib/auth";
import type { RecommendedBackendListing } from "./api";
import type { PublicStore } from "./store-directory";
import {
  evaluateShoppingIntent,
  type PublicShoppingIntent,
} from "./shopping-intent";

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
  supplyFields: unknown;
  publishedAt: string | null;
  likeTotal?: string;
}

const HOSTED_MEDIA_REFERENCE =
  /^media:\/\/hosted\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export type PublicOfferSearchSort =
  | "relevance"
  | "latest"
  | "popularity"
  | "price_asc"
  | "price_desc";

export interface PublicOfferSearchInput {
  stores: PublicStore[];
  narrative: string;
  intent?: PublicShoppingIntent;
  storePaths?: string[];
  sort?: PublicOfferSearchSort;
  offset?: number;
  limit?: number;
}

export interface PublicOfferSearchPage {
  items: RecommendedBackendListing[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Read only active, store-owned product projections; no party or contact field is selected. */
export async function searchPublicStoreOffers(
  input: PublicOfferSearchInput,
): Promise<RecommendedBackendListing[]> {
  return (await searchPublicStoreOfferPage(input)).items;
}

/** Read a bounded, deterministic page that can be safely exposed to an AI retrieval tool. */
export async function searchPublicStoreOfferPage(
  input: PublicOfferSearchInput,
): Promise<PublicOfferSearchPage> {
  const limit = Math.max(1, Math.min(48, input.limit ?? 24));
  const offset = Math.max(0, Math.min(500, input.offset ?? 0));
  const requestedPaths = new Set(
    (input.storePaths ?? []).map((path) => path.trim()).filter(Boolean),
  );
  const scopedStores = requestedPaths.size
    ? input.stores.filter((store) => requestedPaths.has(store.path))
    : input.stores;
  if (!scopedStores.length)
    return { items: [], total: 0, offset, limit, hasMore: false };
  const storeIds = scopedStores.map((store) => store.id);
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
            COALESCE(registration.manifest -> 'ui' -> 'supplyFields', '[]'::jsonb) AS "supplyFields",
            offer.published_at::text AS "publishedAt",
            COALESCE(
              (SELECT sum(like_row.like_count)
                 FROM marketplace_offer_likes like_row
                WHERE like_row.tenant_id = offer.tenant_id
                  AND like_row.offer_id = offer.id),
              0
            )::text AS "likeTotal",
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
       LEFT JOIN subplatform_registrations registration
         ON registration.id = store.current_registration_id
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
      WHERE offer.store_id = ANY($1::uuid[])
        AND offer.status = 'active'
        AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
    )
     SELECT id, "tenantId", "domainId", "displayName", attributes, terms,
            "storeName", "storeSlug", "storePath", "integrationKind", "supplyFields",
            "publishedAt", "likeTotal"
       FROM ranked_offers
      WHERE store_rank <= 100
      ORDER BY relevance DESC, "publishedAt" DESC NULLS LAST, id
      LIMIT 2000`,
    [storeIds, input.narrative.slice(0, 8_000)],
  );

  const ranked = rankRows(result.rows, input.narrative, input.intent);
  const sort = input.sort ?? "relevance";
  if (sort !== "relevance")
    ranked.sort((left, right) =>
      compareRankedOffers(left.row, right.row, sort),
    );
  const publicOffers = ranked.flatMap(
      ({
        row,
        score,
        overlapLabels,
        intentReasons,
      }): RecommendedBackendListing[] => {
        const attributes = publicAttributes(
          row.attributes,
          row.integrationKind,
          row.supplyFields,
        );
        const terms = publicTerms(row.terms);
        const imageUrl = firstPublicImageUrl(attributes.attachments);
        if (
          !text(attributes.description) ||
          !imageUrl ||
          !hasFixedPublicPrice(terms) ||
          attributes.stock_quantity === 0
        )
          return [];
        return [
          {
            offer_id: row.id,
            tenant_id: row.tenantId,
            domain_id: row.domainId,
            display_name: row.displayName,
            attributes,
            terms,
            platform_path: row.storePath,
            subplatform: row.storeSlug,
            store_name: row.storeName,
            like_total: row.likeTotal ?? "0",
            ...(imageUrl ? { image_url: imageUrl } : {}),
            match_score: score,
            match_reasons: [
              ...intentReasons,
              ...(overlapLabels.length
                ? [
                    `在${row.storeName}找到，名称或介绍与“${overlapLabels.slice(0, 4).join("、")}”相关`,
                  ]
                : [`来自${row.storeName}的在售商品`]),
            ].slice(0, 8),
            match_risks: [],
            status: "active",
          },
        ];
      },
    );
  return {
    items: publicOffers.slice(offset, offset + limit),
    total: publicOffers.length,
    offset,
    limit,
    hasMore: offset + limit < publicOffers.length,
  };
}

function compareRankedOffers(
  left: PublicOfferRow,
  right: PublicOfferRow,
  sort: Exclude<PublicOfferSearchSort, "relevance">,
): number {
  if (sort === "latest")
    return String(right.publishedAt ?? "").localeCompare(
      String(left.publishedAt ?? ""),
    );
  if (sort === "popularity")
    return compareBigInt(integerText(right.likeTotal), integerText(left.likeTotal));
  const direction = sort === "price_asc" ? 1 : -1;
  const leftPrice = publicPrice(left.terms);
  const rightPrice = publicPrice(right.terms);
  const currencyOrder = leftPrice.currency.localeCompare(rightPrice.currency);
  if (currencyOrder) return currencyOrder;
  const scale = Math.max(leftPrice.scale, rightPrice.scale);
  const leftAmount =
    leftPrice.amount * 10n ** BigInt(scale - leftPrice.scale);
  const rightAmount =
    rightPrice.amount * 10n ** BigInt(scale - rightPrice.scale);
  return direction * compareBigInt(leftAmount, rightAmount);
}

function publicPrice(value: unknown): {
  currency: string;
  amount: bigint;
  scale: number;
} {
  const terms = record(value);
  const rawScale = Number(terms.currency_scale);
  return {
    currency: text(terms.currency),
    amount: integerText(terms.amount_minor),
    scale: Number.isInteger(rawScale) ? Math.max(0, Math.min(18, rawScale)) : 0,
  };
}

function integerText(value: unknown): bigint {
  const textValue = String(value ?? "");
  return /^\d+$/.test(textValue) ? BigInt(textValue) : 0n;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankRows(
  rows: PublicOfferRow[],
  narrative: string,
  intent?: PublicShoppingIntent,
): Array<{
  row: PublicOfferRow;
  score: number;
  overlapLabels: string[];
  intentReasons: string[];
}> {
  const queryTokens = tokenize(narrative);
  return rows
    .flatMap((row, index) => {
      const attributes = publicAttributes(
        row.attributes,
        row.integrationKind,
        row.supplyFields,
      );
      const terms = publicTerms(row.terms);
      const evaluation = evaluateShoppingIntent(attributes, terms, intent);
      if (!evaluation.eligible) return [];
      const description = text(attributes.description);
      const haystackTokens = new Set(
        tokenize(`${row.displayName}\n${description}`),
      );
      const overlapLabels = queryTokens.filter((token) =>
        haystackTokens.has(token),
      );
      const lexicalScore = queryTokens.length
        ? 0.35 + overlapLabels.length / Math.max(4, queryTokens.length)
        : 0.35;
      const score = Math.min(0.99, lexicalScore + evaluation.boost);
      return [
        { row, score, overlapLabels, intentReasons: evaluation.reasons, index },
      ];
    })
    .sort(
      (left, right) =>
        right.overlapLabels.length - left.overlapLabels.length ||
        right.score - left.score ||
        left.index - right.index,
    );
}

function publicAttributes(
  value: unknown,
  integrationKind: string,
  supplyFields: unknown,
): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  const description = text(source.description).slice(0, 4_000);
  if (description) result.description = description;
  const declaredKeys = Array.isArray(supplyFields)
    ? supplyFields.flatMap((field): string[] => {
        const item = record(field);
        return typeof item.key === "string" &&
          /^[A-Za-z0-9_.-]{1,128}$/.test(item.key)
          ? [item.key]
          : [];
      })
    : [];
  const publicKeys = [
    ...new Set([
      "brand",
      "model",
      "category",
      "condition",
      "location",
      "delivery_mode",
      "stock_quantity",
      ...declaredKeys,
    ]),
  ].slice(0, 32);
  for (const key of publicKeys) {
    const candidate = source[key];
    if (typeof candidate === "string" && candidate.trim())
      result[key] = candidate.trim().slice(0, 300);
    else if (typeof candidate === "number" && Number.isFinite(candidate))
      result[key] = candidate;
  }
  const attachments = publicImageAttachments(
    source.attachments,
    integrationKind,
  );
  if (attachments.length) result.attachments = attachments;
  return result;
}

function publicImageAttachments(
  value: unknown,
  integrationKind: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): Record<string, unknown>[] => {
      const attachment = record(item);
      if (attachment.kind !== "image") return [];
      const hostedReference =
        typeof attachment.attachment_ref === "string"
          ? HOSTED_MEDIA_REFERENCE.exec(attachment.attachment_ref)
          : null;
      const publicUrl =
        integrationKind === "hosted"
          ? hostedReference
            ? `/api/store-media/${hostedReference[1].toLowerCase()}`
            : undefined
          : safePublicUrl(record(attachment.metadata).public_url);
      if (!publicUrl) return [];
      return [
        {
          kind: "image",
          file_name: text(attachment.file_name).slice(0, 255),
          media_type: text(attachment.media_type).slice(0, 255),
          public_url: publicUrl,
        },
      ];
    })
    .slice(0, 8);
}

function publicTerms(value: unknown): Record<string, unknown> {
  const source = record(value);
  const amountMinor = unsignedIntegerString(source.amount_minor);
  const currency =
    typeof source.currency === "string" && /^[A-Z]{3}$/.test(source.currency)
      ? source.currency
      : null;
  const currencyScale =
    typeof source.currency_scale === "number" &&
    Number.isSafeInteger(source.currency_scale) &&
    source.currency_scale >= 0 &&
    source.currency_scale <= 18
      ? source.currency_scale
      : null;
  if (
    !amountMinor ||
    BigInt(amountMinor) <= 0n ||
    !currency ||
    currencyScale === null
  )
    return {};
  return {
    pricing_mode: "fixed",
    amount_minor: amountMinor,
    currency,
    currency_scale: currencyScale,
  };
}

function hasFixedPublicPrice(terms: Record<string, unknown>): boolean {
  return (
    terms.pricing_mode === "fixed" &&
    typeof terms.amount_minor === "string" &&
    typeof terms.currency === "string" &&
    typeof terms.currency_scale === "number"
  );
}

function unsignedIntegerString(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9]{1,38}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
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
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().slice(0, 8_000);
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [];
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]/g)].map(
    ([character]) => character,
  );
  return [...new Set([...words, ...cjk])].slice(0, 512);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
