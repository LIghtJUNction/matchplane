import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateMarketplaceOffer,
  getMarketplaceOfferAdminRecords,
  updateMarketplaceOffer,
  withdrawMarketplaceOffer,
  type MarketplaceOffer,
  type PartySession,
} from "./api";

const session = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  partyId: "22222222-2222-4222-8222-222222222222",
  role: "both",
  accessToken: "scoped-test-token",
  accessTokenExpiresAt: "2026-08-22T12:00:00Z",
  platformPath: "/store",
} as PartySession;
const domainId = "33333333-3333-4333-8333-333333333333";
const offer: MarketplaceOffer = {
  offer_id: "44444444-4444-4444-8444-444444444444",
  tenant_id: session.tenantId,
  domain_id: domainId,
  supply_party_id: session.partyId,
  asset_id: null,
  external_key: "sku-1",
  display_name: "商品",
  attributes: {},
  terms: {},
  status: "draft",
  published_at: null,
  expires_at: null,
  version: 3,
  created_at: "2026-08-22T00:00:00Z",
  updated_at: "2026-08-22T00:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("marketplace offer management API", () => {
  it("patches content with the scoped party and expected version", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(offer),
    );
    vi.stubGlobal("fetch", fetcher);

    await updateMarketplaceOffer({
      session,
      domainId,
      offerId: offer.offer_id,
      displayName: "更新商品",
      attributes: { stock_quantity: 4 },
      terms: { amount_minor: "1234", currency: "CNY" },
      expectedVersion: 2,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(`/v1/marketplace/offers/${offer.offer_id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      tenant_id: session.tenantId,
      domain_id: domainId,
      supply_party_id: session.partyId,
      display_name: "更新商品",
      attributes: { stock_quantity: 4 },
      terms: { amount_minor: "1234", currency: "CNY" },
      expected_version: 2,
    });
  });

  it("normalizes PostgreSQL bigint versions before moderation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ offers: [{ ...offer, version: "3" }] })),
    );

    const records = await getMarketplaceOfferAdminRecords({ status: "draft" });
    expect(records[0]?.version).toBe(3);
  });

  it("sends the reviewed version when an operator activates an offer", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ...offer, catalog_sync: { synced: true } }),
    );
    vi.stubGlobal("fetch", fetcher);

    await activateMarketplaceOffer({
      tenantId: session.tenantId,
      offerId: offer.offer_id,
      expectedVersion: "3" as unknown as number,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(
      `/api/admin/marketplace/offers/${offer.offer_id}/activate`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      tenant_id: session.tenantId,
      expected_version: 3,
    });
  });

  it("withdraws without accepting replacement content", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ...offer, status: "withdrawn" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await withdrawMarketplaceOffer({
      session,
      domainId,
      offerId: offer.offer_id,
      expectedVersion: 3,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain(
      `/v1/marketplace/offers/${offer.offer_id}/withdraw`,
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      tenant_id: session.tenantId,
      domain_id: domainId,
      supply_party_id: session.partyId,
      expected_version: 3,
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
