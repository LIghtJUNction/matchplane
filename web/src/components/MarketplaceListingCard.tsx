"use client";

import { Button } from "@appica/ui-react/button";
import { Heart, ImageOff } from "lucide-react";
import { useState } from "react";

import { listingIdFromBackend } from "../api";
import { isCategoryFact } from "../lib/catalog-browse";
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

/** Store-provided facts only; root cards must not assume a product vertical. */
function keySpecs(listing: AssetListing) {
  const values = listing.facts
    .filter((fact) => !isCategoryFact(fact))
    .map((fact) => fact.value.trim())
    .filter(Boolean);
  if (listing.location?.trim()) values.push(listing.location.trim());
  return Array.from(new Set(values)).slice(0, 3).join(" · ");
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
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const imageUrl = listing.imageUrl || listing.imageUrls?.[0];
  const viewerLikeCount = listing.viewerLikeCount ?? 0;
  const likeTotal = listing.likeTotal ?? "0";
  const likeOfferId = listing.offerId ?? listingIdFromBackend(listing);
  const likeEnabled = Boolean(onLike && likeOfferId);
  const sellerLabel = listing.storeName || listing.seller || listing.subtitle;
  const specs =
    keySpecs(listing) ||
    (listing.subtitle === sellerLabel ? "" : listing.subtitle);
  const matchReasons = compact
    ? Array.from(
        new Set(
          (listing.reasons ?? [])
            .map((reason) => reason.trim())
            .filter((reason) => reason.length > 0),
        ),
      ).slice(0, 3)
    : [];

  return (
    <article
      className={`marketplace-product-card${compact ? " is-chat-recommendation" : ""}`}
      data-accent={listing.accent || "cactus"}
    >
      <div className="marketplace-product-media">
        {imageUrl && failedImage !== imageUrl ? (
          <img
            src={imageUrl}
            alt={listing.title}
            loading="lazy"
            decoding="async"
            width={640}
            height={480}
            onError={() => setFailedImage(imageUrl)}
          />
        ) : (
          <div
            className="marketplace-product-fallback"
            role="img"
            aria-label={listing.title}
          >
            <ImageOff size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>{locale === "en" ? "No photo available" : "暂无图片"}</span>
          </div>
        )}
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
      <div className="marketplace-product-info">
        <button
          className="marketplace-product-title"
          type="button"
          onClick={onOpen}
        >
          {listing.title}
        </button>
        {specs ? (
          <p className="marketplace-product-specs" title={specs}>
            {specs}
          </p>
        ) : null}
        <div className="marketplace-product-price-row">
          <strong>
            {listing.price || (locale === "en" ? "Ask for price" : "价格待询")}
          </strong>
          {listing.priceLabel ? <span>{listing.priceLabel}</span> : null}
        </div>
        {sellerLabel ? (
          <div className="marketplace-product-origin">
            <i aria-hidden="true" />
            <span>{sellerLabel}</span>
          </div>
        ) : null}
        {matchReasons.length ? (
          <ul
            className="marketplace-product-match-reasons"
            aria-label={locale === "en" ? "Why it matches" : "匹配理由"}
          >
            {matchReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
