import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/auth", () => ({ authDatabase: { query: vi.fn() } }));
vi.mock("./rust-lexical-gateway", () => ({
  rankWithRustLexicalGateway: vi.fn(),
}));

import { readPublicStoreOfferDetailFromDatabase } from "./storefront-search";

const lookup = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "22222222-2222-4222-8222-222222222222",
  storeId: "33333333-3333-4333-8333-333333333333",
  offerId: "44444444-4444-4444-8444-444444444444",
};

const baseRow = {
  id: lookup.offerId,
  displayName: "轻便全画幅相机",
  attributes: {
    description: "适合旅行拍摄",
    stock_quantity: 3,
    attachments: [
      {
        kind: "image",
        attachment_ref:
          "media://hosted/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        file_name: "camera.jpg",
        media_type: "image/jpeg",
      },
    ],
    material: "镁合金",
    location: "上海",
    sensor_size: "全画幅",
    brand: "不应公开的品牌字段",
    seller_phone: "13800000000",
  },
  terms: {
    pricing_mode: "fixed",
    amount_minor: "129900",
    currency: "CNY",
    currency_scale: 2,
    private_note: "do not expose",
  },
  updatedAt: "2026-08-30T12:34:56.000Z",
  storeName: "相机屋",
  storeDescription: "相机与镜头",
  storeSlug: "camera-house",
  storePath: "/camera-house",
  integrationKind: "hosted",
  productTemplateId: null,
  productTemplates: null,
  supplyFields: [
    { key: "material", label: "机身材质", group: "外观" },
    { key: "location", label: "所在地区", group: "交付" },
  ],
};

function databaseWith(row: Record<string, unknown> | null) {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }),
  };
}

describe("exact public storefront offer detail", () => {
  it("keeps the legacy storefront allowlist while returning only structured public fields", async () => {
    const database = databaseWith(baseRow);

    const result = await readPublicStoreOfferDetailFromDatabase(
      database as never,
      lookup,
    );

    expect(result).toMatchObject({
      offerId: lookup.offerId,
      displayName: "轻便全画幅相机",
      description: "适合旅行拍摄",
      status: "active",
      updatedAt: "2026-08-30T12:34:56.000Z",
      price: {
        amountMinor: "129900",
        currency: "CNY",
        currencyScale: 2,
      },
      media: [
        {
          url: "/api/store-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
      fields: [
        {
          key: "material",
          label: "机身材质",
          group: "外观",
          unit: null,
          value: "镁合金",
        },
        {
          key: "location",
          label: "所在地区",
          group: "交付",
          unit: null,
          value: "上海",
        },
      ],
      store: {
        name: "相机屋",
        description: "相机与镜头",
        path: "/camera-house",
      },
    });
    expect(result).not.toHaveProperty("attributes");
    expect(result).not.toHaveProperty("terms");
    expect(result).not.toHaveProperty("tenantId");
    expect(result).not.toHaveProperty("domainId");
  });

  it("uses only the explicitly bound product-template allowlist", async () => {
    const database = databaseWith({
      ...baseRow,
      productTemplateId: "camera",
      productTemplates: [
        {
          id: "camera",
          label: "相机",
          supplyFields: [
            {
              key: "sensor_size",
              label: "传感器规格",
              group: "成像",
            },
          ],
        },
        {
          id: "lens",
          label: "镜头",
          supplyFields: [
            { key: "material", label: "镜身材质", group: "外观" },
          ],
        },
      ],
    });

    const result = await readPublicStoreOfferDetailFromDatabase(
      database as never,
      lookup,
    );

    expect(result?.fields).toEqual([
      {
        key: "sensor_size",
        label: "传感器规格",
        group: "成像",
        unit: null,
        value: "全画幅",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("不应公开的品牌字段");
    expect(JSON.stringify(result)).not.toContain("镁合金");
  });

  it("fails closed to zero custom fields for an unknown template", async () => {
    const database = databaseWith({
      ...baseRow,
      productTemplateId: "unknown",
      productTemplates: [
        {
          id: "camera",
          label: "相机",
          supplyFields: [
            { key: "sensor_size", label: "传感器规格", group: "成像" },
          ],
        },
      ],
    });

    const result = await readPublicStoreOfferDetailFromDatabase(
      database as never,
      lookup,
    );

    expect(result?.fields).toEqual([]);
    expect(result?.description).toBe("适合旅行拍摄");
    expect(result?.media).toEqual([
      { url: "/api/store-media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ]);
  });

  it("applies the storefront PII deny even when a legacy manifest declares the key", async () => {
    const database = databaseWith({
      ...baseRow,
      supplyFields: [
        { key: "seller_phone", label: "联系电话", group: "商家" },
        { key: "owner_name", label: "姓名", group: "商家" },
      ],
      attributes: {
        ...baseRow.attributes,
        owner_name: "不应公开的姓名",
      },
    });

    const result = await readPublicStoreOfferDetailFromDatabase(
      database as never,
      lookup,
    );
    const serialized = JSON.stringify(result);

    expect(result?.fields).toEqual([]);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("不应公开的姓名");
  });

  it("collapses inactive, expired, non-public, or stale-registration rows to null", async () => {
    const database = databaseWith(null);

    await expect(
      readPublicStoreOfferDetailFromDatabase(database as never, lookup),
    ).resolves.toBeNull();

    const [sql, parameters] = database.query.mock.calls[0] as [
      string,
      string[],
    ];
    expect(sql).toContain("offer.status = 'active'");
    expect(sql).toContain("offer.expires_at > clock_timestamp()");
    expect(sql).toContain("tenant.status = 'active'");
    expect(sql).toContain("store.status = 'active'");
    expect(sql).toContain("store.visibility = 'public'");
    expect(sql).toContain("domain.status = 'active'");
    expect(sql).toContain("registration.state = 'active'");
    expect(sql).toContain("alias.is_canonical = true");
    expect(parameters).toEqual([
      lookup.tenantId,
      lookup.domainId,
      lookup.storeId,
      lookup.offerId,
    ]);
  });

  it("rejects malformed exact identifiers before querying", async () => {
    const database = databaseWith(baseRow);

    await expect(
      readPublicStoreOfferDetailFromDatabase(database as never, {
        ...lookup,
        offerId: "not-a-uuid",
      }),
    ).resolves.toBeNull();
    expect(database.query).not.toHaveBeenCalled();
  });
});
