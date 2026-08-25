"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  MessageCircle,
  Moon,
  PackageOpen,
  Store,
  X,
} from "lucide-react";

import {
  listingIdFromBackend,
  type MallAssistantContactConsentAction,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { MatchChat } from "./MatchChat";
import { StoreContactRequestsPanel } from "./StoreContactRequestsPanel";

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
  canManageStore = false,
  onOpenStoreConsole,
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
  canManageStore?: boolean;
  onOpenStoreConsole?: () => void;
}) {
  const english = locale === "en";
  const [managerOpen, setManagerOpen] = useState(false);
  const status = subplatform.status ?? "active";
  const isInactive = status !== "active";

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
            <div className="storefront-identity-title-row">
              <p>{english ? "STORE" : "店铺"}</p>
              {status === "closed" && (
                <span className="store-status-badge is-closed">
                  <Moon size={12} aria-hidden="true" />
                  {english ? "Closed / Paused" : "已打烊 · 暂停营业"}
                </span>
              )}
              {status === "suspended" && (
                <span className="store-status-badge is-suspended">
                  <AlertTriangle size={12} aria-hidden="true" />
                  {english ? "Suspended" : "已暂停"}
                </span>
              )}
              {status === "pending" && (
                <span className="store-status-badge is-pending">
                  <Clock size={12} aria-hidden="true" />
                  {english ? "Under review" : "审核中"}
                </span>
              )}
            </div>
            <h1>{subplatform.brandName || subplatform.label}</h1>
            <span>
              {subplatform.description ||
                (english
                  ? "Browse this store's currently available products."
                  : "浏览这家店铺当前在售的商品。")}
            </span>
          </div>
        </div>
        {!isInactive ? (
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
        ) : canManageStore && onOpenStoreConsole ? (
          <button
            className="storefront-manager-trigger"
            type="button"
            onClick={onOpenStoreConsole}
          >
            <Store size={17} aria-hidden="true" />
            {english ? "Store console" : "管理店铺 / 恢复营业"}
          </button>
        ) : null}
      </header>

      {/* When the store is closed or suspended, show a prominent status explanation panel */}
      {status === "closed" && (
        <div className="storefront-closed-panel" role="alert">
          <div className="storefront-closed-badge">
            <Moon size={24} aria-hidden="true" />
          </div>
          <h2>{english ? "Store is currently closed" : "该店铺已打烊 · 暂停营业"}</h2>
          <p>
            {english
              ? "The store owner has temporarily paused operations. Products and inquiries are not publicly available right now. All products and records remain safe."
              : "店主已暂时暂停对外营业，暂不接受新的咨询和下单。所有商品数据与客户记录均完整保留。您可以返回商城选购其他好物。"}
          </p>
          <div className="storefront-closed-actions">
            <a href="/" className="button button-dark">
              <ArrowLeft size={16} aria-hidden="true" />
              {english ? "Back to mall home" : "返回商城首页"}
            </a>
            {canManageStore && onOpenStoreConsole ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={onOpenStoreConsole}
              >
                <Store size={16} aria-hidden="true" />
                {english ? "Open store console (Reopen)" : "进入店铺工作台（恢复营业）"}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {status === "suspended" && (
        <div className="storefront-closed-panel is-suspended" role="alert">
          <div className="storefront-closed-badge is-suspended">
            <AlertTriangle size={24} aria-hidden="true" />
          </div>
          <h2>{english ? "Store suspended by platform" : "该店铺已被平台暂停服务"}</h2>
          <p>
            {english
              ? "This store has been suspended by mall management. Please contact platform support for assistance."
              : "该店铺已被商城管理暂停营业，暂时无法公开访问。如有疑问请联系商城管理员。"}
          </p>
          <div className="storefront-closed-actions">
            <a href="/" className="button button-dark">
              <ArrowLeft size={16} aria-hidden="true" />
              {english ? "Back to mall home" : "返回商城首页"}
            </a>
          </div>
        </div>
      )}

      {status === "pending" && (
        <div className="storefront-closed-panel is-pending" role="alert">
          <div className="storefront-closed-badge is-pending">
            <Clock size={24} aria-hidden="true" />
          </div>
          <h2>{english ? "Store onboarding in review" : "店铺资料审核中"}</h2>
          <p>
            {english
              ? "This store is currently being reviewed and will be available once approved."
              : "该店铺接入资料正在审核中，审核通过后将正式开放营业。"}
          </p>
          <div className="storefront-closed-actions">
            <a href="/" className="button button-dark">
              <ArrowLeft size={16} aria-hidden="true" />
              {english ? "Back to mall home" : "返回商城首页"}
            </a>
          </div>
        </div>
      )}

      {managerOpen && !isInactive ? (
        <section
          className="storefront-manager-chat"
          id="store-manager-chat"
          aria-labelledby="store-manager-chat-title"
        >
          <div className="storefront-manager-chat-heading">
            <div>
              <p>{english ? "STORE CHAT" : "店铺咨询"}</p>
              <h2 id="store-manager-chat-title">
                {english
                  ? `Ask ${subplatform.brandName || subplatform.label}`
                  : `咨询${subplatform.brandName || subplatform.label}`}
              </h2>
              <span>
                {english
                  ? "The store team can answer here and join when needed. Contact details are never shared without your confirmation."
                  : "在线解答商品问题；需要时可联系店员。未经你确认，不会交换联系方式。"}
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

      {!isInactive ? (
        <StoreContactRequestsPanel subplatform={subplatform} locale={locale} />
      ) : null}

      {!isInactive ? (
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
      ) : null}
    </div>
  );
}
