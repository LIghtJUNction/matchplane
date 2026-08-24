import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  hasOnlyPublicAddresses,
  isPrivateOrReservedIpLiteral,
  type ResolveAddresses,
} from "./public-endpoint";

const SECRET_ROOT = "/etc/matchplane/secrets/root-email";
const CONFIG_PATH = path.join(SECRET_ROOT, "platform-router.json");
const LEGACY_KEY_FILE = "platform-router.key";
const DRAFT_CONFIG_PATH = path.join(SECRET_ROOT, "platform-router.draft.json");
const DRAFT_META_PATH = path.join(SECRET_ROOT, "platform-router.draft-meta.json");
const DRAFT_TEST_PATH = path.join(SECRET_ROOT, "platform-router.draft-test.json");
const AUDIT_PATH = path.join(SECRET_ROOT, "platform-router.audit.jsonl");
const MANAGED_KEY_FILE = /^platform-router-key-[0-9a-f-]{36}\.key$/;

const M0_REQUIRED_ROUTER_ENDPOINT = "https://api.lmm.best/v1";
const M0_REQUIRED_ROUTER_MODEL = "gpt-5.6-sol";
const M0_REQUIRED_ROUTER_PROTOCOL: ManagedRouterProtocol =
  "openai-compatible";

export type ManagedRouterProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generate-content";
type ManagedReasoningEffort = string;

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
    endpoint: boolean;
    model: boolean;
    protocol: boolean;
  };
  endpointOrigin: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
  endpointMatchesRequired: boolean;
  modelMatchesRequired: boolean;
  protocolMatchesRequired: boolean;
  requiredEndpoint: string;
  requiredModel: string;
  issues: string[];
}

export interface ManagedPlatformRouterState {
  config: ManagedPlatformRouterConfig | null;
  draft: ManagedPlatformRouterDraftConfig | null;
  effective: PlatformRouterEffectiveStatus;
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
  credentialFile?: string;
}

interface DraftMetadata {
  keyChanged: boolean;
}

interface DraftTestAttestation {
  digest: string;
  testedAt: string;
  requestId: string;
}

export interface PlatformRouterAuditEvent {
  action: "stage" | "test" | "activate";
  actor: string;
  requestId: string;
  endpoint: string;
  model: string;
  enabled: boolean;
  keyChanged: boolean;
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

/** Reads the active administrator-managed provider without exposing it to the browser. */
export function readManagedPlatformRouterConfig():
  | (Required<StoredRouterConfig> & { apiKey: string })
  | null {
  return readSecretConfig(CONFIG_PATH);
}

/** Reads the staged provider for the root-super-admin-only connectivity probe. */
export function readManagedPlatformRouterDraftConfig():
  | (Required<StoredRouterConfig> & { apiKey: string })
  | null {
  return readSecretConfig(DRAFT_CONFIG_PATH);
}

function getManagedPlatformRouterConfig(): ManagedPlatformRouterConfig | null {
  const stored = readStoredConfig(CONFIG_PATH);
  if (!stored) return null;
  return presentManagedConfig(
    stored,
    Boolean(readOptional(credentialPath(stored.credentialFile))),
  );
}

export function getManagedPlatformRouterDraftConfig(): ManagedPlatformRouterDraftConfig | null {
  const stored = readStoredConfig(DRAFT_CONFIG_PATH);
  if (!stored) return null;
  const apiKey = readOptional(credentialPath(stored.credentialFile));
  const metadata = readJson<DraftMetadata>(DRAFT_META_PATH);
  const attestation = readJson<DraftTestAttestation>(DRAFT_TEST_PATH);
  const testedReady = Boolean(
    apiKey &&
      attestation &&
      constantTimeTextEqual(attestation.digest, draftDigest(stored, apiKey)),
  );
  return {
    ...presentManagedConfig(stored, Boolean(apiKey)),
    testedReady,
    testedAt: testedReady ? attestation?.testedAt ?? null : null,
    keyChanged: metadata?.keyChanged === true,
  };
}

export function getManagedPlatformRouterState(): ManagedPlatformRouterState {
  return {
    config: getManagedPlatformRouterConfig(),
    draft: getManagedPlatformRouterDraftConfig(),
    effective: getPlatformRouterEffectiveStatus(),
  };
}

/** Stage a candidate. The active configuration remains untouched until an attested probe passes. */
export function stageManagedPlatformRouterConfig(
  input: ManagedPlatformRouterInput,
): ManagedPlatformRouterDraftConfig {
  const previousDraft = readStoredConfig(DRAFT_CONFIG_PATH);
  const active = readStoredConfig(CONFIG_PATH);
  const suppliedKey = input.apiKey?.trim();
  let credentialFile: string;
  if (suppliedKey) {
    credentialFile = `platform-router-key-${randomUUID()}.key`;
  } else {
    credentialFile =
      previousDraft?.credentialFile ?? active?.credentialFile ?? LEGACY_KEY_FILE;
    if (!readOptional(credentialPath(credentialFile)))
      throw new Error("请输入 API Key 后再保存待测配置");
  }
  const keyChanged = Boolean(
    suppliedKey || credentialFile !== (active?.credentialFile ?? LEGACY_KEY_FILE),
  );
  const config = normalizedInputConfig(input, credentialFile);
  try {
    if (suppliedKey)
      writeProtected(credentialPath(credentialFile), suppliedKey, "API Key");
    writeProtected(DRAFT_CONFIG_PATH, JSON.stringify(config), "AI 待测配置");
    writeProtected(
      DRAFT_META_PATH,
      JSON.stringify({ keyChanged } satisfies DraftMetadata),
      "AI 待测元数据",
    );
    removeOptional(DRAFT_TEST_PATH);
  } catch (error) {
    if (suppliedKey) removeOptional(credentialPath(credentialFile));
    throw error;
  }
  removeUnusedDraftCredential(previousDraft, active, credentialFile);
  const draft = getManagedPlatformRouterDraftConfig();
  if (!draft) throw new Error("AI 待测配置保存后无法读取");
  return draft;
}

export function markManagedPlatformRouterDraftTested(requestId: string): void {
  const draft = readManagedPlatformRouterDraftConfig();
  if (!draft) throw new Error("没有可测试的 AI 待测配置");
  writeProtected(
    DRAFT_TEST_PATH,
    JSON.stringify({
      digest: draftDigest(draft, draft.apiKey),
      testedAt: new Date().toISOString(),
      requestId: boundedAuditText(requestId, "request id"),
    } satisfies DraftTestAttestation),
    "AI 测试证明",
  );
}

export function activateManagedPlatformRouterDraft(): ManagedPlatformRouterConfig {
  const previous = readStoredConfig(CONFIG_PATH);
  const draft = readManagedPlatformRouterDraftConfig();
  const publicDraft = getManagedPlatformRouterDraftConfig();
  if (!draft || !publicDraft?.testedReady)
    throw new Error("请先成功测试待测配置");
  if (!draft.enabled) throw new Error("请先勾选启用商城 AI 导购");
  const { apiKey: _apiKey, ...config } = draft;
  writeProtected(CONFIG_PATH, JSON.stringify(config), "AI 配置");
  removeOptional(DRAFT_CONFIG_PATH);
  removeOptional(DRAFT_META_PATH);
  removeOptional(DRAFT_TEST_PATH);
  const active = getManagedPlatformRouterConfig();
  if (!active) throw new Error("AI 配置激活后无法读取");
  removeUnusedDraftCredential(previous, config, config.credentialFile);
  return active;
}

function readStoredConfig(file: string): Required<StoredRouterConfig> | null {
  try {
    const parsed = readJson<Partial<StoredRouterConfig>>(file);
    return parsed && isStoredConfig(parsed)
      ? normalizeStoredConfig(parsed)
      : null;
  } catch {
    return null;
  }
}

function readSecretConfig(
  file: string,
): (Required<StoredRouterConfig> & { apiKey: string }) | null {
  const config = readStoredConfig(file);
  if (!config) return null;
  const apiKey = readOptional(credentialPath(config.credentialFile));
  return apiKey ? { ...config, apiKey } : null;
}

function credentialPath(file: string): string {
  if (file !== LEGACY_KEY_FILE && !MANAGED_KEY_FILE.test(file))
    throw new Error("AI 凭据文件引用无效");
  return path.join(SECRET_ROOT, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function draftDigest(value: StoredRouterConfig, apiKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeStoredConfig(value)))
    .update("\0")
    .update(apiKey)
    .digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function normalizedInputConfig(
  input: ManagedPlatformRouterInput,
  credentialFile: string,
): Required<StoredRouterConfig> {
  const reasoningEfforts = normalizeReasoningEfforts(
    input.modelReasoningEfforts,
  );
  return normalizeStoredConfig({
    endpoint: normalizeEndpoint(input.endpoint),
    model: boundedText(input.model, "模型", 256),
    protocol: normalizeProtocol(input.protocol),
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

function removeOptional(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Missing staged state is normal.
  }
}

function removeUnusedDraftCredential(
  previous: Required<StoredRouterConfig> | null,
  active: Required<StoredRouterConfig> | null,
  nextCredentialFile: string,
): void {
  const previousFile = previous?.credentialFile;
  if (
    !previousFile ||
    previousFile === nextCredentialFile ||
    previousFile === active?.credentialFile ||
    !MANAGED_KEY_FILE.test(previousFile)
  )
    return;
  removeOptional(credentialPath(previousFile));
}

function boundedAuditText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n]/.test(normalized))
    throw new Error(`${label} 无效`);
  return normalized;
}

export function appendPlatformRouterAudit(
  event: PlatformRouterAuditEvent,
): void {
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(normalizeEndpoint(event.endpoint)).origin;
  } catch (cause) {
    throw new Error("AI 配置审计的 endpoint 无效", { cause });
  }
  const record = {
    actor: boundedAuditText(event.actor, "actor"),
    timestamp: new Date().toISOString(),
    endpoint_origin: endpointOrigin,
    model: boundedText(event.model, "模型", 256),
    enabled: event.enabled,
    key_changed: event.keyChanged,
    request_id: boundedAuditText(event.requestId, "request id"),
    action: event.action,
  };
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      AUDIT_PATH,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW,
      0o640,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    chmodSync(AUDIT_PATH, 0o640);
  } catch (error) {
    throw new Error("AI 配置审计无法写入", { cause: error });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function getPlatformRouterEffectiveStatus(): PlatformRouterEffectiveStatus {
  const managed = getManagedPlatformRouterConfig();
  const environment = readEnvironmentProviderStatus();
  const selected = selectEffectiveProvider(managed, environment);
  const endpointMatchesRequired =
    selected.endpoint === M0_REQUIRED_ROUTER_ENDPOINT;
  const modelMatchesRequired = selected.model === M0_REQUIRED_ROUTER_MODEL;
  const protocolMatchesRequired =
    selected.protocol === M0_REQUIRED_ROUTER_PROTOCOL;
  const issues = platformRouterPolicyIssues(selected);
  const ready = issues.length === 0;
  return {
    ready,
    code: ready ? "ready" : "upstream_configuration",
    preferredHttpStatus: ready ? null : 451,
    source: selected.source,
    managedOverridesEnvironment:
      selected.source === "managed" && environment.present,
    conflicts: managedEnvironmentConflicts(managed, environment, selected.source),
    endpointOrigin: selected.endpoint
      ? safeEndpointOrigin(selected.endpoint)
      : null,
    model: selected.model,
    protocol: selected.protocol,
    enabled: selected.enabled,
    credentialConfigured: selected.credentialConfigured,
    endpointMatchesRequired,
    modelMatchesRequired,
    protocolMatchesRequired,
    requiredEndpoint: M0_REQUIRED_ROUTER_ENDPOINT,
    requiredModel: M0_REQUIRED_ROUTER_MODEL,
    issues,
  };
}

interface EnvironmentProviderStatus {
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  credentialConfigured: boolean;
  present: boolean;
  configured: boolean;
}

interface SelectedProviderStatus {
  source: PlatformRouterEffectiveStatus["source"];
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
}

function readEnvironmentProviderStatus(): EnvironmentProviderStatus {
  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim() || null;
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim() || null;
  const credentialConfigured = Boolean(
    process.env.MATCHPLANE_ROUTER_AI_KEY?.trim(),
  );
  const protocol = safeProtocol(process.env.MATCHPLANE_ROUTER_AI_PROTOCOL);
  const present = Boolean(endpoint || model || credentialConfigured);
  const configured = Boolean(
    endpoint &&
      model &&
      credentialConfigured &&
      protocol &&
      safeHttpsEndpoint(endpoint),
  );
  return {
    endpoint,
    model,
    protocol,
    credentialConfigured,
    present,
    configured,
  };
}

function selectEffectiveProvider(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
): SelectedProviderStatus {
  if (managed?.enabled && managed.credentialConfigured) {
    return {
      source: "managed",
      endpoint: managed.endpoint,
      model: managed.model,
      protocol: managed.protocol,
      enabled: true,
      credentialConfigured: true,
    };
  }
  if (environment.configured) {
    return {
      source: "environment",
      endpoint: environment.endpoint,
      model: environment.model,
      protocol: environment.protocol,
      enabled: true,
      credentialConfigured: true,
    };
  }
  return {
    source: "unconfigured",
    endpoint: null,
    model: null,
    protocol: null,
    enabled: false,
    credentialConfigured: false,
  };
}

function managedEnvironmentConflicts(
  managed: ManagedPlatformRouterConfig | null,
  environment: EnvironmentProviderStatus,
  source: PlatformRouterEffectiveStatus["source"],
): PlatformRouterEffectiveStatus["conflicts"] {
  if (source !== "managed")
    return { endpoint: false, model: false, protocol: false };
  return {
    endpoint: Boolean(
      environment.endpoint && environment.endpoint !== managed?.endpoint,
    ),
    model: Boolean(environment.model && environment.model !== managed?.model),
    protocol: Boolean(
      environment.protocol && environment.protocol !== managed?.protocol,
    ),
  };
}

export function platformRouterPolicyIssues(input: {
  endpoint: string | null;
  model: string | null;
  protocol: ManagedRouterProtocol | null;
  enabled: boolean;
  credentialConfigured: boolean;
}): string[] {
  return [
    ...(!input.enabled ? ["provider_not_enabled"] : []),
    ...(!input.credentialConfigured ? ["credential_not_configured"] : []),
    ...(input.endpoint !== M0_REQUIRED_ROUTER_ENDPOINT
      ? ["endpoint_mismatch"]
      : []),
    ...(input.model !== M0_REQUIRED_ROUTER_MODEL ? ["model_mismatch"] : []),
    ...(input.protocol !== M0_REQUIRED_ROUTER_PROTOCOL
      ? ["protocol_mismatch"]
      : []),
  ];
}

function safeProtocol(value: string | undefined): ManagedRouterProtocol | null {
  try {
    return normalizeProtocol(value?.trim() || "openai-compatible");
  } catch {
    return null;
  }
}

function safeHttpsEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safeEndpointOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
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
  const apiKey =
    input.apiKey?.trim() ||
    readManagedPlatformRouterDraftConfig()?.apiKey ||
    readManagedPlatformRouterConfig()?.apiKey;
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
    endpoint: normalizeEndpoint(value.endpoint),
    model: boundedText(value.model, "模型", 256),
    protocol: normalizeProtocol(value.protocol),
    enabled: value.enabled,
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
    modelReasoningEfforts: normalizeReasoningEfforts(
      value.modelReasoningEfforts,
    ),
    assistantReasoningEffort: normalizeReasoningEffort(
      value.assistantReasoningEffort,
      normalizeReasoningEfforts(value.modelReasoningEfforts),
    ),
  };
}

function normalizeCredentialFile(value: string | undefined): string {
  const candidate = value || LEGACY_KEY_FILE;
  credentialPath(candidate);
  return candidate;
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
      url.pathname.length > 512 ||
      isPrivateOrReservedIpLiteral(url.hostname)
    )
      throw new Error();
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    throw new Error(
      "模型网关必须是 HTTPS API 基址，例如 https://api.example.com/v1",
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
      url: appendProviderPath(endpoint, "v1beta", "models"),
      headers: { "x-goog-api-key": apiKey },
    };
  }
  if (protocol === "anthropic-messages") {
    return {
      url: appendProviderPath(endpoint, "v1", "models"),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return {
    url: appendProviderPath(endpoint, "v1", "models"),
    headers: { authorization: `Bearer ${apiKey}` },
  };
}

function appendProviderPath(
  endpoint: string,
  version: "v1" | "v1beta",
  resource: string,
): string {
  return endpoint.endsWith(`/${version}`)
    ? `${endpoint}/${resource}`
    : `${endpoint}/${version}/${resource}`;
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
