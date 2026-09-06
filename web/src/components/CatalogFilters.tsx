"use client";

import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";
import { Toggle } from "@appica/ui-react/toggle";
import { ToggleGroup } from "@appica/ui-react/toggle-group";
import { Search, X } from "lucide-react";
import { useId } from "react";

import type { useCatalogBrowse } from "../hooks/useCatalogBrowse";
import type { CatalogSort } from "../lib/catalog-browse";
import type { InterfaceLocale } from "../lib/preferences";

export function CatalogFilters({
  browse,
  locale,
}: {
  browse: ReturnType<typeof useCatalogBrowse>;
  locale: InterfaceLocale;
}) {
  const english = locale === "en";
  const hintId = useId();
  return (
    <div className="catalog-filters">
      {browse.categories.length ? (
        <div className="catalog-category-row">
          <span className="catalog-filter-label">
            {english ? "Category" : "品类"}
          </span>
          <ToggleGroup
            className="root-marketplace-inline-categories"
            value={[browse.category ? `category:${browse.category}` : "all"]}
            onValueChange={(value) =>
              browse.setCategory(
                value[0]?.startsWith("category:") ? value[0].slice(9) : "",
              )
            }
            aria-label={english ? "Product categories" : "商品分类"}
          >
            {["", ...browse.categories].map((category) => (
              <Toggle
                className="root-marketplace-category"
                key={category}
                value={category ? `category:${category}` : "all"}
              >
                {category || (english ? "All" : "全部")}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">
            {english ? "Search loaded products" : "在当前商品中搜索"}
          </span>
          <Input
            type="search"
            className="catalog-search-input"
            placeholder={
              english ? "Product, store or location" : "商品名称、店铺或地区"
            }
            value={browse.query}
            maxLength={200}
            onChange={(event) => browse.setQuery(event.target.value)}
          />
        </label>
        <label className="catalog-sort">
          <span className="sr-only">
            {english ? "Sort products" : "商品排序"}
          </span>
          <select
            value={browse.sort}
            aria-describedby={browse.priceSortable ? undefined : hintId}
            onChange={(event) =>
              browse.setSort(event.target.value as CatalogSort)
            }
          >
            <option value="default">
              {english ? "Default order" : "默认排序"}
            </option>
            <option value="price-asc" disabled={!browse.priceSortable}>
              {english ? "Price: low to high" : "价格从低到高"}
            </option>
            <option value="price-desc" disabled={!browse.priceSortable}>
              {english ? "Price: high to low" : "价格从高到低"}
            </option>
          </select>
        </label>
        {browse.hasFilters ? (
          <Button
            className="catalog-reset"
            variant="ghost"
            size="sm"
            type="button"
            onClick={browse.reset}
          >
            <X size={15} aria-hidden="true" />
            {english ? "Clear filters" : "清除筛选"}
          </Button>
        ) : null}
        <span
          className="catalog-result-count"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {browse.visibleListings.length === browse.total
            ? english
              ? `${browse.total} products`
              : `${browse.total} 件商品`
            : english
              ? `${browse.visibleListings.length} of ${browse.total} products`
              : `${browse.visibleListings.length} / ${browse.total} 件商品`}
        </span>
      </div>
      <p className="catalog-scope-note" id={hintId}>
        {english
          ? "Filters apply to loaded products."
          : "仅筛选当前已加载的商品。"}
        {browse.priceSortable
          ? null
          : english
            ? " Price sorting needs comparable, same-currency prices."
            : "价格排序仅用于有明确价格的同币种商品。"}
      </p>
    </div>
  );
}
