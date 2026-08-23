"use client";

import { useState } from "react";
import { ArrowLeft, MessageCircle, PackageOpen, Store, X } from "lucide-react";

import {
  listingIdFromBackend,
  type MallAssistantContactConsentAction,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { MatchChat } from "./MatchChat";

/** A public store is a browse surface: identity, introduction, and products only. */
export function StorefrontView({
  catalogResolved,
  listings,
  locale,
  onOpenListing,
  onLikeListing,
  onNotice = () => undefined,
  onHumanHandoff,
  onContactConsent,
  subplatform,
}: {
  catalogResolved: boolean;
  listings: AssetListing[];
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing?: (listing: AssetListing) => Promise<void>;
  onNotice?: (message: string) => void;
  onHumanHandoff?: (input: {
    requestId: string;
    summary: string;
    intent: "warm" | "high" | "urgent";
    productIds: string[];
  }) => Promise<void>;
  onContactConsent?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<void>;
  subplatform: SubplatformConfig;
}) {
  const english = locale === "en";
  const [managerOpen, setManagerOpen] = useState(false);
  return (
    <div className="storefront-view root-storefront-page">
      <header className="storefront-view-header">
        <a className="storefront-view-back" href="/">
          <ArrowLeft size={17} aria-hidden="true" />
          {english ? "Back to mall" : "返回商城"}
        </a>
        <div className="storefront-view-identity">
          <span className="storefront-view-mark" aria-hidden="true">
            {subplatform.brandLogoUrl ? (
              <img src={subplatform.brandLogoUrl} alt="" />
            ) : (
              <Store size={23} />
            )}
          </span>
          <div>
            <p>{english ? "STORE" : "店铺"}</p>
            <h1>{subplatform.brandName || subplatform.label}</h1>
            <span>
              {subplatform.description ||
                (english
                  ? "Browse this store's currently available products."
                  : "浏览这家店铺当前在售的商品。")}
            </span>
          </div>
        </div>
        <button
          className="storefront-manager-trigger"
          type="button"
          aria-expanded={managerOpen}
          aria-controls="store-manager-chat"
          onClick={() => setManagerOpen((current) => !current)}
        >
          <MessageCircle size={17} aria-hidden="true" />
          {english ? "Chat with store manager" : "与店长对话"}
        </button>
      </header>

      {managerOpen ? (
        <section
          className="storefront-manager-chat"
          id="store-manager-chat"
          aria-labelledby="store-manager-chat-title"
        >
          <div className="storefront-manager-chat-heading">
            <div>
              <p>{english ? "AI STORE MANAGER" : "AI 店长"}</p>
              <h2 id="store-manager-chat-title">
                {english
                  ? `Ask ${subplatform.brandName || subplatform.label}`
                  : `咨询${subplatform.brandName || subplatform.label}`}
              </h2>
              <span>
                {english
                  ? "The AI manager can keep helping while store staff join when needed. Contact details are never shared without your confirmation."
                  : "AI 店长会持续回答；需要时可通知店员介入。未经你确认，不会交换联系方式。"}
              </span>
            </div>
            <button
              type="button"
              aria-label={english ? "Close manager chat" : "关闭店长对话"}
              onClick={() => setManagerOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <MatchChat
            compact
            locale={locale}
            role="buyer"
            subplatform={subplatform}
            onNotice={onNotice}
            onOpenListing={onOpenListing}
            onLikeListing={onLikeListing}
            onHumanHandoff={onHumanHandoff}
            onContactConsent={onContactConsent}
          />
        </section>
      ) : null}

      <main className="storefront-view-products" id="store-products">
        <div className="storefront-view-products-heading">
          <h2>{english ? "Products" : "商品"}</h2>
          {catalogResolved ? (
            <span>
              {english
                ? `${listings.length} listed`
                : `${listings.length} 件在售`}
            </span>
          ) : null}
        </div>
        {catalogResolved ? (
          listings.length ? (
            <div className="grid grid-cols-1 gap-0 lg:grid-cols-4 lg:gap-5">
              {listings.map((listing) => (
                <MarketplaceListingCard
                  key={listing.id}
                  listing={listing}
                  locale={locale}
                  onOpen={() => onOpenListing(listing)}
                  onLike={
                    onLikeListing &&
                    (listing.offerId ?? listingIdFromBackend(listing))
                      ? () => onLikeListing(listing)
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="storefront-view-empty">
              <PackageOpen size={24} aria-hidden="true" />
              <div>
                <strong>
                  {english
                    ? "No products are listed yet"
                    : "这家店暂时没有在售商品"}
                </strong>
                <p>
                  {english
                    ? "You can return to the mall and continue browsing other stores."
                    : "可以返回商城继续看看其他店铺。"}
                </p>
              </div>
              <a href="/">{english ? "Browse other stores" : "浏览其他店铺"}</a>
            </div>
          )
        ) : (
          <div className="storefront-view-loading" role="status">
            {english ? "Loading products…" : "正在读取商品…"}
          </div>
        )}
      </main>
    </div>
  );
}
