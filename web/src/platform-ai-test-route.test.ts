import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendPlatformRouterAudit: vi.fn(),
  getManagedPlatformRouterDraftConfig: vi.fn(),
  getPlatformRouterEffectiveStatus: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  markManagedPlatformRouterDraftTested: vi.fn(),
  platformRouterPolicyIssues: vi.fn(),
  probePlatformRouter: vi.fn(),
  readManagedPlatformRouterDraftConfig: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./platform-router", () => ({
  probePlatformRouter: mocks.probePlatformRouter,
}));
vi.mock("./lib/platform-router-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/platform-router-config")>()),
  appendPlatformRouterAudit: mocks.appendPlatformRouterAudit,
  getManagedPlatformRouterDraftConfig:
    mocks.getManagedPlatformRouterDraftConfig,
  getPlatformRouterEffectiveStatus: mocks.getPlatformRouterEffectiveStatus,
  markManagedPlatformRouterDraftTested:
    mocks.markManagedPlatformRouterDraftTested,
  platformRouterPolicyIssues: mocks.platformRouterPolicyIssues,
  readManagedPlatformRouterDraftConfig:
    mocks.readManagedPlatformRouterDraftConfig,
}));

import { POST } from "../app/api/platform/ai/test/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: { id: "11111111-1111-4111-8111-111111111111", role: "rootAdmin" },
  });
  mocks.platformRouterPolicyIssues.mockReturnValue([]);
  mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
    ready: true,
    issues: [],
  });
});

describe("platform AI admin probe route", () => {
  it("returns a structured slow active-provider result as reachable", async () => {
    mocks.probePlatformRouter.mockResolvedValue({
      status: "slow",
      outcome: "slow",
      phase: "first_byte",
      model: "router-test",
      responseStatus: 200,
      latencyMs: 9_200,
      firstByteLatencyMs: 9_100,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "模型网关可达，但响应较慢。",
    });
    const request = new Request("http://localhost/api/platform/ai/test", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "slow",
      latencyMs: 9_200,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
    });
    expect(mocks.probePlatformRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: request.signal,
        requestId: expect.any(String),
      }),
    );
  });

  it("tests a compliant staged config without returning its write-only key", async () => {
    mocks.getSession.mockResolvedValue({
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        role: "rootSuperAdmin",
      },
    });
    const draft = {
      endpoint: "https://api.lmm.best/v1",
      apiKey: "test-only-secret",
      model: "gpt-5.6-sol",
      protocol: "openai-compatible",
      enabled: true,
      credentialConfigured: true,
      assistantInstructions: "",
      assistantMaxOutputTokens: 320,
      assistantTemperature: 0.2,
      assistantMaxSteps: 3,
      assistantTimeoutMs: 20_000,
      assistantReasoningEffort: "none",
      modelReasoningEfforts: [],
      testedReady: false,
      testedAt: null,
      keyChanged: true,
      credentialFile: "server-only.key",
    };
    mocks.readManagedPlatformRouterDraftConfig.mockReturnValue(draft);
    mocks.getManagedPlatformRouterDraftConfig.mockReturnValue(draft);
    mocks.probePlatformRouter.mockResolvedValue({
      status: "ready",
      outcome: "ready",
      phase: "response",
      model: "gpt-5.6-sol",
      responseStatus: 200,
      latencyMs: 800,
      firstByteLatencyMs: 700,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "模型网关连接正常。",
    });

    const response = await POST(
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ candidate: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.probePlatformRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({ apiKey: "test-only-secret" }),
      }),
    );
    expect(mocks.markManagedPlatformRouterDraftTested).toHaveBeenCalled();
    const text = await response.text();
    expect(text).not.toContain("test-only-secret");
    expect(text).not.toContain("fingerprint");
  });

  it("blocks the old effective model before contacting the provider", async () => {
    mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
      ready: false,
      issues: ["model_mismatch"],
    });

    const response = await POST(
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    );

    expect(response.status).toBe(451);
    await expect(response.json()).resolves.toMatchObject({
      code: "upstream_configuration",
      issues: ["model_mismatch"],
    });
    expect(mocks.probePlatformRouter).not.toHaveBeenCalled();
  });

  it.each([
    ["unconfigured", "unconfigured", null],
    ["failed", "total_timeout", null],
    ["failed", "upstream_http", 503],
  ])("classifies %s/%s as redacted upstream configuration", async (status, outcome, responseStatus) => {
    mocks.probePlatformRouter.mockResolvedValue({
      status,
      outcome,
      phase: outcome === "unconfigured" ? "configuration" : "total",
      model: null,
      responseStatus,
      latencyMs: 100,
      firstByteLatencyMs: null,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "安全状态说明",
    });
    const response = await POST(
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    );

    expect(response.status).toBe(451);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      status,
      outcome,
      code: "upstream_configuration",
      preferredHttpStatus: 451,
    });
    expect(JSON.stringify(body)).not.toContain("response body");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });
});
