"use client";

import { Button } from "@appica/ui-react/button";
import { ArrowRight, Heart } from "lucide-react";
import { useState } from "react";

import { listingIdFromBackend } from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import type { AssetListing } from "../types";

function likeLabel(
  locale: InterfaceLocale,
  title: string,
  viewerLikeCount: number,
  likeTotal: string,
) {
  if (locale === "en") {
    return viewerLikeCount >= 5
      ? `${title}: 5 of 5 likes given, ${likeTotal} total`
      : `Like ${title}: ${viewerLikeCount} of 5 given, ${likeTotal} total`;
  }
  return viewerLikeCount >= 5
    ? `${title}：已点 5 个赞，达到上限，共 ${likeTotal} 个赞`
    : `给${title}点赞：已点 ${viewerLikeCount}/5，共 ${likeTotal} 个赞`;
}

export function MarketplaceListingCard({
  listing,
  locale,
  onOpen,
  onLike,
  compact = false,
}: {
  listing: AssetListing;
  locale: InterfaceLocale;
  onOpen: () => void;
  onLike?: () => Promise<void>;
  compact?: boolean;
}) {
  const [liking, setLiking] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const viewerLikeCount = listing.viewerLikeCount ?? 0;
  const likeTotal = listing.likeTotal ?? "0";
  const likeOfferId = listing.offerId ?? listingIdFromBackend(listing);
  const likeEnabled = Boolean(onLike && likeOfferId);
  const sellerLabel = listing.storeName || listing.seller || listing.subtitle;
  const showSubtitle = Boolean(
    listing.subtitle && listing.subtitle !== sellerLabel,
  );

  return (
    <article
      className={`marketplace-product-card grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4 lg:block lg:py-0${compact ? " is-chat-recommendation" : ""}`}
    >
      <div className="relative aspect-[3/2] overflow-hidden rounded-xl bg-background-muted">
        {listing.imageUrl && !imageFailed ? (
          <img
            className="h-full w-full object-cover"
            src={listing.imageUrl}
            alt={listing.title}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div
            className="grid h-full place-items-center text-sm font-semibold text-foreground-muted"
            role="img"
            aria-label={listing.title}
          >
            {listing.title.slice(0, 2)}
          </div>
        )}
        {likeEnabled ? (
          <Button
            className="marketplace-like-button absolute right-2 top-2 bg-background/90"
            type="button"
            variant="ghost"
            aria-label={likeLabel(
              locale,
              listing.title,
              viewerLikeCount,
              likeTotal,
            )}
            aria-pressed={viewerLikeCount > 0}
            disabled={liking || viewerLikeCount >= 5}
            title={
              viewerLikeCount >= 5
                ? locale === "en"
                  ? "Like limit reached (5)"
                  : "已达点赞上限（5）"
                : undefined
            }
            onClick={() => {
              if (!onLike || viewerLikeCount >= 5) return;
              setLiking(true);
              void onLike().finally(() => setLiking(false));
            }}
          >
            <Heart
              fill={viewerLikeCount > 0 ? "currentColor" : "none"}
              aria-hidden="true"
            />
            <span aria-live="polite">{likeTotal}</span>
          </Button>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col lg:px-1 lg:pt-4">
        <div className="flex items-center justify-between gap-2 text-xs text-foreground-muted">
          <span className="truncate">{sellerLabel}</span>
        </div>
        <button
          className="mt-1 line-clamp-2 text-left text-base font-semibold leading-snug text-foreground-intense"
          type="button"
          onClick={onOpen}
        >
          {listing.title}
        </button>
        {showSubtitle ? (
          <p className="mt-1 line-clamp-1 text-sm text-foreground-muted">
            {listing.subtitle}
          </p>
        ) : null}
        <div className="mt-auto flex flex-col items-start gap-1 pt-3 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <strong className="break-words text-base font-semibold text-foreground-intense sm:text-lg">
            {listing.price}
          </strong>
          <button
            className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-foreground-muted underline-offset-4 hover:underline"
            type="button"
            onClick={onOpen}
          >
            {locale === "en" ? "View product" : "查看商品"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </article>
  );
}
