"use client";

import {
  ArrowRight,
  History,
  MessageSquarePlus,
  PackageOpen,
  RefreshCw,
  ShoppingBag,
  Store,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { RecommendedBackendListing } from "../api";
import type { InterfaceLocale, InterfaceTheme } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { MatchChat } from "./MatchChat";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { Brand } from "./Primitives";
import { StorefrontDirectory } from "./StorefrontDirectory";

interface MarketplaceHomeProps {
  catalogResolved: boolean;
  catalogError?: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  theme: InterfaceTheme;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onThemeChange: (theme: InterfaceTheme) => void;
  onNotice: (message: string) => void;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onPublishProduct: () => void;
  onRetryCatalog: () => void;
  onRecommendations: (recommendations: RecommendedBackendListing[]) => void;
  subplatform: SubplatformConfig;
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
      <div className="root-marketplace-loading" aria-hidden="true">
        {[0, 1, 2, 3].map((item) => (
          <div className="root-marketplace-loading-box" key={item}>
            <span />
            <span />
            <span />
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

function MarketplaceSidebar({
  categories,
  category,
  locale,
  onCategoryChange,
  onPublishProduct,
  subplatform,
}: {
  categories: string[];
  category: string;
  locale: InterfaceLocale;
  onCategoryChange: (category: string) => void;
  onPublishProduct: () => void;
  subplatform: SubplatformConfig;
}) {
  const selectCategory = (item: string) => {
    onCategoryChange(item);
    window.requestAnimationFrame(() =>
      document
        .querySelector("#products")
        ?.scrollIntoView({ behavior: "smooth" }),
    );
  };
  return (
    <aside
      className="root-marketplace-sidebar"
      aria-label={locale === "en" ? "Marketplace navigation" : "商城导航"}
    >
      <Brand
        label={subplatform.brandName}
        logoUrl={subplatform.brandLogoUrl}
        homeHref="#top"
      />
      <p className="root-marketplace-sidebar-kicker">
        {locale === "en" ? "OPEN ARCHIVE · 001" : "开放档案 · 001"}
      </p>
      <nav className="root-marketplace-sidebar-nav">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new Event("matchplane:new-shopping-conversation"),
            )
          }
        >
          <MessageSquarePlus aria-hidden="true" />
          <span>{locale === "en" ? "New conversation" : "新对话"}</span>
        </button>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new Event("matchplane:open-shopping-history"))
          }
        >
          <History aria-hidden="true" />
          <span>{locale === "en" ? "History" : "历史对话"}</span>
        </button>
        <a href="#products">
          <PackageOpen aria-hidden="true" />
          <span>{locale === "en" ? "Products" : "商品"}</span>
        </a>
        <a href="#stores">
          <Store aria-hidden="true" />
          <span>{locale === "en" ? "Stores" : "店铺"}</span>
        </a>
        <button type="button" onClick={onPublishProduct}>
          <ShoppingBag aria-hidden="true" />
          <span>{locale === "en" ? "Sell" : "发布商品"}</span>
        </button>
      </nav>
      {categories.length > 1 ? (
        <section className="root-marketplace-sidebar-categories">
          <h2>{locale === "en" ? "Category index" : "品类索引"}</h2>
          <div>
            {categories.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={category === item}
                onClick={() => selectCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <p className="root-marketplace-sidebar-footer">
        {locale === "en"
          ? "REAL GOODS · CONSENT BEFORE CONTACT"
          : "真实商品 · 同意后联系"}
      </p>
    </aside>
  );
}

interface MarketplaceSearchPanelProps {
  locale: InterfaceLocale;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onNotice: (message: string) => void;
  onOpenListing: (listing: AssetListing) => void;
  onRecommendations: (recommendations: RecommendedBackendListing[]) => void;
  subplatform: SubplatformConfig;
}

function MarketplaceSearchPanel({
  locale,
  onLikeListing,
  onNotice,
  onOpenListing,
  onRecommendations,
  subplatform,
}: MarketplaceSearchPanelProps) {
  return (
    <section
      className="root-marketplace-search"
      aria-label={locale === "en" ? "Product search" : "商品搜索"}
    >
      <div className="root-marketplace-chat-shell">
        <MatchChat
          home
          compact
          role="buyer"
          locale={locale}
          onLikeListing={onLikeListing}
          onNotice={onNotice}
          onOpenListing={onOpenListing}
          onRecommendations={onRecommendations}
          subplatform={subplatform}
        />
      </div>
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
  onPublishProduct,
  onRetryCatalog,
}: {
  catalogResolved: boolean;
  catalogError: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onPublishProduct: () => void;
  onRetryCatalog: () => void;
}) {
  let content: ReactNode;
  if (!catalogResolved) content = <MarketplaceLoading locale={locale} />;
  else if (listings.length)
    content = (
      <div className="root-marketplace-products-grid">
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
      <div className="root-marketplace-error" role="alert">
        <PackageOpen aria-hidden="true" />
        <strong>
          {locale === "en"
            ? "The product shelf did not load"
            : "商品货架读取失败"}
        </strong>
        <p>
          {locale === "en"
            ? "The clerk is still available beside the shelf."
            : "选货员仍在货架旁，可以直接说说你的需要。"}
        </p>
        <button type="button" onClick={onRetryCatalog}>
          <RefreshCw aria-hidden="true" />
          {locale === "en" ? "Retry catalog" : "重新读取商品"}
        </button>
      </div>
    );
  else
    content = (
      <div className="grid items-center gap-5 py-10 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <PackageOpen
          className="size-6 text-foreground-muted"
          aria-hidden="true"
        />
        <div>
          <strong className="block text-sm font-semibold text-foreground-intense">
            {locale === "en"
              ? "Approved products will appear here"
              : "通过审核的商品会出现在这里"}
          </strong>
          <p className="mt-1 text-sm leading-6 text-foreground-muted">
            {locale === "en"
              ? "Ask the clerk what you need, or browse the live stores below."
              : "问问选货员，或继续浏览下方已营业店铺。"}
          </p>
        </div>
        <button
          className="inline-flex min-h-11 items-center gap-2 border-0 bg-transparent text-sm font-medium text-foreground-strong underline-offset-4 hover:underline"
          type="button"
          onClick={onPublishProduct}
        >
          {locale === "en" ? "List a product" : "商家发布商品"}
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
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
          <p>{locale === "en" ? "SHELF 01 · LIVE" : "货架 01 · 实时上架"}</p>
          <h2 id="marketplace-products-title">
            {locale === "en" ? "Products" : "商品"}
          </h2>
          <span>
            {locale === "en"
              ? "Pull a box to inspect the real listing."
              : "抽出一个档案盒，查看真实商品。"}
          </span>
        </div>
        {listings.length ? (
          <strong className="root-marketplace-inventory-count">
            <span>{String(listings.length).padStart(2, "0")}</span>
            {locale === "en" ? " boxes" : " 件"}
          </strong>
        ) : null}
      </div>
      {content}
    </section>
  );
}

export function MarketplaceHome({
  catalogResolved,
  catalogError = false,
  listings,
  locale,
  onNotice,
  onOpenListing,
  onLikeListing,
  onPublishProduct,
  onRetryCatalog,
  onRecommendations,
  subplatform,
}: MarketplaceHomeProps) {
  const allLabel = locale === "en" ? "All" : "全部";
  const [category, setCategory] = useState(allLabel);
  const [clerkOpen, setClerkOpen] = useState(false);
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

  useEffect(() => {
    if (!clerkOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClerkOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [clerkOpen]);

  return (
    <div
      className={`root-marketplace-page min-h-screen bg-background-subtle text-foreground${clerkOpen ? " is-clerk-open" : ""}`}
    >
      <div className="root-marketplace-atmosphere" aria-hidden="true" />
      <MarketplaceSidebar
        categories={categories}
        category={effectiveCategory}
        locale={locale}
        onCategoryChange={setCategory}
        onPublishProduct={onPublishProduct}
        subplatform={subplatform}
      />
      <div className="root-marketplace-main">
        <div className="root-marketplace-catalog">
          <header className="root-marketplace-catalog-intro">
            <p>
              {locale === "en"
                ? "MATCHPLANE MARKET · OPEN"
                : "MATCHPLANE 商城 · 营业中"}
            </p>
            <h1>
              {locale === "en"
                ? "Browse and ask, side by side."
                : "边逛，边问。"}
            </h1>
            <span>
              {locale === "en"
                ? "Real listings stay on the shelf while the clerk helps you narrow the choice."
                : "货架上是真实在售商品；选货员在旁边，随时帮你缩小范围。"}
            </span>
          </header>
          {categories.length > 1 ? (
            <fieldset className="root-marketplace-inline-categories">
              <legend className="sr-only">
                {locale === "en" ? "Product categories" : "商品分类"}
              </legend>
              {categories.map((item) => (
                <button
                  className="root-marketplace-category"
                  key={item}
                  type="button"
                  aria-pressed={effectiveCategory === item}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </fieldset>
          ) : null}
          <MarketplaceProducts
            catalogResolved={catalogResolved}
            catalogError={catalogError}
            listings={visibleListings}
            locale={locale}
            onOpenListing={onOpenListing}
            onLikeListing={onLikeListing}
            onPublishProduct={onPublishProduct}
            onRetryCatalog={onRetryCatalog}
          />
          <div className="root-marketplace-stores" id="stores">
            <StorefrontDirectory locale={locale} />
          </div>
        </div>
        <aside
          className="root-marketplace-stage"
          id="marketplace-chat"
          aria-label={locale === "en" ? "Shopping clerk" : "选货员"}
        >
          <header className="root-marketplace-clerk-heading">
            <div>
              <p>{locale === "en" ? "COUNTER 01" : "柜台 01"}</p>
              <h2>{locale === "en" ? "Shopping clerk" : "选货员"}</h2>
              <span>
                <i aria-hidden="true" />
                {locale === "en"
                  ? "Ready beside the shelf"
                  : "在货架旁，随时可以问"}
              </span>
            </div>
            <button
              className="root-marketplace-clerk-close"
              type="button"
              aria-label={locale === "en" ? "Close clerk" : "关闭选货员"}
              onClick={() => setClerkOpen(false)}
            >
              ×
            </button>
          </header>
          <MarketplaceSearchPanel
            locale={locale}
            onLikeListing={onLikeListing}
            onNotice={onNotice}
            onOpenListing={onOpenListing}
            onRecommendations={onRecommendations}
            subplatform={subplatform}
          />
        </aside>
      </div>
      <button
        className="root-marketplace-clerk-toggle"
        type="button"
        aria-expanded={clerkOpen}
        aria-controls="marketplace-chat"
        onClick={() => setClerkOpen(true)}
      >
        <MessageSquarePlus aria-hidden="true" />
        <span>{locale === "en" ? "Ask the clerk" : "问选货员"}</span>
      </button>
      {clerkOpen ? (
        <button
          className="root-marketplace-clerk-scrim"
          type="button"
          aria-label={locale === "en" ? "Close clerk" : "关闭选货员"}
          onClick={() => setClerkOpen(false)}
        />
      ) : null}
    </div>
  );
}
