import { describe, expect, it } from "vitest";

import {
  formatStoreMoney,
  storeFinanceCsv,
  storeFinanceWindow,
  type StoreFinanceReport,
} from "./store-finance";

describe("store finance utilities", () => {
  it("builds UTC report windows without crossing the requested boundary", () => {
    const now = new Date("2026-08-21T10:30:00.000Z");
    expect(storeFinanceWindow("month", now)).toEqual({
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-21T10:30:00.000Z",
    });
    expect(storeFinanceWindow("year", now).from).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(Date.parse(storeFinanceWindow("ninetyDays", now).from)).toBe(
      now.getTime() - 90 * 86_400_000,
    );
  });

  it("formats minor units without losing bigint precision", () => {
    expect(formatStoreMoney("900719925474099267", 2, "USD", "en")).toBe(
      "$9,007,199,254,740,992.67",
    );
    expect(formatStoreMoney("-23", 2, "USD", "en")).toBe("-$0.23");
  });

  it("exports exact decimal values and escapes merchant text", () => {
    const report: StoreFinanceReport = {
      tenant_id: "00000000-0000-7000-8000-000000000100",
      source_type: "store",
      source_ref: "00000000-0000-7000-8000-000000000201",
      from: "2026-08-01T00:00:00Z",
      to: "2026-09-01T00:00:00Z",
      generated_at: "2026-08-21T10:30:00Z",
      basis: "payment_created_refund_created_invoice_requested",
      currencies: [],
      payments: [],
      refunds: [
        {
          refund_id: "refund-1",
          payment_id: "payment-1",
          merchant_order_id: "order-1",
          status: "succeeded",
          amount: "1234",
          platform_fee_reversal: "12",
          currency: "CNY",
          currency_scale: 2,
          reason: '客户说"不要了", 改单',
          created_at: "2026-08-20T08:00:00Z",
        },
      ],
      invoices: [],
      truncated: false,
    };

    const csv = storeFinanceCsv(report, "zh");
    expect(csv).toContain("-12.34,CNY");
    expect(csv).toContain('"客户说""不要了"", 改单"');
  });
});
