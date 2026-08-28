import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  hasOnlyPublicAddresses: vi.fn(),
  tenantId: "11111111-1111-4111-8111-111111111111",
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.query, connect: mocks.connect },
}));
vi.mock("./lib/public-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/public-endpoint")>()),
  hasOnlyPublicAddresses: mocks.hasOnlyPublicAddresses,
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./lib/store-access", () => ({
  configuredTenantId: () => mocks.tenantId,
}));

import { GET, PATCH, POST } from "../app/api/mall/exchange-rate/route";

const current = {
  localCurrency: "CNY",
  usdToLocalRate: "7.2",
  rateSource: "api.frankfurter.app",
  rateUpdatedAt: "2026-08-28T05:00:00.000Z",
  version: "3",
};
type MockQueryResult = { rowCount?: number; rows?: unknown[] };

function editorSession() {
  return {
    user: {
      id: "22222222-2222-4222-8222-222222222222",
      role: "rootSuperAdmin",
    },
  };
}

function request(method: string, body?: unknown) {
  return new Request("https://matchplane.test/api/mall/exchange-rate", {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://matchplane.test",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function transactionClient(row: Record<string, unknown> = current) {
  const client = {
    query: vi.fn<(sql: string) => Promise<MockQueryResult>>(
      async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
          return {};
        if (sql.includes("FROM tenants"))
          return { rowCount: 1, rows: [{ id: mocks.tenantId }] };
        if (sql.includes("FROM mall_currency_settings"))
          return { rowCount: 1, rows: [row] };
        if (sql.includes("UPDATE mall_currency_settings")) {
          return {
            rowCount: 1,
            rows: [
              {
                ...row,
                localCurrency: "JPY",
                usdToLocalRate: "146.12",
                rateSource: "api.frankfurter.app",
                rateUpdatedAt: "2026-08-28T06:00:00.000Z",
                version: "4",
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO platform_audit_events"))
          return { rowCount: 1, rows: [] };
        return { rowCount: 1, rows: [] };
      },
    ),
    release: vi.fn(),
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MATCHPLANE_EXCHANGE_RATE_URL;
  mocks.hasOnlyPublicAddresses.mockResolvedValue(true);
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue(editorSession());
  mocks.query.mockResolvedValue({ rows: [current], rowCount: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mall exchange-rate route", () => {
  it("returns the stored local currency and USD rate", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      exchangeRate: {
        baseCurrency: "USD",
        localCurrency: "CNY",
        usdToLocalRate: 7.2,
        rateSource: "api.frankfurter.app",
        rateUpdatedAt: "2026-08-28T05:00:00.000Z",
        version: 3,
      },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("mall_currency_settings"),
      [mocks.tenantId, "CNY"],
    );
  });

  it("clears a stale rate when the local currency is changed", async () => {
    const client = transactionClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM tenants"))
        return { rowCount: 1, rows: [{ id: mocks.tenantId }] };
      if (sql.includes("FROM mall_currency_settings"))
        return { rowCount: 1, rows: [current] };
      if (sql.includes("UPDATE mall_currency_settings")) {
        return {
          rowCount: 1,
          rows: [
            {
              ...current,
              localCurrency: "EUR",
              usdToLocalRate: null,
              rateSource: null,
              rateUpdatedAt: null,
              version: "4",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);

    const response = await PATCH(
      request("PATCH", { localCurrency: "EUR", expectedVersion: 3 }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      exchangeRate: { localCurrency: "EUR", usdToLocalRate: null, version: 4 },
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("usd_to_local_rate = $3::numeric"),
      [mocks.tenantId, "EUR", null, null, "3"],
    );
  });

  it("fetches and stores the latest rate for the selected currency", async () => {
    const client = transactionClient();
    mocks.connect.mockResolvedValue(client);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ base: "USD", rates: { JPY: 146.12 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      exchangeRate: {
        localCurrency: "JPY",
        usdToLocalRate: 146.12,
        version: 4,
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    const providerUrl = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(String(providerUrl)).toContain("to=JPY");
    vi.unstubAllGlobals();
  });

  it("rejects private provider IPs before making an outbound request", async () => {
    vi.stubEnv(
      "MATCHPLANE_EXCHANGE_RATE_URL",
      "https://169.254.169.254/latest",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务配置无效",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("fails closed when a provider hostname resolves to a private address", async () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    vi.stubEnv(
      "MATCHPLANE_EXCHANGE_RATE_URL",
      "https://provider.example/latest",
    );
    mocks.hasOnlyPublicAddresses.mockResolvedValue(false);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务配置无效",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects provider credentials before making an outbound request", async () => {
    vi.stubEnv(
      "MATCHPLANE_EXCHANGE_RATE_URL",
      "https://user:secret@provider.example/latest",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务配置无效",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the MatchPlane production profile for the HTTPS boundary", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    vi.stubEnv(
      "MATCHPLANE_EXCHANGE_RATE_URL",
      "http://localhost:8787/latest",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("applies the provider timeout while reading a slow response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const responseBody = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancel(reason);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(responseBody, { status: 200 })),
    );
    mocks.connect.mockResolvedValue(transactionClient());

    const pending = POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await pending;

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务响应超时，请稍后重试",
    });
    expect(cancel).toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("requires the trusted owner session for mutations", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await PATCH(
      request("PATCH", { localCurrency: "EUR", expectedVersion: 3 }),
    );
    expect(response.status).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
