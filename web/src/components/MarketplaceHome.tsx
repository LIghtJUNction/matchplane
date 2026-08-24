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
import { Toggle } from "@appica/ui-react/toggle";
import { ToggleGroup } from "@appica/ui-react/toggle-group";
import { ArrowRight, PackageOpen, RefreshCw, ShoppingBag } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { RecommendedBackendListing } from "../api";
import type { InterfaceLocale, InterfaceTheme } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { FloatingMarketplaceClerk } from "./FloatingMarketplaceClerk";
import { MatchChat } from "./MatchChat";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
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
        onRecommendations: (
                recommendations: RecommendedBackendListing[],
        ) => void;
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
                const timeout = window.setTimeout(
                        () => setShowLongWait(true),
                        2_000,
                );
                return () => window.clearTimeout(timeout);
        }, []);

        return (
                <section
                        className="root-marketplace-loading-state"
                        role="status"
                        aria-label={
                                locale === "en"
                                        ? "Loading products"
                                        : "商品读取中"
                        }
                        aria-busy="true"
                >
                        <div
                                className="root-marketplace-loading"
                                aria-hidden="true"
                        >
                                {[0, 1, 2, 3].map((item) => (
                                        <div
                                                className="root-marketplace-loading-box"
                                                key={item}
                                        >
                                                <Skeleton className="root-marketplace-loading-visual" />
                                                <Skeleton className="root-marketplace-loading-line" />
                                                <Skeleton className="root-marketplace-loading-line is-short" />
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

interface MarketplaceSearchPanelProps {
        locale: InterfaceLocale;
        onLikeListing: (listing: AssetListing) => Promise<void>;
        onNotice: (message: string) => void;
        onOpenListing: (listing: AssetListing) => void;
        onRecommendations: (
                recommendations: RecommendedBackendListing[],
        ) => void;
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
                        aria-label={
                                locale === "en" ? "Product search" : "商品搜索"
                        }
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
                                                onOpen={() =>
                                                        onOpenListing(listing)
                                                }
                                                onLike={() =>
                                                        onLikeListing(listing)
                                                }
                                                key={listing.id}
                                        />
                                ))}
                        </div>
                );
        else if (catalogError)
                content = (
                        <Alert
                                className="root-marketplace-error"
                                variant="error"
                                layout="inline"
                        >
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
                                                ? "The shopping assistant is still available."
                                                : "选货员仍然可用，可以直接描述你的需要。"}
                                </AlertDescription>
                                <AlertAction>
                                        <Button
                                                size="sm"
                                                type="button"
                                                onClick={onRetryCatalog}
                                        >
                                                <RefreshCw aria-hidden="true" />
                                                {locale === "en"
                                                        ? "Retry catalog"
                                                        : "重新读取商品"}
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
                                                        ? "Ask the shopping assistant, or browse the open stores below."
                                                        : "可以询问选货员，也可以浏览下方已营业店铺。"}
                                        </p>
                                </div>
                                <Button
                                        variant="outline"
                                        size="sm"
                                        type="button"
                                        onClick={onPublishProduct}
                                >
                                        {locale === "en"
                                                ? "List a product"
                                                : "发布商品"}
                                        <ArrowRight aria-hidden="true" />
                                </Button>
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
                                        <p>
                                                {locale === "en"
                                                        ? "CURATED PRODUCTS"
                                                        : "精选在售"}
                                        </p>
                                        <h2 id="marketplace-products-title">
                                                {locale === "en"
                                                        ? "Products"
                                                        : "商品"}
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
                                                {locale === "en"
                                                        ? " products"
                                                        : " 件商品"}
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
                        ...Array.from(
                                new Set(
                                        listings
                                                .map(listingCategory)
                                                .filter(Boolean),
                                ),
                        ),
                ],
                [allLabel, listings],
        );
        const effectiveCategory = categories.includes(category)
                ? category
                : allLabel;
        const visibleListings =
                effectiveCategory === allLabel
                        ? listings
                        : listings.filter(
                                  (listing) =>
                                          listingCategory(listing) ===
                                          effectiveCategory,
                          );

        const sparseCatalog = catalogResolved && visibleListings.length <= 2;

        return (
                <div
                        className={`root-marketplace-page min-h-screen bg-background-subtle text-foreground${clerkOpen ? " is-clerk-open" : ""}`}
                        id="top"
                >
                        <div className="root-marketplace-main">
                                <div className="root-marketplace-catalog">
                                        <header className="root-marketplace-catalog-intro">
                                                <div>
                                                        <p>
                                                                {locale === "en"
                                                                        ? "MATCHPLANE MARKET"
                                                                        : "MATCHPLANE 商城"}
                                                        </p>
                                                        <h1>
                                                                {locale === "en"
                                                                        ? "Find products that fit."
                                                                        : "发现适合你的商品"}
                                                        </h1>
                                                        <span>
                                                                {locale === "en"
                                                                        ? "Browse real listings. The shopping assistant can help narrow the choice when needed."
                                                                        : "浏览真实在售商品；需要帮助时，选货员会帮你缩小范围。"}
                                                        </span>
                                                </div>
                                                <div className="root-marketplace-catalog-actions">
                                                        <Button
                                                                variant="outline"
                                                                nativeButton={
                                                                        false
                                                                }
                                                                render={
                                                                        <a href="#stores">
                                                                                {locale ===
                                                                                "en"
                                                                                        ? "Browse stores"
                                                                                        : "浏览店铺"}
                                                                        </a>
                                                                }
                                                        />
                                                        <Button
                                                                type="button"
                                                                onClick={
                                                                        onPublishProduct
                                                                }
                                                        >
                                                                <ShoppingBag aria-hidden="true" />
                                                                {locale === "en"
                                                                        ? "List a product"
                                                                        : "发布商品"}
                                                        </Button>
                                                </div>
                                        </header>
                                        <div className="root-marketplace-concierge">
                                                <MarketplaceSearchPanel
                                                        locale={locale}
                                                        onLikeListing={
                                                                onLikeListing
                                                        }
                                                        onNotice={onNotice}
                                                        onOpenListing={
                                                                onOpenListing
                                                        }
                                                        onRecommendations={
                                                                onRecommendations
                                                        }
                                                        subplatform={
                                                                subplatform
                                                        }
                                                />
                                        </div>
                                        {categories.length > 1 ? (
                                                <ToggleGroup
                                                        className="root-marketplace-inline-categories"
                                                        aria-label={
                                                                locale === "en"
                                                                        ? "Product categories"
                                                                        : "商品分类"
                                                        }
                                                        value={[
                                                                effectiveCategory,
                                                        ]}
                                                        onValueChange={(
                                                                next,
                                                        ) => {
                                                                if (next[0])
                                                                        setCategory(
                                                                                next[0],
                                                                        );
                                                        }}
                                                >
                                                        {categories.map(
                                                                (item) => (
                                                                        <Toggle
                                                                                key={
                                                                                        item
                                                                                }
                                                                                value={
                                                                                        item
                                                                                }
                                                                                aria-label={
                                                                                        item
                                                                                }
                                                                                render={
                                                                                        <Button
                                                                                                className="root-marketplace-category"
                                                                                                variant="ghost"
                                                                                                size="sm"
                                                                                                type="button"
                                                                                        >
                                                                                                {
                                                                                                        item
                                                                                                }
                                                                                        </Button>
                                                                                }
                                                                        />
                                                                ),
                                                        )}
                                                </ToggleGroup>
                                        ) : null}
                                        <div
                                                className={`root-marketplace-content${sparseCatalog ? " is-sparse" : ""}`}
                                        >
                                                <MarketplaceProducts
                                                        catalogResolved={
                                                                catalogResolved
                                                        }
                                                        catalogError={
                                                                catalogError
                                                        }
                                                        listings={
                                                                visibleListings
                                                        }
                                                        locale={locale}
                                                        onOpenListing={
                                                                onOpenListing
                                                        }
                                                        onLikeListing={
                                                                onLikeListing
                                                        }
                                                        onPublishProduct={
                                                                onPublishProduct
                                                        }
                                                        onRetryCatalog={
                                                                onRetryCatalog
                                                        }
                                                />
                                                <div
                                                        className="root-marketplace-stores"
                                                        id="stores"
                                                >
                                                        <StorefrontDirectory
                                                                locale={locale}
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
                                <MarketplaceSearchPanel
                                        locale={locale}
                                        onLikeListing={onLikeListing}
                                        onNotice={onNotice}
                                        onOpenListing={onOpenListing}
                                        onRecommendations={onRecommendations}
                                        subplatform={subplatform}
                                />
                        </FloatingMarketplaceClerk>
                </div>
        );
}
