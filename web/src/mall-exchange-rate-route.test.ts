import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  fetchPinnedPublicText: vi.fn(),
  tenantId: "11111111-1111-4111-8111-111111111111",
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.query, connect: mocks.connect },
}));
vi.mock("./lib/pinned-public-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/pinned-public-endpoint")>()),
  fetchPinnedPublicText: mocks.fetchPinnedPublicText,
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./lib/store-access", () => ({
  configuredTenantId: () => mocks.tenantId,
}));

import { GET, PATCH, POST } from "../app/api/mall/exchange-rate/route";
import {
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
} from "./lib/pinned-public-endpoint";

const current = {
  localCurrency: "CNY",
  usdToLocalRate: "7.2",
  rateSource: "api.frankfurter.app",
  rateProvider: "frankfurter",
  rateEffectiveDate: "2026-08-28",
  rateResponseDigest: `sha256:${"a".repeat(64)}`,
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
    query: vi.fn<
      (sql: string, parameters?: readonly unknown[]) => Promise<MockQueryResult>
    >(async (sql: string) => {
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
              rateProvider: "frankfurter",
              rateEffectiveDate: "2026-08-28",
              rateResponseDigest: `sha256:${"b".repeat(64)}`,
              rateUpdatedAt: "2026-08-28T06:00:00.000Z",
              version: "4",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO platform_audit_events"))
        return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  return client;
}

function schemaUnavailableClient(code: "42P01" | "42703") {
  const client = transactionClient();
  client.query.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return {};
    if (sql.includes("FROM tenants")) {
      return { rowCount: 1, rows: [{ id: mocks.tenantId }] };
    }
    if (sql.includes("FROM mall_currency_settings")) {
      throw Object.assign(new Error("currency settings schema unavailable"), {
        code,
      });
    }
    return { rowCount: 1, rows: [] };
  });
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MATCHPLANE_EXCHANGE_RATE_URL;
  mocks.fetchPinnedPublicText.mockImplementation(async (url: URL) => {
    const response = await fetch(url);
    return { response, text: await response.text() };
  });
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
        usdToLocalRateExact: "7.2",
        rateSource: "api.frankfurter.app",
        rateProvider: "frankfurter",
        rateEffectiveDate: "2026-08-28",
        rateResponseDigest: `sha256:${"a".repeat(64)}`,
        rateUpdatedAt: "2026-08-28T05:00:00.000Z",
        version: 3,
      },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("mall_currency_settings"),
      [mocks.tenantId, "CNY"],
    );
  });

  it.each(["42P01", "42703"] as const)(
    "returns 503 when GET encounters PostgreSQL schema error %s",
    async (code) => {
      mocks.query.mockRejectedValueOnce(
        Object.assign(new Error("currency settings schema unavailable"), {
          code,
        }),
      );

      const response = await GET();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "货币设置暂不可用；请确认数据库迁移已完成",
      });
    },
  );

  it.each(["42P01", "42703"] as const)(
    "returns 503 when PATCH encounters PostgreSQL schema error %s",
    async (code) => {
      const client = schemaUnavailableClient(code);
      mocks.connect.mockResolvedValue(client);

      const response = await PATCH(
        request("PATCH", { localCurrency: "EUR", expectedVersion: 3 }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "货币设置暂不可用；请确认数据库迁移已完成",
      });
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    },
  );

  it.each(["42P01", "42703"] as const)(
    "returns 503 when POST encounters PostgreSQL schema error %s",
    async (code) => {
      const client = schemaUnavailableClient(code);
      mocks.connect.mockResolvedValue(client);

      const response = await POST(
        request("POST", { localCurrency: "USD", expectedVersion: 3 }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "货币设置暂不可用；请确认数据库迁移已完成",
      });
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    },
  );

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
              rateProvider: null,
              rateEffectiveDate: null,
              rateResponseDigest: null,
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
      [mocks.tenantId, "EUR", null, null, null, null, null, "3"],
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
            JSON.stringify({
              base: "USD",
              date: "2026-08-28",
              provider: "frankfurter",
              rates: { JPY: 146.12 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const syncRequest = request("POST", {
      localCurrency: "JPY",
      expectedVersion: 3,
    });
    const response = await POST(syncRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      exchangeRate: {
        localCurrency: "JPY",
        usdToLocalRate: 146.12,
        usdToLocalRateExact: "146.12",
        rateProvider: "frankfurter",
        rateEffectiveDate: "2026-08-28",
        rateResponseDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        version: 4,
      },
    });
    expect(mocks.fetchPinnedPublicText).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestTimeoutMs: 6_000,
        responseBodyTimeoutMs: 6_000,
        responseLimitBytes: 64 * 1024,
        signal: syncRequest.signal,
      }),
    );
    const providerUrl = mocks.fetchPinnedPublicText.mock.calls[0]?.[0];
    expect(String(providerUrl)).toContain("to=JPY");
    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE mall_currency_settings"),
    );
    expect(updateCall?.[1]).toEqual([
      mocks.tenantId,
      "JPY",
      "146.12",
      "api.frankfurter.app",
      "frankfurter",
      "2026-08-28",
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      "3",
    ]);
    const auditCall = client.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO platform_audit_events"),
    );
    expect(JSON.parse(String(auditCall?.[1]?.[3]))).toMatchObject({
      previous_usd_to_local_rate_exact: "7.2",
      usd_to_local_rate_exact: "146.12",
      rate_provider: "frankfurter",
      rate_effective_date: "2026-08-28",
    });
    vi.unstubAllGlobals();
  });

  it("propagates request cancellation to the pinned provider before opening a database transaction", async () => {
    const controller = new AbortController();
    const syncRequest = new Request(
      "https://matchplane.test/api/mall/exchange-rate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://matchplane.test",
        },
        body: JSON.stringify({ localCurrency: "JPY", expectedVersion: 3 }),
        signal: controller.signal,
      },
    );
    mocks.fetchPinnedPublicText.mockImplementation(async (_url, options) => {
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    });

    const pending = POST(syncRequest);
    await vi.waitFor(() => {
      expect(mocks.fetchPinnedPublicText).toHaveBeenCalledOnce();
    });
    expect(mocks.fetchPinnedPublicText.mock.calls[0]?.[1]?.signal).toBe(
      syncRequest.signal,
    );
    controller.abort();

    const response = await pending;
    expect(response.status).toBe(504);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rolls back a provider sync aborted during the database update without writing an audit event", async () => {
    const controller = new AbortController();
    const client = transactionClient();
    client.query.mockImplementation(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM tenants"))
        return { rowCount: 1, rows: [{ id: mocks.tenantId }] };
      if (sql.includes("FROM mall_currency_settings"))
        return { rowCount: 1, rows: [current] };
      if (sql.includes("UPDATE mall_currency_settings")) {
        controller.abort();
        return {
          rowCount: 1,
          rows: [
            {
              ...current,
              localCurrency: "JPY",
              usdToLocalRate: "146.12",
              rateSource: "api.frankfurter.app",
              rateProvider: "frankfurter",
              rateEffectiveDate: "2026-08-28",
              rateResponseDigest: `sha256:${"b".repeat(64)}`,
              rateUpdatedAt: "2026-08-28T06:00:00.000Z",
              version: "4",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO platform_audit_events"))
        return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base: "USD",
              date: "2026-08-28",
              rates: { JPY: "146.12" },
            }),
            { status: 200 },
          ),
      ),
    );
    const syncRequest = new Request(
      "https://matchplane.test/api/mall/exchange-rate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://matchplane.test",
        },
        body: JSON.stringify({ localCurrency: "JPY", expectedVersion: 3 }),
        signal: controller.signal,
      },
    );

    const response = await POST(syncRequest);

    expect(response.status).toBe(504);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(
      client.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO platform_audit_events"),
      ),
    ).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["default", undefined],
    ["custom", "https://rates.example/latest"],
  ])("requires an explicit USD base from the %s provider", async (_name, url) => {
    if (url) vi.stubEnv("MATCHPLANE_EXCHANGE_RATE_URL", url);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ date: "2026-08-28", rates: { JPY: "146.12" } }),
            { status: 200 },
          ),
      ),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务返回了无效数据，请稍后重试",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("keeps the provider decimal exact in SQL and audit metadata", async () => {
    const exact = "146.12345678901234567890123456789";
    const client = transactionClient();
    client.query.mockImplementation(async (sql, parameters) => {
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
              localCurrency: "JPY",
              usdToLocalRate: parameters?.[2],
              rateProvider: parameters?.[4],
              rateEffectiveDate: parameters?.[5],
              rateResponseDigest: parameters?.[6],
              version: "4",
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);
    const providerPayload =
      `{"base":"USD","date":"2026-08-28","provider":"decimal-feed",` +
      `"rates":{"JPY":${exact}}}`;
    const expectedDigest = `sha256:${createHash("sha256")
      .update(providerPayload)
      .digest("hex")}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(providerPayload, { status: 200 })),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(200);
    const updateCall = client.query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE mall_currency_settings"),
    );
    expect(updateCall?.[1]?.[2]).toBe(exact);
    expect(updateCall?.[1]?.[6]).toBe(expectedDigest);
    const auditCall = client.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO platform_audit_events"),
    );
    const metadata = JSON.parse(String(auditCall?.[1]?.[3]));
    expect(metadata.usd_to_local_rate_exact).toBe(exact);
    expect(typeof metadata.usd_to_local_rate_exact).toBe("string");
    await expect(response.json()).resolves.toMatchObject({
      exchangeRate: { usdToLocalRateExact: exact },
    });
  });

  it("rolls back the rate write when the audit insert fails", async () => {
    const client = transactionClient();
    client.query.mockImplementation(async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return {};
      if (sql.includes("FROM tenants"))
        return { rowCount: 1, rows: [{ id: mocks.tenantId }] };
      if (sql.includes("FROM mall_currency_settings"))
        return { rowCount: 1, rows: [current] };
      if (sql.includes("UPDATE mall_currency_settings")) {
        return { rowCount: 1, rows: [{ ...current, version: "4" }] };
      }
      if (sql.includes("INSERT INTO platform_audit_events")) {
        throw new Error("audit unavailable");
      }
      return { rowCount: 1, rows: [] };
    });
    mocks.connect.mockResolvedValue(client);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              base: "USD",
              date: "2026-08-28",
              rates: { JPY: "146.12" },
            }),
            { status: 200 },
          ),
      ),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(500);
    expect(client.query.mock.calls.some(([sql]) =>
      sql.includes("UPDATE mall_currency_settings"),
    )).toBe(true);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务配置无效",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned connector rejects resolved addresses", async () => {
    vi.stubEnv(
      "MATCHPLANE_EXCHANGE_RATE_URL",
      "https://provider.example/latest",
    );
    mocks.fetchPinnedPublicText.mockRejectedValueOnce(
      new PinnedPublicEndpointError(),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务配置无效",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
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

    expect(response.status).toBe(503);
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

    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps blocked redirects to an upstream provider failure", async () => {
    mocks.fetchPinnedPublicText.mockRejectedValueOnce(
      new PinnedPublicRedirectError(302),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务暂时不可用，请稍后重试",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("maps unsupported provider currencies to a client error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    const response = await POST(
      request("POST", { localCurrency: "TWD", expectedVersion: 3 }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务暂不支持该本地货币",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("maps malformed provider data to an upstream failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ base: "USD", rates: {} }), {
            status: 200,
          }),
      ),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务返回了无效数据，请稍后重试",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("maps a pinned response-body timeout without opening a transaction", async () => {
    mocks.fetchPinnedPublicText.mockRejectedValueOnce(
      Object.assign(new Error("response body timed out"), {
        name: "TimeoutError",
      }),
    );

    const response = await POST(
      request("POST", { localCurrency: "JPY", expectedVersion: 3 }),
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "汇率服务响应超时，请稍后重试",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(["40001", "40P01"])(
    "maps PostgreSQL transaction conflict %s to 409",
    async (code) => {
      const client = transactionClient();
      client.query.mockImplementation(async (sql: string) => {
        if (sql === "ROLLBACK") return {};
        throw Object.assign(new Error("transaction conflict"), { code });
      });
      mocks.connect.mockResolvedValue(client);

      const response = await PATCH(
        request("PATCH", { localCurrency: "EUR", expectedVersion: 3 }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "货币设置已被其他人更新，请刷新后重试",
      });
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    },
  );

  it("requires the trusted owner session for mutations", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await PATCH(
      request("PATCH", { localCurrency: "EUR", expectedVersion: 3 }),
    );
    expect(response.status).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
