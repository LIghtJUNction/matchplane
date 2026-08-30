import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  loadInternalBearer: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./lib/internal-auth", () => ({
  loadInternalBearer: mocks.loadInternalBearer,
}));

import { GET as getPayments } from "../app/api/admin/payments/route";
import {
  getInvoiceAdminRecords,
  getPaymentAdminRecords,
  getRefundAdminRecords,
} from "./api";

const tenantId = "11111111-1111-4111-8111-111111111111";
const originalTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID;
const originalPaymentUrl = process.env.MATCHPLANE_PAYMENT_INTERNAL_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
  process.env.MATCHPLANE_PAYMENT_INTERNAL_URL = "http://payment.internal:8081";
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: { id: "root-admin", role: "rootAdmin" },
  });
  mocks.loadInternalBearer.mockResolvedValue("internal-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("MATCHPLANE_ROOT_TENANT_ID", originalTenantId);
  restoreEnv("MATCHPLANE_PAYMENT_INTERNAL_URL", originalPaymentUrl);
});

describe("payment admin pagination contract", () => {
  it("forwards bounded pagination controls while pinning tenant ownership", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getPayments(
      new Request(
        `https://mall.example/api/admin/payments?tenant_id=${tenantId}&limit=7&offset=14&actor_id=forged`,
      ),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      `http://payment.internal:8081/v1/admin/payments?tenant_id=${tenantId}&limit=7&offset=14`,
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer internal-token",
    );
  });

  it("includes offset in every browser list request without changing defaults", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await getPaymentAdminRecords(tenantId, 10, 20);
    await getRefundAdminRecords(tenantId);
    await getInvoiceAdminRecords(undefined, 5, 15);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/admin/payments?limit=10&offset=20&tenant_id=${tenantId}`,
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/admin/refunds?limit=25&offset=0&tenant_id=${tenantId}`,
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/invoices?limit=5&offset=15",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
