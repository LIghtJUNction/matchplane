/**
 * Provider-neutral AI router for the platform tree.
 *
 * The model is only allowed to choose from the already-authorized candidate
 * set supplied by PostgreSQL. It never receives credentials, organization IDs,
 * or a tool that can call an arbitrary path. If the provider is unavailable,
 * the caller gets an explicit policy-fallback result so the event is auditable.
 */

import { isProductionEnvironment } from "./lib/runtime";
import { readJsonResponseBody } from "./lib/body-limit";

export interface PlatformRouteCandidate {
  slug: string;
  path: string;
  /** Internal authority metadata; never sent to the provider prompt. */
  tenantId?: string;
  domainId?: string;
  displayName: string;
  description: string;
  capabilities: string[];
  agentStages: string[];
  agentSkills: string[];
  depth: number;
}

export interface PlatformRouteDecision {
  selectedSlugs: string[];
  source: "ai" | "policy_fallback";
  /** How the bounded router produced this decision; retained for auditability. */
  routeMechanism?: "mcp_tool" | "structured_json" | "policy_fallback";
  model: string | null;
  rationale: string;
  confidence: number | null;
  degraded: boolean;
  costBearer: "platform";
  budget: PlatformRouteBudget;
  usage: PlatformRouteUsage | null;
}

/**
 * The platform owns the model call.  Keeping the budget in the decision makes
 * the cost boundary observable without exposing the provider credential or a
 * provider-specific price to a tenant.
 */
export interface PlatformRouteBudget {
  maxInputCharacters: number;
  maxOutputTokens: number;
}

export interface PlatformRouteUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Raised when the platform's own model-call budget has no remaining admission. */
export class PlatformRouterQuotaExceededError extends Error {
  constructor() {
    super("平台 AI 撮合额度暂时用尽，请稍后再试。");
    this.name = "PlatformRouterQuotaExceededError";
  }
}

const MAX_CANDIDATES = 32;
const MAX_RATIONALE_LENGTH = 1_000;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_PROVIDER_TIMEOUT_MS = 20_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const MAX_TOTAL_TIMEOUT_MS = 60_000;
const MAX_ROUTER_INPUT_CHARACTERS = 24_000;
const MAX_ROUTER_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_FALLBACK_CHILDREN = 4;
const ROUTER_TOOL_NAME = "matchplane.platform.select_children";
// Gemini function declarations reject dots in names. Native providers use this
// wire-safe alias while the audit/event contract keeps the canonical tool name.
const NATIVE_ROUTER_TOOL_NAME = "matchplane_platform_select_children";
const DEFAULT_ROUTER_PROTOCOL = "openai-compatible";

type RouterToolMode = "auto" | "required" | "disabled";

/** Native wire protocols accepted at the server-side provider boundary. */
export type PlatformRouterProtocol =
  | "openai-compatible"
  | "anthropic-messages"
  | "gemini-generate-content";

export async function decidePlatformRoutes(input: {
  platformPath: string;
  narrative: string;
  candidates: PlatformRouteCandidate[];
  /** Absolute deadline shared by every recursive hop in one routing request. */
  deadlineAt?: number;
  /** Atomically reserve one provider call immediately before it is made. */
  admitCall?: () => Promise<void>;
}): Promise<PlatformRouteDecision> {
  // A registry can contain more children than the provider prompt budget permits.  Taking the
  // first rows (the SQL projection is intentionally stable) would permanently starve every
  // child after MAX_CANDIDATES.  Rank the bounded window by the same explainable token overlap
  // used by the policy fallback, then use a request-stable hash as a fair tie breaker so a
  // no-overlap request still rotates through the whole registry without randomising retries.
  const candidates = selectCandidateWindow(input.candidates, input.narrative);
  if (candidates.length === 0) {
    return {
      selectedSlugs: [],
      source: "policy_fallback",
      routeMechanism: "policy_fallback",
      model: null,
      rationale: "当前节点没有可用的已激活子平台。",
      confidence: null,
      degraded: false,
      costBearer: "platform",
      budget: currentBudget(),
      usage: null,
    };
  }

  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim();
  const apiKey = process.env.MATCHPLANE_ROUTER_AI_KEY?.trim();
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim() || null;
  const protocol = configuredPlatformRouterProtocol();
  if (!isPlatformRouterConfigured() || !endpoint || !apiKey || !model) {
    return policyFallback(candidates, input.narrative, "AI 路由服务未配置，使用受控相关性降级。", null);
  }

  try {
    const remainingBeforeAdmission = remainingDeadlineMs(input.deadlineAt);
    if (remainingBeforeAdmission === 0) {
      return policyFallback(candidates, input.narrative, "平台路由达到本次请求的总时限，使用受控相关性降级。", model);
    }
    await input.admitCall?.();
    const remaining = remainingDeadlineMs(input.deadlineAt);
    if (remaining === 0) {
      return policyFallback(candidates, input.narrative, "平台路由达到本次请求的总时限，使用受控相关性降级。", model);
    }
    const toolMode = configuredToolMode();
    const providerRequest = buildProviderRequest({
      endpoint,
      apiKey,
      model,
      protocol,
      toolMode,
      candidates,
      systemPrompt: toolMode === "disabled"
        ? "你是 MatchPlane 平台路由器。只能从候选 slug 中选择与用户目标相关的子平台，不能创造 slug。返回 JSON：selectedSlugs(string[]), rationale(string), confidence(number 0..1)。如果没有合适候选，selectedSlugs 返回空数组。"
        : `你是 MatchPlane 平台路由器。只能从候选 slug 中选择与用户目标相关的子平台，不能创造 slug。优先调用 ${ROUTER_TOOL_NAME} 完成选择；不要调用未声明的工具。`,
      userContent: boundedProviderIntent(input, candidates),
    });
    // The recursive orchestrator owns the larger request deadline, but one
    // provider hop must stay bounded so a slow model cannot consume the whole
    // budget and starve every descendant node.
    const providerTimeoutMs = Math.min(remaining ?? configuredProviderTimeoutMs(), configuredProviderTimeoutMs());
    const response = await fetch(providerRequest.url, {
      method: "POST",
      headers: providerRequest.headers,
      body: JSON.stringify(providerRequest.body),
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
    if (!response.ok) throw new Error(`router provider returned ${response.status}`);
    const payload = await readJsonResponseBody<unknown>(response, MAX_ROUTER_RESPONSE_BYTES);
    const providerDecision = readProviderDecision(payload, candidates, protocol);
    return {
      ...providerDecision.decision,
      source: "ai",
      routeMechanism: providerDecision.routeMechanism,
      model,
      degraded: false,
      costBearer: "platform",
      budget: currentBudget(),
      usage: readUsage(payload, protocol),
    };
  } catch (error) {
    if (error instanceof PlatformRouterQuotaExceededError) throw error;
    const reason = error instanceof Error ? error.message : "AI 路由服务不可用";
    return policyFallback(candidates, input.narrative, `AI 路由降级：${reason.slice(0, 240)}`, model);
  }
}

function selectCandidateWindow(
  candidates: PlatformRouteCandidate[],
  narrative: string,
): PlatformRouteCandidate[] {
  if (candidates.length <= MAX_CANDIDATES) return candidates.slice();
  const intentTokens = new Set(tokenize(narrative));
  return candidates
    .map((candidate, index) => {
      const metadataTokens = tokenize([
        candidate.slug,
        candidate.displayName,
        candidate.description,
        ...candidate.capabilities,
        ...candidate.agentSkills,
      ].join(" "));
      const overlap = metadataTokens.reduce((count, token) => count + (intentTokens.has(token) ? 1 : 0), 0);
      return {
        candidate,
        index,
        overlap,
        tie: stableHash(`${narrative}\u0000${candidate.path}`),
      };
    })
    .sort((left, right) => right.overlap - left.overlap || left.tie - right.tie || left.index - right.index)
    .slice(0, MAX_CANDIDATES)
    .map(({ candidate }) => candidate);
}

/** Small deterministic non-cryptographic hash used only for fair candidate ordering. */
function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** True when a server-side provider credential is present and the endpoint is allowed. */
export function isPlatformRouterConfigured(): boolean {
  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim();
  const apiKey = process.env.MATCHPLANE_ROUTER_AI_KEY?.trim();
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim();
  const rawProtocol = process.env.MATCHPLANE_ROUTER_AI_PROTOCOL?.trim().toLowerCase();
  const supportedProtocol = !rawProtocol
    || rawProtocol === "openai-compatible"
    || rawProtocol === "anthropic-messages"
    || rawProtocol === "gemini-generate-content";
  return Boolean(endpoint && apiKey && model && supportedProtocol && isAllowedEndpoint(endpoint));
}

export function configuredPlatformRouterProtocol(): PlatformRouterProtocol {
  const value = process.env.MATCHPLANE_ROUTER_AI_PROTOCOL?.trim().toLowerCase();
  return value === "anthropic-messages" || value === "gemini-generate-content"
    ? value
    : DEFAULT_ROUTER_PROTOCOL;
}

export interface PlatformRouterProbeResult {
  status: "ready" | "unconfigured" | "failed";
  model: string | null;
  responseStatus: number | null;
  latencyMs: number;
  message: string;
}

/**
 * Perform a bounded, credential-safe connectivity check for the configured router.
 *
 * This is intentionally separate from `decidePlatformRoutes`: an administrator may verify a
 * provider without spending a normal routing admission or sending user data. The request has a
 * fixed prompt and one output token, and the result never includes provider response content.
 */
export async function probePlatformRouter(options: {
  fetcher?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<PlatformRouterProbeResult> {
  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim();
  const apiKey = process.env.MATCHPLANE_ROUTER_AI_KEY?.trim();
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim() || null;
  const protocol = configuredPlatformRouterProtocol();
  const startedAt = Date.now();
  if (!isPlatformRouterConfigured() || !endpoint || !apiKey || !model) {
    return {
      status: "unconfigured",
      model,
      responseStatus: null,
      latencyMs: 0,
      message: "模型网关尚未配置完整，或生产环境端点不是 HTTPS。",
    };
  }

  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.max(1_000, Math.min(8_000, options.timeoutMs as number))
    : 4_000;
  const fetcher = options.fetcher ?? fetch;
  try {
    const providerRequest = buildProviderRequest({
      endpoint,
      apiKey,
      model,
      protocol,
      toolMode: "disabled",
      candidates: [],
      systemPrompt: "Respond with one short token.",
      userContent: "healthcheck",
      maxOutputTokens: 1,
    });
    const response = await fetcher(providerRequest.url, {
      method: "POST",
      headers: providerRequest.headers,
      body: JSON.stringify(providerRequest.body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const payload = await readJsonResponseBody<unknown>(response, 64 * 1024);
    const hasOutput = hasProviderOutput(payload, protocol);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    if (!response.ok || !hasOutput) {
      return {
        status: "failed",
        model,
        responseStatus: response.status,
        latencyMs,
        message: !response.ok
          ? `模型网关返回 HTTP ${response.status}。`
          : "模型网关响应缺少可读内容。",
      };
    }
    return {
      status: "ready",
      model,
      responseStatus: response.status,
      latencyMs,
      message: "模型网关连接正常。",
    };
  } catch (error) {
    return {
      status: "failed",
      model,
      responseStatus: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      message: `模型网关连接失败：${safeProbeError(error)}`,
    };
  }
}

function safeProbeError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "请求超时";
  if (error instanceof Error && error.message) return error.message.slice(0, 160);
  return "网络或上游服务不可用";
}

/** Total wall-clock budget for one recursive platform routing request. */
export function configuredPlatformRouterTotalTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS ?? String(DEFAULT_TOTAL_TIMEOUT_MS), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(DEFAULT_TIMEOUT_MS, Math.min(MAX_TOTAL_TIMEOUT_MS, parsed))
    : DEFAULT_TOTAL_TIMEOUT_MS;
}

function policyFallback(
  candidates: PlatformRouteCandidate[],
  narrative: string,
  rationale: string,
  model: string | null,
): PlatformRouteDecision {
  const ranked = rankFallbackCandidates(candidates, narrative);
  return {
    selectedSlugs: ranked.slice(0, configuredFallbackChildren()).map((candidate) => candidate.slug),
    source: "policy_fallback",
    routeMechanism: "policy_fallback",
    model,
    rationale: `${rationale} 已按需求与平台描述的轻量相关性选择最多 ${configuredFallbackChildren()} 个候选。`.slice(0, MAX_RATIONALE_LENGTH),
    confidence: null,
    degraded: true,
    costBearer: "platform",
    budget: currentBudget(),
    usage: null,
  };
}

function configuredFallbackChildren(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_FALLBACK_CHILDREN ?? String(DEFAULT_FALLBACK_CHILDREN), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(MAX_CANDIDATES, parsed)) : DEFAULT_FALLBACK_CHILDREN;
}

/**
 * A deterministic, domain-neutral fallback. It is intentionally not presented as an AI score:
 * it only counts bounded token/character overlap in operator-authored public metadata and leaves
 * confidence null. Ties retain registration order so an operator can apply a separate exposure
 * policy without turning alphabetical slug order into an accidental ranking rule.
 */
function rankFallbackCandidates(
  candidates: PlatformRouteCandidate[],
  narrative: string,
): PlatformRouteCandidate[] {
  const intentTokens = tokenize(narrative);
  return candidates
    .map((candidate, index) => {
      const metadataTokens = tokenize([
        candidate.slug,
        candidate.displayName,
        candidate.description,
        ...candidate.capabilities,
        ...candidate.agentSkills,
      ].join(" "));
      const metadata = new Set(metadataTokens);
      const overlap = intentTokens.reduce((count, token) => count + (metadata.has(token) ? 1 : 0), 0);
      return { candidate, index, overlap };
    })
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().slice(0, 8_000);
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [];
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]/g)].map(([character]) => character);
  return [...new Set([...words, ...cjk])].slice(0, 512);
}

function currentBudget(): PlatformRouteBudget {
  return {
    maxInputCharacters: MAX_ROUTER_INPUT_CHARACTERS,
    maxOutputTokens: configuredMaxTokens(),
  };
}

function boundedProviderIntent(
  input: { platformPath: string; narrative: string },
  candidates: PlatformRouteCandidate[],
): string {
  const detailed = {
    currentPlatformPath: input.platformPath,
    userIntent: input.narrative.slice(0, 8_000),
    candidates: candidates.map((candidate) => ({
      slug: candidate.slug,
      path: candidate.path,
      displayName: candidate.displayName.slice(0, 160),
      description: candidate.description.slice(0, 400),
      capabilities: candidate.capabilities.slice(0, 16).map((value) => value.slice(0, 96)),
      agentStages: candidate.agentStages.slice(0, 8),
      agentSkills: candidate.agentSkills.slice(0, 16).map((value) => value.slice(0, 128)),
    })),
  };
  const detailedJson = JSON.stringify(detailed);
  if (detailedJson.length <= MAX_ROUTER_INPUT_CHARACTERS) return detailedJson;

  // If a very large manifest still exceeds the cap, retain only the fields
  // needed to make an allowlisted slug decision.  This keeps the request valid
  // JSON instead of truncating a string in the middle of a serialized object.
  return JSON.stringify({
    currentPlatformPath: input.platformPath,
    userIntent: input.narrative.slice(0, 4_000),
    candidates: candidates.map((candidate) => ({
      slug: candidate.slug,
      path: candidate.path,
      displayName: candidate.displayName.slice(0, 120),
    })),
  });
}

function readUsage(value: unknown, protocol: PlatformRouterProtocol): PlatformRouteUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = protocol === "gemini-generate-content"
    ? (value as { usageMetadata?: unknown }).usageMetadata
    : (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = finiteNonNegativeInteger(protocol === "gemini-generate-content" ? record.promptTokenCount : protocol === "anthropic-messages" ? record.input_tokens : record.prompt_tokens);
  const completionTokens = finiteNonNegativeInteger(protocol === "gemini-generate-content" ? record.candidatesTokenCount : protocol === "anthropic-messages" ? record.output_tokens : record.completion_tokens);
  const reportedTotal = finiteNonNegativeInteger(protocol === "gemini-generate-content" ? record.totalTokenCount : record.total_tokens);
  const totalTokens = reportedTotal ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  if (promptTokens === null || completionTokens === null || totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function configuredMaxTokens(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS ?? "512", 10);
  return Number.isSafeInteger(parsed) ? Math.max(64, Math.min(2_048, parsed)) : 512;
}

function remainingDeadlineMs(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) return null;
  if (!Number.isFinite(deadlineAt)) return 0;
  const remaining = Math.floor(deadlineAt - Date.now());
  return remaining > 0 ? remaining : 0;
}

function configuredToolMode(): RouterToolMode {
  const value = process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE?.trim().toLowerCase();
  return value === "required" || value === "disabled" ? value : "auto";
}

function configuredProviderTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MATCHPLANE_ROUTER_AI_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(DEFAULT_TIMEOUT_MS, Math.min(MAX_PROVIDER_TIMEOUT_MS, parsed))
    : DEFAULT_TIMEOUT_MS;
}

function routerSelectionTool(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  return {
    type: "function",
    function: routerSelectionFunction(candidates),
  };
}

function routerSelectionFunction(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  return {
    name: ROUTER_TOOL_NAME,
    description: "从当前节点已授权的候选子平台中选择下一跳；不得创造候选之外的 slug。",
    strict: true,
    parameters: routerSelectionParameters(candidates),
  };
}

function routerSelectionParameters(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["selectedSlugs", "rationale", "confidence"],
    properties: {
      selectedSlugs: {
        type: "array",
        maxItems: candidates.length,
        uniqueItems: true,
        items: { type: "string", enum: candidates.map((candidate) => candidate.slug) },
      },
      rationale: { type: "string", maxLength: MAX_RATIONALE_LENGTH },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildProviderRequest(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  protocol: PlatformRouterProtocol;
  toolMode: RouterToolMode;
  candidates: PlatformRouteCandidate[];
  systemPrompt: string;
  userContent: string;
  maxOutputTokens?: number;
}): ProviderRequest {
  const maxOutputTokens = input.maxOutputTokens ?? configuredMaxTokens();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (input.protocol === "anthropic-messages") {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: maxOutputTokens,
      temperature: 0,
      system: input.systemPrompt,
      messages: [{ role: "user", content: input.userContent }],
    };
    if (input.toolMode !== "disabled") {
      body.tools = [{
        name: NATIVE_ROUTER_TOOL_NAME,
        description: "从当前节点已授权的候选子平台中选择下一跳；不得创造候选之外的 slug。",
        input_schema: routerSelectionParameters(input.candidates),
      }];
      if (input.toolMode === "required") body.tool_choice = { type: "tool", name: NATIVE_ROUTER_TOOL_NAME };
    }
    return { url: input.endpoint, headers, body };
  }
  if (input.protocol === "gemini-generate-content") {
    headers["x-goog-api-key"] = input.apiKey;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: input.userContent }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        ...(input.toolMode === "disabled" ? { responseMimeType: "application/json" } : {}),
      },
    };
    if (input.toolMode !== "disabled") {
      body.tools = [{ functionDeclarations: [geminiRouterFunction(input.candidates)] }];
      if (input.toolMode === "required") {
        body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [NATIVE_ROUTER_TOOL_NAME] } };
      }
    }
    return { url: geminiEndpoint(input.endpoint, input.model), headers, body };
  }

  headers.authorization = `Bearer ${input.apiKey}`;
  const body: Record<string, unknown> = {
    model: input.model,
    temperature: 0,
    max_tokens: maxOutputTokens,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userContent },
    ],
  };
  if (input.toolMode === "disabled") {
    body.response_format = { type: "json_object" };
  } else {
    body.tools = [routerSelectionTool(input.candidates)];
    if (input.toolMode === "required") body.tool_choice = { type: "function", function: { name: ROUTER_TOOL_NAME } };
  }
  return { url: input.endpoint, headers, body };
}

function geminiRouterFunction(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  const fn = routerSelectionFunction(candidates);
  return {
    name: NATIVE_ROUTER_TOOL_NAME,
    description: fn.description,
    parameters: fn.parameters,
  };
}

function geminiEndpoint(endpoint: string, model: string): string {
  if (endpoint.includes(":generateContent")) return endpoint;
  return `${endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
}

function normalizeDecision(
  value: unknown,
  candidates: PlatformRouteCandidate[],
): Omit<PlatformRouteDecision, "source" | "model" | "degraded" | "costBearer" | "budget" | "usage"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 路由响应不是对象");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.selectedSlugs) || record.selectedSlugs.some((slug) => typeof slug !== "string")) {
    throw new Error("AI 路由响应缺少 selectedSlugs");
  }
  const allowed = new Set(candidates.map((candidate) => candidate.slug));
  const selectedSlugs = [...new Set(record.selectedSlugs.filter((slug): slug is string => allowed.has(slug)))];
  const rationale = typeof record.rationale === "string"
    ? record.rationale.trim().slice(0, MAX_RATIONALE_LENGTH)
    : "AI 已根据候选平台能力完成路由。";
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : null;
  return { selectedSlugs, rationale, confidence };
}

function readProviderContent(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI 路由响应无效");
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length || !choices[0] || typeof choices[0] !== "object") {
    throw new Error("AI 路由响应缺少 choices");
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("AI 路由响应缺少 message");
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { text: string } => Boolean(part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"))
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  throw new Error("AI 路由响应 content 无效");
}

function readProviderDecision(
  value: unknown,
  candidates: PlatformRouteCandidate[],
  protocol: PlatformRouterProtocol,
): {
  decision: Omit<PlatformRouteDecision, "source" | "model" | "degraded" | "costBearer" | "budget" | "usage">;
  routeMechanism: "mcp_tool" | "structured_json";
} {
  const toolCall = readProviderToolCall(value, protocol);
  if (toolCall) {
    return {
      decision: normalizeDecision(JSON.parse(toolCall), candidates),
      routeMechanism: "mcp_tool",
    };
  }
  return {
    decision: normalizeDecision(JSON.parse(readProviderText(value, protocol)), candidates),
    routeMechanism: "structured_json",
  };
}

function readProviderText(value: unknown, protocol: PlatformRouterProtocol): string {
  if (protocol === "anthropic-messages") {
    if (!isRecord(value) || !Array.isArray(value.content)) throw new Error("AI 路由响应缺少 content");
    const text = value.content
      .filter((part): part is { type?: unknown; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!text) throw new Error("AI 路由响应 content 无效");
    return text;
  }
  if (protocol === "gemini-generate-content") {
    const parts = geminiParts(value);
    const text = parts
      .filter((part): part is { text: string } => typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!text) throw new Error("AI 路由响应 content 无效");
    return text;
  }
  return readProviderContent(value);
}

function readProviderToolCall(value: unknown, protocol: PlatformRouterProtocol): string | null {
  if (protocol === "anthropic-messages") {
    if (!isRecord(value) || !Array.isArray(value.content)) return null;
    const call = value.content.find((part) => isRecord(part) && part.type === "tool_use" && isRouterToolName(part.name));
    if (!call || !isRecord(call)) return null;
    return isRecord(call.input) ? JSON.stringify(call.input) : null;
  }
  if (protocol === "gemini-generate-content") {
    const call = geminiParts(value).find((part) => {
      const functionCall = isRecord(part.functionCall) ? part.functionCall : null;
      return isRouterToolName(functionCall?.name);
    });
    if (!call) return null;
    const functionCall = isRecord(call.functionCall) ? call.functionCall : null;
    return functionCall && isRecord(functionCall.args) ? JSON.stringify(functionCall.args) : null;
  }
  return readRouterToolCall(readProviderMessage(value));
}

function geminiParts(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.candidates) || !isRecord(value.candidates[0])) {
    throw new Error("AI 路由响应缺少 candidates");
  }
  const content = value.candidates[0].content;
  if (!isRecord(content) || !Array.isArray(content.parts)) throw new Error("AI 路由响应缺少 parts");
  return content.parts.filter(isRecord);
}

function hasProviderOutput(value: unknown, protocol: PlatformRouterProtocol): boolean {
  try {
    if (protocol === "anthropic-messages") {
      return isRecord(value) && Array.isArray(value.content) && value.content.some((part) => isRecord(part) && (part.type === "text" || part.type === "tool_use"));
    }
    if (protocol === "gemini-generate-content") return geminiParts(value).length > 0;
    return isRecord(value) && Array.isArray(value.choices) && value.choices.length > 0;
  } catch {
    return false;
  }
}

function readProviderMessage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI 路由响应无效");
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length || !choices[0] || typeof choices[0] !== "object") {
    throw new Error("AI 路由响应缺少 choices");
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("AI 路由响应缺少 message");
  return message as Record<string, unknown>;
}

function readRouterToolCall(message: Record<string, unknown>): string | null {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return null;
  const call = calls.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const fn = (candidate as { function?: unknown }).function;
    return Boolean(fn && typeof fn === "object" && !Array.isArray(fn)
      && isRouterToolName((fn as { name?: unknown }).name));
  });
  if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("AI 路由工具调用无效");
  const args = (call as { function?: unknown }).function;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("AI 路由工具参数无效");
  const value = (args as { arguments?: unknown }).arguments;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  throw new Error("AI 路由工具参数无效");
}

function isAllowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    // Provider credentials must stay in headers; rejecting query strings also
    // prevents accidental leakage through logs, traces, and reverse proxies.
    if (url.username || url.password || url.hash || url.search) return false;
    if (isProductionEnvironment()) {
      return url.protocol === "https:";
    }
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function isRouterToolName(value: unknown): boolean {
  return value === ROUTER_TOOL_NAME || value === NATIVE_ROUTER_TOOL_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
