import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PlatformRouterQuotaExceededError extends Error {}
  return {
    admitPlatformAiCall: vi.fn(),
    authDatabaseConnect: vi.fn(),
    decidePlatformRoutes: vi.fn(),
    getSession: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    isPlatformRouterConfigured: vi.fn(),
    readPublicStores: vi.fn(),
    searchPublicStoreOffers: vi.fn(),
    storeRouteCandidates: vi.fn(),
    PlatformRouterQuotaExceededError,
  };
});

vi.mock("./platform-ai-admission", () => ({
  admitPlatformAiCall: mocks.admitPlatformAiCall,
}));
vi.mock("./platform-router", () => ({
  decidePlatformRoutes: mocks.decidePlatformRoutes,
  isPlatformRouterConfigured: mocks.isPlatformRouterConfigured,
  PlatformRouterQuotaExceededError: mocks.PlatformRouterQuotaExceededError,
}));
vi.mock("./store-directory", () => ({
  readPublicStores: mocks.readPublicStores,
  storeRouteCandidates: mocks.storeRouteCandidates,
}));
vi.mock("./storefront-search", () => ({
  searchPublicStoreOffers: mocks.searchPublicStoreOffers,
}));
vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { connect: mocks.authDatabaseConnect },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));

import { POST } from "../app/api/mall/search/route";
import { PublicStorefrontRankingError } from "./storefront-ranking-contract";

const originalTenantId = process.env.MATCHPLANE_ROOT_TENANT_ID;
const tenantId = "11111111-1111-4111-8111-111111111111";
const store = {
  slug: "camera-house",
  path: "/camera-house",
  displayName: "相机屋",
};

beforeEach(() => {
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.readPublicStores.mockResolvedValue([store]);
  mocks.isPlatformRouterConfigured.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalTenantId === undefined)
    delete process.env.MATCHPLANE_ROOT_TENANT_ID;
  else process.env.MATCHPLANE_ROOT_TENANT_ID = originalTenantId;
});

function request(): Request {
  return new Request("http://localhost/api/mall/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify({
      narrative: "旅行相机",
      storePath: store.path,
    }),
  });
}

describe("mall public product-search failure mapping", () => {
  it("maps a typed Rust ranking failure to a bounded visible 503", async () => {
    mocks.searchPublicStoreOffers.mockRejectedValue(
      new PublicStorefrontRankingError("timeout", { batchIndex: 2 }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({ error: "商品搜索暂时不可用，请稍后重试" });
    expect(JSON.stringify(payload)).not.toContain("旅行相机");
    expect(JSON.stringify(payload)).not.toContain("token");
    expect(consoleError).toHaveBeenCalledWith(
      "mall product search failed",
      expect.objectContaining({
        code: "public_storefront_ranking_failed",
        kind: "timeout",
      }),
    );
    expect(mocks.authDatabaseConnect).not.toHaveBeenCalled();
  });
});
