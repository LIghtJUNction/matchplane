import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({ authDatabase: { query } }));

import { searchPublicStoreOffers } from "./storefront-search";
import type { PublicStore } from "./store-directory";

const store: PublicStore = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "camera-house",
  path: "/camera-house",
  displayName: "相机屋",
  description: "相机与镜头",
  integrationKind: "hosted",
  capabilities: [],
  agentStages: [],
  agentSkills: [],
  tenantId: "20000000-0000-4000-8000-000000000001",
  domainId: "30000000-0000-4000-8000-000000000001",
};

describe("public storefront search", () => {
  beforeEach(() => query.mockReset());

  it("returns only complete canonical products and strips private fields", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          displayName: "轻便全画幅相机",
          attributes: {
            description: "适合旅行拍摄",
            brand: "Example",
            seller_phone: "13800000000",
            attachments: [
              {
                kind: "image",
                attachment_ref:
                  "media://hosted/50000000-0000-4000-8000-000000000001",
                file_name: "camera.webp",
                media_type: "image/webp",
                metadata: {
                  public_url: "https://tracking.example/camera.webp",
                  private_key: "secret",
                },
              },
            ],
          },
          terms: {
            pricing_mode: "negotiable",
            amount_minor: "1299900",
            currency: "CNY",
            currency_scale: 2,
            credential: "secret",
          },
          storeName: "相机屋",
          storeSlug: "camera-house",
          storePath: "/camera-house",
          integrationKind: "hosted",
          publishedAt: "2026-08-21T00:00:00Z",
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          displayName: "没有图片的草率商品",
          attributes: { description: "不会公开" },
          terms: { amount_minor: "1", currency: "CNY", currency_scale: 2 },
          storeName: "相机屋",
          storeSlug: "camera-house",
          storePath: "/camera-house",
          integrationKind: "hosted",
          publishedAt: "2026-08-21T00:00:00Z",
        },
      ],
    });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "旅行相机",
    });

    expect(products).toEqual([
      expect.objectContaining({
        offer_id: "40000000-0000-4000-8000-000000000001",
        display_name: "轻便全画幅相机",
        store_name: "相机屋",
        image_url: "/api/store-media/50000000-0000-4000-8000-000000000001",
        attributes: {
          description: "适合旅行拍摄",
          brand: "Example",
          attachments: [
            {
              kind: "image",
              file_name: "camera.webp",
              media_type: "image/webp",
              public_url:
                "/api/store-media/50000000-0000-4000-8000-000000000001",
            },
          ],
        },
        terms: {
          pricing_mode: "fixed",
          amount_minor: "1299900",
          currency: "CNY",
          currency_scale: 2,
        },
      }),
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain("contact");
    expect(query.mock.calls[0]?.[0]).not.toContain("supply_party_id");
    expect(query.mock.calls[0]?.[1]).toEqual([[store.id], "旅行相机"]);
  });

  it("indexes multiple products and keeps only exact budget and attribute matches", async () => {
    const row = (
      id: string,
      name: string,
      memoryGb: number,
      amountMinor: string,
      stock = 2,
    ) => ({
      id,
      displayName: name,
      attributes: {
        description: `${name} 通勤轻薄本`,
        memory_gb: memoryGb,
        stock_quantity: stock,
        attachments: [
          {
            kind: "image",
            attachment_ref: `media://hosted/${id}`,
            file_name: `${id}.webp`,
            media_type: "image/webp",
          },
        ],
      },
      terms: {
        pricing_mode: "fixed",
        amount_minor: amountMinor,
        currency: "CNY",
        currency_scale: 2,
      },
      storeName: "相机屋",
      storeSlug: "camera-house",
      storePath: "/camera-house",
      integrationKind: "hosted",
      supplyFields: [{ key: "memory_gb" }],
      publishedAt: "2026-08-21T00:00:00Z",
    });
    query.mockResolvedValue({
      rows: [
        row("40000000-0000-4000-8000-000000000011", "轻薄本 A", 16, "399900"),
        row("40000000-0000-4000-8000-000000000012", "轻薄本 B", 32, "459900"),
        row("40000000-0000-4000-8000-000000000013", "内存不足", 8, "299900"),
        row("40000000-0000-4000-8000-000000000014", "超预算", 32, "559900"),
        row("40000000-0000-4000-8000-000000000015", "已售罄", 16, "449900", 0),
      ],
    });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "通勤轻薄本",
      intent: {
        budget: { maximum: 5_000, currency: "CNY" },
        requirements: [
          {
            field: "memory_gb",
            value: "16",
            mode: "must",
            operator: "gte",
          },
        ],
      },
      limit: 10,
    });

    expect(products.map((product) => product.display_name)).toEqual([
      "轻薄本 A",
      "轻薄本 B",
    ]);
    expect(
      products.every((product) => (product.match_reasons?.length ?? 0) > 0),
    ).toBe(true);
  });

  it("rejects unsafe image URLs instead of presenting a fabricated product card", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "40000000-0000-4000-8000-000000000003",
          displayName: "Unsafe image",
          attributes: {
            description: "Has a credential URL",
            attachments: [
              {
                kind: "image",
                metadata: {
                  public_url: "https://user:secret@example.test/a.png",
                },
              },
            ],
          },
          terms: { amount_minor: "100", currency: "CNY", currency_scale: 2 },
          storeName: "相机屋",
          storeSlug: "camera-house",
          storePath: "/camera-house",
          integrationKind: "hosted",
          publishedAt: "2026-08-21T00:00:00Z",
        },
      ],
    });

    await expect(
      searchPublicStoreOffers({ stores: [store], narrative: "相机" }),
    ).resolves.toEqual([]);
  });
});
