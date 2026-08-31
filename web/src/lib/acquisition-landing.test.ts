import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./acquisition-links", () => ({
  resolveActiveAcquisitionLink: vi.fn(),
}));
vi.mock("../storefront-search", () => ({
  readPublicStoreOfferDetail: vi.fn(),
}));

import { loadAcquisitionLanding } from "./acquisition-landing";

const link = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  storeId: "44444444-4444-4444-8444-444444444444",
  offerId: "55555555-5555-4555-8555-555555555555",
  channelKey: "partner.referral",
  sourceRef: "source-7",
  campaignRef: "campaign-9",
};

const offer = {
  offerId: link.offerId,
  displayName: "旅行相机",
  description: "轻巧机身",
  status: "active" as const,
  updatedAt: "2026-08-30T12:34:56.000Z",
  price: {
    amountMinor: "129900",
    currency: "CNY",
    currencyScale: 2,
  },
  media: [{ url: "https://images.example.test/camera.jpg" }],
  fields: [],
  store: {
    name: "相机屋",
    description: "相机与镜头",
    path: "/camera-house",
  },
};

describe("acquisition landing loader", () => {
  it("resolves the link, reads the exact public projection, and builds canonical CTAs", async () => {
    const resolveLink = vi.fn().mockResolvedValue(link);
    const readOffer = vi.fn().mockResolvedValue(offer);

    const result = await loadAcquisitionLanding("AAAAAAAAAAAAAAAAAAAAAA", {
      resolveLink,
      readOffer,
    });

    expect(resolveLink).toHaveBeenCalledWith("AAAAAAAAAAAAAAAAAAAAAA");
    expect(readOffer).toHaveBeenCalledWith({
      tenantId: link.tenantId,
      domainId: link.domainId,
      storeId: link.storeId,
      offerId: link.offerId,
    });
    expect(result).toMatchObject({
      primaryHref: `/camera-house?offer=${link.offerId}`,
      storeHref: "/camera-house",
      offerId: link.offerId,
    });
    expect(result).not.toHaveProperty("channelKey");
    expect(result).not.toHaveProperty("sourceRef");
    expect(result).not.toHaveProperty("campaignRef");
  });

  it.each(["invalid token", "expired link", "down store"])(
    "returns the same null result for %s",
    async () => {
      const resolveLink = vi.fn().mockResolvedValue(null);
      const readOffer = vi.fn();

      await expect(
        loadAcquisitionLanding("unavailable", { resolveLink, readOffer }),
      ).resolves.toBeNull();
      expect(readOffer).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the public store or its current registration changes after link resolution", async () => {
    const readOffer = vi.fn().mockResolvedValue(null);

    await expect(
      loadAcquisitionLanding("AAAAAAAAAAAAAAAAAAAAAA", {
        resolveLink: vi.fn().mockResolvedValue(link),
        readOffer,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a mismatched exact-offer projection", async () => {
    await expect(
      loadAcquisitionLanding("AAAAAAAAAAAAAAAAAAAAAA", {
        resolveLink: vi.fn().mockResolvedValue(link),
        readOffer: vi.fn().mockResolvedValue({
          ...offer,
          offerId: "66666666-6666-4666-8666-666666666666",
        }),
      }),
    ).resolves.toBeNull();
  });
});
