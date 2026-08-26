import type { RecommendedBackendListing } from "./api";
import { localizedSubplatformCopy } from "./lib/localized-copy";
import { boundedMatchReasons } from "./storefront-ranking-shared";
import {
  subplatformFieldLabel,
  subplatformFieldValue,
  type SubplatformConfig,
} from "./subplatform";
import type { AssetListing } from "./types";

interface UnknownFields {
  [key: string]: unknown;
}

type Locale = "zh" | "en";

const ACCENTS: AssetListing["accent"][] = ["cactus", "clay", "heather", "oat"];

/** Maps the bounded public recommendation contract into the root listing view model. */
export function mapRecommendations(
  items: RecommendedBackendListing[],
  subplatform: SubplatformConfig,
  locale: Locale,
): AssetListing[] {
  return items.flatMap((item, index) => {
    const listing = mapRecommendation(item, index, subplatform, locale);
    return listing ? [listing] : [];
  });
}

function mapRecommendation(
  item: RecommendedBackendListing,
  index: number,
  subplatform: SubplatformConfig,
  locale: Locale,
): AssetListing | null {
  const id = item.listing_id ?? item.offer_id;
  if (!id) return null;

  const attributes = item.attributes ?? {};
  const storeName = stringValue(item.store_name);
  const facts = recommendationFacts(
    attributes,
    stringMap(item.field_labels),
    subplatform,
    locale,
  );
  const subtitle =
    storeName ??
    facts
      .slice(0, 2)
      .map((fact) => `${fact.label} ${fact.value}`)
      .join(" · ");
  const imageUrl = stringValue(item.image_url);
  const imageUrls = recommendationImages(imageUrl, attributes.attachments);
  const displayImageUrl = imageUrls[0];
  const terms = objectValue(item.terms) ?? {};
  const money = recommendationMoney(item, terms);
  const intentId = stringValue(item.intent_id);
  const dynamicItem: UnknownFields = item;
  const matchScore = finiteNumber(item.match_score);
  const canonicalReasons = boundedReasonList(
    item.match_reasons ?? (intentId ? dynamicItem.reasons : undefined),
  );
  const canonicalRisks = boundedReasonList(
    item.match_risks ?? (intentId ? dynamicItem.risks : undefined),
  );
  const providerHints = boundedReasonList(item.provider_hints);

  const listing: AssetListing = {
    id,
    title: item.display_name,
    subtitle,
    imageUrls,
    likeTotal: digitString(item.like_total) ?? "0",
    viewerLikeCount: 0,
    price: recommendationPrice(terms, money, subplatform, locale),
    accent: ACCENTS[index % ACCENTS.length],
    facts,
  };

  assignText(listing, "tenantId", stringValue(item.tenant_id));
  assignText(listing, "domainId", stringValue(item.domain_id));
  assignText(listing, "platformPath", item.platform_path ?? subplatform.path);
  assignText(listing, "subplatform", item.subplatform ?? subplatform.slug);
  assignText(listing, "description", stringValue(attributes.description));
  assignText(listing, "imageUrl", displayImageUrl);
  assignText(listing, "storeId", stringValue(item.store_id));
  assignText(listing, "storeName", storeName);
  assignText(listing, "location", stringValue(item.location));
  assignText(listing, "seller", storeName);
  assignText(listing, "offerId", item.offer_id);
  assignText(listing, "intentId", intentId);
  assignText(
    listing,
    "response",
    firstString(dynamicItem, ["response", "seller_response", "sellerResponse"]),
  );

  if (money) {
    listing.priceAmountMinor = money.amount;
    listing.priceCurrency = money.currency;
    listing.priceCurrencyScale = money.scale;
  }
  if (matchScore !== undefined) {
    listing.matchScore = Math.round(Math.max(0, Math.min(1, matchScore)) * 100);
  }
  if (canonicalReasons) listing.reasons = canonicalReasons;
  if (canonicalRisks) listing.risks = canonicalRisks;
  if (providerHints) listing.providerHints = providerHints;

  return listing;
}

function recommendationFacts(
  attributes: UnknownFields,
  configuredLabels: { [key: string]: string },
  subplatform: SubplatformConfig,
  locale: Locale,
): AssetListing["facts"] {
  const facts: AssetListing["facts"] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "description" || key === "attachments") continue;
    if (primitiveValue(value) === null) continue;
    facts.push({
      key,
      label:
        trimmed(configuredLabels[key]) ??
        subplatformFieldLabel(subplatform, key, locale),
      value: subplatformFieldValue(key, value, locale),
    });
    if (facts.length === 4) break;
  }
  return facts;
}

function recommendationImages(
  primary: string | undefined,
  attachmentsValue: unknown,
): string[] {
  const images = primary ? [primary] : [];
  if (Array.isArray(attachmentsValue)) {
    for (const value of attachmentsValue) {
      const attachment = objectValue(value);
      if (attachment?.kind !== "image") continue;
      const url =
        stringValue(attachment.public_url) ?? stringValue(attachment.url);
      if (url) images.push(url);
    }
  }
  return [...new Set(images)];
}

interface MoneyValue {
  amount: string;
  currency: string;
  scale: number;
}

function recommendationMoney(
  item: RecommendedBackendListing,
  terms: UnknownFields,
): MoneyValue | null {
  const askingMoney = moneyValue(
    item.asking_amount,
    item.currency,
    item.currency_scale,
  );
  if (askingMoney) return askingMoney;
  return moneyValue(
    stringValue(terms.amount_minor),
    stringValue(terms.currency),
    integerValue(terms.currency_scale),
  );
}

function recommendationPrice(
  terms: UnknownFields,
  money: MoneyValue | null,
  subplatform: SubplatformConfig,
  locale: Locale,
): string {
  if (money) return formatMoney(money.amount, money.currency, money.scale);

  const currency = stringValue(terms.currency);
  const scale = integerValue(terms.currency_scale);
  const minimum = stringValue(terms.amount_min_minor);
  const maximum = stringValue(terms.amount_max_minor);
  if (minimum && maximum && currency && scale !== undefined) {
    return `${formatMoney(minimum, currency, scale)} – ${formatMoney(maximum, currency, scale)}`;
  }

  const pricingNote = firstString(terms, ["pricing_note", "pricing_label"]);
  const pricingMode = stringValue(terms.pricing_mode);
  if (pricingMode === "negotiable") {
    return (
      pricingNote ??
      localizedSubplatformCopy(
        subplatform,
        locale,
        "negotiablePriceLabel",
        "可议价",
        "Negotiable",
      )
    );
  }
  if (pricingMode === "none") {
    return (
      pricingNote ??
      localizedSubplatformCopy(
        subplatform,
        locale,
        "noPriceLabel",
        "面议",
        "Price on request",
      )
    );
  }
  return firstString(terms, ["display_price", "price_label", "price"]) ?? "—";
}

function moneyValue(
  amount: string | undefined,
  currency: string | undefined,
  scale: number | undefined,
): MoneyValue | null {
  if (!amount || !currency || scale === undefined || !Number.isInteger(scale))
    return null;
  return { amount, currency, scale };
}

function assignText<Key extends keyof AssetListing>(
  listing: AssetListing,
  key: Key,
  value: string | undefined,
) {
  if (value) Object.assign(listing, { [key]: value });
}

function firstString(value: UnknownFields, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = stringValue(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function boundedReasonList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reasons = boundedMatchReasons(
    value.flatMap((item) => {
      const candidate = stringValue(item);
      return candidate ? [candidate] : [];
    }),
  );
  return reasons.length ? reasons : undefined;
}

function objectValue(value: unknown): UnknownFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownFields;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? trimmed(value) : undefined;
}

function stringMap(value: unknown): { [key: string]: string } {
  const source = objectValue(value);
  if (!source) return {};
  const result: { [key: string]: string } = {};
  for (const [key, candidate] of Object.entries(source)) {
    const text = stringValue(candidate);
    if (text) result[key] = text;
  }
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function digitString(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate && /^\d+$/.test(candidate) ? candidate : undefined;
}

function trimmed(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate || undefined;
}

function primitiveValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  return null;
}

function formatMoney(amount: string, currency: string, scale: number): string {
  try {
    const numeric = BigInt(amount);
    const divisor = 10n ** BigInt(Math.max(0, scale));
    const whole = numeric / divisor;
    const remainder = (numeric < 0n ? -numeric : numeric) % divisor;
    if (scale === 0) return `${currency} ${whole}`;
    return `${currency} ${whole}.${remainder.toString().padStart(scale, "0")}`;
  } catch {
    return `${currency} ${amount}`;
  }
}
