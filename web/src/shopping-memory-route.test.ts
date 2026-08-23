import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  admitPlatformAiCall,
  auditQuery,
  deleteShoppingMemory,
  getSession,
  hasTrustedBrowserOrigin,
  parseShoppingMemoryMutation,
  readShoppingMemory,
  reviseShoppingMemoryWithAi,
  writeShoppingMemory,
} = vi.hoisted(() => ({
  admitPlatformAiCall: vi.fn(),
  auditQuery: vi.fn(),
  deleteShoppingMemory: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  parseShoppingMemoryMutation: vi.fn(),
  readShoppingMemory: vi.fn(),
  reviseShoppingMemoryWithAi: vi.fn(),
  writeShoppingMemory: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query: auditQuery },
}));
vi.mock("./platform-ai-admission", () => ({ admitPlatformAiCall }));
vi.mock("./platform-router", () => ({
  PlatformAssistantUnavailableError: class PlatformAssistantUnavailableError extends Error {},
  PlatformRouterQuotaExceededError: class PlatformRouterQuotaExceededError extends Error {},
  reviseShoppingMemoryWithAi,
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./shopping-memory", () => ({
  deleteShoppingMemory,
  parseShoppingMemoryMutation,
  readShoppingMemory,
  ShoppingMemoryValidationError: class ShoppingMemoryValidationError extends Error {},
  writeShoppingMemory,
}));

import { DELETE, GET, POST, PUT } from "../app/api/mall/memory/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const emptyMemory = { enabled: true, facts: [], version: 0, updatedAt: null };

beforeEach(() => {
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
  getSession.mockResolvedValue({ user: { id: authUserId } });
  hasTrustedBrowserOrigin.mockReturnValue(true);
  admitPlatformAiCall.mockResolvedValue(true);
  auditQuery.mockResolvedValue({ rows: [] });
  readShoppingMemory.mockResolvedValue(emptyMemory);
  deleteShoppingMemory.mockResolvedValue(emptyMemory);
  parseShoppingMemoryMutation.mockReturnValue({
    enabled: true,
    facts: [],
    expectedVersion: 0,
  });
  writeShoppingMemory.mockResolvedValue({
    enabled: true,
    facts: [],
    version: 1,
    updatedAt: "2026-08-22T08:00:00.000Z",
  });
  reviseShoppingMemoryWithAi.mockImplementation(async (input) => {
    await input.admitCall?.();
    return {
      message: "已把预算改为 8000 元。",
      facts: [
        { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
      ],
      model: "shopping-model",
      usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
    };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MATCHPLANE_ROOT_TENANT_ID;
});

describe("shopping memory route", () => {
  it("requires a signed-in account", async () => {
    getSession.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/mall/memory"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "请先登录再管理购物记忆",
    });
    expect(readShoppingMemory).not.toHaveBeenCalled();
  });

  it("reads only the current tenant and account without caching", async () => {
    const response = await GET(new Request("http://localhost/api/mall/memory"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(readShoppingMemory).toHaveBeenCalledWith(tenantId, authUserId);
  });

  it("rejects untrusted write origins before touching durable state", async () => {
    hasTrustedBrowserOrigin.mockReturnValue(false);
    const response = await PUT(
      new Request("http://localhost/api/mall/memory", {
        method: "PUT",
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(writeShoppingMemory).not.toHaveBeenCalled();
  });

  it("saves an explicitly versioned profile", async () => {
    const body = { enabled: true, facts: [], expectedVersion: 0 };
    const response = await PUT(
      new Request("http://localhost/api/mall/memory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(parseShoppingMemoryMutation).toHaveBeenCalledWith(body);
    expect(writeShoppingMemory).toHaveBeenCalledWith({
      tenantId,
      authUserId,
      mutation: { enabled: true, facts: [], expectedVersion: 0 },
    });
  });

  it("returns a conflict instead of overwriting a newer profile", async () => {
    writeShoppingMemory.mockResolvedValue(null);
    const response = await PUT(
      new Request("http://localhost/api/mall/memory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, facts: [], expectedVersion: 0 }),
      }),
    );
    expect(response.status).toBe(409);
  });

  it("lets AI revise the complete memory snapshot from a user suggestion", async () => {
    const current = { ...emptyMemory, version: 2 };
    const mutation = {
      enabled: true,
      expectedVersion: 2,
      facts: [
        { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
      ],
    };
    const saved = {
      enabled: true,
      facts: mutation.facts,
      version: 3,
      updatedAt: "2026-08-22T09:00:00.000Z",
    };
    readShoppingMemory.mockResolvedValue(current);
    parseShoppingMemoryMutation.mockReturnValue(mutation);
    writeShoppingMemory.mockResolvedValue(saved);

    const response = await POST(
      new Request("http://localhost/api/mall/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          suggestion: "预算改成 8000 元",
          expectedVersion: 2,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      memory: saved,
      message: "已把预算改为 8000 元。",
    });
    expect(reviseShoppingMemoryWithAi).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestion: "预算改成 8000 元",
        memory: current,
      }),
    );
    expect(admitPlatformAiCall).toHaveBeenCalled();
    expect(writeShoppingMemory).toHaveBeenCalledWith({
      tenantId,
      authUserId,
      mutation,
      source: "assistant_revision",
    });
  });

  it("hard-deletes the current account profile", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/mall/memory", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(deleteShoppingMemory).toHaveBeenCalledWith({ tenantId, authUserId });
  });
});
