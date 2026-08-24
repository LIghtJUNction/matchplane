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

const CATALOG_TIMEOUT_MS = 10_000;
export const PENDING_MARKETPLACE_LIKE_KEY =
  "matchplane.marketplace.pending-like";

interface PendingMarketplaceLike {
  version: 1;
  platformPath: string;
  listingId: string;
  offerId: string;
  expectedCount: number;
  expectedTotal: string;
}

export function readPendingMarketplaceLike(): PendingMarketplaceLike | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_MARKETPLACE_LIKE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      (value as PendingMarketplaceLike).version !== 1 ||
      typeof (value as PendingMarketplaceLike).platformPath !== "string" ||
      typeof (value as PendingMarketplaceLike).listingId !== "string" ||
      typeof (value as PendingMarketplaceLike).offerId !== "string" ||
      typeof (value as PendingMarketplaceLike).expectedCount !== "number" ||
      typeof (value as PendingMarketplaceLike).expectedTotal !== "string"
    ) {
      return null;
    }
    return value as PendingMarketplaceLike;
  } catch {
    return null;
  }
}

function rememberPendingMarketplaceLike(value: PendingMarketplaceLike): void {
  try {
    window.sessionStorage.setItem(
      PENDING_MARKETPLACE_LIKE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Session storage can be unavailable in hardened browser modes; login still proceeds.
  }
}

function clearPendingMarketplaceLike(): void {
  try {
    window.sessionStorage.removeItem(PENDING_MARKETPLACE_LIKE_KEY);
  } catch {
    // Nothing else is required when session storage is unavailable.
  }
}

function incrementLikeTotal(value: string): string {
  try {
    return (BigInt(value) + 1n).toString();
  } catch {
    return value;
  }
}

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
  const [catalogRequestVersion, setCatalogRequestVersion] = useState(0);
  const [listing, setListing] = useState<AssetListing | null>(null);
  const catalogInteractionRef = useRef(false);
  const catalogPathRef = useRef(subplatform.path);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
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
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("catalog request timed out")),
        CATALOG_TIMEOUT_MS,
      );
    });
    void Promise.race([
      browseMallCatalog(
        subplatform.slug === "root" ? {} : { storePath: subplatform.path },
      ),
      timeout,
    ])
      .then(({ recommendations }) => {
        if (!cancelled && !catalogInteractionRef.current) {
          setListings(mapRecommendations(recommendations, subplatform, locale));
          setCatalogError(false);
        }
      })
      .catch(() => {
        // The live store directory remains available when the product feed is temporarily down.
        if (!cancelled && !catalogInteractionRef.current) {
          setListings([]);
          setCatalogError(true);
        }
      })
      .finally(() => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        if (!cancelled) setCatalogResolved(true);
      });
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    catalogRequestVersion,
    hydrated,
    locale,
    subplatform,
    subplatform.path,
    subplatform.slug,
  ]);

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

  const applyLikeState = useCallback(
    (offerId: string, likeTotal: string, viewerLikeCount: number) => {
      const applyState = (item: AssetListing) =>
        (item.offerId ?? listingIdFromBackend(item)) === offerId
          ? { ...item, likeTotal, viewerLikeCount }
          : item;
      setListings((current) => current.map(applyState));
      setListing((current) => (current ? applyState(current) : current));
    },
    [],
  );

  const submitLike = useCallback(
    async (pending: PendingMarketplaceLike) => {
      if (pending.expectedCount >= 5) return;
      applyLikeState(
        pending.offerId,
        incrementLikeTotal(pending.expectedTotal),
        pending.expectedCount + 1,
      );
      try {
        const state = await setMarketplaceOfferLikeCount({
          offerId: pending.offerId,
          count: pending.expectedCount + 1,
          expectedCount: pending.expectedCount,
        });
        applyLikeState(pending.offerId, state.likeTotal, state.viewerLikeCount);
      } catch (error) {
        if (error instanceof MarketplaceApiError && error.status === 401) {
          applyLikeState(
            pending.offerId,
            pending.expectedTotal,
            pending.expectedCount,
          );
          rememberPendingMarketplaceLike(pending);
          onAuthRequired();
          throw new Error("authentication required");
        }
        if (error instanceof MarketplaceApiError && error.status === 409) {
          const [state] = await getMarketplaceOfferLikes([
            pending.offerId,
          ]).catch(() => []);
          if (state) {
            applyLikeState(
              pending.offerId,
              state.likeTotal,
              state.viewerLikeCount,
            );
            return;
          }
        }
        applyLikeState(
          pending.offerId,
          pending.expectedTotal,
          pending.expectedCount,
        );
        onNotice(error instanceof Error ? error.message : "点赞失败");
        throw error;
      }
    },
    [applyLikeState, onAuthRequired, onNotice],
  );

  const likeListing = useCallback(
    async (target: AssetListing) => {
      const offerId = target.offerId ?? listingIdFromBackend(target);
      if (!offerId) {
        onNotice("这个商品暂不支持点赞");
        return;
      }
      const pending: PendingMarketplaceLike = {
        version: 1,
        platformPath: window.location.pathname,
        listingId: target.id,
        offerId,
        expectedCount: target.viewerLikeCount ?? 0,
        expectedTotal: target.likeTotal ?? "0",
      };
      if (!authUserId) {
        rememberPendingMarketplaceLike(pending);
        onAuthRequired();
        throw new Error("authentication required");
      }
      await submitLike(pending);
    },
    [authUserId, onAuthRequired, onNotice, submitLike],
  );

  useEffect(() => {
    if (!authUserId) return;
    const pending = readPendingMarketplaceLike();
    if (!pending || pending.platformPath !== window.location.pathname) return;
    clearPendingMarketplaceLike();
    void submitLike(pending).catch(() => undefined);
  }, [authUserId, submitLike]);

  const replaceFromRecommendations = useCallback(
    (recommendations: Parameters<typeof mapRecommendations>[0]) => {
      catalogInteractionRef.current = true;
      setListings(mapRecommendations(recommendations, subplatform, locale));
    },
    [locale, subplatform],
  );

  const closeListing = useCallback(() => setListing(null), []);
  const retryCatalog = useCallback(() => {
    catalogInteractionRef.current = false;
    setCatalogRequestVersion((current) => current + 1);
  }, []);

  return {
    listings,
    setListings,
    catalogResolved,
    catalogError,
    retryCatalog,
    listing,
    setListing,
    closeListing,
    likeListing,
    replaceFromRecommendations,
  };
}
