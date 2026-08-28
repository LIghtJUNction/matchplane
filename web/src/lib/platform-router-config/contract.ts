import { isPrivateOrReservedIpLiteral } from "../public-endpoint";

export const LEGACY_ROUTER_KEY_FILE = "platform-router.key";
export const MANAGED_ROUTER_KEY_FILE =
  /^platform-router-key-[0-9a-f-]{36}\.key$/;

export type ManagedRouterProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generate-content";
type ManagedReasoningEffort = string;

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

export interface ManagedPlatformRouterDraftConfig
  extends ManagedPlatformRouterConfig {
  testedReady: boolean;
  testedAt: string | null;
  keyChanged: boolean;
}

export interface PlatformRouterEffectiveStatus {
  ready: boolean;
  code: "ready" | "upstream_configuration";
  preferredHttpStatus: 451 | null;
  source: "managed" | "environment" | "unconfigured";
  managedOverridesEnvironment: boolean;
  conflicts: {
    endpoint: boolean | null;
    model: boolean | null;
    protocol: boolean | null;
  };
  endpointOrigin: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
  originAllowlistApplied: boolean;
  issues: string[];
}

export interface ManagedPlatformRouterState {
  config: ManagedPlatformRouterConfig | null;
  draft: ManagedPlatformRouterDraftConfig | null;
  effective: PlatformRouterEffectiveStatus;
}

export interface StoredRouterConfig {
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
  credentialFile?: string;
}

interface StoredRouterConfigCandidate {
  endpoint: unknown;
  model: unknown;
  protocol: unknown;
  enabled: unknown;
  assistantInstructions?: unknown;
  assistantMaxOutputTokens?: unknown;
  assistantTemperature?: unknown;
  assistantMaxSteps?: unknown;
  assistantTimeoutMs?: unknown;
  assistantReasoningEffort?: unknown;
  modelReasoningEfforts?: unknown;
  credentialFile?: unknown;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NormalizedStoredRouterConfig = Required<StoredRouterConfig>;
export type ManagedPlatformRouterSecretConfig = NormalizedStoredRouterConfig & {
  apiKey: string;
};

export interface DraftMetadata {
  keyChanged: boolean;
}

export interface DraftTestAttestation {
  digest: string;
  testedAt: string;
  requestId: string;
}

export interface PlatformRouterAuditEvent {
  /** Stable identity used to replay the durable audit outbox exactly once. */
  eventId?: string;
  action: "stage" | "test" | "activate";
  actor: string;
  requestId: string;
  endpoint: string;
  model: string;
  enabled: boolean;
  keyChanged: boolean;
}

export interface StoredRouterDraft {
  config: NormalizedStoredRouterConfig;
  metadata: DraftMetadata;
  attestation: DraftTestAttestation | null;
}

export interface ManagedPlatformRouterInput {
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
}

export class PlatformRouterConfigValidationError extends Error {}

export function decodeStoredRouterConfig(
  raw: string | null,
): NormalizedStoredRouterConfig | null {
  if (raw === null) return null;
  const parsed = parseJson(raw);
  if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return null;
  try {
    return normalizeStoredRouterConfig({
      endpoint: parsed.endpoint,
      model: parsed.model,
      protocol: parsed.protocol,
      enabled: parsed.enabled,
      assistantInstructions: parsed.assistantInstructions,
      assistantMaxOutputTokens: parsed.assistantMaxOutputTokens,
      assistantTemperature: parsed.assistantTemperature,
      assistantMaxSteps: parsed.assistantMaxSteps,
      assistantTimeoutMs: parsed.assistantTimeoutMs,
      assistantReasoningEffort: parsed.assistantReasoningEffort,
      modelReasoningEfforts: parsed.modelReasoningEfforts,
      credentialFile: parsed.credentialFile,
    });
  } catch (cause) {
    if (cause instanceof PlatformRouterConfigValidationError) return null;
    throw cause;
  }
}

export function normalizeManagedRouterInput(
  input: ManagedPlatformRouterInput,
  credentialFile: string,
): NormalizedStoredRouterConfig {
  const reasoningEfforts = normalizeReasoningEfforts(
    input.modelReasoningEfforts,
  );
  const protocol = normalizeProtocol(input.protocol);
  return normalizeStoredRouterConfig({
    endpoint: normalizeEndpoint(input.endpoint),
    model: normalizeProviderModel(input.model, protocol),
    protocol,
    enabled: input.enabled,
    credentialFile,
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
    assistantMaxSteps: boundedInteger(input.assistantMaxSteps, 5, 2, 8),
    assistantTimeoutMs: boundedInteger(
      input.assistantTimeoutMs,
      20_000,
      4_000,
      30_000,
    ),
    modelReasoningEfforts: reasoningEfforts,
    assistantReasoningEffort: normalizeReasoningEffort(
      input.assistantReasoningEffort,
      reasoningEfforts,
    ),
  });
}

export function normalizeStoredRouterConfig(
  value: StoredRouterConfigCandidate,
): NormalizedStoredRouterConfig {
  const reasoningEfforts = normalizeReasoningEfforts(
    value.modelReasoningEfforts,
  );
  const protocol = normalizeProtocol(value.protocol);
  return {
    endpoint: normalizeEndpoint(value.endpoint),
    model: normalizeProviderModel(value.model, protocol),
    protocol,
    enabled: requiredBoolean(value.enabled, "启用状态"),
    credentialFile: normalizeCredentialFile(value.credentialFile),
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
    assistantMaxSteps: boundedInteger(value.assistantMaxSteps, 5, 2, 8),
    assistantTimeoutMs: boundedInteger(
      value.assistantTimeoutMs,
      20_000,
      4_000,
      30_000,
    ),
    modelReasoningEfforts: reasoningEfforts,
    assistantReasoningEffort: normalizeReasoningEffort(
      value.assistantReasoningEffort,
      reasoningEfforts,
    ),
  };
}

export function normalizeCredentialFile(value: unknown): string {
  const candidate =
    typeof value === "string" && value ? value : LEGACY_ROUTER_KEY_FILE;
  if (
    candidate !== LEGACY_ROUTER_KEY_FILE &&
    !MANAGED_ROUTER_KEY_FILE.test(candidate)
  ) {
    throw new PlatformRouterConfigValidationError("AI 凭据文件引用无效");
  }
  return candidate;
}

export function normalizeEndpoint(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!URL.canParse(candidate)) throw invalidEndpoint();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidEndpoint();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname.length > 512 ||
    isPrivateOrReservedIpLiteral(url.hostname)
  ) {
    throw invalidEndpoint();
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

export function normalizeProtocol(value: unknown): ManagedRouterProtocol {
  if (
    value === "openai-compatible" ||
    value === "anthropic-messages" ||
    value === "gemini-generate-content"
  ) {
    return value;
  }
  throw new PlatformRouterConfigValidationError("模型协议无效");
}

export function isValidProviderModel(
  value: unknown,
  protocol: unknown,
): boolean {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    return false;
  }
  if (protocol === "gemini-generate-content") {
    return !value.includes("/") && !value.includes(":");
  }
  return protocol === "openai-compatible" || protocol === "anthropic-messages";
}

function normalizeProviderModel(
  value: unknown,
  protocol: ManagedRouterProtocol,
): string {
  const model = boundedText(value, "模型", 256);
  if (!isValidProviderModel(model, protocol)) {
    throw new PlatformRouterConfigValidationError("模型 ID 格式无效");
  }
  return model;
}

export function boundedText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) {
    throw new PlatformRouterConfigValidationError(
      `${label}必须为 1..=${maximum} 个字符`,
    );
  }
  return normalized;
}

export function boundedAuditText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n]/.test(normalized)) {
    throw new PlatformRouterConfigValidationError(`${label} 无效`);
  }
  return normalized;
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

export function presentManagedConfig(
  value: StoredRouterConfig,
  credentialConfigured: boolean,
): ManagedPlatformRouterConfig {
  const normalized = normalizeStoredRouterConfig(value);
  return {
    endpoint: normalized.endpoint,
    model: normalized.model,
    protocol: normalized.protocol,
    enabled: normalized.enabled,
    credentialConfigured,
    assistantInstructions: normalized.assistantInstructions,
    assistantMaxOutputTokens: normalized.assistantMaxOutputTokens,
    assistantTemperature: normalized.assistantTemperature,
    assistantMaxSteps: normalized.assistantMaxSteps,
    assistantTimeoutMs: normalized.assistantTimeoutMs,
    assistantReasoningEffort: normalized.assistantReasoningEffort,
    modelReasoningEfforts: normalized.modelReasoningEfforts,
  };
}

function parseJson(raw: string): JsonValue {
  try {
    const value: JsonValue = JSON.parse(raw);
    return value;
  } catch (cause) {
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedOptionalText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > maximum) {
    throw new PlatformRouterConfigValidationError(
      `${label}不能超过 ${maximum} 个字符`,
    );
  }
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

function normalizeReasoningEffort(
  value: unknown,
  supported: string[],
): ManagedReasoningEffort {
  return typeof value === "string" && supported.includes(value)
    ? value
    : "none";
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value;
  throw new PlatformRouterConfigValidationError(`${label}无效`);
}

function invalidEndpoint(): PlatformRouterConfigValidationError {
  return new PlatformRouterConfigValidationError(
    "模型网关必须是 HTTPS API 基址，例如 https://api.example.com/v1",
  );
}
