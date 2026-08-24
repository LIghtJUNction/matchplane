import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PlatformRouterQuotaExceededError extends Error {}
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
    getSession: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    isPlatformRouterConfigured: vi.fn(),
    readPublicStores: vi.fn(),
    readShoppingMemory: vi.fn(),
    writeShoppingMemory: vi.fn(),
    PlatformAssistantUnavailableError,
    PlatformRouterQuotaExceededError,
  };
});

vi.mock("./platform-ai-admission", () => ({
  admitPlatformAiCall: mocks.admitPlatformAiCall,
}));
vi.mock("./platform-router", () => ({
  answerPlatformShoppingQuestion: mocks.answerPlatformShoppingQuestion,
  isPlatformRouterConfigured: mocks.isPlatformRouterConfigured,
  PlatformAssistantUnavailableError:
    mocks.PlatformAssistantUnavailableError,
  PlatformRouterQuotaExceededError: mocks.PlatformRouterQuotaExceededError,
}));
vi.mock("./store-directory", () => ({
  readPublicStores: mocks.readPublicStores,
}));
vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.authDatabaseQuery },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
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
  mocks.isPlatformRouterConfigured.mockReturnValue(true);
  mocks.configuredTenantId.mockReturnValue(tenantId);
  mocks.getSession.mockResolvedValue({ user: { id: userId } });
  mocks.readPublicStores.mockResolvedValue([]);
  mocks.readShoppingMemory.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

function assistantRequest(): Request {
  return new Request("http://localhost/api/mall/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify({ question: "帮我找一款商品" }),
  });
}

describe("mall assistant provider failure mapping", () => {
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
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    await expect(response.json()).resolves.toMatchObject({
      error: "响应超时，请稍后重试。",
      code: "provider_first_byte_timeout",
      retryable: true,
      requestId: expect.any(String),
    });
    expect(mocks.answerPlatformShoppingQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ signal: request.signal, requestId: expect.any(String) }),
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
