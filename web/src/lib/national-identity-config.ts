import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const SECRET_ROOT = "/etc/matchplane/secrets/root-email";
const CONFIG_PATH = path.join(SECRET_ROOT, "national-identity.json");
const SECRET_PATH = path.join(SECRET_ROOT, "national-identity-client-secret");

export type NationalIdentityEndpointMode = "discovery" | "endpoints";

interface StoredNationalIdentityConfig {
  enabled: boolean;
  clientId: string;
  scopes: string[];
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
}

export interface ManagedNationalIdentityConfig {
  enabled: boolean;
  clientId: string;
  scopes: string[];
  endpointMode: NationalIdentityEndpointMode;
  discoveryUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  credentialConfigured: boolean;
}

export interface ActiveNationalIdentityConfig extends StoredNationalIdentityConfig {
  clientSecret: string;
}

/** Reads an administrator-managed provider without ever returning its client secret to the browser. */
export function readManagedNationalIdentityConfig(): ActiveNationalIdentityConfig | null {
  try {
    const parsed = normalizeStoredConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<StoredNationalIdentityConfig>);
    const clientSecret = readOptional(SECRET_PATH);
    return clientSecret ? { ...parsed, clientSecret } : null;
  } catch {
    return null;
  }
}

export function getManagedNationalIdentityConfig(): ManagedNationalIdentityConfig | null {
  try {
    const config = normalizeStoredConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<StoredNationalIdentityConfig>);
    return toPublicConfig(config, Boolean(readOptional(SECRET_PATH)));
  } catch {
    return null;
  }
}

export function saveManagedNationalIdentityConfig(input: {
  enabled: boolean;
  clientId: string;
  clientSecret?: string;
  endpointMode: NationalIdentityEndpointMode;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
}): ManagedNationalIdentityConfig {
  const endpointMode = input.endpointMode === "endpoints" ? "endpoints" : "discovery";
  const config: StoredNationalIdentityConfig = endpointMode === "discovery"
    ? {
        enabled: input.enabled,
        clientId: boundedText(input.clientId, "Client ID", 512),
        scopes: normalizeScopes(input.scopes),
        discoveryUrl: normalizeHttpsUrl(input.discoveryUrl, "OIDC discovery 地址"),
      }
    : {
        enabled: input.enabled,
        clientId: boundedText(input.clientId, "Client ID", 512),
        scopes: normalizeScopes(input.scopes),
        authorizationUrl: normalizeHttpsUrl(input.authorizationUrl, "授权地址"),
        tokenUrl: normalizeHttpsUrl(input.tokenUrl, "令牌地址"),
        userInfoUrl: normalizeHttpsUrl(input.userInfoUrl, "用户信息地址"),
      };
  if (input.clientSecret !== undefined) writeProtected(SECRET_PATH, input.clientSecret, "Client Secret");
  const configured = Boolean(readOptional(SECRET_PATH));
  if (config.enabled && !configured) throw new Error("启用前请填写 Client Secret");
  writeProtected(CONFIG_PATH, JSON.stringify(config), "国家网络身份认证配置");
  return toPublicConfig(config, configured);
}

function toPublicConfig(config: StoredNationalIdentityConfig, credentialConfigured: boolean): ManagedNationalIdentityConfig {
  const endpointMode: NationalIdentityEndpointMode = config.discoveryUrl ? "discovery" : "endpoints";
  return {
    enabled: config.enabled,
    clientId: config.clientId,
    scopes: config.scopes,
    endpointMode,
    discoveryUrl: config.discoveryUrl ?? "",
    authorizationUrl: config.authorizationUrl ?? "",
    tokenUrl: config.tokenUrl ?? "",
    userInfoUrl: config.userInfoUrl ?? "",
    credentialConfigured,
  };
}

function normalizeStoredConfig(value: Partial<StoredNationalIdentityConfig>): StoredNationalIdentityConfig {
  const enabled = value.enabled === true;
  const clientId = boundedText(value.clientId ?? "", "Client ID", 512);
  const scopes = normalizeScopes(value.scopes);
  if (value.discoveryUrl) {
    return { enabled, clientId, scopes, discoveryUrl: normalizeHttpsUrl(value.discoveryUrl, "OIDC discovery 地址") };
  }
  return {
    enabled,
    clientId,
    scopes,
    authorizationUrl: normalizeHttpsUrl(value.authorizationUrl, "授权地址"),
    tokenUrl: normalizeHttpsUrl(value.tokenUrl, "令牌地址"),
    userInfoUrl: normalizeHttpsUrl(value.userInfoUrl, "用户信息地址"),
  };
}

function normalizeHttpsUrl(value: string | undefined, label: string): string {
  try {
    const url = new URL(value?.trim() ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label}必须是 HTTPS 地址，且不能包含凭据、查询参数或片段`);
  }
}

function normalizeScopes(value: string[] | undefined): string[] {
  const scopes = (value?.length ? value : ["openid"])
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
