import { useMemo, useState } from "react";

import {
  canSortCatalogByPrice,
  filterCatalogListings,
  listingCategory,
  sortCatalogListings,
  type CatalogSort,
} from "../lib/catalog-browse";
import type { AssetListing } from "../types";

export function useCatalogBrowse(listings: readonly AssetListing[]) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<CatalogSort>("default");
  const categories = useMemo(
    () => Array.from(new Set(listings.map(listingCategory).filter(Boolean))),
    [listings],
  );
  const effectiveCategory = categories.includes(category) ? category : "";
  const filtered = useMemo(
    () => filterCatalogListings(listings, query, effectiveCategory),
    [listings, query, effectiveCategory],
  );
  const priceSortable = useMemo(
    () => canSortCatalogByPrice(filtered),
    [filtered],
  );
  const effectiveSort = priceSortable ? sort : "default";
  const visibleListings = useMemo(
    () => sortCatalogListings(filtered, effectiveSort),
    [filtered, effectiveSort],
  );
  const reset = () => {
    setQuery("");
    setCategory("");
    setSort("default");
  };

  return {
    query,
    setQuery,
    category: effectiveCategory,
    setCategory,
    sort: effectiveSort,
    setSort,
    categories,
    priceSortable,
    visibleListings,
    total: listings.length,
    hasFilters: Boolean(
      query.trim() || effectiveCategory || effectiveSort !== "default",
    ),
    reset,
  };
}
