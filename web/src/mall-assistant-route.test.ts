import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PlatformRouterQuotaExceededError extends Error {}
  class PublicStoreDirectoryBudgetExceededError extends Error {
    readonly code = "public_store_directory_budget_exceeded";
    readonly maximum = 500;

    constructor(readonly actual: number) {
      super(`public store directory budget exceeded: ${actual} > 500`);
    }
  }
  class PublicOfferSearchBudgetExceededError extends Error {
    readonly code = "public_offer_search_budget_exceeded";

    constructor(
      readonly budget: string,
      readonly actual: number,
      readonly maximum: number,
    ) {
      super(`public storefront search ${budget} budget exceeded`);
    }
  }
  class PlatformAssistantUnavailableError extends Error {
    readonly kind: string;
    readonly phase: string;
    readonly retryable: boolean;

    constructor(
      message: string,
      metadata: { kind: string; phase: string; retryable?: boolean },
    ) {
      super(message);
      this.kind = metadata.kind;
      this.phase = metadata.phase;
      this.retryable = metadata.retryable ?? true;
    }
  }
  return {
    admitPlatformAiCall: vi.fn(),
    answerPlatformShoppingQuestion: vi.fn(),
    authDatabaseQuery: vi.fn(),
    configuredTenantId: vi.fn(),
    getPlatformRouterEffectiveStatus: vi.fn(),
    getSession: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    isPlatformRouterConfigured: vi.fn(),
    readPublicStores: vi.fn(),
    readShoppingMemory: vi.fn(),
    writeShoppingMemory: vi.fn(),
    PlatformAssistantUnavailableError,
    PlatformRouterQuotaExceededError,
    PublicOfferSearchBudgetExceededError,
    PublicStoreDirectoryBudgetExceededError,
  };
});

vi.mock("./platform-ai-admission", () => ({
  admitPlatformAiCall: mocks.admitPlatformAiCall,
}));
vi.mock("./platform-router", () => ({
  answerPlatformShoppingQuestion: mocks.answerPlatformShoppingQuestion,
  isPlatformRouterConfigured: mocks.isPlatformRouterConfigured,
  PlatformAssistantUnavailableError: mocks.PlatformAssistantUnavailableError,
  PlatformRouterQuotaExceededError: mocks.PlatformRouterQuotaExceededError,
}));
vi.mock("./store-directory", () => ({
  MAX_PUBLIC_STORES: 500,
  PublicStoreDirectoryBudgetExceededError:
    mocks.PublicStoreDirectoryBudgetExceededError,
  readPublicStores: mocks.readPublicStores,
}));
vi.mock("./storefront-search", () => ({
  PublicOfferSearchBudgetExceededError:
    mocks.PublicOfferSearchBudgetExceededError,
}));
vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.authDatabaseQuery },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./lib/platform-router-config", () => ({
  getPlatformRouterEffectiveStatus: mocks.getPlatformRouterEffectiveStatus,
}));
vi.mock("./lib/store-access", () => ({
  configuredTenantId: mocks.configuredTenantId,
}));
vi.mock("./shopping-memory", () => ({
  parseShoppingMemoryMutation: vi.fn(),
  readShoppingMemory: mocks.readShoppingMemory,
  writeShoppingMemory: mocks.writeShoppingMemory,
}));

import { POST } from "../app/api/mall/assistant/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
    ready: true,
    source: "managed",
    issues: [],
    credentialConfigured: true,
  });
  mocks.isPlatformRouterConfigured.mockReturnValue(true);
  mocks.configuredTenantId.mockReturnValue(tenantId);
  mocks.getSession.mockResolvedValue({ user: { id: userId } });
  mocks.readPublicStores.mockResolvedValue([]);
  mocks.readShoppingMemory.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

function assistantRequest(
  body: Record<string, unknown> = { question: "帮我找一款商品" },
): Request {
  return new Request("http://localhost/api/mall/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}

function successfulReply() {
  return {
    text: "找到一件公开商品。",
    model: "deterministic",
    usage: null,
    modelCalls: 0,
    recommendations: [],
    toolCalls: [],
    uiActions: [],
  };
}

describe("mall assistant store directory budget", () => {
  it("requests the overflow sentinel for an unscoped mall search", async () => {
    mocks.answerPlatformShoppingQuestion.mockResolvedValue(successfulReply());

    const response = await POST(assistantRequest());

    expect(response.status).toBe(200);
    expect(mocks.readPublicStores).toHaveBeenCalledWith(tenantId, {
      limit: 501,
    });
  });

  it("rejects the 501st global store before assistant scoring", async () => {
    mocks.readPublicStores.mockResolvedValue(Array.from({ length: 501 }, () => ({})));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const response = await POST(assistantRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "public_store_directory_budget_exceeded",
        retryable: false,
        requestId: expect.any(String),
      });
      expect(mocks.answerPlatformShoppingQuestion).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("public_store_directory_budget_exceeded"),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("maps candidate overflow to a typed non-retryable 503", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PublicOfferSearchBudgetExceededError(
        "candidates",
        2_001,
        2_000,
      ),
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const response = await POST(assistantRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "public_offer_search_budget_exceeded",
        retryable: false,
        requestId: expect.any(String),
      });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          '"budget":"candidates","actual":2001,"maximum":2000',
        ),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("uses an exact SQL-scoped path even when the global directory exceeds 500", async () => {
    const target = {
      path: "/target-store",
      displayName: "目标店铺",
    };
    const globalStores = Array.from({ length: 501 }, () => ({}));
    mocks.readPublicStores.mockImplementation(async (_tenant, options) =>
      options?.path === target.path ? [target] : globalStores,
    );
    mocks.answerPlatformShoppingQuestion.mockResolvedValue(successfulReply());

    const response = await POST(
      assistantRequest({ question: "找商品", storePath: target.path }),
    );

    expect(response.status).toBe(200);
    expect(mocks.readPublicStores).toHaveBeenCalledTimes(1);
    expect(mocks.readPublicStores).toHaveBeenCalledWith(tenantId, {
      path: target.path,
    });
    expect(mocks.answerPlatformShoppingQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        stores: [target],
        storeContext: { path: target.path, name: target.displayName },
      }),
    );
  });

  it("attributes store-scoped assistant usage to the canonical store path", async () => {
    const target = {
      path: "/target-store",
      displayName: "目标店铺",
    };
    mocks.readPublicStores.mockResolvedValue([target]);
    mocks.answerPlatformShoppingQuestion.mockResolvedValue(successfulReply());

    const response = await POST(
      assistantRequest({ question: "找商品", storePath: target.path }),
    );

    expect(response.status).toBe(200);
    expect(mocks.authDatabaseQuery).toHaveBeenCalledOnce();
    expect(
      String(mocks.authDatabaseQuery.mock.calls[0]?.[0]).match(/\$11/g),
    ).toHaveLength(2);
    expect(mocks.authDatabaseQuery.mock.calls[0]?.[1]?.[10]).toBe(target.path);
  });

  it("keeps an unknown exact store path as a 404", async () => {
    mocks.readPublicStores.mockResolvedValue([]);

    const response = await POST(
      assistantRequest({ question: "找商品", storePath: "/missing-store" }),
    );

    expect(response.status).toBe(404);
    expect(mocks.readPublicStores).toHaveBeenCalledWith(tenantId, {
      path: "/missing-store",
    });
    expect(mocks.answerPlatformShoppingQuestion).not.toHaveBeenCalled();
  });
});

describe("mall assistant provider failure mapping", () => {
  it("blocks public AI safely while managed configuration is degraded", async () => {
    mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
      ready: false,
      source: "managed",
      issues: ["model_invalid"],
      credentialConfigured: true,
    });

    const response = await POST(assistantRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "upstream_configuration",
      status: "degraded",
      retryable: false,
      provider: {
        source: "managed",
        issues: ["model_invalid"],
        credentialConfigured: true,
      },
    });
    expect(mocks.answerPlatformShoppingQuestion).not.toHaveBeenCalled();
  });
  it("maps provider timeout to a retryable 504 with no-store and Retry-After", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PlatformAssistantUnavailableError("响应超时，请稍后重试。", {
        kind: "first_byte_timeout",
        phase: "first_byte",
      }),
    );

    const request = assistantRequest();
    const response = await POST(request);

    expect(response.status).toBe(504);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    await expect(response.json()).resolves.toMatchObject({
      error: "响应超时，请稍后重试。",
      code: "provider_first_byte_timeout",
      retryable: true,
      requestId: expect.any(String),
    });
    expect(mocks.answerPlatformShoppingQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: request.signal,
        requestId: expect.any(String),
      }),
    );
  });

  it("reports no-final-text distinctly from generic service unavailability", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PlatformAssistantUnavailableError(
        "AI 模型未返回有效回答，请重试。",
        { kind: "no_final_text", phase: "response" },
      ),
    );

    const response = await POST(assistantRequest());

    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_no_final_text",
      retryable: true,
    });
  });

  it("maps a retryable internal tool failure to 503 without exposing its cause", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PlatformAssistantUnavailableError(
        "商城 AI 导购的内部工具暂时不可用，请稍后重试。",
        { kind: "tool_failure", phase: "tool" },
      ),
    );

    const response = await POST(assistantRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      error: "商城 AI 导购的内部工具暂时不可用，请稍后重试。",
      code: "provider_tool_failure",
      retryable: true,
    });
  });

  it("does not add Retry-After for non-retryable upstream client errors", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PlatformAssistantUnavailableError(
        "商城 AI 导购上游拒绝了请求，请联系管理员检查服务配置。",
        {
          kind: "upstream_http",
          phase: "response",
          retryable: false,
        },
      ),
    );

    const response = await POST(assistantRequest());

    expect(response.status).toBe(502);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_upstream_http",
      retryable: false,
    });
  });

  it("serializes the bounded visible-result search trace", async () => {
    mocks.answerPlatformShoppingQuestion.mockResolvedValue({
      text: "找到三件公开商品。",
      model: "shopping-model",
      usage: null,
      modelCalls: 1,
      recommendations: [],
      toolCalls: ["search_public_products"],
      uiActions: [],
      searchTrace: {
        source: "visible_recommendations",
        resultCount: 3,
        stores: [
          { path: "/store-a", displayName: "示例店铺甲", offerCount: 2 },
          { path: "/store-b", displayName: "示例店铺乙", offerCount: 1 },
        ],
      },
    });

    const response = await POST(assistantRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      answer: "找到三件公开商品。",
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

  it("keeps malformed output separate from an unreachable provider", async () => {
    mocks.answerPlatformShoppingQuestion.mockRejectedValue(
      new mocks.PlatformAssistantUnavailableError(
        "AI 模型返回了无法解析的响应，请重试。",
        { kind: "malformed_response", phase: "response" },
      ),
    );

    const response = await POST(assistantRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_malformed_response",
    });
  });
});
