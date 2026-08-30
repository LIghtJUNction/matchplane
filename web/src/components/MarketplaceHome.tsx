"use client";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@appica/ui-react/alert";
import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";
import { Skeleton } from "@appica/ui-react/skeleton";
import { Toggle } from "@appica/ui-react/toggle";
import { ToggleGroup } from "@appica/ui-react/toggle-group";
import { PackageOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { MallAssistantSearchTrace } from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import type { AssetListing } from "../types";
import { useMarketplaceWebMcp } from "../webmcp/useMarketplaceWebMcp";
import { FloatingMarketplaceClerk } from "./FloatingMarketplaceClerk";
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

function listingCategory(listing: AssetListing) {
  const fact = listing.facts.find((item) => {
    const key = item.key?.toLowerCase();
    const label = item.label.toLowerCase();
    return (
      key === "category" ||
      key === "product_category" ||
      label === "品类" ||
      label === "分类" ||
      label === "category"
    );
  });
  return fact?.value.trim() ?? "";
}

function MarketplaceLoading({ locale }: { locale: InterfaceLocale }) {
  const [showLongWait, setShowLongWait] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setShowLongWait(true), 2_000);
    return () => window.clearTimeout(timeout);
  }, []);

  return (
    <section
      className="root-marketplace-loading-state"
      role="status"
      aria-label={locale === "en" ? "Loading products" : "商品读取中"}
      aria-busy="true"
    >
      <div className="marketplace-home-loading-rows" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="marketplace-home-loading-row" key={item}>
            <Skeleton className="root-marketplace-loading-visual" />
            <div className="marketplace-home-loading-lines">
              <Skeleton className="root-marketplace-loading-line" />
              <Skeleton className="root-marketplace-loading-line is-short" />
            </div>
          </div>
        ))}
      </div>
      {showLongWait ? (
        <p>
          {locale === "en"
            ? "Reading the live catalog. This can take a moment."
            : "正在读取实时商品目录，请稍候。"}
        </p>
      ) : null}
    </section>
  );
}

function MarketplaceProducts({
  catalogResolved,
  catalogError,
  listings,
  locale,
  onOpenListing,
  onLikeListing,
  onRetryCatalog,
}: {
  catalogResolved: boolean;
  catalogError: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onRetryCatalog: () => void;
}) {
  let content: ReactNode;
  if (!catalogResolved) content = <MarketplaceLoading locale={locale} />;
  else if (listings.length)
    content = (
      <div className="marketplace-home-listing-rows">
        {listings.map((listing) => (
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
  else if (catalogError)
    content = (
      <Alert className="root-marketplace-error" variant="error" layout="inline">
        <AlertIcon>
          <PackageOpen aria-hidden="true" />
        </AlertIcon>
        <AlertTitle as="div">
          {locale === "en"
            ? "The product shelf did not load"
            : "商品货架读取失败"}
        </AlertTitle>
        <AlertDescription>
          {locale === "en"
            ? "The shopping search is still available."
            : "仍可直接填写预算和需求进行搜索。"}
        </AlertDescription>
        <AlertAction>
          <Button size="sm" type="button" onClick={onRetryCatalog}>
            <RefreshCw aria-hidden="true" />
            {locale === "en" ? "Retry catalog" : "重新读取商品"}
          </Button>
        </AlertAction>
      </Alert>
    );
  else
    content = (
      <div className="root-marketplace-empty">
        <PackageOpen aria-hidden="true" />
        <div>
          <strong>
            {locale === "en"
              ? "No approved products yet"
              : "暂时还没有通过审核的商品"}
          </strong>
          <p>
            {locale === "en"
              ? "Refine your request above, or browse the open stores below."
              : "可以修改上方需求，也可以浏览下方已营业店铺。"}
          </p>
        </div>
      </div>
    );

  return (
    <section
      className="root-marketplace-products"
      id="products"
      aria-labelledby="marketplace-products-title"
    >
      <div className="root-marketplace-products-heading">
        <div>
          <p>{locale === "en" ? "CURATED PRODUCTS" : "精选在售"}</p>
          <h2 id="marketplace-products-title">
            {locale === "en" ? "Products" : "商品"}
          </h2>
          <span>
            {locale === "en"
              ? "Clear product details from open stores."
              : "商品信息来自当前营业店铺。"}
          </span>
        </div>
        {listings.length ? (
          <strong className="root-marketplace-inventory-count">
            <span>{listings.length}</span>
            {locale === "en" ? " products" : " 件商品"}
          </strong>
        ) : null}
      </div>
      {content}
    </section>
  );
}

function MarketplaceNeedPrompt({
  locale,
  onSubmit,
}: {
  locale: InterfaceLocale;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const english = locale === "en";

  return (
    <form
      className="root-marketplace-need-prompt"
      aria-label={english ? "Describe what you need" : "描述你的需求"}
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text) return;
        onSubmit(text);
        setValue("");
      }}
    >
      <Input
        className="root-marketplace-need-input"
        value={value}
        maxLength={240}
        placeholder={
          english
            ? "For example: a family SUV under 150,000"
            : "例如：预算 15 万以内的家用 SUV"
        }
        aria-label={
          english
            ? "Describe what you want and your budget"
            : "描述想买的东西和预算"
        }
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={!value.trim()}>
        {english ? "Find matches" : "帮我找"}
      </Button>
    </form>
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
  const allLabel = locale === "en" ? "All" : "全部";
  const [category, setCategory] = useState(allLabel);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [directoryStorePaths, setDirectoryStorePaths] = useState<
    readonly string[]
  >([]);
  const categories = useMemo(
    () => [
      allLabel,
      ...Array.from(new Set(listings.map(listingCategory).filter(Boolean))),
    ],
    [allLabel, listings],
  );
  const effectiveCategory = categories.includes(category) ? category : allLabel;
  const visibleListings =
    effectiveCategory === allLabel
      ? listings
      : listings.filter(
          (listing) => listingCategory(listing) === effectiveCategory,
        );
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
    <div
      className={`root-marketplace-page min-h-screen bg-background-subtle text-foreground${clerkOpen ? " is-clerk-open" : ""}`}
      id="top"
    >
      <div className="root-marketplace-atmosphere" aria-hidden="true" />
      <div className="root-marketplace-main">
        <section
          className={`root-marketplace-entry${searchTrace ? " has-results" : ""}`}
          aria-labelledby="root-marketplace-title"
        >
          <section
            className="marketplace-hero"
            aria-label={locale === "en" ? "MatchPlane" : "MatchPlane 商城"}
          >
            <div className="marketplace-hero-inner">
              <p className="marketplace-hero-kicker">
                {locale === "en" ? "MARKETPLACE" : "商城"}
              </p>
              <p className="marketplace-hero-brand root-marketplace-brand">
                {brandName}
              </p>
              <h1 id="root-marketplace-title" className="marketplace-hero-title">
                {locale === "en"
                  ? "Describe what you are looking for."
                  : "说说你想找什么。"}
              </h1>
              <p className="marketplace-hero-support">
                {locale === "en"
                  ? `${brandName} searches public stores and keeps every visible result tied to its source.`
                  : `${brandName} 会检索公开店铺，并保留每个可见结果的真实来源。`}
              </p>
              <ul className="root-marketplace-entry-facts">
                <li>
                  {locale === "en"
                    ? "Browse without signing in"
                    : "无需登录即可浏览"}
                </li>
                <li>
                  {locale === "en" ? "Public listings only" : "只检索公开商品"}
                </li>
                <li>
                  {locale === "en" ? "Sources stay visible" : "结果来源始终可见"}
                </li>
              </ul>
              <div className="marketplace-hero-cta">
                <MarketplaceNeedPrompt
                  locale={locale}
                  onSubmit={(text) => {
                    onWebMcpDescribeNeed(text);
                    setClerkOpen(true);
                  }}
                />
              </div>
            </div>
          </section>
          {searchTrace ? (
            <MarketplaceSearchTrace
              trace={searchTrace}
              locale={locale}
              onOpenStore={onOpenStore}
            />
          ) : null}
          <a className="root-marketplace-scroll-cue" href="#products">
            {locale === "en" ? "Browse what is live" : "浏览当前在售"}
            <span aria-hidden="true">↓</span>
          </a>
        </section>

        <div className="root-marketplace-catalog">
          {categories.length > 1 ? (
            <ToggleGroup
              className="root-marketplace-inline-categories"
              aria-label={locale === "en" ? "Product categories" : "商品分类"}
              value={[effectiveCategory]}
              onValueChange={(next) => {
                if (next[0]) setCategory(next[0]);
              }}
            >
              {categories.map((item) => (
                <Toggle
                  key={item}
                  value={item}
                  aria-label={item}
                  render={
                    <Button
                      className="root-marketplace-category"
                      variant="ghost"
                      size="sm"
                      type="button"
                    >
                      {item}
                    </Button>
                  }
                />
              ))}
            </ToggleGroup>
          ) : null}
          <div className="root-marketplace-content">
            <MarketplaceProducts
              catalogResolved={catalogResolved}
              catalogError={catalogError}
              listings={visibleListings}
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
      <FloatingMarketplaceClerk
        open={clerkOpen}
        locale={locale}
        onOpenChange={setClerkOpen}
      >
        <section
          className="root-marketplace-search"
          aria-label={locale === "en" ? "Product search" : "商品搜索"}
        >
          <div className="root-marketplace-chat-shell">{assistant}</div>
        </section>
      </FloatingMarketplaceClerk>
    </div>
  );
}
