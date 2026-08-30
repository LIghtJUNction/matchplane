import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMarketplaceIntroductions: vi.fn(),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
}));
const marketplaceSession = vi.hoisted(() => ({
  getMarketplaceSession: vi.fn(),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, ...api };
});
vi.mock("../lib/marketplace-session", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/marketplace-session")
  >("../lib/marketplace-session");
  return { ...actual, ...marketplaceSession };
});

import { conversionIdempotencyKey, useStoreHandoff } from "./useStoreHandoff";

const session = {
  partyId: "00000000-0000-7000-8000-000000000001",
};
const intentId = "00000000-0000-7000-8000-000000000002";
const offerId = "00000000-0000-7000-8000-000000000003";

describe("conversion idempotency scope", () => {
  it("reuses one explicit confirmation attempt across retries", () => {
    const attemptId = "00000000-0000-7000-8000-000000000004";

    expect(
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        attemptId,
        intentId,
        offerId,
      ),
    ).toBe(
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        attemptId,
        intentId,
        offerId,
      ),
    );
  });

  it("creates a new action key for a later explicit confirmation", () => {
    const first = conversionIdempotencyKey(
      session,
      "web-contact-request",
      "00000000-0000-7000-8000-000000000004",
      intentId,
      offerId,
    );
    const next = conversionIdempotencyKey(
      session,
      "web-contact-request",
      "00000000-0000-7000-8000-000000000005",
      intentId,
      offerId,
    );

    expect(next).not.toBe(first);
  });

  it("rejects untrusted non-canonical IDs instead of hashing them into collisions", () => {
    expect(() =>
      conversionIdempotencyKey(
        session,
        "web-contact-request",
        "00000000-0000-7000-8000-000000000004",
        intentId,
        "seller-controlled-offer",
      ),
    ).toThrow("conversion idempotency scope is invalid");
  });
});

describe("buyer contact retrieval", () => {
  it("retrieves verified counterpart contact only after supply consent", async () => {
    const partySession = {
      tenantId: "00000000-0000-7000-8000-000000000010",
      partyId: "00000000-0000-7000-8000-000000000011",
      role: "buyer" as const,
      accessToken: "server-session",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    marketplaceSession.getMarketplaceSession.mockResolvedValue(partySession);
    api.getMarketplaceIntroductions.mockResolvedValue([
      {
        introduction_id: "00000000-0000-7000-8000-000000000012",
        offer_id: offerId,
        demand_party_id: partySession.partyId,
        supply_contact_consent_at: new Date().toISOString(),
      },
    ]);
    api.retrieveMarketplaceContact.mockResolvedValue({
      introduction: { introduction_id: "00000000-0000-7000-8000-000000000012" },
      counterpart: {
        party_id: "00000000-0000-7000-8000-000000000013",
        contact: { email: "seller@example.com" },
      },
    });
    const notification = vi.fn();
    window.addEventListener("matchplane:notifications-updated", notification);
    const { result } = renderHook(() =>
      useStoreHandoff({
        subplatform: {
          slug: "store-a",
          path: "/store-a",
          label: "二手车",
          tenantId: partySession.tenantId,
          domainId: "00000000-0000-7000-8000-000000000014",
          ui: {},
        } as never,
        listings: [
          {
            id: "listing-1",
            offerId,
            title: "二手车",
            subtitle: "认证车商",
            price: "¥100,000",
            accent: "cactus",
            facts: [],
          },
        ],
        locale: "zh",
        onNotice: vi.fn(),
      }),
    );

    let contact: Awaited<
      ReturnType<typeof result.current.retrieveStoreContact>
    >;
    await act(async () => {
      contact = await result.current.retrieveStoreContact({
        type: "contact_consent",
        id: "consent-1",
        reason: "与车商交换已验证联系方式",
        productId: offerId,
      });
    });

    expect(contact!).toMatchObject({
      counterpart: { contact: { email: "seller@example.com" } },
    });
    expect(api.retrieveMarketplaceContact).toHaveBeenCalledWith(
      expect.objectContaining({
        introductionId: "00000000-0000-7000-8000-000000000012",
      }),
    );
    expect(notification).toHaveBeenCalledTimes(1);
    window.removeEventListener(
      "matchplane:notifications-updated",
      notification,
    );
  });
});
