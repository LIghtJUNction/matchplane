import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  forwardPaymentAdmin: vi.fn(),
}));

vi.mock("./lib/payment-admin", () => ({
  forwardPaymentAdmin: mocks.forwardPaymentAdmin,
}));

import { GET, POST } from "../app/api/admin/invoice-mode/route";
import { getInvoiceSetting, switchInvoiceMode } from "./api";

const tenantId = "11111111-1111-4111-8111-111111111111";
const providerId = "22222222-2222-4222-8222-222222222222";
const upstreamSetting = {
  tenant_id: tenantId,
  active_mode: "test",
  active_provider_id: providerId,
  updated_by: "33333333-3333-4333-8333-333333333333",
  version: 42,
  updated_at: "2026-08-26T00:00:00.000Z",
};
const canonicalSetting = {
  tenant_id: tenantId,
  active_mode: "test",
  provider_id: providerId,
  updated_by: "33333333-3333-4333-8333-333333333333",
  version: 42,
  updated_at: "2026-08-26T00:00:00.000Z",
};

beforeEach(() => {
  mocks.forwardPaymentAdmin.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invoice mode BFF contract", () => {
  it("normalizes the bound provider on GET without exposing the upstream field", async () => {
    mocks.forwardPaymentAdmin.mockResolvedValue(Response.json(upstreamSetting));
    const request = invoiceModeRequest("GET");

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(canonicalSetting);
    expect(mocks.forwardPaymentAdmin).toHaveBeenCalledWith(
      request,
      "/v1/admin/invoice-mode",
      "GET",
    );
  });

  it("preserves a null provider and the success status on POST", async () => {
    mocks.forwardPaymentAdmin.mockResolvedValue(
      Response.json(
        {
          ...upstreamSetting,
          active_mode: "production",
          active_provider_id: null,
          version: 43,
        },
        { status: 201 },
      ),
    );
    const request = invoiceModeRequest("POST");

    const response = await POST(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ...canonicalSetting,
      active_mode: "production",
      provider_id: null,
      version: 43,
    });
    expect(mocks.forwardPaymentAdmin).toHaveBeenCalledWith(
      request,
      "/v1/admin/invoice-mode",
      "POST",
    );
  });

  it.each([
    ["missing active provider", omit(upstreamSetting, "active_provider_id")],
    ["missing version", omit(upstreamSetting, "version")],
    ["invalid provider", { ...upstreamSetting, active_provider_id: 7 }],
    ["invalid mode", { ...upstreamSetting, active_mode: "sandbox" }],
    ["fractional version", { ...upstreamSetting, version: 2.5 }],
    [
      "competing canonical field",
      { ...upstreamSetting, provider_id: providerId },
    ],
  ])("rejects a malformed success payload with %s", async (_label, value) => {
    mocks.forwardPaymentAdmin.mockResolvedValue(Response.json(value));

    const response = await GET(invoiceModeRequest("GET"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "支付管理服务返回的发票设置无效",
    });
  });

  it("rejects an invalid JSON success payload", async () => {
    mocks.forwardPaymentAdmin.mockResolvedValue(
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await GET(invoiceModeRequest("GET"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "支付管理服务返回的发票设置无效",
    });
  });

  it("passes an upstream error response through unchanged", async () => {
    const upstream = Response.json(
      { error: "支付管理服务暂时不可用" },
      { status: 503 },
    );
    mocks.forwardPaymentAdmin.mockResolvedValue(upstream);

    const response = await GET(invoiceModeRequest("GET"));

    expect(response).toBe(upstream);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "支付管理服务暂时不可用",
    });
  });
});

describe("invoice mode browser client contract", () => {
  it("returns the canonical bound provider and current version", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(canonicalSetting));
    vi.stubGlobal("fetch", fetchMock);

    const setting = await getInvoiceSetting(tenantId);

    expect(setting).toEqual(canonicalSetting);
    expect(setting.provider_id).toBe(providerId);
    expect(setting.version).toBe(42);
    expect(setting).not.toHaveProperty("active_provider_id");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/invoice-mode?tenant_id=${tenantId}`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("preserves the canonical POST response and sends provider_id upstream", async () => {
    const switched = {
      ...canonicalSetting,
      active_mode: "production",
      provider_id: null,
      version: 43,
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(Response.json(switched));
    vi.stubGlobal("fetch", fetchMock);

    const setting = await switchInvoiceMode({
      tenantId,
      mode: "production",
      providerId: providerId,
      expectedVersion: 42,
      reason: "contract test",
    });

    expect(setting).toEqual(switched);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      tenant_id: tenantId,
      mode: "production",
      provider_id: providerId,
      expected_version: 42,
      reason: "contract test",
    });
  });
});

function invoiceModeRequest(method: "GET" | "POST"): Request {
  return new Request("https://mall.example/api/admin/invoice-mode", {
    method,
  });
}

function omit<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
