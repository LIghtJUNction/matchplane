import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const readStoreAccess = vi.hoisted(() => vi.fn());

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));
vi.mock("./lib/store-access", () => ({
  readStoreAccess,
  roleOf: () => "buyer",
}));

import { GET, PATCH } from "../app/api/stores/[storeId]/customers/route";

const context = {
  params: Promise.resolve({
    storeId: "11111111-1111-4111-8111-111111111111",
  }),
};
const customerRow = {
  id: "22222222-2222-4222-8222-222222222222",
  participantId: "33333333-3333-4333-8333-333333333333",
  displayName: "测试客户",
  avatarUrl: null,
  summary: {
    analysis: "询问交付时间，购买意向高。",
    intent_strength: "high",
    product_ids: ["01a0291f-e2d6-7ff0-8e03-8560fb2ef34f"],
  },
  handoffStatus: "requested",
  stage: "qualified",
  favorite: true,
  contactConsentStatus: "not_requested",
  staffNotes: null,
  lastActivityAt: "2026-08-23T04:00:00.000Z",
  createdAt: "2026-08-23T04:00:00.000Z",
  version: "1",
};

describe("store customers route", () => {
  beforeEach(() => {
    getSession.mockReset();
    query.mockReset();
    readStoreAccess.mockReset();
    getSession.mockResolvedValue({ user: { id: "user-1" } });
    readStoreAccess.mockResolvedValue({
      store: {
        id: "11111111-1111-4111-8111-111111111111",
        domainId: "55555555-5555-4555-8555-555555555555",
      },
      canOperate: true,
      canManageStore: false,
    });
  });

  it("returns a permission-scoped, product-enriched customer queue without contact details", async () => {
    query
      .mockResolvedValueOnce({ rows: [customerRow] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "01a0291f-e2d6-7ff0-8e03-8560fb2ef34f",
            displayName: "测试商品",
            attributes: { image_url: "https://cdn.example.com/product.webp" },
            terms: { display_price: "CNY 99.00" },
          },
        ],
      });

    const response = await GET(
      new Request("http://localhost/api/stores/store/customers"),
      context,
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.customers[0]).toEqual(
      expect.objectContaining({
        displayName: "测试客户",
        analysis: "询问交付时间，购买意向高。",
        intent: "high",
        favorite: true,
        products: [
          expect.objectContaining({ name: "测试商品", price: "CNY 99.00" }),
        ],
      }),
    );
    expect(JSON.stringify(body)).not.toContain("email");
    expect(JSON.stringify(body)).not.toContain("phone");
  });

  it("updates favorite and stage with optimistic version checking", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          ...customerRow,
          favorite: false,
          stage: "won",
          version: "2",
          displayName: null,
        },
      ],
    });
    const response = await PATCH(
      new Request("http://localhost/api/stores/store/customers", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          host: "localhost",
        },
        body: JSON.stringify({
          id: customerRow.id,
          favorite: false,
          stage: "won",
          expectedVersion: 1,
        }),
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      customer: expect.objectContaining({ favorite: false, stage: "won", version: 2 }),
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      customerRow.id,
      "55555555-5555-4555-8555-555555555555",
      false,
      "won",
      false,
      null,
      1,
    ]);
  });

  it("hides the queue from users without store operation permission", async () => {
    readStoreAccess.mockResolvedValue({
      store: { domainId: "55555555-5555-4555-8555-555555555555" },
      canOperate: false,
      canManageStore: false,
    });
    const response = await GET(
      new Request("http://localhost/api/stores/store/customers"),
      context,
    );
    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
