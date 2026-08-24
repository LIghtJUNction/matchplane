import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, hasTrustedBrowserOrigin, query, readStoreAccess } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    query: vi.fn(),
    readStoreAccess: vi.fn(),
  }));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/store-access", () => ({
  configuredTenantId: () => "11111111-1111-4111-8111-111111111111",
  readStoreAccess,
  roleOf: () => "user",
}));

import { PATCH } from "../app/api/stores/[storeId]/lifecycle/route";

const storeId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const baseStore = {
  id: storeId,
  tenantId: "11111111-1111-4111-8111-111111111111",
  slug: "store-a1b2c3d4e5f6",
  path: "/store-a1b2c3d4e5f6",
  displayName: "山里杂货铺",
  description: "手作与山货",
  integrationKind: "hosted",
  status: "active",
  version: 1,
  domainId: "44444444-4444-4444-8444-444444444444",
  organizationId: "55555555-5555-4555-8555-555555555555",
};

function request(action: "close" | "reopen", expectedVersion = 1): Request {
  return new Request(
    `https://matchplane.test/api/stores/${storeId}/lifecycle`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://matchplane.test",
      },
      body: JSON.stringify({ action, expectedVersion }),
    },
  );
}

const context = { params: Promise.resolve({ storeId }) };

describe("store lifecycle route", () => {
  beforeEach(() => {
    getSession.mockReset();
    hasTrustedBrowserOrigin.mockReset();
    query.mockReset();
    readStoreAccess.mockReset();
    hasTrustedBrowserOrigin.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { id: userId, role: "user" } });
    readStoreAccess.mockResolvedValue({
      store: baseStore,
      canOperate: true,
      canManageStore: true,
    });
  });

  it("soft-closes an active store and records the transition atomically", async () => {
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{ ...baseStore, status: "closed", version: 2 }],
    });

    const response = await PATCH(request("close"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      store: expect.objectContaining({
        id: storeId,
        status: "closed",
        version: 2,
      }),
    });
    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WITH transitioned AS");
    expect(sql).toContain("INSERT INTO platform_audit_events");
    expect(parameters.slice(2, 5)).toEqual([1, "closed", "active"]);
    expect(parameters[7]).toBe("store.closed");
  });

  it("reopens only a closed store with a ready integration", async () => {
    readStoreAccess.mockResolvedValue({
      store: { ...baseStore, status: "closed", version: 4 },
      canOperate: true,
      canManageStore: true,
    });
    query.mockResolvedValue({
      rowCount: 1,
      rows: [{ ...baseStore, status: "active", version: 5 }],
    });

    const response = await PATCH(request("reopen", 4), context);

    expect(response.status).toBe(200);
    const [, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters.slice(2, 5)).toEqual([4, "active", "closed"]);
    expect(parameters[7]).toBe("store.reopened");
  });

  it("does not let a store owner bypass an administrative suspension", async () => {
    readStoreAccess.mockResolvedValue({
      store: { ...baseStore, status: "suspended" },
      canOperate: true,
      canManageStore: true,
    });

    const response = await PATCH(request("close"), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining("商城暂停") }),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("reports an integration readiness conflict instead of pretending to reopen", async () => {
    readStoreAccess.mockResolvedValue({
      store: { ...baseStore, status: "closed" },
      canOperate: true,
      canManageStore: true,
    });
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    const response = await PATCH(request("reopen"), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("接入尚未就绪"),
      }),
    );
  });

  it("rejects cross-origin lifecycle changes before reading a session", async () => {
    hasTrustedBrowserOrigin.mockReturnValue(false);

    const response = await PATCH(request("close"), context);

    expect(response.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
