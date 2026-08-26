import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, configuredOAuthProviderIds, isPhoneOtpConfigured } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    configuredOAuthProviderIds: vi.fn(),
    isPhoneOtpConfigured: vi.fn(),
  }));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authBaseURL: "https://auth.matchplane.example",
  configuredOAuthProviderIds,
}));

vi.mock("./lib/sms", () => ({
  isPhoneOtpConfigured,
}));

import { GET } from "../app/api/admin/auth-providers/route";

function panelRequest(origin?: string): Request {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  return new Request("http://localhost:4173/api/admin/auth-providers", {
    headers,
  });
}

type PanelProvider = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  envKeys?: string[];
  callbackUrl?: string;
  hint?: string;
};

const ALLOWED_PROVIDER_FIELDS = new Set([
  "id",
  "label",
  "configured",
  "enabled",
  "envKeys",
  "callbackUrl",
  "hint",
]);

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(configuredOAuthProviderIds).mockReset();
  vi.mocked(isPhoneOtpConfigured).mockReset().mockReturnValue(false);
});

describe("GET /api/admin/auth-providers", () => {
  it("returns 401 when the caller has no session", async () => {
    getSession.mockResolvedValue(null);

    const response = await GET(panelRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "未登录" });
    expect(configuredOAuthProviderIds).not.toHaveBeenCalled();
    expect(isPhoneOtpConfigured).not.toHaveBeenCalled();
  });

  it("returns 403 for a signed-in non-root administrator", async () => {
    getSession.mockResolvedValue({ user: { id: "u-admin", role: "admin" } });

    const response = await GET(panelRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "无权访问" });
    expect(configuredOAuthProviderIds).not.toHaveBeenCalled();
  });

  it.each(["rootAdmin", "rootSuperAdmin"])(
    "serves the status board to %s",
    async (role) => {
      getSession.mockResolvedValue({ user: { id: "u-root", role } });
      configuredOAuthProviderIds.mockReturnValue(["wechat"]);
      isPhoneOtpConfigured.mockReturnValue(true);

      const response = await GET(panelRequest());

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        providers: PanelProvider[];
      };
      const wechat = body.providers.find((item) => item.id === "wechat");
      const phone = body.providers.find((item) => item.id === "phone");
      expect(wechat?.configured).toBe(true);
      expect(wechat?.enabled).toBe(true);
      expect(phone?.configured).toBe(true);
      expect(phone?.enabled).toBe(true);
    },
  );

  it("marks OAuth providers disabled when the capability source excludes them (incomplete credentials or a managed disable record)", async () => {
    getSession.mockResolvedValue({
      user: { id: "u-root", role: "rootAdmin" },
    });
    configuredOAuthProviderIds.mockReturnValue([]);

    const response = await GET(panelRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: PanelProvider[] };
    for (const provider of body.providers) {
      if (provider.id === "email") {
        // Built-in email auth is always available.
        expect(provider.enabled).toBe(true);
        continue;
      }
      expect(provider.configured).toBe(false);
      expect(provider.enabled).toBe(false);
    }
  });

  it("derives callback URLs from the server-configured auth base URL, not from the request Origin", async () => {
    getSession.mockResolvedValue({
      user: { id: "u-root", role: "rootSuperAdmin" },
    });
    configuredOAuthProviderIds.mockReturnValue(["wechat"]);

    const response = await GET(panelRequest("https://evil.example"));

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain(
      "https://auth.matchplane.example/api/auth/callback/wechat",
    );
    expect(serialized).not.toContain("evil.example");
  });

  it("exposes only status fields — no credential material in the payload", async () => {
    getSession.mockResolvedValue({
      user: { id: "u-root", role: "rootAdmin" },
    });
    configuredOAuthProviderIds.mockReturnValue(["wechat"]);
    isPhoneOtpConfigured.mockReturnValue(true);

    const response = await GET(panelRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: PanelProvider[] };
    for (const provider of body.providers) {
      for (const field of Object.keys(provider)) {
        expect(ALLOWED_PROVIDER_FIELDS.has(field)).toBe(true);
      }
    }
  });
});
