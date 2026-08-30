import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  consentMarketplaceContact: vi.fn(),
  createMarketplaceOffer: vi.fn(),
  getMarketplaceIntroductions: vi.fn(async () => []),
  getMarketplaceDemandMatches: vi.fn(),
  getMarketplaceOffers: vi.fn(async (): Promise<unknown[]> => []),
  getSellerListingSubmissions: vi.fn(async () => []),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
  submitSellerListing: vi.fn(),
  updateMarketplaceOffer: vi.fn(),
  uploadMarketplaceAttachment: vi.fn(),
  withdrawMarketplaceOffer: vi.fn(),
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
    metadata: {
      public_url: "/api/store-media/44444444-4444-4444-8444-444444444444",
    },
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
    render(
      <SellerDashboard
        locale="zh"
        onNotice={vi.fn()}
        subplatform={subplatform}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "商品列表" }),
    ).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "发布商品" })[0]!);

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["image"], "product.png", { type: "image/png" }),
    );
    await user.type(screen.getByLabelText("商品名称"), "测试商品");
    await user.type(screen.getByLabelText("商品分类"), "自定义分类");
    await user.type(
      screen.getByLabelText("商品描述"),
      "真实商品描述与交付说明",
    );
    await user.type(screen.getByLabelText(/价格/), "99.00");
    await user.selectOptions(screen.getByLabelText("交付方式"), "service");
    await user.clear(screen.getByLabelText(/可售库存/));
    await user.type(screen.getByLabelText(/可售库存/), "8");
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    expect(api.createMarketplaceOffer).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "商品列表" }),
    ).toBeInTheDocument();
  });

  it("reveals and focuses an offer requested by the today workspace", async () => {
    const activeOffer = marketplaceOffer({ status: "active", version: 4 });
    api.getMarketplaceOffers.mockResolvedValueOnce([activeOffer]);

    render(
      <SellerDashboard
        locale="zh"
        onNotice={vi.fn()}
        subplatform={subplatform}
        focusOfferId={activeOffer.offer_id}
      />,
    );

    await screen.findAllByText(activeOffer.display_name);
    const offerRow = document.querySelector(
      '#seller-panel-history li[tabindex="-1"]',
    );
    expect(offerRow).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(offerRow));
    expect(screen.getByRole("heading", { name: "商品列表" })).toBeVisible();
  });

  it("prefills an active generic offer and resubmits it with its optimistic version", async () => {
    const activeOffer = marketplaceOffer({ status: "active", version: 4 });
    api.getMarketplaceOffers.mockResolvedValueOnce([activeOffer]);
    api.updateMarketplaceOffer.mockResolvedValueOnce({
      ...activeOffer,
      display_name: "更新后的商品",
      status: "draft",
      version: 5,
    });
    render(
      <SellerDashboard
        locale="zh"
        onNotice={vi.fn()}
        subplatform={subplatform}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(
      screen.getByRole("heading", { name: "编辑商品" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/待审核状态/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("商品名称"), {
      target: { value: "更新后的商品" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新提交审核" }));

    await waitFor(() =>
      expect(api.updateMarketplaceOffer).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: activeOffer.offer_id,
          displayName: "更新后的商品",
          expectedVersion: 4,
          attributes: expect.objectContaining({ opaque: "kept" }),
        }),
      ),
    );
    expect(await screen.findByText("待审核")).toBeInTheDocument();
  });

  it("keeps edited fields when an optimistic update conflicts", async () => {
    const activeOffer = marketplaceOffer({ status: "active", version: 6 });
    const onNotice = vi.fn();
    api.getMarketplaceOffers.mockResolvedValueOnce([activeOffer]);
    api.updateMarketplaceOffer.mockRejectedValueOnce(
      new Error("商品已被其他会话更新，请重新读取后重试"),
    );
    render(
      <SellerDashboard
        locale="zh"
        onNotice={onNotice}
        subplatform={subplatform}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText("商品名称");
    fireEvent.change(name, { target: { value: "尚未丢失的修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新提交审核" }));

    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(screen.getByLabelText("商品名称")).toHaveValue("尚未丢失的修改");
    expect(
      screen.getByRole("heading", { name: "编辑商品" }),
    ).toBeInTheDocument();
  });

  it("requires confirmation and removes a withdrawn offer from the active list", async () => {
    const activeOffer = marketplaceOffer({ status: "active", version: 2 });
    api.getMarketplaceOffers.mockResolvedValueOnce([activeOffer]);
    api.withdrawMarketplaceOffer.mockResolvedValueOnce({
      ...activeOffer,
      status: "withdrawn",
      version: 3,
    });
    render(
      <SellerDashboard
        locale="zh"
        onNotice={vi.fn()}
        subplatform={subplatform}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "下架" }));
    expect(screen.getByText("确认下架？")).toBeInTheDocument();
    expect(api.withdrawMarketplaceOffer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认下架" }));

    await waitFor(() =>
      expect(api.withdrawMarketplaceOffer).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: activeOffer.offer_id,
          expectedVersion: 2,
        }),
      ),
    );
    expect((await screen.findAllByText("还没有商品")).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByText(activeOffer.display_name),
    ).not.toBeInTheDocument();
  });
});

function marketplaceOffer(input: { status: string; version: number }) {
  return {
    offer_id: "44444444-4444-4444-8444-444444444444",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    domain_id: subplatform.domainId,
    supply_party_id: "22222222-2222-4222-8222-222222222222",
    asset_id: null,
    external_key: "sku-1",
    display_name: "可编辑商品",
    attributes: {
      description: "可编辑说明",
      category: "furniture",
      delivery_mode: "shipping",
      stock_quantity: 2,
      opaque: "kept",
      attachments: [
        {
          attachment_ref: "hosted-media:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "image",
          file_name: "product.png",
          media_type: "image/png",
          size_bytes: 42,
          sha256: "a".repeat(64),
          width: 200,
          height: 200,
          metadata: {},
        },
      ],
    },
    terms: {
      pricing_mode: "fixed",
      amount_minor: "1234",
      currency: "CNY",
      currency_scale: 2,
    },
    status: input.status,
    published_at: null,
    expires_at: null,
    version: input.version,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
  };
}
