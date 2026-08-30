import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ResponseBodyTooLargeError } from "./body-limit";
import {
  fetchPinnedPublicText,
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
} from "./pinned-public-endpoint";
import { isProductionEnvironment } from "./runtime";

const SECRET_ROOT = "/etc/matchplane/secrets/root-email";
const CONFIG_PATH = path.join(SECRET_ROOT, "wechat-oauth.json");
const SECRET_PATH = path.join(SECRET_ROOT, "wechat-oauth-app-secret");

// Official WeChat Open Platform "website application" QR-code login contract.
// The #wechat_redirect fragment is part of the documented authorize URL format.
export const WECHAT_QR_AUTHORIZATION_URL = "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect";
export const WECHAT_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
export const WECHAT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
const WECHAT_DEFAULT_SCOPES = ["snsapi_login"] as const;
const WECHAT_REQUEST_TIMEOUT_MS = 5_000;
const WECHAT_RESPONSE_BODY_TIMEOUT_MS = 5_000;
const WECHAT_RESPONSE_LIMIT_BYTES = 64 * 1024;

interface StoredWeChatOAuthConfig {
  enabled: boolean;
  appId: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export interface ManagedWeChatOAuthConfig extends StoredWeChatOAuthConfig {
  credentialConfigured: boolean;
}

export interface ActiveWeChatOAuthConfig extends StoredWeChatOAuthConfig {
  appSecret: string;
}

/** Reads the administrator-managed WeChat provider without ever returning its AppSecret to the browser. */
export function readManagedWeChatOAuthConfig(): ActiveWeChatOAuthConfig | null {
  try {
    const parsed = normalizeStoredConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<StoredWeChatOAuthConfig>);
    const appSecret = readOptional(SECRET_PATH);
    return appSecret ? { ...parsed, appSecret } : null;
  } catch {
    return null;
  }
}

export function getManagedWeChatOAuthConfig(): ManagedWeChatOAuthConfig | null {
  try {
    const config = normalizeStoredConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<StoredWeChatOAuthConfig>);
    return { ...config, credentialConfigured: Boolean(readOptional(SECRET_PATH)) };
  } catch {
    return null;
  }
}

export function saveManagedWeChatOAuthConfig(input: {
  enabled: boolean;
  appId: string;
  appSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
}): ManagedWeChatOAuthConfig {
  const config: StoredWeChatOAuthConfig = {
    enabled: input.enabled,
    appId: boundedText(input.appId, "AppID", 512),
    scopes: normalizeScopes(input.scopes),
    authorizationUrl: normalizeWeChatUrl(input.authorizationUrl?.trim() || WECHAT_QR_AUTHORIZATION_URL, "授权地址", true),
    tokenUrl: normalizeWeChatUrl(input.tokenUrl?.trim() || WECHAT_TOKEN_URL, "令牌地址", false),
    userInfoUrl: normalizeWeChatUrl(input.userInfoUrl?.trim() || WECHAT_USERINFO_URL, "用户信息地址", false),
  };
  assertManagedWeChatEgressPolicy(config);
  if (input.appSecret !== undefined) writeProtected(SECRET_PATH, input.appSecret, "AppSecret");
  const configured = Boolean(readOptional(SECRET_PATH));
  if (config.enabled && !configured) throw new Error("启用前请填写 AppSecret");
  writeProtected(CONFIG_PATH, JSON.stringify(config), "微信扫码登录配置");
  return { ...config, credentialConfigured: configured };
}

/**
 * WeChat's sns endpoints predate standard OAuth2: they only speak WeChat's own
 * protocol. The adapters below are applied when the configured endpoints are
 * WeChat-hosted. A standards-compliant proxy or mock gateway remains available
 * outside production; production managed configuration fails closed because
 * Better Auth's generic transport cannot enforce this module's DNS pinning.
 */
export function isWeChatNativeEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return isAllowedWeChatRequestDestination(new URL(value));
  } catch {
    return false;
  }
}

export interface WeChatOAuthTokens {
  tokenType?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  scopes?: string[];
  raw?: Record<string, unknown>;
}

/**
 * WeChat exchanges the authorization code through a GET request with
 * appid/secret query parameters instead of a POSTed client_id/client_secret
 * form, and reports failures as HTTP 200 bodies carrying errcode/errmsg.
 */
export function createWeChatTokenExchange(options: { tokenUrl: string; appId: string; appSecret: string }) {
  return async (data: { code: string }): Promise<WeChatOAuthTokens> => {
    const url = parseWeChatRequestUrl(options.tokenUrl, "微信令牌");
    url.searchParams.set("appid", options.appId);
    url.searchParams.set("secret", options.appSecret);
    url.searchParams.set("code", data.code);
    url.searchParams.set("grant_type", "authorization_code");
    const body = await fetchWeChatJson(url, "微信令牌");
    const accessToken = readString(body, "access_token");
    if (!accessToken || !readString(body, "openid")) throw new Error("微信令牌响应缺少 access_token 或 openid");
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : undefined;
    return {
      tokenType: "bearer",
      accessToken,
      refreshToken: readString(body, "refresh_token"),
      accessTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : undefined,
      scopes: readString(body, "scope")?.split(",").filter(Boolean),
      // Keeps openid/unionid available to the userinfo call below.
      raw: body,
    };
  };
}

export interface WeChatUserProfile {
  emailVerified: boolean;
  name?: string;
  email?: string;
  image?: string;
  [key: string]: unknown;
}

/**
 * WeChat's userinfo endpoint requires the token response's openid as a query
 * parameter next to the access token. When the granted scope cannot read the
 * profile, login still proceeds on the stable openid/unionid identity.
 */
export function createWeChatUserInfoLoader(options: { userInfoUrl: string }) {
  return async (tokens: WeChatOAuthTokens): Promise<WeChatUserProfile> => {
    const accessToken = tokens.accessToken;
    const openid = typeof tokens.raw?.openid === "string" ? tokens.raw.openid : undefined;
    if (!accessToken || !openid) throw new Error("微信登录缺少 access_token 或 openid");
    // WeChat never returns an email; the synthetic Better Auth address must stay unverified.
    const identity: WeChatUserProfile = { openid, emailVerified: false };
    if (typeof tokens.raw?.unionid === "string") identity.unionid = tokens.raw.unionid;
    const url = parseWeChatRequestUrl(options.userInfoUrl, "微信用户信息");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("openid", openid);
    url.searchParams.set("lang", "zh_CN");
    try {
      const body = await fetchWeChatJson(url, "微信用户信息");
      return { ...body, ...identity, openid: readString(body, "openid") ?? openid } as WeChatUserProfile;
    } catch {
      return identity;
    }
  };
}

async function fetchWeChatJson(url: URL, label: string): Promise<Record<string, unknown>> {
  if (!isAllowedWeChatRequestDestination(url)) throw new Error(`${label}请求地址不在微信官方域名 allowlist 内`);

  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchPinnedPublicText(url, {
      requestTimeoutMs: WECHAT_REQUEST_TIMEOUT_MS,
      responseBodyTimeoutMs: WECHAT_RESPONSE_BODY_TIMEOUT_MS,
      responseLimitBytes: WECHAT_RESPONSE_LIMIT_BYTES,
    }));
  } catch (error) {
    if (error instanceof PinnedPublicEndpointError) {
      throw new Error(`${label}请求地址未通过公共网络边界检查`);
    }
    if (error instanceof PinnedPublicRedirectError) {
      throw new Error(`${label}请求不允许重定向`);
    }
    if (error instanceof ResponseBodyTooLargeError) {
      throw new Error(`${label}响应体超过大小限制`);
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${label}请求超时`);
    }
    // Do not propagate Undici errors containing the credential-bearing query URL.
    throw new Error(`${label}请求失败`);
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error(`${label}请求不允许重定向`);
  }
  // WeChat serves JSON bodies with a text/plain content type; parse the bounded raw text.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}响应不是有效 JSON`);
  }
  const errcode = body.errcode;
  if (!response.ok || (typeof errcode === "number" && errcode !== 0)) {
    throw new Error(`${label}请求失败（errcode ${String(errcode ?? response.status)}）`);
  }
  return body;
}

function parseWeChatRequestUrl(value: string, label: string): URL {
  try {
    const url = new URL(value);
    if (!isAllowedWeChatRequestDestination(url) || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new Error(`${label}地址必须是无凭据、无查询参数或片段的微信官方 HTTPS 地址`);
  }
}

function isAllowedWeChatRequestDestination(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const officialHostname = hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com");
  return url.protocol === "https:" && !url.username && !url.password && !url.port && officialHostname;
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStoredConfig(value: Partial<StoredWeChatOAuthConfig>): StoredWeChatOAuthConfig {
  const config = {
    enabled: value.enabled === true,
    appId: boundedText(value.appId ?? "", "AppID", 512),
    scopes: normalizeScopes(value.scopes),
    authorizationUrl: normalizeWeChatUrl(value.authorizationUrl, "授权地址", true),
    tokenUrl: normalizeWeChatUrl(value.tokenUrl, "令牌地址", false),
    userInfoUrl: normalizeWeChatUrl(value.userInfoUrl, "用户信息地址", false),
  };
  assertManagedWeChatEgressPolicy(config);
  return config;
}

function assertManagedWeChatEgressPolicy(config: StoredWeChatOAuthConfig): void {
  if (!config.enabled || !isProductionEnvironment()) return;
  if (
    isWeChatNativeEndpoint(config.authorizationUrl) &&
    isWeChatNativeEndpoint(config.tokenUrl) &&
    isWeChatNativeEndpoint(config.userInfoUrl)
  ) {
    return;
  }
  throw new Error("生产环境仅允许微信官方 OAuth 地址");
}

function normalizeWeChatUrl(value: string | undefined, label: string, allowWeChatRedirectFragment: boolean): string {
  try {
    const url = new URL(value?.trim() ?? "");
    const allowedHash = allowWeChatRedirectFragment && url.hash === "#wechat_redirect";
    if (url.protocol !== "https:" || url.username || url.password || url.search || (url.hash && !allowedHash)) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label}必须是 HTTPS 地址，且不能包含凭据、查询参数或片段`);
  }
}

function normalizeScopes(value: string[] | undefined): string[] {
  const scopes = (value?.length ? value : [...WECHAT_DEFAULT_SCOPES])
    .map((scope) => scope.trim())
    .filter((scope) => /^[A-Za-z0-9._:-]{1,64}$/.test(scope));
  if (!scopes.length) throw new Error("至少需要一个合法 scope");
  return [...new Set(scopes)].slice(0, 16);
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}必须为 1..=${maximum} 个字符`);
  return normalized;
}

function readOptional(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeProtected(destination: string, value: string, label: string): void {
  const content = value.trim();
  if (!content || content.length > 16_384) throw new Error(`${label}必须为 1..=16384 个字符`);
  const temporary = path.join(SECRET_ROOT, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o640);
    try { writeFileSync(descriptor, `${content}\n`, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, destination);
    chmodSync(destination, 0o640);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error instanceof Error ? new Error(`${label}无法写入受保护存储`, { cause: error }) : new Error(`${label}无法写入受保护存储`);
  }
}
