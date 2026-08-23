"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  browseMallCatalog,
  getMarketplaceOfferLikes,
  listingIdFromBackend,
  MarketplaceApiError,
  setMarketplaceOfferLikeCount,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import { mapRecommendations } from "../marketplace-listings";
import type { SubplatformConfig } from "../subplatform";
import type { AssetListing } from "../types";

interface UseMarketplaceCatalogOptions {
  hydrated: boolean;
  locale: InterfaceLocale;
  subplatform: SubplatformConfig;
  authUserId?: string | null;
  onAuthRequired: () => void;
  onNotice: (message: string) => void;
}

export function useMarketplaceCatalog({
  hydrated,
  locale,
  subplatform,
  authUserId,
  onAuthRequired,
  onNotice,
}: UseMarketplaceCatalogOptions) {
  const [listings, setListings] = useState<AssetListing[]>([]);
  const [catalogResolved, setCatalogResolved] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [listing, setListing] = useState<AssetListing | null>(null);
  const catalogInteractionRef = useRef(false);
  const catalogPathRef = useRef(subplatform.path);

  useEffect(() => {
    let cancelled = false;
    if (!hydrated) {
      return () => {
        cancelled = true;
      };
    }
    if (catalogPathRef.current !== subplatform.path) {
      catalogPathRef.current = subplatform.path;
      catalogInteractionRef.current = false;
    }
    setCatalogResolved(false);
    setCatalogError(false);
    void browseMallCatalog(
      subplatform.slug === "root" ? {} : { storePath: subplatform.path },
    )
      .then(({ recommendations }) => {
        if (!cancelled && !catalogInteractionRef.current) {
          setListings(mapRecommendations(recommendations, subplatform, locale));
          setCatalogError(false);
        }
      })
      .catch(() => {
        if (!cancelled && !catalogInteractionRef.current) {
          setListings([]);
          setCatalogError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, locale, subplatform, subplatform.path, subplatform.slug]);

  const listingOfferIds = listings
    .flatMap((item) => item.offerId ?? listingIdFromBackend(item) ?? [])
    .filter((offerId, position, all) => all.indexOf(offerId) === position)
    .sort((left, right) => left.localeCompare(right))
    .join(",");

  useEffect(() => {
    let cancelled = false;
    if (!authUserId || !listingOfferIds) {
      if (!authUserId) {
        setListings((current) =>
          current.map((item) =>
            item.viewerLikeCount ? { ...item, viewerLikeCount: 0 } : item,
          ),
        );
      }
      return () => {
        cancelled = true;
      };
    }
    void getMarketplaceOfferLikes(listingOfferIds.split(","))
      .then((states) => {
        if (cancelled) return;
        const byOfferId = new Map(
          states.map((state) => [state.offerId, state]),
        );
        setListings((current) =>
          current.map((item) => {
            const offerId = item.offerId ?? listingIdFromBackend(item);
            const state = offerId ? byOfferId.get(offerId) : undefined;
            return state
              ? {
                  ...item,
                  likeTotal: state.likeTotal,
                  viewerLikeCount: state.viewerLikeCount,
                }
              : item;
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authUserId, listingOfferIds]);

  const likeListing = useCallback(
    async (target: AssetListing) => {
      if (!authUserId) {
        onAuthRequired();
        return;
      }
      const offerId = target.offerId ?? listingIdFromBackend(target);
      if (!offerId) {
        onNotice("这个商品暂不支持点赞");
        return;
      }
      const expectedCount = target.viewerLikeCount ?? 0;
      if (expectedCount >= 5) return;
      try {
        const state = await setMarketplaceOfferLikeCount({
          offerId,
          count: expectedCount + 1,
          expectedCount,
        });
        const applyState = (item: AssetListing) =>
          (item.offerId ?? listingIdFromBackend(item)) === offerId
            ? {
                ...item,
                likeTotal: state.likeTotal,
                viewerLikeCount: state.viewerLikeCount,
              }
            : item;
        setListings((current) => current.map(applyState));
        setListing((current) => (current ? applyState(current) : current));
      } catch (error) {
        if (error instanceof MarketplaceApiError && error.status === 401) {
          onAuthRequired();
          return;
        }
        if (error instanceof MarketplaceApiError && error.status === 409) {
          const [state] = await getMarketplaceOfferLikes([offerId]).catch(
            () => [],
          );
          if (state) {
            setListings((current) =>
              current.map((item) =>
                (item.offerId ?? listingIdFromBackend(item)) === offerId
                  ? {
                      ...item,
                      likeTotal: state.likeTotal,
                      viewerLikeCount: state.viewerLikeCount,
                    }
                  : item,
              ),
            );
            return;
          }
        }
        onNotice(error instanceof Error ? error.message : "点赞失败");
      }
    },
    [authUserId, onAuthRequired, onNotice],
  );

  const replaceFromRecommendations = useCallback(
    (recommendations: Parameters<typeof mapRecommendations>[0]) => {
      catalogInteractionRef.current = true;
      setListings(mapRecommendations(recommendations, subplatform, locale));
    },
    [locale, subplatform],
  );

  const closeListing = useCallback(() => setListing(null), []);

  return {
    listings,
    setListings,
    catalogResolved,
    catalogError,
    listing,
    setListing,
    closeListing,
    likeListing,
    replaceFromRecommendations,
  };
}
