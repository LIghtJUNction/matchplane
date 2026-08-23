import { afterEach, describe, expect, it, vi } from "vitest";

import { getStoreFinanceReport } from "./api";
import type { StoreFinanceReport } from "./store-finance";

const storeId = "11111111-1111-4111-8111-111111111111";
const report: StoreFinanceReport = {
  tenant_id: "22222222-2222-4222-8222-222222222222",
  source_type: "store",
  source_ref: storeId,
  from: "2026-08-01T00:00:00Z",
  to: "2026-09-01T00:00:00Z",
  generated_at: "2026-08-21T12:00:00Z",
  basis: "payment_created_refund_created_invoice_requested",
  currencies: [],
  payments: [],
  refunds: [],
  invoices: [],
  truncated: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("getStoreFinanceReport", () => {
  it("sends only the store path and report window from the browser", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(report), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      getStoreFinanceReport({ storeId, from: report.from, to: report.to }),
    ).resolves.toEqual(report);
    const requestUrl = String(fetcher.mock.calls[0]?.[0]);
    expect(requestUrl).toContain(`/api/stores/${storeId}/finance?`);
    expect(requestUrl).not.toContain("tenant_id");
    expect(requestUrl).not.toContain("source_ref");
  });

  it("rejects a report returned for another store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...report,
              source_ref: "33333333-3333-4333-8333-333333333333",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      getStoreFinanceReport({ storeId, from: report.from, to: report.to }),
    ).rejects.toThrow("财务报表店铺范围校验失败");
  });
});
