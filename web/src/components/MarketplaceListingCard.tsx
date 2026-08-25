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
  const archiveCode = (listing.offerId ?? listing.id)
    .replace(/[^a-z0-9]/gi, "")
    .slice(-6)
    .toUpperCase()
    .padStart(6, "0");

  return (
    <article
      className={`marketplace-product-card${compact ? " is-chat-recommendation" : ""}`}
      data-accent={listing.accent || "cactus"}
    >
      <div className="marketplace-product-box">
        <div className="marketplace-product-lid" aria-hidden="true" />
        <div className="marketplace-product-media">
          {listing.imageUrl && !imageFailed ? (
            <img
              src={listing.imageUrl}
              alt={listing.title}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div
              className="marketplace-product-fallback"
              role="img"
              aria-label={listing.title}
            >
              <span>{listing.title.slice(0, 2)}</span>
            </div>
          )}
          <span className="marketplace-product-code" aria-hidden="true">
            MP-{archiveCode}
          </span>
          {likeEnabled ? (
            <Button
              className="marketplace-like-button"
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
                void onLike()
                  .catch(() => undefined)
                  .finally(() => setLiking(false));
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
        <div className="marketplace-product-end-label">
          <div className="marketplace-product-origin">
            <i aria-hidden="true" />
            <span>{sellerLabel}</span>
          </div>
          <button
            className="marketplace-product-title"
            type="button"
            onClick={onOpen}
          >
            {listing.title}
          </button>
          {showSubtitle ? (
            <p className="marketplace-product-subtitle">{listing.subtitle}</p>
          ) : null}
          <div className="marketplace-product-price-row">
            <strong>{listing.price}</strong>
            <button type="button" onClick={onOpen}>
              {locale === "en" ? "View product" : "查看商品"}
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
