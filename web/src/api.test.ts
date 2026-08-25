import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  askMallShoppingAssistant,
  clearPartySessionCache,
  MarketplaceApiError,
  readPartySession,
  savePartySession,
} from "./api";

describe("marketplace capability cache", () => {
  beforeEach(() => clearPartySessionCache());

  it("rejects an expired capability so the caller can exchange a fresh one", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "expired",
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      "store-a",
    );

    expect(readPartySession("buyer", "store-a")).toBeNull();
  });

  it("accepts only a capability whose deadline is still in the future", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "active",
        accessTokenExpiresAt: expiresAt,
      },
      "store-a",
    );

    expect(readPartySession("buyer", "store-a")?.accessToken).toBe("active");
  });

  it("shares a dual-role store capability between buyer and seller surfaces", () => {
    const session = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both" as const,
      accessToken: "shared",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      platformPath: "/store-a",
    };
    savePartySession(session, "store-a", "seller", "/store-a");

    expect(
      readPartySession("buyer", "store-a", "/store-a")?.accessToken,
    ).toBe("shared");
    expect(
      readPartySession("seller", "store-a", "/store-a")?.accessToken,
    ).toBe("shared");
  });

  it("does not let an expired admin cache hide a valid dual-role capability", () => {
    const base = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both" as const,
    };
    savePartySession(
      {
        ...base,
        accessToken: "expired",
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
      "store-a",
      "admin",
    );
    savePartySession(
      {
        ...base,
        accessToken: "active",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "store-a",
      "both",
    );

    expect(readPartySession("admin", "store-a")?.accessToken).toBe("active");
  });

  it("does not reuse a capability after the Better Auth user changes", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        authUserId: "333e4567-e89b-12d3-a456-426614174000", // gitleaks:allow -- deterministic UUID fixture
        role: "buyer",
        accessToken: "alice",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "store-a",
      "buyer",
    );

    expect(
      readPartySession(
        "buyer",
        "store-a",
        undefined,
        "444e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBeNull();
  });

  it("never writes the short-lived bearer to browser storage", () => {
    savePartySession(
      {
        tenantId: "123e4567-e89b-12d3-a456-426614174000",
        partyId: "223e4567-e89b-12d3-a456-426614174000",
        role: "buyer",
        accessToken: "memory-only",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "store-a",
    );

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("shopping assistant retry metadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a rate-limit detail and Retry-After timing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "请求过于频繁，请稍后再试。",
                code: "rate_limited",
                retryable: true,
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "90",
              },
            },
          ),
      ),
    );

    const error = await askMallShoppingAssistant([
      { role: "user", content: "帮我找一台电脑" },
    ]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MarketplaceApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "请求过于频繁，请稍后再试。",
      retryable: true,
      retryAfterMs: 90_000,
    });
  });

  it("preserves gateway timeout Retry-After metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "下游平台响应超时，请稍后重试。",
                code: "gateway_timeout",
                retryable: true,
              },
              requestId: "44444444-4444-4444-8444-444444444444",
            }),
            {
              status: 504,
              headers: {
                "content-type": "application/json",
                "retry-after": "5",
                "x-request-id": "44444444-4444-4444-8444-444444444444",
              },
            },
          ),
      ),
    );

    const error = await askMallShoppingAssistant([
      { role: "user", content: "帮我找一台电脑" },
    ]).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      status: 504,
      code: "gateway_timeout",
      message: "下游平台响应超时，请稍后重试。",
      retryable: true,
      retryAfterMs: 5_000,
    });
  });

  it("accepts a bounded search trace tied to visible result stores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          requestId: "55555555-5555-4555-8555-555555555554",
          answer: "找到三件商品。",
          recommendations: [
            { listing_id: "offer-1", platform_path: "/store-a" },
            { listing_id: "offer-2", platform_path: "/store-a" },
            { listing_id: "offer-3", platform_path: "/store-b" },
          ],
          uiActions: [],
          searchTrace: {
            source: "visible_recommendations",
            resultCount: 3,
            stores: [
              { path: "/store-a", displayName: "示例店铺甲", offerCount: 2 },
              { path: "/store-b", displayName: "示例店铺乙", offerCount: 1 },
            ],
          },
        }),
      ),
    );

    await expect(
      askMallShoppingAssistant([{ role: "user", content: "找一辆通勤车" }]),
    ).resolves.toMatchObject({
      searchTrace: {
        source: "visible_recommendations",
        resultCount: 3,
        stores: [
          { path: "/store-a", displayName: "示例店铺甲", offerCount: 2 },
          { path: "/store-b", displayName: "示例店铺乙", offerCount: 1 },
        ],
      },
    });
  });

  it("drops an inconsistent or unbounded search trace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          requestId: "55555555-5555-4555-8555-555555555553",
          answer: "暂时没有可验证的来源。",
          recommendations: [],
          uiActions: [],
          searchTrace: {
            source: "visible_recommendations",
            resultCount: 99,
            stores: [
              { path: "https://private.example", displayName: "未知店铺", offerCount: 1 },
            ],
          },
        }),
      ),
    );

    await expect(
      askMallShoppingAssistant([{ role: "user", content: "找一件商品" }]),
    ).resolves.not.toHaveProperty("searchTrace");
  });

  it("drops a recursive path even when a recommendation repeats it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          requestId: "55555555-5555-4555-8555-555555555552",
          answer: "忽略非 canonical 路径。",
          recommendations: [
            { listing_id: "offer-nested", platform_path: "/group/store-a" },
          ],
          uiActions: [],
          searchTrace: {
            source: "visible_recommendations",
            resultCount: 1,
            stores: [
              { path: "/group/store-a", displayName: "嵌套店铺", offerCount: 1 },
            ],
          },
        }),
      ),
    );

    await expect(
      askMallShoppingAssistant([{ role: "user", content: "找一件商品" }]),
    ).resolves.not.toHaveProperty("searchTrace");
  });

  it("returns request identity with a typed empty-catalog outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              requestId: "55555555-5555-4555-8555-555555555555",
              answer: "当前公开目录里暂时还没有可推荐的商品。",
              recommendations: [],
              uiActions: [],
              outcome: "empty_catalog",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    await expect(
      askMallShoppingAssistant([{ role: "user", content: "现在有什么商品？" }]),
    ).resolves.toMatchObject({
      requestId: "55555555-5555-4555-8555-555555555555",
      answer: "当前公开目录里暂时还没有可推荐的商品。",
      recommendations: [],
      outcome: "empty_catalog",
    });
  });
});
