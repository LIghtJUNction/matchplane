import { describe, expect, it } from "vitest";

import { validateStorefrontPublication } from "./storefront-publication";

const mediaId = "10000000-0000-4000-8000-000000000001";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    storeId: "20000000-0000-4000-8000-000000000001",
    storeStatus: "active",
    storeVisibility: "public",
    integrationKind: "hosted",
    domainMatches: true,
    displayName: "真实商品",
    attributes: {
      description: "经过店铺确认的商品介绍",
      attachments: [{ kind: "image", attachment_ref: `media://hosted/${mediaId}` }],
    },
    terms: { pricing_mode: "fixed", amount_minor: "129900", currency: "CNY", currency_scale: 2 },
    availableHostedMediaIds: [mediaId],
    ...overrides,
  };
}

describe("storefront publication validation", () => {
  it("accepts a complete hosted product and returns the media to publish", () => {
    expect(validateStorefrontPublication(candidate())).toEqual({ ok: true, hostedMediaIds: [mediaId] });
  });

  it("rejects a hosted image that belongs to another store", () => {
    expect(validateStorefrontPublication(candidate({ availableHostedMediaIds: [] }))).toEqual({
      ok: false,
      error: "请上传一张由当前店铺控制的有效商品图片",
    });
  });

  it("rejects a seller-controlled URL attached to a valid hosted media reference", () => {
    expect(validateStorefrontPublication(candidate({
      attributes: {
        description: "看似有效的商品",
        attachments: [{
          kind: "image",
          attachment_ref: `media://hosted/${mediaId}`,
          metadata: { public_url: "https://tracking.example/item.webp" },
        }],
      },
    }))).toEqual({ ok: false, error: "托管商品图片地址无效，请重新上传" });
  });

  it("rejects products without a positive fixed price", () => {
    expect(validateStorefrontPublication(candidate({
      terms: { pricing_mode: "fixed", amount_minor: "0", currency: "CNY", currency_scale: 2 },
    }))).toEqual({ ok: false, error: "请填写有效的固定价格和币种" });
  });

  it("allows a connected store to use a credential-free HTTPS image", () => {
    expect(validateStorefrontPublication(candidate({
      integrationKind: "external",
      attributes: {
        description: "外部店铺商品",
        attachments: [{ kind: "image", metadata: { public_url: "https://merchant.example/item.webp" } }],
      },
      availableHostedMediaIds: [],
    }))).toEqual({ ok: true, hostedMediaIds: [] });
  });
});
