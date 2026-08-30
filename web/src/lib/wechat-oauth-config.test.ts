import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => {
  const files = new Map<string, string>();
  const descriptors = new Map<number, string>();
  let nextDescriptor = 3;
  return { files, descriptors, allocate: () => nextDescriptor++ };
});

const endpointState = vi.hoisted(() => ({
  fetchPinnedPublicText: vi.fn(),
}));

vi.mock("./pinned-public-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pinned-public-endpoint")>()),
  fetchPinnedPublicText: endpointState.fetchPinnedPublicText,
}));

vi.mock("node:fs", () => {
  const mocked = {
    readFileSync: vi.fn((file: string) => {
      const content = fsState.files.get(file);
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return content;
    }),
    openSync: vi.fn((file: string) => {
      const descriptor = fsState.allocate();
      fsState.descriptors.set(descriptor, file);
      return descriptor;
    }),
    writeFileSync: vi.fn((descriptor: number, content: string) => {
      const file = fsState.descriptors.get(descriptor);
      if (!file) throw new Error("unknown file descriptor");
      fsState.files.set(file, content);
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn((from: string, to: string) => {
      const content = fsState.files.get(from);
      if (content === undefined)
        throw new Error(`missing temporary file ${from}`);
      fsState.files.delete(from);
      fsState.files.set(to, content);
    }),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn((file: string) => {
      fsState.files.delete(file);
    }),
  };
  return { ...mocked, default: mocked };
});

import {
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
} from "./pinned-public-endpoint";
import {
  createWeChatTokenExchange,
  createWeChatUserInfoLoader,
  getManagedWeChatOAuthConfig,
  isWeChatNativeEndpoint,
  readManagedWeChatOAuthConfig,
  saveManagedWeChatOAuthConfig,
  WECHAT_QR_AUTHORIZATION_URL,
  WECHAT_TOKEN_URL,
  WECHAT_USERINFO_URL,
} from "./wechat-oauth-config";

beforeEach(() => {
  fsState.files.clear();
  fsState.descriptors.clear();
  endpointState.fetchPinnedPublicText.mockImplementation(async (url: URL) => {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new PinnedPublicRedirectError(response.status);
    }
    return { response, text: await response.text() };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed wechat oauth config storage", () => {
  it("returns null while nothing is configured", () => {
    expect(getManagedWeChatOAuthConfig()).toBeNull();
    expect(readManagedWeChatOAuthConfig()).toBeNull();
  });

  it("saves official QR connect endpoints by default", () => {
    const config = saveManagedWeChatOAuthConfig({
      enabled: true,
      appId: " <appid> ",
      appSecret: "<appsecret>",
    });
    expect(config).toEqual({
      enabled: true,
      appId: "<appid>",
      scopes: ["snsapi_login"],
      authorizationUrl: WECHAT_QR_AUTHORIZATION_URL,
      tokenUrl: WECHAT_TOKEN_URL,
      userInfoUrl: WECHAT_USERINFO_URL,
      credentialConfigured: true,
    });
    expect(getManagedWeChatOAuthConfig()).toEqual(config);
    expect(readManagedWeChatOAuthConfig()).toEqual({
      enabled: true,
      appId: "<appid>",
      scopes: ["snsapi_login"],
      authorizationUrl: WECHAT_QR_AUTHORIZATION_URL,
      tokenUrl: WECHAT_TOKEN_URL,
      userInfoUrl: WECHAT_USERINFO_URL,
      appSecret: "<appsecret>",
    });
  });

  it("rejects non-WeChat managed endpoints in production before storing the secret", () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    expect(() =>
      saveManagedWeChatOAuthConfig({
        enabled: true,
        appId: "appid",
        appSecret: "must-not-be-written",
        authorizationUrl: "https://oauth.example.test/authorize",
        tokenUrl: "https://oauth.example.test/token",
        userInfoUrl: "https://oauth.example.test/userinfo",
      }),
    ).toThrow("生产环境仅允许微信官方 OAuth 地址");
    expect([...fsState.files.values()]).not.toContain("must-not-be-written");
  });

  it("keeps custom OAuth-compatible mock endpoints available outside production", () => {
    const config = saveManagedWeChatOAuthConfig({
      enabled: true,
      appId: "appid",
      appSecret: "secret",
      authorizationUrl: "https://oauth.example.test/authorize",
      tokenUrl: "https://oauth.example.test/token",
      userInfoUrl: "https://oauth.example.test/userinfo",
    });
    expect(config.tokenUrl).toBe("https://oauth.example.test/token");
  });

  it("keeps the stored AppSecret when the update omits it", () => {
    saveManagedWeChatOAuthConfig({
      enabled: true,
      appId: "<appid>",
      appSecret: "<appsecret>",
    });
    const updated = saveManagedWeChatOAuthConfig({
      enabled: false,
      appId: "<appid>",
    });
    expect(updated.credentialConfigured).toBe(true);
    expect(readManagedWeChatOAuthConfig()?.appSecret).toBe("<appsecret>");
  });

  it("refuses to enable the login without an AppSecret", () => {
    expect(() =>
      saveManagedWeChatOAuthConfig({ enabled: true, appId: "<appid>" }),
    ).toThrow(/AppSecret/);
    expect(getManagedWeChatOAuthConfig()).toBeNull();
  });

  it("rejects a non-HTTPS token endpoint", () => {
    expect(() =>
      saveManagedWeChatOAuthConfig({
        enabled: false,
        appId: "<appid>",
        tokenUrl: "http://insecure.example/token",
      }),
    ).toThrow(/令牌地址/);
  });

  it("only allows the documented #wechat_redirect fragment", () => {
    expect(() =>
      saveManagedWeChatOAuthConfig({
        enabled: false,
        appId: "<appid>",
        authorizationUrl: "https://open.weixin.qq.com/connect/qrconnect#other",
      }),
    ).toThrow(/授权地址/);
    const config = saveManagedWeChatOAuthConfig({
      enabled: false,
      appId: "<appid>",
      authorizationUrl:
        "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect",
    });
    expect(config.authorizationUrl).toBe(
      "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect",
    );
  });
});

describe("wechat native protocol adapter", () => {
  it("only treats weixin.qq.com hosts as native endpoints", () => {
    expect(isWeChatNativeEndpoint(WECHAT_TOKEN_URL)).toBe(true);
    expect(
      isWeChatNativeEndpoint("https://open.weixin.qq.com/connect/qrconnect"),
    ).toBe(true);
    expect(isWeChatNativeEndpoint("https://mock-gateway.example/token")).toBe(
      false,
    );
    expect(isWeChatNativeEndpoint("https://api.weixin.qq.com.evil.example/token")).toBe(false);
    expect(isWeChatNativeEndpoint("http://api.weixin.qq.com/token")).toBe(false);
    expect(isWeChatNativeEndpoint("https://user:pass@api.weixin.qq.com/token")).toBe(false);
    expect(isWeChatNativeEndpoint("not a url")).toBe(false);
    expect(isWeChatNativeEndpoint(undefined)).toBe(false);
  });

  it("exchanges the code with appid/secret query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "ACCESS",
          expires_in: 7200,
          refresh_token: "REFRESH",
          openid: "OPENID",
          scope: "snsapi_login",
          unionid: "UNIONID",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const exchange = createWeChatTokenExchange({
      tokenUrl: WECHAT_TOKEN_URL,
      appId: "<appid>",
      appSecret: "<appsecret>",
    });
    const tokens = await exchange({ code: "AUTH_CODE" });
    const requested = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requested.origin + requested.pathname).toBe(WECHAT_TOKEN_URL);
    expect(requested.searchParams.get("appid")).toBe("<appid>");
    expect(requested.searchParams.get("secret")).toBe("<appsecret>");
    expect(requested.searchParams.get("code")).toBe("AUTH_CODE");
    expect(requested.searchParams.get("grant_type")).toBe("authorization_code");
    expect(endpointState.fetchPinnedPublicText).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        requestTimeoutMs: expect.any(Number),
        responseBodyTimeoutMs: expect.any(Number),
        responseLimitBytes: expect.any(Number),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ credentials: "omit", redirect: "manual" }),
    );
    expect(tokens.accessToken).toBe("ACCESS");
    expect(tokens.refreshToken).toBe("REFRESH");
    expect(tokens.scopes).toEqual(["snsapi_login"]);
    expect(tokens.raw?.openid).toBe("OPENID");
    expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
  });

  it("rejects malformed or non-official token destinations before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const tokenUrl of [
      "not a url",
      "http://api.weixin.qq.com/sns/oauth2/access_token",
      "https://user:pass@api.weixin.qq.com/sns/oauth2/access_token",
      "https://api.weixin.qq.com.evil.example/sns/oauth2/access_token",
      "https://api.weixin.qq.com/sns/oauth2/access_token?redirect=https://example.com",
    ]) {
      const exchange = createWeChatTokenExchange({
        tokenUrl,
        appId: "<appid>",
        appSecret: "<appsecret>",
      });
      await expect(exchange({ code: "AUTH_CODE" }), tokenUrl).rejects.toThrow(
        /微信官方 HTTPS 地址/,
      );
    }
    const loadUserInfo = createWeChatUserInfoLoader({
      userInfoUrl: "https://api.weixin.qq.com.evil.example/sns/userinfo",
    });
    await expect(
      loadUserInfo({ accessToken: "ACCESS", raw: { openid: "OPENID" } }),
    ).rejects.toThrow(/微信官方 HTTPS 地址/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned connector rejects the resolved addresses", async () => {
    endpointState.fetchPinnedPublicText.mockRejectedValueOnce(
      new PinnedPublicEndpointError(),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exchange = createWeChatTokenExchange({
      tokenUrl: WECHAT_TOKEN_URL,
      appId: "<appid>",
      appSecret: "<appsecret>",
    });

    await expect(exchange({ code: "AUTH_CODE" })).rejects.toThrow(
      /公共网络边界/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects redirects even when the fetch implementation returns them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        redirected: false,
        status: 302,
      }),
    );
    const exchange = createWeChatTokenExchange({
      tokenUrl: WECHAT_TOKEN_URL,
      appId: "<appid>",
      appSecret: "<appsecret>",
    });

    await expect(exchange({ code: "AUTH_CODE" })).rejects.toThrow(/重定向/);
  });

  it("rejects WeChat errcode bodies even on HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ errcode: 40029, errmsg: "invalid code" }),
      }),
    );
    const exchange = createWeChatTokenExchange({
      tokenUrl: WECHAT_TOKEN_URL,
      appId: "<appid>",
      appSecret: "<appsecret>",
    });
    await expect(exchange({ code: "BAD" })).rejects.toThrow(/40029/);
  });

  it("loads the profile with the token response's openid", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          openid: "OPENID",
          nickname: "微信用户",
          headimgurl: "https://cdn.example/avatar",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const loadUserInfo = createWeChatUserInfoLoader({
      userInfoUrl: WECHAT_USERINFO_URL,
    });
    const profile = await loadUserInfo({
      accessToken: "ACCESS",
      raw: { openid: "OPENID", unionid: "UNIONID" },
    });
    const requested = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requested.searchParams.get("access_token")).toBe("ACCESS");
    expect(requested.searchParams.get("openid")).toBe("OPENID");
    expect(profile.openid).toBe("OPENID");
    expect(profile.unionid).toBe("UNIONID");
    expect(profile.nickname).toBe("微信用户");
    expect(profile.emailVerified).toBe(false);
  });

  it("falls back to the token identity when the profile scope is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ errcode: 48001, errmsg: "api unauthorized" }),
      }),
    );
    const loadUserInfo = createWeChatUserInfoLoader({
      userInfoUrl: WECHAT_USERINFO_URL,
    });
    const profile = await loadUserInfo({
      accessToken: "ACCESS",
      raw: { openid: "OPENID", unionid: "UNIONID" },
    });
    expect(profile).toEqual({
      openid: "OPENID",
      unionid: "UNIONID",
      emailVerified: false,
    });
  });

  it("requires the access token and openid before calling userinfo", async () => {
    const loadUserInfo = createWeChatUserInfoLoader({
      userInfoUrl: WECHAT_USERINFO_URL,
    });
    await expect(loadUserInfo({ raw: {} })).rejects.toThrow(/openid/);
  });
});
