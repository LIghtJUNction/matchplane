import { beforeEach, describe, expect, it, vi } from "vitest";

const { gatewayRank, query } = vi.hoisted(() => ({
  gatewayRank: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./lib/auth", () => ({ authDatabase: { query } }));
vi.mock("./storefront-ranking-gateway", () => ({
  rankWithRustLexicalGateway: gatewayRank,
}));

import {
  MAX_PUBLIC_MATCH_REASON_CHARACTERS,
  MAX_PUBLIC_MATCH_REASONS,
} from "./storefront-ranking";
import {
  MAX_PUBLIC_OFFER_SEARCH_STORE_IDS,
  PublicOfferSearchBudgetExceededError,
  searchPublicStoreOfferPage,
  searchPublicStoreOffers,
} from "./storefront-search";
import {
  completeProductRow,
  fakeRustRank,
  store,
} from "./storefront-search.test-helpers";

describe("public storefront search", () => {
  beforeEach(() => {
    query.mockReset();
    gatewayRank.mockReset();
    gatewayRank.mockImplementation(fakeRustRank);
  });

  it("returns no recommendations when a nonempty request has zero explainable overlap", async () => {
    query.mockResolvedValue({
      rows: [
        completeProductRow({
          displayName: "专业摄影设备",
          description: "适合影棚人像拍摄",
        }),
      ],
    });

    await expect(
      searchPublicStoreOffers({ stores: [store], narrative: "登山帐篷" }),
    ).resolves.toEqual([]);
  });

  it("emits only positive lexical evidence and remains deterministic", async () => {
    query.mockResolvedValue({ rows: [completeProductRow()] });

    const first = await searchPublicStoreOffers({
      stores: [store],
      narrative: "旅行相机",
    });
    const second = await searchPublicStoreOffers({
      stores: [store],
      narrative: "旅行相机",
    });

    expect(second).toEqual(first);
    expect(first[0]?.match_score).toBeGreaterThan(0);
    expect(first[0]?.match_reasons).toEqual([
      "名称或公开属性与“旅、行、相、机”相关",
    ]);
    expect(first[0]?.match_reasons?.join(" ")).not.toContain(store.displayName);
    expect(first[0]).not.toHaveProperty("advisory");
    expect(first[0]).not.toHaveProperty("confidence");
    expect(first[0]?.store_name).toBe(store.displayName);
  });

  it("matches a canonical public attribute without prose duplication", async () => {
    query.mockResolvedValue({
      rows: [
        completeProductRow({
          displayName: "标准商品",
          description: "常规公开说明",
          attributes: { brand: "Aurora" },
        }),
      ],
    });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "aurora",
    });

    expect(products[0]?.match_score).toBe(0.25);
    expect(products[0]?.match_reasons).toEqual([
      "名称或公开属性与“aurora”相关",
    ]);
  });

  it("accepts an explainable structured match without lexical overlap", async () => {
    query.mockResolvedValue({ rows: [completeProductRow()] });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "zzzz",
      intent: {
        budget: { maximum: 2_000, currency: "CNY" },
        requirements: [],
      },
    });

    expect(products).toEqual([
      expect.objectContaining({
        match_score: 0.32,
        match_reasons: ["币种符合 CNY", "价格符合预算"],
      }),
    ]);
  });

  it("returns an empty browse without making any match claim", async () => {
    query.mockResolvedValue({ rows: [completeProductRow()] });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "   ",
    });

    expect(products).toHaveLength(1);
    expect(products[0]).not.toHaveProperty("match_score");
    expect(products[0]).not.toHaveProperty("match_reasons");
    expect(products[0]?.store_name).toBe(store.displayName);
    expect(gatewayRank).not.toHaveBeenCalled();
  });

  it("rejects an over-budget store input before querying PostgreSQL", async () => {
    const stores = Array.from(
      { length: MAX_PUBLIC_OFFER_SEARCH_STORE_IDS + 1 },
      () => store,
    );

    await expect(
      searchPublicStoreOffers({ stores, narrative: "旅行相机" }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: PublicOfferSearchBudgetExceededError.name,
        code: "public_offer_search_budget_exceeded",
        budget: "store_ids",
        actual: MAX_PUBLIC_OFFER_SEARCH_STORE_IDS + 1,
        maximum: MAX_PUBLIC_OFFER_SEARCH_STORE_IDS,
      }),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("bounds structured reasons by count and per-reason length", async () => {
    const longValue = "a".repeat(600);
    const values = [
      longValue,
      ...Array.from({ length: 7 }, (_, i) => `needle${i}`),
    ];
    query.mockResolvedValue({
      rows: [
        completeProductRow({
          description: values.join(" "),
        }),
      ],
    });

    const products = await searchPublicStoreOffers({
      stores: [store],
      narrative: "",
      intent: {
        budget: { maximum: 2_000, currency: "CNY" },
        requirements: values.map((value) => ({
          value,
          mode: "prefer" as const,
          operator: "contains" as const,
        })),
      },
    });
    const reasons = products[0]?.match_reasons ?? [];

    expect(reasons).toHaveLength(MAX_PUBLIC_MATCH_REASONS);
    expect(
      reasons.every(
        (reason) => reason.length <= MAX_PUBLIC_MATCH_REASON_CHARACTERS,
      ),
    ).toBe(true);
    expect(reasons.join(" ")).not.toContain(store.displayName);
  });

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
            contactPhone: "13900000000",
            authorization: "Bearer private-authorization",
            cookie: "session=private-cookie",
            provider_hints: "private provider advice",
            raw_manifest: "private manifest",
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
          supplyFields: [
            { key: "brand" },
            { key: "seller_phone" },
            { key: "contactPhone" },
            { key: "authorization" },
            { key: "cookie" },
            { key: "provider_hints" },
            { key: "raw_manifest" },
          ],
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
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toContain("contact");
    expect(sql).not.toContain("supply_party_id");
    expect(sql).not.toContain("row_number");
    expect(sql).not.toContain("store_rank");
    expect(sql).not.toContain("ts_rank");
    expect(sql).toContain("LIMIT 2001");
    expect(gatewayRank.mock.calls[0]?.[0]).toBe("旅行相机");
    expect(gatewayRank.mock.calls[0]?.[1]).toEqual([
      {
        displayName: "轻便全画幅相机",
        description: "Example\n适合旅行拍摄",
        eligible: true,
        intentBoost: 0,
        intentReasons: [],
      },
      {
        displayName: "没有图片的草率商品",
        description: "不会公开",
        eligible: true,
        intentBoost: 0,
        intentReasons: [],
      },
    ]);
    const rustPayload = JSON.stringify(gatewayRank.mock.calls[0]?.[1]);
    expect(rustPayload).not.toMatch(
      /provider|13900000000|secret|private-authorization|private-cookie/,
    );
    expect(JSON.stringify(products)).not.toMatch(
      /private-authorization|private-cookie/,
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      [store.id],
      [store.tenantId],
      [store.domainId],
    ]);
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

  it("returns a scoped, sorted page with exact pagination metadata", async () => {
    const row = (id: string, amountMinor: string) => ({
      id,
      displayName: `商品 ${amountMinor}`,
      attributes: {
        description: "公开商品",
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
      publishedAt: "2026-08-21T00:00:00Z",
      likeTotal: "0",
    });
    query.mockResolvedValue({
      rows: [
        row("40000000-0000-4000-8000-000000000021", "10000"),
        row("40000000-0000-4000-8000-000000000022", "30000"),
        row("40000000-0000-4000-8000-000000000023", "20000"),
      ],
    });

    const page = await searchPublicStoreOfferPage({
      stores: [
        store,
        {
          ...store,
          id: "10000000-0000-4000-8000-000000000002",
          slug: "other-store",
          path: "/other-store",
        },
      ],
      narrative: "公开商品",
      storePaths: ["/camera-house"],
      sort: "price_desc",
      offset: 1,
      limit: 1,
    });

    expect(page).toEqual({
      items: [expect.objectContaining({ display_name: "商品 20000" })],
      total: 3,
      offset: 1,
      limit: 1,
      hasMore: true,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      [store.id],
      [store.tenantId],
      [store.domainId],
    ]);
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
