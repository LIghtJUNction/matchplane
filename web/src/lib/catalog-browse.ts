import type { AssetListing } from "../types";
import { parseMoneyMinorUnits } from "./payment-money";

export type CatalogSort = "default" | "price-asc" | "price-desc";

type ListingFact = AssetListing["facts"][number];

export function isCategoryFact(fact: ListingFact): boolean {
  const key = fact.key?.toLowerCase();
  const label = fact.label.toLowerCase();
  return (
    key === "category" ||
    key === "product_category" ||
    label === "品类" ||
    label === "分类" ||
    label === "category"
  );
}

export function listingCategory(listing: AssetListing): string {
  return listing.facts.find(isCategoryFact)?.value.trim() ?? "";
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Search the loaded catalog only; AI retrieval remains the cross-store search. */
export function filterCatalogListings(
  listings: readonly AssetListing[],
  query: string,
  category: string,
): AssetListing[] {
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  return listings.filter((listing) => {
    if (category && listingCategory(listing) !== category) return false;
    if (!terms.length) return true;
    const text = normalizeSearch(
      [
        listing.title,
        listing.subtitle,
        listing.description,
        listing.storeName,
        listing.seller,
        listing.location,
        ...listing.facts.map((fact) => fact.value),
      ]
        .filter(Boolean)
        .join(" "),
    );
    return terms.every((term) => text.includes(term));
  });
}

/** Never infer a numeric price from localized display text or convert currencies. */
function canonicalPrice(listing: AssetListing) {
  const scale = listing.priceCurrencyScale;
  const currency = listing.priceCurrency?.trim().toUpperCase();
  if (
    scale === undefined ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > 18 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  )
    return null;
  const amount = parseMoneyMinorUnits(listing.priceAmountMinor ?? "", 0);
  return amount === null
    ? null
    : {
        currency,
        amount: amount * 10n ** BigInt(18 - scale),
      };
}

export function canSortCatalogByPrice(
  listings: readonly AssetListing[],
): boolean {
  const prices = listings.map(canonicalPrice).filter((price) => price !== null);
  return (
    prices.length > 1 &&
    new Set(prices.map((price) => price.currency)).size === 1
  );
}

export function sortCatalogListings(
  listings: readonly AssetListing[],
  sort: CatalogSort,
): AssetListing[] {
  if (sort === "default" || !canSortCatalogByPrice(listings))
    return [...listings];
  const priced = listings.map((listing) => ({
    listing,
    price: canonicalPrice(listing),
  }));
  priced.sort((a, b) => {
    if (!a.price) return b.price ? 1 : 0;
    if (!b.price) return -1;
    const order =
      a.price.amount < b.price.amount
        ? -1
        : a.price.amount > b.price.amount
          ? 1
          : 0;
    return sort === "price-asc" ? order : -order;
  });
  return priced.map(({ listing }) => listing);
}
