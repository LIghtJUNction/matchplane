import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  hasOnlyPublicAddresses,
  isPrivateOrReservedIpLiteral,
  type ResolveAddresses,
} from "./public-endpoint";

const SECRET_ROOT = "/etc/matchplane/secrets/root-email";
const CONFIG_PATH = path.join(SECRET_ROOT, "platform-router.json");
const KEY_PATH = path.join(SECRET_ROOT, "platform-router.key");

export type ManagedRouterProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generate-content";
export type ManagedReasoningEffort = string;

export interface ManagedRouterModel {
  id: string;
  reasoningEfforts: string[];
}

export interface ManagedPlatformRouterConfig {
  endpoint: string;
  model: string;
  protocol: ManagedRouterProtocol;
  enabled: boolean;
  credentialConfigured: boolean;
  assistantInstructions: string;
  assistantMaxOutputTokens: number;
  assistantTemperature: number;
  assistantMaxSteps: number;
  assistantTimeoutMs: number;
  assistantReasoningEffort: ManagedReasoningEffort;
  modelReasoningEfforts: string[];
}

interface StoredRouterConfig {
  endpoint: string;
  model: string;
  protocol: ManagedRouterProtocol;
  enabled: boolean;
  assistantInstructions?: string;
  assistantMaxOutputTokens?: number;
  assistantTemperature?: number;
  assistantMaxSteps?: number;
  assistantTimeoutMs?: number;
  assistantReasoningEffort?: ManagedReasoningEffort;
  modelReasoningEfforts?: string[];
}

/** Reads the administrator-managed provider from host-protected files, never from the browser. */
export function readManagedPlatformRouterConfig():
  | (Required<StoredRouterConfig> & { apiKey: string })
  | null {
  try {
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf8"),
    ) as Partial<StoredRouterConfig>;
    if (!isStoredConfig(parsed)) return null;
    const apiKey = readFileSync(KEY_PATH, "utf8").trim();
    return apiKey ? { ...normalizeStoredConfig(parsed), apiKey } : null;
  } catch {
    return null;
  }
}

export function getManagedPlatformRouterConfig(): ManagedPlatformRouterConfig | null {
  try {
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf8"),
    ) as Partial<StoredRouterConfig>;
    if (!isStoredConfig(parsed)) return null;
    let credentialConfigured = false;
    try {
      credentialConfigured = Boolean(readFileSync(KEY_PATH, "utf8").trim());
    } catch {
      /* absent is a normal first-run state */
    }
    return presentManagedConfig(parsed, credentialConfigured);
  } catch {
    return null;
  }
}

export function saveManagedPlatformRouterConfig(input: {
  endpoint: string;
  model: string;
  protocol: ManagedRouterProtocol;
  enabled: boolean;
  apiKey?: string;
  assistantInstructions?: string;
  assistantMaxOutputTokens?: number;
  assistantTemperature?: number;
  assistantMaxSteps?: number;
  assistantTimeoutMs?: number;
  assistantReasoningEffort?: ManagedReasoningEffort;
  modelReasoningEfforts?: string[];
}): ManagedPlatformRouterConfig {
  const protocol = normalizeProtocol(input.protocol);
  const model = boundedText(input.model, "模型", 256);
  const config: StoredRouterConfig = {
    endpoint: normalizeEndpoint(input.endpoint),
    model,
    protocol,
    enabled: input.enabled,
    assistantInstructions: boundedOptionalText(
      input.assistantInstructions,
      "导购补充指引",
      4_000,
    ),
    assistantMaxOutputTokens: boundedInteger(
      input.assistantMaxOutputTokens,
      320,
      64,
      512,
    ),
    assistantTemperature: boundedNumber(input.assistantTemperature, 0.2, 0, 1),
    assistantMaxSteps: boundedInteger(input.assistantMaxSteps, 3, 2, 8),
    assistantTimeoutMs: boundedInteger(
      input.assistantTimeoutMs,
      20_000,
      4_000,
      30_000,
    ),
    modelReasoningEfforts: normalizeReasoningEfforts(
      input.modelReasoningEfforts,
    ),
    assistantReasoningEffort: normalizeReasoningEffort(
      input.assistantReasoningEffort,
      normalizeReasoningEfforts(input.modelReasoningEfforts),
    ),
  };
  if (input.apiKey !== undefined)
    writeProtected(KEY_PATH, input.apiKey, "API Key");
  const existingKey = readOptional(KEY_PATH);
  if (!existingKey) throw new Error("请输入 API Key 后再保存");
  writeProtected(CONFIG_PATH, JSON.stringify(config), "AI 配置");
  return presentManagedConfig(config, true);
}

export async function listManagedPlatformRouterModels(input: {
  endpoint: string;
  protocol: ManagedRouterProtocol;
  apiKey?: string;
  fetcher?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
}): Promise<ManagedRouterModel[]> {
  const endpoint = normalizeEndpoint(input.endpoint);
  const protocol = normalizeProtocol(input.protocol);
  const apiKey = input.apiKey?.trim() || readOptional(KEY_PATH);
  if (!apiKey) throw new Error("请先填写 API Key");
  const request = modelListRequest(endpoint, protocol, apiKey);
  if (!(await hasOnlyPublicAddresses(request.url, input.resolveAddresses))) {
    throw new Error("模型网关必须解析到公网地址");
  }
  const response = await (input.fetcher ?? fetch)(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）`);
  const payload = (await response.json()) as unknown;
  const models = parseModelList(payload, protocol);
  if (!models.length) throw new Error("模型服务没有返回可选择的模型");
  return models;
}

function isStoredConfig(
  value: Partial<StoredRouterConfig>,
): value is StoredRouterConfig {
  try {
    return (
      typeof value.enabled === "boolean" &&
      Boolean(normalizeEndpoint(value.endpoint ?? "")) &&
      Boolean(boundedText(value.model ?? "", "模型", 256)) &&
      Boolean(normalizeProtocol(value.protocol))
    );
  } catch {
    return false;
  }
}

function normalizeStoredConfig(
  value: StoredRouterConfig,
): Required<StoredRouterConfig> {
  return {
    ...value,
    assistantInstructions: boundedOptionalText(
      value.assistantInstructions,
      "导购补充指引",
      4_000,
    ),
    assistantMaxOutputTokens: boundedInteger(
      value.assistantMaxOutputTokens,
      320,
      64,
      512,
    ),
    assistantTemperature: boundedNumber(value.assistantTemperature, 0.2, 0, 1),
    assistantMaxSteps: boundedInteger(value.assistantMaxSteps, 3, 2, 8),
    assistantTimeoutMs: boundedInteger(
      value.assistantTimeoutMs,
      20_000,
      4_000,
      30_000,
    ),
    modelReasoningEfforts: normalizeReasoningEfforts(
      value.modelReasoningEfforts,
    ),
    assistantReasoningEffort: normalizeReasoningEffort(
      value.assistantReasoningEffort,
      normalizeReasoningEfforts(value.modelReasoningEfforts),
    ),
  };
}

function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/" ||
      isPrivateOrReservedIpLiteral(url.hostname)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      "模型网关只填写 HTTPS 主机地址，例如 https://api.example.com",
    );
  }
}

function normalizeProtocol(value: unknown): ManagedRouterProtocol {
  if (
    value === "openai-compatible" ||
    value === "anthropic-messages" ||
    value === "gemini-generate-content"
  )
    return value;
  throw new Error("模型协议无效");
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw new Error(`${label}必须为 1..=${maximum} 个字符`);
  return normalized;
}

function boundedOptionalText(
  value: string | undefined,
  label: string,
  maximum: number,
): string {
  const normalized = (value ?? "").trim();
  if (normalized.length > maximum)
    throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return normalized;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function presentManagedConfig(
  value: StoredRouterConfig,
  credentialConfigured: boolean,
): ManagedPlatformRouterConfig {
  const normalized = normalizeStoredConfig(value);
  return {
    ...normalized,
    credentialConfigured,
    modelReasoningEfforts: normalized.modelReasoningEfforts,
  };
}

function normalizeReasoningEffort(
  value: unknown,
  supported: string[],
): ManagedReasoningEffort {
  return typeof value === "string" && supported.includes(value)
    ? value
    : "none";
}

function normalizeReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(item),
      ),
    ),
  ].slice(0, 16);
}

function readOptional(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function modelListRequest(
  endpoint: string,
  protocol: ManagedRouterProtocol,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  if (protocol === "gemini-generate-content") {
    return {
      url: `${endpoint}/v1beta/models`,
      headers: { "x-goog-api-key": apiKey },
    };
  }
  if (protocol === "anthropic-messages") {
    return {
      url: `${endpoint}/v1/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return {
    url: `${endpoint}/v1/models`,
    headers: { authorization: `Bearer ${apiKey}` },
  };
}

function parseModelList(
  value: unknown,
  protocol: ManagedRouterProtocol,
): ManagedRouterModel[] {
  if (!isRecord(value)) return [];
  const records = value.data ?? value.models;
  if (!Array.isArray(records)) return [];
  const names = records.flatMap((record) => {
    if (!isRecord(record)) return [];
    const candidate = record.id ?? record.name;
    if (typeof candidate !== "string") return [];
    const normalized =
      protocol === "gemini-generate-content"
        ? candidate.replace(/^models\//, "")
        : candidate;
    return /^[A-Za-z0-9._:/-]{1,256}$/.test(normalized)
      ? [
          {
            id: normalized,
            reasoningEfforts: modelReasoningEffortsFromRecord(record),
          },
        ]
      : [];
  });
  return [...new Map(names.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 512);
}

export function modelReasoningEffortsFromRecord(
  record: Record<string, unknown>,
): string[] {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : {};
  const reasoning = isRecord(capabilities.reasoning)
    ? capabilities.reasoning
    : {};
  return normalizeReasoningEfforts(
    record.supported_reasoning_efforts ??
      record.reasoning_efforts ??
      capabilities.reasoning_efforts ??
      reasoning.efforts ??
      reasoning.levels,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeProtected(
  destination: string,
  value: string,
  label: string,
): void {
  const content = value.trim();
  if (!content || content.length > 16_384)
    throw new Error(`${label}必须为 1..=16384 个字符`);
  const temporary = path.join(
    SECRET_ROOT,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    const descriptor = openSync(temporary, "wx", 0o640);
    try {
      writeFileSync(descriptor, `${content}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, destination);
    chmodSync(destination, 0o640);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort cleanup */
    }
    throw error instanceof Error
      ? new Error(`${label}无法写入受保护存储`, { cause: error })
      : new Error(`${label}无法写入受保护存储`);
  }
}
