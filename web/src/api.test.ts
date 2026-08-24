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
      "used-car",
    );

    expect(readPartySession("buyer", "used-car")).toBeNull();
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
      "used-car",
    );

    expect(readPartySession("buyer", "used-car")?.accessToken).toBe("active");
  });

  it("shares a dual-role store capability between buyer and seller surfaces", () => {
    const session = {
      tenantId: "123e4567-e89b-12d3-a456-426614174000",
      partyId: "223e4567-e89b-12d3-a456-426614174000",
      role: "both" as const,
      accessToken: "shared",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      platformPath: "/used-car",
    };
    savePartySession(session, "used-car", "seller", "/used-car");

    expect(
      readPartySession("buyer", "used-car", "/used-car")?.accessToken,
    ).toBe("shared");
    expect(
      readPartySession("seller", "used-car", "/used-car")?.accessToken,
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
      "used-car",
      "admin",
    );
    savePartySession(
      {
        ...base,
        accessToken: "active",
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      "used-car",
      "both",
    );

    expect(readPartySession("admin", "used-car")?.accessToken).toBe("active");
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
      "used-car",
      "buyer",
    );

    expect(
      readPartySession(
        "buyer",
        "used-car",
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
      "used-car",
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
