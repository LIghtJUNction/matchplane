"use client";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@appica/ui-react/alert";
import { Button } from "@appica/ui-react/button";
import { Skeleton } from "@appica/ui-react/skeleton";
import {
  ArrowDown,
  LockKeyhole,
  PackageOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { MallAssistantSearchTrace } from "../api";
import { useCatalogBrowse } from "../hooks/useCatalogBrowse";
import type { InterfaceLocale } from "../lib/preferences";
import type { AssetListing } from "../types";
import { useMarketplaceWebMcp } from "../webmcp/useMarketplaceWebMcp";
import { CatalogFilters } from "./CatalogFilters";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { MarketplaceSearchTrace } from "./MarketplaceSearchTrace";
import { StorefrontDirectory } from "./StorefrontDirectory";

interface MarketplaceHomeProps {
  brandName?: string;
  catalogResolved: boolean;
  catalogError?: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  assistant: ReactNode;
  searchTrace?: MallAssistantSearchTrace | null;
  onWebMcpDescribeNeed: (narrative: string) => void;
  onOpenStore: (path: string) => void | Promise<void>;
  onOpenListing: (listing: AssetListing) => void | Promise<void>;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onRetryCatalog: () => void;
}

function MarketplaceLoading({
  locale,
  onRetry,
}: {
  locale: InterfaceLocale;
  onRetry: () => void;
}) {
  const [wait, setWait] = useState<"short" | "long" | "delayed">("short");
  useEffect(() => {
    const long = window.setTimeout(() => setWait("long"), 2_000);
    const delayed = window.setTimeout(() => setWait("delayed"), 10_000);
    return () => {
      window.clearTimeout(long);
      window.clearTimeout(delayed);
    };
  }, []);

  return (
    <section
      className="root-marketplace-loading-state"
      role="status"
      aria-label={locale === "en" ? "Loading products" : "商品读取中"}
      aria-busy="true"
    >
      <div className="root-marketplace-loading" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="root-marketplace-loading-box" key={item}>
            <Skeleton className="root-marketplace-loading-visual" />
            <Skeleton className="root-marketplace-loading-line" />
            <Skeleton className="root-marketplace-loading-line is-short" />
          </div>
        ))}
      </div>
      {wait === "short" ? null : (
        <p>
          {locale === "en"
            ? "Reading the live catalog. This can take a moment."
            : "正在读取实时商品目录，请稍候。"}
        </p>
      )}
      {wait === "delayed" ? (
        <Button variant="outline" size="sm" type="button" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          {locale === "en" ? "Taking too long? Retry" : "等待较久？重新读取"}
        </Button>
      ) : null}
    </section>
  );
}

function MarketplaceProducts({
  catalogResolved,
  catalogError,
  browse,
  locale,
  onOpenListing,
  onLikeListing,
  onRetryCatalog,
}: {
  catalogResolved: boolean;
  catalogError: boolean;
  browse: ReturnType<typeof useCatalogBrowse>;
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onRetryCatalog: () => void;
}) {
  const english = locale === "en";
  let content: ReactNode;
  if (!catalogResolved) {
    content = <MarketplaceLoading locale={locale} onRetry={onRetryCatalog} />;
  } else if (catalogError) {
    content = (
      <Alert className="root-marketplace-error" variant="error" layout="inline">
        <AlertIcon>
          <PackageOpen aria-hidden="true" />
        </AlertIcon>
        <AlertTitle as="div">
          {english ? "The product shelf did not load" : "商品货架读取失败"}
        </AlertTitle>
        <AlertDescription>
          {english
            ? "The shopping assistant is still available above."
            : "上方选货员仍然可用，可以直接描述你的需要。"}
        </AlertDescription>
        <AlertAction>
          <Button size="sm" type="button" onClick={onRetryCatalog}>
            <RefreshCw aria-hidden="true" />
            {english ? "Retry catalog" : "重新读取商品"}
          </Button>
        </AlertAction>
      </Alert>
    );
  } else if (browse.visibleListings.length) {
    content = (
      <div className="root-marketplace-products-grid catalog-products-grid">
        {browse.visibleListings.map((listing) => (
          <MarketplaceListingCard
            listing={listing}
            locale={locale}
            onOpen={() => onOpenListing(listing)}
            onLike={() => onLikeListing(listing)}
            key={listing.id}
          />
        ))}
      </div>
    );
  } else if (browse.total) {
    content = (
      <div
        className="root-marketplace-empty catalog-filter-empty"
        role="status"
      >
        <Search aria-hidden="true" />
        <div>
          <strong>
            {english ? "No products match these filters" : "没有符合筛选的商品"}
          </strong>
          <p>
            {english
              ? "Try another keyword or clear the filters."
              : "换个关键词，或清除筛选再看看。"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={browse.reset}
        >
          {english ? "View all products" : "查看全部商品"}
        </Button>
      </div>
    );
  } else {
    content = (
      <div className="root-marketplace-empty">
        <PackageOpen aria-hidden="true" />
        <div>
          <strong>
            {english ? "No approved products yet" : "暂时还没有通过审核的商品"}
          </strong>
          <p>
            {english
              ? "Refine your request above, or browse the open stores below."
              : "可以修改上方需求，也可以浏览下方已营业店铺。"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <section
      className="root-marketplace-products"
      id="products"
      aria-labelledby="marketplace-products-title"
    >
      <div className="root-marketplace-products-heading">
        <div>
          <h2 id="marketplace-products-title">
            {english ? "Products" : "商品"}
          </h2>
          <span>
            {english
              ? "Published product details from open stores."
              : "商品信息来自当前营业店铺。"}
          </span>
        </div>
        <a className="catalog-stores-link" href="#stores">
          {english ? "Explore stores →" : "逛逛店铺 →"}
        </a>
      </div>
      {catalogResolved && !catalogError && browse.total > 0 ? (
        <CatalogFilters browse={browse} locale={locale} />
      ) : null}
      {content}
    </section>
  );
}

export function MarketplaceHome({
  brandName = "MatchPlane",
  catalogResolved,
  catalogError = false,
  listings,
  locale,
  assistant,
  searchTrace,
  onWebMcpDescribeNeed,
  onOpenStore,
  onOpenListing,
  onLikeListing,
  onRetryCatalog,
}: MarketplaceHomeProps) {
  const browse = useCatalogBrowse(listings);
  const [directoryStorePaths, setDirectoryStorePaths] = useState<
    readonly string[]
  >([]);
  const visibleListings =
    catalogResolved && !catalogError ? browse.visibleListings : [];
  const visibleStorePaths = Array.from(
    new Set([
      ...visibleListings.flatMap((listing) =>
        listing.platformPath ? [listing.platformPath] : [],
      ),
      ...(searchTrace?.stores.map((store) => store.path) ?? []),
      ...directoryStorePaths,
    ]),
  );

  useMarketplaceWebMcp({
    enabled: true,
    scopeKey: "buyer:/",
    visibleListings,
    visibleStorePaths,
    describeNeed: onWebMcpDescribeNeed,
    openStore: onOpenStore,
    openListing: onOpenListing,
  });

  return (
    <div className="root-marketplace-page" id="top">
      <div className="root-marketplace-main">
        <section
          className={`root-marketplace-entry${searchTrace ? " has-results" : ""}`}
          aria-labelledby="root-marketplace-title"
        >
          <div className="root-marketplace-entry-frame">
            <header className="root-marketplace-catalog-intro">
              <p className="root-marketplace-brand">{brandName}</p>
              <h1 id="root-marketplace-title">
                {locale === "en"
                  ? "Describe what you are looking for."
                  : "说说你想找什么。"}
              </h1>
              <span>
                {locale === "en"
                  ? `${brandName} searches public stores and keeps every visible result tied to its source.`
                  : `${brandName} 会检索公开店铺，并保留每个可见结果的真实来源。`}
              </span>
              <p className="root-marketplace-privacy">
                <LockKeyhole size={14} aria-hidden="true" />
                {locale === "en"
                  ? "Contact details stay private until you agree."
                  : "未经你确认，不会交换联系方式。"}
              </p>
              <a className="root-marketplace-scroll-cue" href="#products">
                {locale === "en" ? "Browse what is live" : "浏览当前在售"}
                <ArrowDown size={15} aria-hidden="true" />
              </a>
            </header>
            <div className="root-marketplace-concierge">
              <div className="root-marketplace-chat-shell">{assistant}</div>
            </div>
          </div>
          {searchTrace ? (
            <MarketplaceSearchTrace
              trace={searchTrace}
              locale={locale}
              onOpenStore={onOpenStore}
            />
          ) : null}
        </section>
        <div className="root-marketplace-catalog" id="marketplace-products">
          <div className="root-marketplace-content">
            <MarketplaceProducts
              catalogResolved={catalogResolved}
              catalogError={catalogError}
              browse={browse}
              locale={locale}
              onOpenListing={onOpenListing}
              onLikeListing={onLikeListing}
              onRetryCatalog={onRetryCatalog}
            />
            <div className="root-marketplace-stores" id="stores">
              <StorefrontDirectory
                locale={locale}
                onVisibleStorePathsChange={setDirectoryStorePaths}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
