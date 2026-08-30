import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configuredFallbackOAuthProviderIds: vi.fn(),
  configuredPrimaryOAuthProviderIds: vi.fn(),
  isPhoneOtpConfigured: vi.fn(),
  isRootEmailAuthConfigured: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  authBaseURL: "https://auth.matchplane.example",
  configuredFallbackOAuthProviderIds:
    mocks.configuredFallbackOAuthProviderIds,
  configuredPrimaryOAuthProviderIds: mocks.configuredPrimaryOAuthProviderIds,
}));
vi.mock("./lib/mail", () => ({
  isRootEmailAuthConfigured: mocks.isRootEmailAuthConfigured,
}));
vi.mock("./lib/sms", () => ({
  isPhoneOtpConfigured: mocks.isPhoneOtpConfigured,
}));

import { GET } from "../app/api/auth/providers/route";

const OAUTH_IDS = [
  "national_identity",
  "wechat",
  "qq",
  "alipay",
  "google",
] as const;
const RESPONSE_FIELDS = [
  "emailOtp",
  "magicLink",
  "oauthCallbacks",
  "passkey",
  "password",
  "phoneOtp",
  "primary",
  "social",
];

beforeEach(() => {
  mocks.configuredFallbackOAuthProviderIds.mockReset().mockReturnValue([]);
  mocks.configuredPrimaryOAuthProviderIds.mockReset().mockReturnValue([]);
  mocks.isPhoneOtpConfigured.mockReset().mockReturnValue(false);
  mocks.isRootEmailAuthConfigured.mockReset().mockResolvedValue(false);
});

describe("GET /api/auth/providers", () => {
  it("reports the effective email, phone, and OAuth capability helpers", async () => {
    mocks.isRootEmailAuthConfigured.mockResolvedValue(true);
    mocks.isPhoneOtpConfigured.mockReturnValue(true);
    mocks.configuredPrimaryOAuthProviderIds.mockReturnValue([
      "national_identity",
    ]);
    mocks.configuredFallbackOAuthProviderIds.mockReturnValue([
      "wechat",
      "google",
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      password: true,
      passkey: true,
      emailOtp: true,
      magicLink: true,
      phoneOtp: true,
      primary: ["national_identity"],
      social: ["wechat", "google"],
    });
    expect(mocks.isRootEmailAuthConfigured).toHaveBeenCalledOnce();
    expect(mocks.isPhoneOtpConfigured).toHaveBeenCalledOnce();
    expect(mocks.configuredPrimaryOAuthProviderIds).toHaveBeenCalledOnce();
    expect(mocks.configuredFallbackOAuthProviderIds).toHaveBeenCalledOnce();
  });

  it("returns all fixed callbacks from the server auth base, ignoring a hostile request Origin", async () => {
    const request = new Request("https://mall.example/api/auth/providers", {
      headers: { origin: "https://evil.example" },
    });
    const response = await (
      GET as unknown as (request: Request) => Promise<Response>
    )(request);
    const body = (await response.json()) as {
      oauthCallbacks: Record<string, string>;
    };

    expect(Object.keys(body.oauthCallbacks)).toEqual(OAUTH_IDS);
    for (const id of OAUTH_IDS) {
      expect(body.oauthCallbacks[id]).toBe(
        `https://auth.matchplane.example/api/auth/callback/${id}`,
      );
    }
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });

  it("keeps the public response bounded to allowlisted capability metadata", async () => {
    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(Object.keys(body).sort()).toEqual(RESPONSE_FIELDS);
    expect(
      Object.keys(body.oauthCallbacks as Record<string, string>),
    ).toEqual(OAUTH_IDS);
    expect(serialized).not.toMatch(
      /client[_-]?secret|credential|authorizationUrl|tokenUrl|userinfoUrl/i,
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
  });
});
