import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  browseMallCatalog: vi.fn(async () => ({ recommendations: [] })),
  getMarketplaceOfferLikes: vi.fn(async () => []),
  setMarketplaceOfferLikeCount: vi.fn(async () => ({
    offerId: "offer-1",
    likeTotal: "1",
    viewerLikeCount: 1,
  })),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, ...api };
});

import type { AssetListing } from "../types";
import {
  PENDING_MARKETPLACE_LIKE_KEY,
  readPendingMarketplaceLike,
  useMarketplaceCatalog,
} from "./useMarketplaceCatalog";

const listing: AssetListing = {
  id: "listing-1",
  offerId: "offer-1",
  platformPath: "/store-a",
  title: "二手车",
  subtitle: "认证车商",
  price: "¥100,000",
  accent: "cactus",
  facts: [],
  viewerLikeCount: 0,
  likeTotal: "0",
};

const subplatform = {
  slug: "store-a",
  path: "/store-a",
  label: "二手车",
  ui: {},
};

describe("useMarketplaceCatalog pending likes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/store-a");
    window.sessionStorage.removeItem(PENDING_MARKETPLACE_LIKE_KEY);
  });

  it("preserves the child path and resumes the requested like after sign-in", async () => {
    const onAuthRequired = vi.fn();
    const onNotice = vi.fn();
    const { result, rerender } = renderHook(
      ({ authUserId }: { authUserId?: string }) =>
        useMarketplaceCatalog({
          hydrated: true,
          locale: "zh",
          subplatform: subplatform as never,
          authUserId,
          onNotice,
          onAuthRequired,
        }),
      { initialProps: { authUserId: undefined as string | undefined } },
    );

    await act(async () => {
      await expect(result.current.likeListing(listing)).rejects.toThrow(
        "authentication required",
      );
    });

    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(readPendingMarketplaceLike()).toMatchObject({
      platformPath: "/store-a",
      listingId: "listing-1",
      offerId: "offer-1",
    });
    expect(api.setMarketplaceOfferLikeCount).not.toHaveBeenCalled();

    rerender({ authUserId: "buyer-1" });

    await waitFor(() =>
      expect(api.setMarketplaceOfferLikeCount).toHaveBeenCalledWith({
        offerId: "offer-1",
        count: 1,
        expectedCount: 0,
      }),
    );
    expect(
      window.sessionStorage.getItem(PENDING_MARKETPLACE_LIKE_KEY),
    ).toBeNull();
    expect(window.location.pathname).toBe("/store-a");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("rolls an optimistic like back when the authenticated mutation fails", async () => {
    const onNotice = vi.fn();
    let rejectMutation: ((reason: Error) => void) | undefined;
    api.setMarketplaceOfferLikeCount.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectMutation = reject;
        }),
    );
    const { result } = renderHook(() =>
      useMarketplaceCatalog({
        hydrated: true,
        locale: "zh",
        subplatform: subplatform as never,
        authUserId: "buyer-1",
        onNotice,
        onAuthRequired: vi.fn(),
      }),
    );
    act(() => result.current.setListing(listing));

    let mutation: Promise<void> | undefined;
    act(() => {
      mutation = result.current.likeListing(listing);
    });
    expect(result.current.listing).toMatchObject({
      likeTotal: "1",
      viewerLikeCount: 1,
    });
    const pendingMutation = mutation;
    const rejectPendingMutation = rejectMutation;
    if (!pendingMutation || !rejectPendingMutation)
      throw new Error("mutation did not start");

    await act(async () => {
      rejectPendingMutation(new Error("provider unavailable"));
      await expect(pendingMutation).rejects.toThrow("provider unavailable");
    });

    expect(result.current.listing).toMatchObject({
      likeTotal: "0",
      viewerLikeCount: 0,
    });
    expect(onNotice).toHaveBeenCalledWith("provider unavailable");
  });
});
