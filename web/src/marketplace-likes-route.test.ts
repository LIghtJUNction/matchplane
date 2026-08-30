import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  databaseQuery,
  getSession,
  hasTrustedBrowserOrigin,
  notifyPartyUsers,
  release,
  transactionQuery,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  databaseQuery: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  notifyPartyUsers: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { connect, query: databaseQuery },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/user-notifications", () => ({ notifyPartyUsers }));

import { GET } from "../app/api/mall/likes/route";
import { PUT } from "../app/api/mall/offers/[offerId]/likes/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-7333-8333-333333333333";
const partyId = "44444444-4444-7444-8444-444444444444";

beforeEach(() => {
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
  getSession.mockResolvedValue({ user: { id: authUserId } });
  hasTrustedBrowserOrigin.mockReturnValue(true);
  notifyPartyUsers.mockResolvedValue(1);
  release.mockReset();
  transactionQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM marketplace_offers offer")) {
      return {
        rows: [
          {
            supplyPartyId: partyId,
            displayName: "测试商品",
            storePath: "/store-a",
          },
        ],
      };
    }
    if (sql.includes("SELECT like_count::int")) return { rows: [] };
    if (sql.includes("SELECT COALESCE(sum(like_count)")) {
      return { rows: [{ total: "11" }] };
    }
    return { rows: [] };
  });
  connect.mockResolvedValue({ query: transactionQuery, release });
  databaseQuery.mockResolvedValue({
    rows: [{ offerId, viewerLikeCount: 2, likeTotal: "12" }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MATCHPLANE_ROOT_TENANT_ID;
});

describe("marketplace likes", () => {
  it("requires a signed-in account", async () => {
    getSession.mockResolvedValue(null);
    const response = await GET(
      new Request(`http://localhost/api/mall/likes?offerIds=${offerId}`),
    );
    expect(response.status).toBe(401);
    expect(databaseQuery).not.toHaveBeenCalled();
  });

  it("returns the current account count and public total", async () => {
    const response = await GET(
      new Request(`http://localhost/api/mall/likes?offerIds=${offerId}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      likes: [{ offerId, viewerLikeCount: 2, likeTotal: "12" }],
    });
    expect(databaseQuery).toHaveBeenCalledWith(
      expect.stringContaining("marketplace_offer_likes viewer"),
      [tenantId, authUserId, [offerId]],
    );
  });

  it("persists one of at most five likes and notifies the product owner", async () => {
    const response = await PUT(
      new Request(`http://localhost/api/mall/offers/${offerId}/likes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 1, expectedCount: 0 }),
      }),
      { params: Promise.resolve({ offerId }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      offerId,
      viewerLikeCount: 1,
      likeTotal: "11",
    });
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_offer_likes"),
      [tenantId, offerId, authUserId, 1],
    );
    expect(notifyPartyUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        partyId,
        kind: "offer_liked",
        excludeAuthUserId: authUserId,
      }),
    );
    expect(release).toHaveBeenCalled();
  });

  it("rejects a sixth like before touching the database", async () => {
    const response = await PUT(
      new Request(`http://localhost/api/mall/offers/${offerId}/likes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 6, expectedCount: 5 }),
      }),
      { params: Promise.resolve({ offerId }) },
    );

    expect(response.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it("returns a conflict instead of overwriting a newer like count", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM marketplace_offers offer")) {
        return {
          rows: [
            {
              supplyPartyId: partyId,
              displayName: "测试商品",
              storePath: "/store-a",
            },
          ],
        };
      }
      if (sql.includes("SELECT like_count::int")) {
        return { rows: [{ likeCount: 2 }] };
      }
      if (sql.includes("SELECT COALESCE(sum(like_count)")) {
        return { rows: [{ total: "12" }] };
      }
      return { rows: [] };
    });
    const response = await PUT(
      new Request(`http://localhost/api/mall/offers/${offerId}/likes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 2, expectedCount: 1 }),
      }),
      { params: Promise.resolve({ offerId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      viewerLikeCount: 2,
      likeTotal: "12",
    });
  });
});
