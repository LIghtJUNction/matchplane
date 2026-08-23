"use client";

import {
  ArrowRight,
  History,
  MessageSquarePlus,
  PackageOpen,
  ShoppingBag,
  Store,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

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
  return (
    <div
      className="grid gap-3 lg:grid-cols-4"
      role="status"
      aria-label={locale === "en" ? "Loading products" : "商品读取中"}
      aria-busy="true"
    >
      {[0, 1, 2, 3].map((item) => (
        <div
          className="h-40 animate-pulse rounded-xl bg-background-muted motion-reduce:animate-none"
          key={item}
        />
      ))}
    </div>
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
          <h2>{locale === "en" ? "Categories" : "分类"}</h2>
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
    </aside>
  );
}

interface MarketplaceSearchPanelProps {
  categories: string[];
  category: string;
  locale: InterfaceLocale;
  onCategoryChange: (category: string) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onNotice: (message: string) => void;
  onOpenListing: (listing: AssetListing) => void;
  onRecommendations: (recommendations: RecommendedBackendListing[]) => void;
  subplatform: SubplatformConfig;
}

function MarketplaceSearchPanel({
  categories,
  category,
  locale,
  onCategoryChange,
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
                aria-pressed={category === item}
                onClick={() => onCategoryChange(item)}
              >
                {item}
              </button>
            ))}
          </fieldset>
        ) : null}
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
}: {
  catalogResolved: boolean;
  catalogError: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing: (listing: AssetListing) => Promise<void>;
  onPublishProduct: () => void;
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
      <div className="py-10 text-sm leading-6 text-foreground-muted" role="alert">
        {locale === "en"
          ? "Product catalog is temporarily unavailable. You can still try describing what you need above."
          : "商品目录暂时不可用。你仍可在上方描述需求，稍后再试。"}
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
              ? "You can still describe what you need above, or browse the live stores below."
              : "现在仍可在上方描述需求，或继续浏览下方已营业店铺。"}
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
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h2
            className="text-2xl font-semibold tracking-[-0.03em] text-foreground-intense"
            id="marketplace-products-title"
          >
            {locale === "en" ? "Products" : "商品"}
          </h2>
        </div>
        {listings.length ? (
          <span className="text-sm text-foreground-muted">
            {locale === "en"
              ? `${listings.length} listed`
              : `${listings.length} 件`}
          </span>
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
  theme,
  onLocaleChange,
  onThemeChange,
  onNotice,
  onOpenListing,
  onLikeListing,
  onPublishProduct,
  onRecommendations,
  subplatform,
}: MarketplaceHomeProps) {
  const allLabel = locale === "en" ? "All" : "全部";
  const [category, setCategory] = useState(allLabel);
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

  return (
    <div className="root-marketplace-page min-h-screen bg-background-subtle text-foreground">
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
        <section className="root-marketplace-stage" id="marketplace-chat">
          <MarketplaceSearchPanel
            categories={categories}
            category={effectiveCategory}
            locale={locale}
            onCategoryChange={setCategory}
            onLikeListing={onLikeListing}
            onNotice={onNotice}
            onOpenListing={onOpenListing}
            onRecommendations={onRecommendations}
            subplatform={subplatform}
          />
        </section>
        <MarketplaceProducts
          catalogResolved={catalogResolved}
          catalogError={catalogError}
          listings={visibleListings}
          locale={locale}
          onOpenListing={onOpenListing}
          onLikeListing={onLikeListing}
          onPublishProduct={onPublishProduct}
        />
        <div className="root-marketplace-stores" id="stores">
          <StorefrontDirectory locale={locale} />
        </div>
      </div>
    </div>
  );
}
