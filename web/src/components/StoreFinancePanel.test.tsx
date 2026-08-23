import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getStoreFinanceReport: vi.fn() }));
vi.mock("../api", () => api);

import { StoreFinancePanel } from "./StoreFinancePanel";
import type { StoreSummary } from "../api";
import type { StoreFinanceReport } from "../store-finance";

const store = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "merchant-store",
  displayName: "商家店铺",
} as StoreSummary;

const report: StoreFinanceReport = {
  tenant_id: "22222222-2222-4222-8222-222222222222",
  source_type: "store",
  source_ref: store.id,
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-21T12:00:00Z",
  generated_at: "2026-08-21T12:00:01Z",
  basis: "payment_created_refund_created_invoice_requested",
  currencies: [
    {
      currency: "CNY",
      currency_scale: 2,
      gross_captured: "3330000",
      refunded: "100000",
      platform_fees: "96900",
      net_revenue: "3133100",
      payment_count: 2,
      captured_count: 2,
      refund_count: 1,
      invoice_count: 1,
    },
  ],
  payments: [
    {
      payment_id: "33333333-3333-4333-8333-333333333333",
      merchant_order_id: "ORDER-001",
      status: "captured",
      amount: "850000",
      captured_amount: "850000",
      refunded_amount: "100000",
      platform_fee: "25500",
      currency: "CNY",
      currency_scale: 2,
      created_at: "2026-08-18T03:00:00Z",
    },
  ],
  refunds: [],
  invoices: [],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getStoreFinanceReport.mockResolvedValue(report);
});

describe("StoreFinancePanel", () => {
  it("renders a store-scoped report without seeded product data", async () => {
    const user = userEvent.setup();
    render(<StoreFinancePanel locale="zh" onNotice={vi.fn()} store={store} />);

    expect(screen.getByLabelText("财务报表读取中")).toBeInTheDocument();
    expect(await screen.findByText("¥33,300.00")).toBeInTheDocument();
    expect(screen.getByText("¥31,331.00")).toBeInTheDocument();
    expect(screen.getAllByText("ORDER-001").length).toBeGreaterThan(0);
    expect(api.getStoreFinanceReport).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: store.id }),
    );

    await user.click(screen.getByRole("button", { name: "今年" }));
    await waitFor(() =>
      expect(api.getStoreFinanceReport).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps the failure state explicit and retryable", async () => {
    api.getStoreFinanceReport
      .mockRejectedValueOnce(new Error("财务服务暂时不可用"))
      .mockResolvedValueOnce(report);
    const user = userEvent.setup();
    render(<StoreFinancePanel locale="zh" onNotice={vi.fn()} store={store} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "财务服务暂时不可用",
    );
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("¥33,300.00")).toBeInTheDocument();
  });
});
