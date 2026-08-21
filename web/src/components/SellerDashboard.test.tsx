import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  consentMarketplaceContact: vi.fn(),
  createMarketplaceOffer: vi.fn(),
  getMarketplaceIntroductions: vi.fn(async () => []),
  getMarketplaceDemandMatches: vi.fn(),
  getMarketplaceOffers: vi.fn(async () => []),
  getSellerListingSubmissions: vi.fn(async () => []),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
  submitSellerListing: vi.fn(),
  uploadMarketplaceAttachment: vi.fn(),
}));

vi.mock("../api", () => api);
vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession: vi.fn(async () => ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    partyId: "22222222-2222-4222-8222-222222222222",
    role: "seller",
    accessToken: "test-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}));

import { SellerDashboard } from "./SellerDashboard";
import type { SubplatformConfig } from "../subplatform";

const subplatform = {
  slug: "my-store",
  path: "/my-store",
  label: "我的店铺",
  brandName: "我的店铺",
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "33333333-3333-4333-8333-333333333333",
  marketplaceContract: "generic-v1",
  pricing: { mode: "fixed", currency: "CNY", currencyScale: 2, label: "价格" },
  ui: {},
} as unknown as SubplatformConfig;

beforeEach(() => {
  vi.clearAllMocks();
  api.getMarketplaceOffers.mockResolvedValue([]);
  api.getMarketplaceIntroductions.mockResolvedValue([]);
  api.uploadMarketplaceAttachment.mockResolvedValue({
    attachment_ref: "media://hosted/44444444-4444-4444-8444-444444444444",
    kind: "image",
    file_name: "product.webp",
    media_type: "image/webp",
    size_bytes: 100,
    sha256: "a".repeat(64),
    metadata: { public_url: "/api/store-media/44444444-4444-4444-8444-444444444444" },
  });
  api.createMarketplaceOffer.mockResolvedValue({
    offer_id: "55555555-5555-4555-8555-555555555555",
    tenant_id: subplatform.tenantId,
    domain_id: subplatform.domainId,
    supply_party_id: "22222222-2222-4222-8222-222222222222",
    external_key: "offer-test",
    display_name: "测试商品",
    attributes: {},
    terms: {},
    status: "draft",
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    duplicate: false,
  });
});

describe("SellerDashboard product publishing", () => {
  it("starts from the catalogue and publishes a complete real offer", async () => {
    const user = userEvent.setup();
    render(<SellerDashboard locale="zh" onNotice={vi.fn()} subplatform={subplatform} />);

    expect(await screen.findByRole("heading", { name: "商品列表" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "发布商品" })[0]!);

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["image"], "product.png", { type: "image/png" }));
    await user.type(screen.getByLabelText("商品名称"), "测试商品");
    await user.type(screen.getByLabelText("商品分类"), "自定义分类");
    await user.type(screen.getByLabelText("商品描述"), "真实商品描述与交付说明");
    await user.type(screen.getByLabelText(/价格/), "99.00");
    await user.selectOptions(screen.getByLabelText("交付方式"), "service");
    await user.clear(screen.getByLabelText(/可售库存/));
    await user.type(screen.getByLabelText(/可售库存/), "8");
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    expect(api.createMarketplaceOffer).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "测试商品",
      attributes: expect.objectContaining({
        category: "自定义分类",
        delivery_mode: "service",
        stock_quantity: 8,
        description: "真实商品描述与交付说明",
      }),
      terms: expect.objectContaining({
        amount_minor: "9900",
        currency: "CNY",
        currency_scale: 2,
      }),
    }));
    expect(await screen.findByRole("heading", { name: "商品列表" })).toBeInTheDocument();
  });
});
