import { authDatabase } from "./lib/auth";
import type { RecommendedBackendListing } from "./api";
import { MAX_PUBLIC_STORES, type PublicStore } from "./store-directory";
import {
  boundedMatchReasons,
  comparePublicStorefrontOffers,
  rankPublicStorefrontCandidates,
  type PublicOfferSearchSort,
} from "./storefront-ranking";
import { MAX_LEXICAL_RANK_TOTAL_CANDIDATES } from "./storefront-ranking-contract";
import { isSafePublicAttributeKey } from "./storefront-ranking-shared";
import type { PublicShoppingIntent } from "./shopping-intent";

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

/** Maximum store scopes admitted to one public-offer SQL query; excess fails closed. */
export const MAX_PUBLIC_OFFER_SEARCH_STORE_IDS = MAX_PUBLIC_STORES;
const MAX_PUBLIC_OFFER_SEARCH_NARRATIVE_CHARACTERS = 8_000;
export const MAX_PUBLIC_OFFER_SEARCH_CANDIDATES =
  MAX_LEXICAL_RANK_TOTAL_CANDIDATES;

const MAX_PUBLIC_OFFER_SEARCH_STORE_PATHS = MAX_PUBLIC_OFFER_SEARCH_STORE_IDS;
const PUBLIC_OFFER_SEARCH_CANDIDATE_SENTINEL =
  MAX_PUBLIC_OFFER_SEARCH_CANDIDATES + 1;

export type PublicOfferSearchBudget =
  | "store_ids"
  | "store_paths"
  | "narrative_characters"
  | "candidates";

/** Typed, observable refusal instead of silently truncating retrieval work. */
export class PublicOfferSearchBudgetExceededError extends Error {
  readonly code = "public_offer_search_budget_exceeded";

  constructor(
    readonly budget: PublicOfferSearchBudget,
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(
      `public storefront search ${budget} budget exceeded: ${actual} > ${maximum}`,
    );
    this.name = "PublicOfferSearchBudgetExceededError";
  }
}

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
  return searchPublicStoreOffersFromDatabase(authDatabase, input);
}

/** Database reader seam used by the production offer path and PostgreSQL contract tests. */
export async function searchPublicStoreOffersFromDatabase(
  database: Pick<typeof authDatabase, "query">,
  input: PublicOfferSearchInput,
): Promise<RecommendedBackendListing[]> {
  return (await searchPublicStoreOfferPageFromDatabase(database, input)).items;
}

/** Read a bounded, deterministic page that can be safely exposed to an AI retrieval tool. */
export async function searchPublicStoreOfferPage(
  input: PublicOfferSearchInput,
): Promise<PublicOfferSearchPage> {
  return searchPublicStoreOfferPageFromDatabase(authDatabase, input);
}

/** Database reader seam for the bounded production offer page. */
async function searchPublicStoreOfferPageFromDatabase(
  database: Pick<typeof authDatabase, "query">,
  input: PublicOfferSearchInput,
): Promise<PublicOfferSearchPage> {
  assertPublicOfferSearchBudget(
    "store_ids",
    input.stores.length,
    MAX_PUBLIC_OFFER_SEARCH_STORE_IDS,
  );
  assertPublicOfferSearchBudget(
    "store_paths",
    input.storePaths?.length ?? 0,
    MAX_PUBLIC_OFFER_SEARCH_STORE_PATHS,
  );
  assertPublicOfferSearchBudget(
    "narrative_characters",
    [...input.narrative].length,
    MAX_PUBLIC_OFFER_SEARCH_NARRATIVE_CHARACTERS,
  );

  const executeQuery = database.query.bind(database);
  const limit = Math.max(1, Math.min(48, input.limit ?? 24));
  const offset = Math.max(0, Math.min(500, input.offset ?? 0));
  const requestedPaths = new Set(
    (input.storePaths ?? []).map((path) => path.trim()).filter(Boolean),
  );
  const scopedStores = requestedPaths.size
    ? input.stores.filter((store) => requestedPaths.has(store.path))
    : input.stores;
  const uniqueStores = [
    ...new Map(scopedStores.map((store) => [store.id, store])).values(),
  ];
  if (!uniqueStores.length)
    return { items: [], total: 0, offset, limit, hasMore: false };
  const storeIds = uniqueStores.map((store) => store.id);
  const tenantIds = uniqueStores.map((store) => store.tenantId);
  const domainIds = uniqueStores.map((store) => store.domainId);
  const result = (await executeQuery(
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
            )::text AS "likeTotal"
       FROM marketplace_offers offer
       JOIN unnest($1::uuid[], $2::uuid[], $3::uuid[])
         AS requested_store(store_id, tenant_id, domain_id)
         ON requested_store.store_id = offer.store_id
        AND requested_store.tenant_id = offer.tenant_id
        AND requested_store.domain_id = offer.domain_id
       JOIN stores store
         ON store.tenant_id = offer.tenant_id
        AND store.domain_id = offer.domain_id
        AND store.id = offer.store_id
        AND store.status = 'active'
        AND store.visibility = 'public'
       JOIN domains domain
         ON domain.tenant_id = store.tenant_id
        AND domain.id = store.domain_id
        AND domain.status = 'active'
       LEFT JOIN subplatform_registrations registration
         ON registration.id = store.current_registration_id
        AND registration.tenant_id = store.tenant_id
        AND registration.domain_id = store.domain_id
        AND registration.slug = store.slug
        AND registration.state = 'active'
       LEFT JOIN platform_federation_bindings binding
         ON binding.id = store.federation_binding_id
        AND binding.tenant_id = store.tenant_id
        AND binding.domain_id = store.domain_id
        AND binding.slug = store.slug
        AND binding.organization_id = store.organization_id
        AND binding.registration_id = registration.id
        AND binding.status = 'active'
       JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
      WHERE offer.status = 'active'
        AND (offer.expires_at IS NULL OR offer.expires_at > clock_timestamp())
        AND (store.integration_kind = 'hosted' OR registration.id IS NOT NULL)
        AND (store.integration_kind <> 'external' OR binding.id IS NOT NULL)
        AND (
          store.integration_kind = 'hosted'
          OR registration.source_kind <> 'remote'
          OR binding.id IS NOT NULL
        )
    )
     SELECT id, "tenantId", "domainId", "displayName", attributes, terms,
            "storeName", "storeSlug", "storePath", "integrationKind", "supplyFields",
            "publishedAt", "likeTotal"
       FROM ranked_offers
      ORDER BY "publishedAt" DESC NULLS LAST, id
      LIMIT ${PUBLIC_OFFER_SEARCH_CANDIDATE_SENTINEL}`,
    [storeIds, tenantIds, domainIds],
  )) as { rows: PublicOfferRow[] };
  if (result.rows.length > MAX_PUBLIC_OFFER_SEARCH_CANDIDATES) {
    throw new PublicOfferSearchBudgetExceededError(
      "candidates",
      result.rows.length,
      MAX_PUBLIC_OFFER_SEARCH_CANDIDATES,
    );
  }

  const ranked = await rankPublicStorefrontCandidates(
    result.rows.map((row) => ({
      row,
      displayName: row.displayName,
      attributes: publicAttributes(
        row.attributes,
        row.integrationKind,
        row.supplyFields,
      ),
      terms: publicTerms(row.terms),
    })),
    input.narrative,
    input.intent,
  );
  const sort = input.sort ?? "relevance";
  if (sort !== "relevance") {
    ranked.sort((left, right) =>
      comparePublicStorefrontOffers(left.row, right.row, sort),
    );
  }
  const publicOffers = ranked.flatMap(
    ({
      row,
      attributes,
      terms,
      score,
      overlapLabels,
      intentReasons,
    }): RecommendedBackendListing[] => {
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
          ...(score === undefined
            ? {}
            : {
                match_score: score,
                match_reasons: boundedMatchReasons([
                  ...intentReasons,
                  ...(overlapLabels.length
                    ? [
                        `名称或公开属性与“${overlapLabels.slice(0, 4).join("、")}”相关`,
                      ]
                    : []),
                ]),
                match_risks: [],
              }),
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

function assertPublicOfferSearchBudget(
  budget: PublicOfferSearchBudget,
  actual: number,
  maximum: number,
): void {
  if (actual > maximum) {
    throw new PublicOfferSearchBudgetExceededError(budget, actual, maximum);
  }
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
          /^[A-Za-z0-9_.-]{1,128}$/.test(item.key) &&
          isSafePublicAttributeKey(item.key)
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
