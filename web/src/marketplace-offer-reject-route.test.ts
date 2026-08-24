import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadInternalBearer: vi.fn(),
  notifyPartyUsers: vi.fn(),
  query: vi.fn(),
  requireRootManager: vi.fn(),
  syncCanonicalMarketplaceOffer: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.query },
}));
vi.mock("./lib/internal-auth", () => ({
  loadInternalBearer: mocks.loadInternalBearer,
}));
vi.mock("./lib/session", () => ({
  requireRootManager: mocks.requireRootManager,
}));
vi.mock("./lib/store-access", () => ({
  configuredTenantId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("./lib/user-notifications", () => ({
  notifyPartyUsers: mocks.notifyPartyUsers,
}));
vi.mock("./catalog-sync", () => ({
  syncCanonicalMarketplaceOffer: mocks.syncCanonicalMarketplaceOffer,
}));

import { POST } from "../app/api/admin/marketplace/offers/[offerId]/reject/route";

const offerId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ offerId }) };

function request(reason = "图片不清晰"): Request {
  return new Request(
    `https://matchplane.test/api/admin/marketplace/offers/${offerId}/reject`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenant_id: "11111111-1111-4111-8111-111111111111",
        expected_version: 3,
        reason,
      }),
    },
  );
}

describe("marketplace offer rejection route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getSession.mockReset();
    mocks.loadInternalBearer.mockReset();
    mocks.notifyPartyUsers.mockReset();
    mocks.query.mockReset();
    mocks.requireRootManager.mockReset();
    mocks.syncCanonicalMarketplaceOffer.mockReset();
    mocks.requireRootManager.mockResolvedValue(null);
    mocks.loadInternalBearer.mockResolvedValue("operator-token");
    mocks.getSession.mockResolvedValue({
      user: { id: "33333333-3333-4333-8333-333333333333" },
    });
    mocks.query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            displayName: "测试商品",
            domainId: "44444444-4444-4444-8444-444444444444",
            supplyPartyId: "55555555-5555-4555-8555-555555555555",
            storePath: "/store-a",
            version: 3,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    mocks.syncCanonicalMarketplaceOffer.mockResolvedValue({
      synced: true,
      platformPath: "/store-a",
    });
    mocks.notifyPartyUsers.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              offer_id: offerId,
              status: "withdrawn",
              version: 4,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
  });

  it("rejects a draft through the Rust operator boundary and records the reason", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        offer_id: offerId,
        status: "withdrawn",
        review_reason: "图片不清晰",
        catalog_sync: { synced: true, platform_path: "/store-a" },
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/admin/marketplace/offers/${offerId}/reject`),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer operator-token",
        }),
        body: JSON.stringify({
          tenant_id: "11111111-1111-4111-8111-111111111111",
          expected_version: 3,
        }),
      }),
    );
    expect(mocks.query.mock.calls[1]?.[0]).toContain(
      "marketplace.offer.rejected",
    );
    expect(mocks.notifyPartyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        partyId: "55555555-5555-4555-8555-555555555555",
        kind: "offer_rejected",
        payload: { offerId, reason: "图片不清晰" },
      }),
    );
  });

  it("rejects a blank moderation reason before calling the gateway", async () => {
    const response = await POST(request(" "), context);

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("honors the root-manager authorization boundary", async () => {
    mocks.requireRootManager.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
