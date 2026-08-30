import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSession,
  hasTrustedBrowserOrigin,
  getManagedWeChatOAuthConfig,
  saveManagedWeChatOAuthConfig,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  getManagedWeChatOAuthConfig: vi.fn(),
  saveManagedWeChatOAuthConfig: vi.fn(),
}));

vi.mock("./lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/wechat-oauth-config", () => ({
  getManagedWeChatOAuthConfig,
  saveManagedWeChatOAuthConfig,
}));

import { GET, PATCH } from "../app/api/platform/wechat-oauth/config/route";

const managedConfig = {
  enabled: true,
  appId: "<appid>",
  scopes: ["snsapi_login"],
  authorizationUrl:
    "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect",
  tokenUrl: "https://api.weixin.qq.com/sns/oauth2/access_token",
  userInfoUrl: "https://api.weixin.qq.com/sns/userinfo",
  credentialConfigured: true,
};

function getRequest(): Request {
  return new Request("http://localhost/api/platform/wechat-oauth/config");
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/platform/wechat-oauth/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { role: "rootSuperAdmin" } });
  hasTrustedBrowserOrigin.mockReturnValue(true);
  getManagedWeChatOAuthConfig.mockReturnValue(managedConfig);
  saveManagedWeChatOAuthConfig.mockReturnValue(managedConfig);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("wechat oauth config route", () => {
  it("returns the managed config to mall staff without the AppSecret", async () => {
    getSession.mockResolvedValue({ user: { role: "rootAdmin" } });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ config: managedConfig });
    expect(JSON.stringify(body)).not.toContain("appSecret");
  });

  it("rejects reads from untrusted origins", async () => {
    hasTrustedBrowserOrigin.mockReturnValue(false);
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(getManagedWeChatOAuthConfig).not.toHaveBeenCalled();
  });

  it("rejects reads from ordinary users", async () => {
    getSession.mockResolvedValue({ user: { role: "user" } });
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    expect(getManagedWeChatOAuthConfig).not.toHaveBeenCalled();
  });

  it("persists a normalized payload for the mall owner", async () => {
    const response = await PATCH(
      patchRequest({
        enabled: true,
        appId: "<appid>",
        appSecret: "<appsecret>",
        scopes: ["snsapi_login", 42],
        authorizationUrl:
          "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect",
      }),
    );
    expect(response.status).toBe(200);
    expect(saveManagedWeChatOAuthConfig).toHaveBeenCalledWith({
      enabled: true,
      appId: "<appid>",
      appSecret: "<appsecret>",
      authorizationUrl:
        "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect",
      tokenUrl: undefined,
      userInfoUrl: undefined,
      scopes: ["snsapi_login"],
    });
    await expect(response.json()).resolves.toEqual({
      config: managedConfig,
      restartRequired: true,
    });
  });

  it("rejects writes from mall staff who are not the owner", async () => {
    getSession.mockResolvedValue({ user: { role: "rootAdmin" } });
    const response = await PATCH(
      patchRequest({ enabled: false, appId: "<appid>" }),
    );
    expect(response.status).toBe(403);
    expect(saveManagedWeChatOAuthConfig).not.toHaveBeenCalled();
  });

  it("rejects a non-object body", async () => {
    const response = await PATCH(patchRequest(["not", "an", "object"]));
    expect(response.status).toBe(400);
    expect(saveManagedWeChatOAuthConfig).not.toHaveBeenCalled();
  });

  it("surfaces validation errors from the config store", async () => {
    saveManagedWeChatOAuthConfig.mockImplementation(() => {
      throw new Error("启用前请填写 AppSecret");
    });
    const response = await PATCH(
      patchRequest({ enabled: true, appId: "<appid>" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "启用前请填写 AppSecret",
    });
  });
});
