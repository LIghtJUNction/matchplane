import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateManagedPlatformRouterDraft: vi.fn(),
  appendPlatformRouterAudit: vi.fn(),
  getManagedPlatformRouterDraftConfig: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  getSession: vi.fn(),
  hasTrustedCookieOrigin: vi.fn(),
  stageManagedPlatformRouterConfig: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedCookieOrigin: mocks.hasTrustedCookieOrigin,
}));
vi.mock("./lib/platform-router-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/platform-router-config")>()),
  activateManagedPlatformRouterDraft: mocks.activateManagedPlatformRouterDraft,
  appendPlatformRouterAudit: mocks.appendPlatformRouterAudit,
  getManagedPlatformRouterDraftConfig:
    mocks.getManagedPlatformRouterDraftConfig,
  getManagedPlatformRouterState: mocks.getManagedPlatformRouterState,
  stageManagedPlatformRouterConfig: mocks.stageManagedPlatformRouterConfig,
}));

import { GET, PATCH } from "../app/api/platform/ai/config/route";

const config = {
  endpoint: "https://api.lmm.best/v1",
  model: "gpt-5.6-sol",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  assistantInstructions: "",
  assistantMaxOutputTokens: 320,
  assistantTemperature: 0.2,
  assistantMaxSteps: 3,
  assistantTimeoutMs: 20_000,
  assistantReasoningEffort: "none",
  modelReasoningEfforts: [],
};
const draft = {
  ...config,
  testedReady: false,
  testedAt: null,
  keyChanged: true,
};
const state = {
  config,
  draft,
  effective: {
    ready: true,
    code: "ready" as const,
    preferredHttpStatus: null,
    source: "managed" as const,
    managedOverridesEnvironment: true,
    conflicts: { endpoint: true, model: true, protocol: false },
    endpointOrigin: "https://api.lmm.best",
    model: "gpt-5.6-sol",
    protocol: "openai-compatible" as const,
    enabled: true,
    credentialConfigured: true,
    endpointMatchesRequired: true,
    modelMatchesRequired: true,
    protocolMatchesRequired: true,
    requiredEndpoint: "https://api.lmm.best/v1",
    requiredModel: "gpt-5.6-sol",
    issues: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedCookieOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      role: "rootSuperAdmin",
    },
  });
  mocks.getManagedPlatformRouterState.mockReturnValue(state);
  mocks.getManagedPlatformRouterDraftConfig.mockReturnValue(draft);
  mocks.stageManagedPlatformRouterConfig.mockReturnValue(draft);
  mocks.activateManagedPlatformRouterDraft.mockReturnValue(config);
});

describe("platform AI managed config route", () => {
  it("returns source and conflicts without any credential material", async () => {
    const response = await GET(
      new Request("http://localhost/api/platform/ai/config", {
        headers: { origin: "http://localhost" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('"source":"managed"');
    expect(text).toContain('"managedOverridesEnvironment":true');
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("fingerprint");
  });

  it("stages a write-only key and appends a bounded non-secret audit", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/platform/ai/config", {
        method: "PATCH",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "x-request-id": "request-stage-1",
        },
        body: JSON.stringify({
          ...config,
          action: "stage",
          apiKey: "test-only-secret",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.stageManagedPlatformRouterConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-only-secret" }),
    );
    expect(mocks.appendPlatformRouterAudit).toHaveBeenCalledWith({
      action: "stage",
      actor: "11111111-1111-4111-8111-111111111111",
      requestId: "request-stage-1",
      endpoint: "https://api.lmm.best/v1",
      model: "gpt-5.6-sol",
      enabled: true,
      keyChanged: true,
    });
    const text = await response.text();
    expect(text).not.toContain("test-only-secret");
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("fingerprint");
  });

  it("activates only through the explicit action and audits the actor", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/platform/ai/config", {
        method: "PATCH",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "x-request-id": "request-activate-1",
        },
        body: JSON.stringify({ action: "activate" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.activateManagedPlatformRouterDraft).toHaveBeenCalledTimes(1);
    expect(mocks.appendPlatformRouterAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "activate",
        actor: "11111111-1111-4111-8111-111111111111",
        requestId: "request-activate-1",
      }),
    );
  });

  it("keeps rootAdmin read-only and reserves audited writes for rootSuperAdmin", async () => {
    mocks.getSession.mockResolvedValue({
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        role: "rootAdmin",
      },
    });

    const readResponse = await GET(
      new Request("http://localhost/api/platform/ai/config", {
        headers: { origin: "http://localhost" },
      }),
    );
    const writeResponse = await PATCH(
      new Request("http://localhost/api/platform/ai/config", {
        method: "PATCH",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "activate" }),
      }),
    );

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(403);
    expect(mocks.activateManagedPlatformRouterDraft).not.toHaveBeenCalled();
    expect(mocks.stageManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(mocks.appendPlatformRouterAudit).not.toHaveBeenCalled();
  });

  it("rejects writes from untrusted origins before touching config", async () => {
    mocks.hasTrustedCookieOrigin.mockReturnValue(false);
    const response = await PATCH(
      new Request("http://localhost/api/platform/ai/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "activate" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.activateManagedPlatformRouterDraft).not.toHaveBeenCalled();
  });
});
