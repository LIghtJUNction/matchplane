import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configuredFallbackOAuthProviderIds: vi.fn(),
  configuredPrimaryOAuthProviderIds: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  isPhoneOtpConfigured: vi.fn(),
  isPlatformRouterConfigured: vi.fn(),
  isRootEmailAuthConfigured: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  configuredFallbackOAuthProviderIds: mocks.configuredFallbackOAuthProviderIds,
  configuredPrimaryOAuthProviderIds: mocks.configuredPrimaryOAuthProviderIds,
}));
vi.mock("./lib/mail", () => ({
  isRootEmailAuthConfigured: mocks.isRootEmailAuthConfigured,
}));
vi.mock("./lib/sms", () => ({
  isPhoneOtpConfigured: mocks.isPhoneOtpConfigured,
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./platform-router", () => ({
  isPlatformRouterConfigured: mocks.isPlatformRouterConfigured,
}));
vi.mock("./lib/platform-router-config", () => ({
  getManagedPlatformRouterState: mocks.getManagedPlatformRouterState,
}));

import { GET } from "../app/api/platform/ai/status/route";

const request = () =>
  new Request("http://localhost/api/platform/ai/status", {
    headers: { origin: "http://localhost" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: { role: "rootAdmin" } });
  mocks.isRootEmailAuthConfigured.mockResolvedValue(true);
  mocks.isPhoneOtpConfigured.mockReturnValue(false);
  mocks.isPlatformRouterConfigured.mockReturnValue(true);
  mocks.configuredPrimaryOAuthProviderIds.mockReturnValue([]);
  mocks.configuredFallbackOAuthProviderIds.mockReturnValue([]);
  mocks.getManagedPlatformRouterState.mockReturnValue({
    effective: {
      ready: true,
      code: "ready",
      source: "managed",
      managedOverridesEnvironment: true,
      conflicts: { endpoint: true, model: false, protocol: false },
      endpointOrigin: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      protocol: "anthropic-messages",
      enabled: true,
      credentialConfigured: true,
      originAllowlistApplied: true,
      issues: [],
    },
  });
});

describe("platform AI status route", () => {
  it("reports provider-neutral effective state without a fabricated required tuple", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.router).toMatchObject({
      aiReady: true,
      protocol: "anthropic-messages",
      model: "claude-sonnet-4-6",
      endpointOrigin: "https://api.anthropic.com",
      originAllowlistApplied: true,
    });
    expect(body.router).not.toHaveProperty("requiredEndpoint");
    expect(body.router).not.toHaveProperty("requiredModel");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });

  it("preserves trusted-origin, session, and root-admin guards", async () => {
    mocks.hasTrustedBrowserOrigin.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();

    mocks.getSession.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mocks.getSession.mockResolvedValueOnce({ user: { role: "user" } });
    expect((await GET(request())).status).toBe(403);
  });
});
