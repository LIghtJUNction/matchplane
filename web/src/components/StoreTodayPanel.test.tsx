import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMarketplaceOffers: vi.fn(),
  getStoreCustomers: vi.fn(),
}));
const getMarketplaceSession = vi.hoisted(() => vi.fn());

vi.mock("../api", () => api);
vi.mock("../lib/marketplace-session", () => ({ getMarketplaceSession }));

import type {
  MarketplaceOffer,
  StoreCustomerRecord,
  StoreSummary,
} from "../api";
import type { SubplatformConfig } from "../subplatform";
import { StoreTodayPanel } from "./StoreTodayPanel";

const store = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "general-store",
  path: "/general-store",
  displayName: "通用商店",
  description: "",
  integrationKind: "package",
  status: "active",
} as StoreSummary;
const subplatform = {
  slug: "general-store",
  path: "/general-store",
  label: "通用商店",
  brandName: "通用商店",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  marketplaceContract: "generic-v1",
  pricing: { mode: "fixed", currency: "CNY", currencyScale: 2, label: "价格" },
  ui: {},
} as unknown as SubplatformConfig;
const session = {
  tenantId: subplatform.tenantId,
  partyId: "44444444-4444-4444-8444-444444444444",
  role: "seller",
  accessToken: "test-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getMarketplaceSession.mockResolvedValue(session);
  api.getStoreCustomers.mockResolvedValue([]);
  api.getMarketplaceOffers.mockResolvedValue([]);
});

describe("StoreTodayPanel", () => {
  it("builds only actionable queues from existing customer and offer fields", async () => {
    const now = Date.now();
    api.getStoreCustomers.mockResolvedValue([
      customer({
        id: "new-customer",
        displayName: "新客户",
        stage: "new",
        lastActivityAt: new Date(now - 60 * 60 * 1_000).toISOString(),
      }),
      customer({
        id: "contact-customer",
        displayName: "待同意客户",
        stage: "qualified",
        contactConsentStatus: "pending",
        lastActivityAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
      }),
      customer({
        id: "high-intent-customer",
        displayName: "高意向客户",
        stage: "discovering",
        intent: "urgent",
        lastActivityAt: new Date(now - 25 * 60 * 60 * 1_000).toISOString(),
      }),
      customer({
        id: "scheduled-customer",
        displayName: "下一步客户",
        stage: "discovering",
        nextAction: "发送规格说明",
        nextActionAt: new Date(now).toISOString(),
      }),
      customer({
        id: "terminal-customer",
        displayName: "已终结客户",
        stage: "won",
        intent: "urgent",
        contactConsentStatus: "accepted",
        lastActivityAt: new Date(now - 48 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);
    api.getMarketplaceOffers.mockResolvedValue([
      offer({
        offer_id: "stale-active",
        display_name: "待更新商品",
        status: "active",
        updated_at: new Date(now - 25 * 60 * 60 * 1_000).toISOString(),
      }),
      offer({
        offer_id: "recent-draft",
        display_name: "刚更新草稿",
        status: "draft",
        updated_at: new Date(now - 60 * 60 * 1_000).toISOString(),
      }),
      offer({
        offer_id: "withdrawn-offer",
        display_name: "已下架商品",
        status: "withdrawn",
        updated_at: new Date(now - 48 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);
    const onOpenCustomers = vi.fn();
    const onOpenProducts = vi.fn();

    render(
      <StoreTodayPanel
        locale="zh"
        store={store}
        subplatform={subplatform}
        onOpenCustomers={onOpenCustomers}
        onOpenProducts={onOpenProducts}
      />,
    );

    expect(await screen.findByLabelText("新客户 / 未跟进: 1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("待联系同意 / 同意后未接待: 1"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("高意向超过 24 小时未活动: 1"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("今天已有下一步: 1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("超过 24 小时未更新的商品: 1"),
    ).toBeInTheDocument();
    expect(screen.queryByText("已终结客户")).not.toBeInTheDocument();
    expect(screen.queryByText("刚更新草稿")).not.toBeInTheDocument();
    expect(screen.queryByText("已下架商品")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "打开待办" }));
    expect(onOpenCustomers).toHaveBeenCalledWith("scheduled-customer");

    await userEvent.click(
      screen.getByRole("button", { name: /待更新商品.*更新于/ }),
    );
    expect(onOpenProducts).toHaveBeenCalledWith("stale-active");
    expect(document.querySelectorAll(".store-today-primary > button")).toHaveLength(1);
  });

  it("keeps the refresh control mounted and suppresses duplicate in-flight loads", async () => {
    const firstCustomers = deferred<StoreCustomerRecord[]>();
    const firstOffers = deferred<MarketplaceOffer[]>();
    api.getStoreCustomers.mockReturnValueOnce(firstCustomers.promise);
    api.getMarketplaceOffers.mockReturnValueOnce(firstOffers.promise);

    render(
      <StoreTodayPanel
        locale="zh"
        store={store}
        subplatform={subplatform}
        onOpenCustomers={vi.fn()}
        onOpenProducts={vi.fn()}
      />,
    );

    const initialRefresh = screen.getByRole("button", { name: "刷新中…" });
    expect(initialRefresh).toBeDisabled();
    await waitFor(() => {
      expect(api.getStoreCustomers).toHaveBeenCalledTimes(1);
      expect(api.getMarketplaceOffers).toHaveBeenCalledTimes(1);
    });

    firstCustomers.resolve([]);
    firstOffers.resolve([]);
    const refresh = await screen.findByRole("button", { name: "刷新" });
    expect(refresh).toBe(initialRefresh);

    const secondCustomers = deferred<StoreCustomerRecord[]>();
    const secondOffers = deferred<MarketplaceOffer[]>();
    api.getStoreCustomers.mockReturnValueOnce(secondCustomers.promise);
    api.getMarketplaceOffers.mockReturnValueOnce(secondOffers.promise);
    refresh.focus();
    await userEvent.click(refresh);
    expect(screen.getByRole("button", { name: "刷新中…" })).toBe(refresh);
    expect(document.activeElement).toBe(refresh);
    expect(api.getStoreCustomers).toHaveBeenCalledTimes(2);
    expect(api.getMarketplaceOffers).toHaveBeenCalledTimes(2);

    secondCustomers.resolve([]);
    secondOffers.resolve([]);
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it("provides English empty, error, and retry states", async () => {
    api.getStoreCustomers.mockRejectedValueOnce(new Error("customers offline"));
    api.getMarketplaceOffers.mockRejectedValueOnce(new Error("offers offline"));

    render(
      <StoreTodayPanel
        locale="en"
        store={store}
        subplatform={subplatform}
        onOpenCustomers={vi.fn()}
        onOpenProducts={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("The new-customer queue could not be loaded."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The offer queue could not be loaded."),
    ).toBeInTheDocument();
    const firstCustomerQueue = screen
      .getByRole("heading", { name: "New or not followed up" })
      .closest("section");
    expect(firstCustomerQueue).not.toBeNull();

    api.getStoreCustomers.mockResolvedValue([]);
    api.getMarketplaceOffers.mockResolvedValue([]);
    await userEvent.click(
      within(firstCustomerQueue!).getByRole("button", {
        name: "Retry customer queue",
      }),
    );

    expect(
      await screen.findByText("No customers are currently in the new stage."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Today’s queues are up to date.",
    );
  });
});

function customer(
  overrides: Partial<StoreCustomerRecord>,
): StoreCustomerRecord {
  return {
    id: "customer-id",
    participantId: "participant-id",
    displayName: "客户",
    avatarUrl: null,
    analysis: "",
    intent: "warm",
    productIds: [],
    products: [],
    handoffStatus: "requested",
    stage: "qualified",
    favorite: false,
    contactConsentStatus: "not_requested",
    staffNotes: null,
    nextAction: null,
    nextActionAt: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function offer(overrides: Partial<MarketplaceOffer>): MarketplaceOffer {
  return {
    offer_id: "offer-id",
    tenant_id: subplatform.tenantId!,
    domain_id: subplatform.domainId!,
    supply_party_id: "44444444-4444-4444-8444-444444444444",
    asset_id: null,
    external_key: "sku",
    display_name: "商品",
    attributes: {},
    terms: {},
    status: "draft",
    published_at: null,
    expires_at: null,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
