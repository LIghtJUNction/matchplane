"use client";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@appica/ui-react/alert";
import { Button, buttonVariants } from "@appica/ui-react/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@appica/ui-react/dialog";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  MessageCircle,
  Moon,
  PackageOpen,
  RefreshCw,
  Store,
  X,
} from "lucide-react";

import {
  listingIdFromBackend,
  type MallAssistantContactConsentAction,
  type MarketplaceContactResponse,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import { subplatformCopy, type SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";
import { MarketplaceListingCard } from "./MarketplaceListingCard";
import { MatchChat } from "./MatchChat";
import { StoreContactRequestsPanel } from "./StoreContactRequestsPanel";

/** A public store is a browse surface: identity, introduction, and products only. */
export function StorefrontView({
  catalogResolved,
  catalogError = false,
  listings,
  onRetryCatalog,
  locale,
  onOpenListing,
  onLikeListing,
  onNotice = () => undefined,
  onHumanHandoff,
  onContactConsent,
  onContactRetrieve,
  subplatform,
  canManageStore = false,
  onOpenStoreConsole,
}: {
  catalogResolved: boolean;
  catalogError?: boolean;
  listings: AssetListing[];
  onRetryCatalog?: () => void;
  locale: InterfaceLocale;
  onOpenListing: (listing: AssetListing) => void;
  onLikeListing?: (listing: AssetListing) => Promise<void>;
  onNotice?: (message: string) => void;
  onHumanHandoff?: (input: {
    requestId: string;
    conversionAttemptId: string;
    intent: "warm" | "high" | "urgent";
    productIds: string[];
  }) => Promise<void>;
  onContactConsent?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<unknown>;
  onContactRetrieve?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<MarketplaceContactResponse | null>;
  subplatform: SubplatformConfig;
  canManageStore?: boolean;
  onOpenStoreConsole?: () => void;
}) {
  const english = locale === "en";
  const [managerOpen, setManagerOpen] = useState(false);
  const status = subplatform.status ?? "active";
  const isInactive = status !== "active";
  const verticalCopy = (
    key: string,
    chineseFallback: string,
    englishFallback: string,
  ) =>
    subplatformCopy(
      subplatform,
      english ? `${key}En` : key,
      english ? englishFallback : chineseFallback,
    );

  return (
    <div className="storefront-view root-storefront-page">
      <header className="storefront-view-header">
        <a
          href="/"
          data-slot="button"
          className={buttonVariants({
            variant: "ghost",
            size: "md",
            className:
              "min-h-11 justify-start px-0 text-[var(--retail-blue)] text-sm font-semibold",
          })}
        >
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
        {isInactive ? (
          canManageStore && onOpenStoreConsole ? (
            <Button
              variant="primary"
              size="md"
              className="mt-5 min-h-11 w-full justify-center gap-2 rounded-full px-4 text-sm font-semibold sm:w-auto"
              type="button"
              onClick={onOpenStoreConsole}
            >
              <Store size={17} aria-hidden="true" />
              {english ? "Store console" : "管理店铺 / 恢复营业"}
            </Button>
          ) : null
        ) : (
          <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
            <DialogTrigger
              render={
                <Button
                  variant="primary"
                  size="md"
                  className="mt-5 min-h-11 w-full justify-center gap-2 rounded-full px-4 text-sm font-semibold sm:w-auto"
                  type="button"
                  aria-controls="store-manager-chat"
                >
                  <MessageCircle size={17} aria-hidden="true" />
                  {english ? "Chat with store manager" : "与店长对话"}
                </Button>
              }
            />
            <DialogContent
              className="storefront-manager-dialog"
              closeButton={false}
              closeLabel={english ? "Close manager chat" : "关闭店长对话"}
              frame={false}
              id="store-manager-chat"
              viewportProps={{
                className: "storefront-manager-dialog-viewport",
              }}
            >
              <DialogHeader className="storefront-manager-dialog-header">
                <div>
                  <DialogTitle id="store-manager-chat-title">
                    {english
                      ? `Ask ${subplatform.brandName || subplatform.label}`
                      : `咨询${subplatform.brandName || subplatform.label}`}
                  </DialogTitle>
                  <DialogDescription>
                    {english
                      ? "The AI manager can keep helping while store staff join when needed. Contact details are never shared without your confirmation."
                      : "AI 店长会持续回答；需要时可通知店员介入。未经你确认，不会交换联系方式。"}
                  </DialogDescription>
                </div>
                <DialogClose
                  render={
                    <Button
                      variant="ghost"
                      size="icon-md"
                      type="button"
                      aria-label={
                        english ? "Close manager chat" : "关闭店长对话"
                      }
                    >
                      <X size={18} aria-hidden="true" />
                    </Button>
                  }
                />
              </DialogHeader>
              <DialogBody className="storefront-manager-dialog-body">
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
                  onContactRetrieve={onContactRetrieve}
                />
              </DialogBody>
            </DialogContent>
          </Dialog>
        )}
      </header>

      {/* When the store is closed or suspended, show a prominent status explanation panel */}
      {status === "closed" && (
        <div className="storefront-closed-panel" role="alert">
          <div className="storefront-closed-badge">
            <Moon size={24} aria-hidden="true" />
          </div>
          <h2>
            {english ? "Store is currently closed" : "该店铺已打烊 · 暂停营业"}
          </h2>
          <p>
            {english
              ? "The store owner has temporarily paused operations. Products and inquiries are not publicly available right now. All products and records remain safe."
              : "店主已暂时暂停对外营业，暂不接受新的咨询和下单。所有商品数据与客户记录均完整保留。您可以返回商城选购其他好物。"}
          </p>
          <div className="storefront-closed-actions">
            <a
              href="/"
              data-slot="button"
              className={buttonVariants({
                variant: "primary",
                size: "md",
                className: "min-h-11",
              })}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {english ? "Back to mall home" : "返回商城首页"}
            </a>
            {canManageStore && onOpenStoreConsole ? (
              <Button
                variant="outline"
                size="md"
                className="min-h-11"
                type="button"
                onClick={onOpenStoreConsole}
              >
                <Store size={16} aria-hidden="true" />
                {english
                  ? "Open store console (Reopen)"
                  : "进入店铺工作台（恢复营业）"}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {status === "suspended" && (
        <div className="storefront-closed-panel is-suspended" role="alert">
          <div className="storefront-closed-badge is-suspended">
            <AlertTriangle size={24} aria-hidden="true" />
          </div>
          <h2>
            {english ? "Store suspended by platform" : "该店铺已被平台暂停服务"}
          </h2>
          <p>
            {english
              ? "This store has been suspended by mall management. Please contact platform support for assistance."
              : "该店铺已被商城管理暂停营业，暂时无法公开访问。如有疑问请联系商城管理员。"}
          </p>
          <div className="storefront-closed-actions">
            <a
              href="/"
              data-slot="button"
              className={buttonVariants({
                variant: "primary",
                size: "md",
                className: "min-h-11",
              })}
            >
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
            <a
              href="/"
              data-slot="button"
              className={buttonVariants({
                variant: "primary",
                size: "md",
                className: "min-h-11",
              })}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {english ? "Back to mall home" : "返回商城首页"}
            </a>
          </div>
        </div>
      )}

      {!isInactive ? (
        <StoreContactRequestsPanel subplatform={subplatform} locale={locale} />
      ) : null}

      {isInactive ? null : (
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
          {catalogError ? (
            <Alert
              className="storefront-catalog-error"
              variant="error"
              layout="inline"
            >
              <AlertIcon>
                <AlertTriangle aria-hidden="true" />
              </AlertIcon>
              <div>
                <AlertTitle>
                  {english ? "Products could not load" : "商品暂时无法读取"}
                </AlertTitle>
                <AlertDescription>
                  {english
                    ? "Your place in the store is unchanged. Retry the catalog when the service is available."
                    : "当前店铺与操作不会丢失；服务恢复后可重新读取商品。"}
                </AlertDescription>
              </div>
              {onRetryCatalog ? (
                <AlertAction>
                  <Button
                    variant="primary-outline"
                    size="sm"
                    type="button"
                    onClick={onRetryCatalog}
                  >
                    <RefreshCw size={15} aria-hidden="true" />
                    {english ? "Retry" : "重新加载"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          ) : catalogResolved ? (
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
                    {canManageStore
                      ? verticalCopy(
                          "emptyManagerTitle",
                          "还没有发布商品",
                          "No products are published yet",
                        )
                      : verticalCopy(
                          "emptyBuyerTitle",
                          "这家店暂时没有在售商品",
                          "This store has no active listings yet",
                        )}
                  </strong>
                  <p>
                    {canManageStore
                      ? verticalCopy(
                          "emptyManagerDescription",
                          "添加真实商品资料，审核通过后即可对外展示。",
                          "Add a real product. It becomes public after review.",
                        )
                      : verticalCopy(
                          "emptyBuyerDescription",
                          "可以先咨询店长，或继续浏览其他店铺。",
                          "Ask the store manager or continue browsing other stores.",
                        )}
                  </p>
                </div>
                <div className="storefront-view-empty-actions">
                  {canManageStore && onOpenStoreConsole ? (
                    <Button
                      variant="primary"
                      size="sm"
                      className="min-h-11"
                      type="button"
                      onClick={onOpenStoreConsole}
                    >
                      {verticalCopy(
                        "emptyManagerAction",
                        "添加第一个商品",
                        "Add the first product",
                      )}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        className="min-h-11"
                        type="button"
                        onClick={() => setManagerOpen(true)}
                      >
                        <MessageCircle size={15} aria-hidden="true" />
                        {verticalCopy(
                          "emptyBuyerAiAction",
                          "咨询店长",
                          "Ask the store manager",
                        )}
                      </Button>
                      <a
                        href="/"
                        data-slot="button"
                        className={buttonVariants({
                          variant: "ghost",
                          size: "md",
                          className: "min-h-11 text-[var(--retail-blue)]",
                        })}
                      >
                        {verticalCopy(
                          "emptyBrowseAction",
                          "浏览其他店铺",
                          "Browse other stores",
                        )}
                      </a>
                    </>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="storefront-view-loading" role="status">
              {english ? "Loading products…" : "正在读取商品…"}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
