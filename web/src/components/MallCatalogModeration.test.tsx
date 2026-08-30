import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateMarketplaceOffer: vi.fn(),
  getMarketplaceOfferAdminRecords: vi.fn(),
}));
vi.mock("../api", () => api);

import type { MarketplaceOfferAdminRecord } from "../api";
import { MallCatalogModeration } from "./MallCatalogModeration";

const offer: MarketplaceOfferAdminRecord = {
  offer_id: "01a0286a-4642-70d0-abc4-bbb21392cbd4",
  tenant_id: "00000000-0000-7000-8000-000000000100",
  domain_id: "00000000-0000-7000-8000-000000000101",
  supply_party_id: "28573c08-9d56-53c2-91bc-83741d006405",
  asset_id: null,
  external_key: "test-dog",
  display_name: "测试小狗",
  status: "draft",
  published_at: null,
  expires_at: null,
  version: 1,
  created_at: "2026-08-22T08:00:00.000Z",
  updated_at: "2026-08-22T08:00:00.000Z",
  store_id: "b06e7f1c-b56e-408e-aa20-39f7aae90302",
  store_name: "Store A",
  store_path: "/store-a",
  description: "合成商品 A",
  image_url: "https://matx.tech/store-a-agent/media/test/face.jpeg",
  amount_minor: "10000",
  currency: "CNY",
  currency_scale: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getMarketplaceOfferAdminRecords.mockResolvedValue([offer]);
  api.activateMarketplaceOffer.mockResolvedValue({
    ...offer,
    status: "active",
    version: 2,
    catalog_sync: { synced: true },
  });
});

describe("MallCatalogModeration", () => {
  it("publishes a reviewed item and removes it from the pending queue", async () => {
    const onNotice = vi.fn();
    render(<MallCatalogModeration onNotice={onNotice} />);
    await screen.findByText("测试小狗");

    fireEvent.click(screen.getByRole("button", { name: "通过并发布" }));

    await waitFor(() =>
      expect(api.activateMarketplaceOffer).toHaveBeenCalledWith({
        offerId: offer.offer_id,
        tenantId: offer.tenant_id,
        expectedVersion: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("测试小狗")).not.toBeInTheDocument(),
    );
    expect(onNotice).toHaveBeenCalledWith("商品已通过审核并进入公开目录");
  });

  it("shows an inline error instead of behaving like a dead button", async () => {
    api.activateMarketplaceOffer.mockRejectedValue(
      new Error("商品版本已变化，请刷新后重试"),
    );
    render(<MallCatalogModeration onNotice={vi.fn()} />);
    await screen.findByText("测试小狗");

    fireEvent.click(screen.getByRole("button", { name: "通过并发布" }));

    expect(
      await screen.findByRole("alert", {
        name: "",
      }),
    ).toHaveTextContent("商品版本已变化，请刷新后重试");
    expect(screen.getByText("测试小狗")).toBeInTheDocument();
  });
});
