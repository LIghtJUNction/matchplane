import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getStoreCustomers = vi.hoisted(() => vi.fn());
const updateStoreCustomer = vi.hoisted(() => vi.fn());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, getStoreCustomers, updateStoreCustomer };
});

import { StoreCustomersPanel } from "./StoreCustomersPanel";

const customer = {
  id: "11111111-1111-4111-8111-111111111111",
  participantId: "22222222-2222-4222-8222-222222222222",
  displayName: "测试客户",
  avatarUrl: null,
  analysis: "明确询问交付时间，关注测试商品，购买意向较高。",
  intent: "high" as const,
  productIds: ["33333333-3333-4333-8333-333333333333"],
  products: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "测试商品",
      imageUrl: null,
      price: "CNY 99.00",
    },
  ],
  handoffStatus: "requested",
  stage: "qualified" as const,
  favorite: false,
  contactConsentStatus: "not_requested" as const,
  staffNotes: null,
  lastActivityAt: "2026-08-23T04:00:00.000Z",
  createdAt: "2026-08-23T04:00:00.000Z",
  version: 1,
};

describe("StoreCustomersPanel", () => {
  beforeEach(() => {
    getStoreCustomers.mockReset();
    updateStoreCustomer.mockReset();
  });

  it("shows AI analysis, products, consent state, and updates favorite and notes", async () => {
    const user = userEvent.setup();
    getStoreCustomers.mockResolvedValue([customer]);
    updateStoreCustomer.mockImplementation(async (input) => ({
      ...customer,
      favorite: input.favorite ?? customer.favorite,
      staffNotes: input.staffNotes ?? customer.staffNotes,
      version: 2,
      products: [],
      displayName: "",
    }));

    render(<StoreCustomersPanel storeId="store-1" locale="zh" />);

    expect(await screen.findByText("测试客户")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /测试客户/ }));

    expect(screen.getAllByText(/明确询问交付时间/).length).toBeGreaterThan(0);
    expect(screen.getByText("测试商品")).toBeVisible();
    expect(screen.getByText("未请求")).toBeVisible();
    expect(screen.getByText("高意向客户")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "搜索客户" })).toBeVisible();

    const search = screen.getByRole("textbox", { name: "搜索客户" });
    await user.type(search, "不存在");
    expect(screen.getByText("没有符合筛选条件的客户")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getAllByText("测试客户").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "收藏客户" }));
    expect(updateStoreCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ favorite: true, expectedVersion: 1 }),
    );

    const notes = screen.getByPlaceholderText("下一步、时间、约束…");
    await user.type(notes, "明天下午回访");
    await user.click(screen.getByRole("button", { name: "保存备注" }));
    await waitFor(() =>
      expect(updateStoreCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ staffNotes: "明天下午回访" }),
      ),
    );
  });

  it("keeps the 320/390 summary in one row and explains the unselected 1280 detail pane", async () => {
    getStoreCustomers.mockResolvedValue([customer]);
    render(<StoreCustomersPanel storeId="store-1" locale="zh" />);

    await screen.findByText("测试客户");

    const summary = screen.getByRole("group", { name: "客户概览" });
    expect(summary).toHaveClass("grid-cols-3");
    expect(summary).not.toHaveClass("grid-cols-1");
    expect(summary.querySelectorAll('[data-slot="card"]')).toHaveLength(3);
    expect(within(summary).getByText("高意向客户")).toBeVisible();
    expect(within(summary).getByText("已收藏")).toBeVisible();
    expect(within(summary).getByText("已同意联系")).toBeVisible();

    const emptyDetail = screen.getByRole("complementary", {
      name: "选择一位客户",
    });
    expect(emptyDetail).toHaveClass("store-customer-detail-empty");
    expect(
      within(emptyDetail).getByText(
        "选择客户后，这里会显示意向分析、关注商品、联系方式同意状态和店员备注。",
      ),
    ).toBeVisible();
    expect(within(emptyDetail).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a useful empty state", async () => {
    getStoreCustomers.mockResolvedValue([]);
    render(<StoreCustomersPanel storeId="store-1" locale="zh" />);

    expect(await screen.findByText("暂时没有高意向客户")).toBeVisible();
    expect(screen.getByText(/AI 店长识别到购买意向/)).toBeVisible();
  });
});
