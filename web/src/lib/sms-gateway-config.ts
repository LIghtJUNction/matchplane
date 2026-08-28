import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { isProductionEnvironment } from "./runtime";

const DEFAULT_SECRET_ROOT = "/etc/matchplane/secrets/root-email";
const CONFIG_FILE = "sms-gateway.json";
const TOKEN_FILE = "sms-gateway-token";

interface StoredSmsGatewayConfig {
  enabled: boolean;
  gatewayUrl: string;
}

export interface ManagedSmsGatewayConfig {
  enabled: boolean;
  gatewayUrl: string;
  tokenConfigured: boolean;
}

export interface ActiveSmsGatewayConfig extends StoredSmsGatewayConfig {
  token: string | null;
}

/**
 * The secret root is deployment-owned. Production mounts /etc/matchplane; a development
 * checkout points MATCHPLANE_ROOT_SECRET_DIR at a writable directory so the console panel
 * and the localhost mock gateway work without host provisioning.
 */
function secretRoot(): string {
  return process.env.MATCHPLANE_ROOT_SECRET_DIR?.trim() || DEFAULT_SECRET_ROOT;
}

/** Resolves the operator-managed gateway for the server-side sender. The token never reaches the browser. */
export function readManagedSmsGatewayConfig(): ActiveSmsGatewayConfig | null {
  try {
    const parsed = normalizeStoredConfig(JSON.parse(readFileSync(path.join(secretRoot(), CONFIG_FILE), "utf8")) as Partial<StoredSmsGatewayConfig>);
    return { ...parsed, token: readOptional(path.join(secretRoot(), TOKEN_FILE)) };
  } catch {
    return null;
  }
}

export function getManagedSmsGatewayConfig(): ManagedSmsGatewayConfig | null {
  const config = readManagedSmsGatewayConfig();
  if (!config) return null;
  return { enabled: config.enabled, gatewayUrl: config.gatewayUrl, tokenConfigured: Boolean(config.token) };
}

export function saveManagedSmsGatewayConfig(input: {
  enabled: boolean;
  gatewayUrl: string;
  token?: string;
}): ManagedSmsGatewayConfig {
  const config: StoredSmsGatewayConfig = {
    enabled: input.enabled,
    gatewayUrl: normalizeGatewayUrl(input.gatewayUrl),
  };
  if (input.token !== undefined) writeProtected(path.join(secretRoot(), TOKEN_FILE), input.token, "网关访问令牌");
  writeProtected(path.join(secretRoot(), CONFIG_FILE), JSON.stringify(config), "短信网关配置");
  return { enabled: config.enabled, gatewayUrl: config.gatewayUrl, tokenConfigured: Boolean(readOptional(path.join(secretRoot(), TOKEN_FILE))) };
}

function normalizeStoredConfig(value: Partial<StoredSmsGatewayConfig>): StoredSmsGatewayConfig {
  return { enabled: value.enabled === true, gatewayUrl: normalizeGatewayUrl(value.gatewayUrl ?? "") };
}

/**
 * HTTPS is required in production. Plain HTTP is limited to an exact loopback
 * hostname in non-production profiles so the development mock cannot become a
 * production SSRF escape hatch. Embedded credentials and fragments are rejected.
 */
function normalizeGatewayUrl(value: string): string {
  try {
    const normalized = value.trim();
    if (!normalized || normalized.length > 2_048) throw new Error();
    const url = new URL(normalized);
    if (url.username || url.password || url.hash) throw new Error();
    const loopback =
      !isProductionEnvironment() &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) throw new Error();
    return url.toString();
  } catch {
    throw new Error("短信网关地址必须是 HTTPS 地址（非生产本地演示可用 http://localhost），且不能包含凭据或片段");
  }
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
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o750 });
    const descriptor = openSync(temporary, "wx", 0o640);
    try { writeFileSync(descriptor, `${content}\n`, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, destination);
    chmodSync(destination, 0o640);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error instanceof Error ? new Error(`${label}无法写入受保护存储`, { cause: error }) : new Error(`${label}无法写入受保护存储`);
  }
}
