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
import { readManagedPlatformRouterConfig } from "./lib/platform-router-config";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { searchPublicStoreOffers } from "./storefront-search";
import type { PublicStore } from "./store-directory";
import type { RecommendedBackendListing } from "./api";

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

export interface PlatformAssistantReply {
  text: string;
  model: string;
  usage: PlatformRouteUsage | null;
  recommendations: RecommendedBackendListing[];
}

/** Raised when the platform's own model-call budget has no remaining admission. */
export class PlatformRouterQuotaExceededError extends Error {
  constructor() {
    super("商城 AI 导购额度暂时用尽，请稍后再试。");
    this.name = "PlatformRouterQuotaExceededError";
  }
}

export class PlatformAssistantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAssistantUnavailableError";
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
// Provider function names use a wire-safe alias. The dotted name remains the canonical
// MatchPlane audit/tool contract, but New API/OpenAI-compatible gateways reject dots in the
// provider-facing function name.
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
      rationale: "商城目前没有可检索的已上线店铺。",
      confidence: null,
      degraded: false,
      costBearer: "platform",
      budget: currentBudget(),
      usage: null,
    };
  }

  const router = configuredPlatformRouter();
  const endpoint = router?.endpoint;
  const apiKey = router?.apiKey;
  const model = router?.model ?? null;
  const protocol = router?.protocol ?? DEFAULT_ROUTER_PROTOCOL;
  if (!router || !endpoint || !apiKey || !model) {
    return policyFallback(candidates, input.narrative, "AI 导购尚未配置，先按商品与店铺相关性搜索。", null);
  }

  try {
    const remainingBeforeAdmission = remainingDeadlineMs(input.deadlineAt);
    if (remainingBeforeAdmission === 0) {
      return policyFallback(candidates, input.narrative, "商城导购达到本次请求时限，先按相关性搜索。", model);
    }
    await input.admitCall?.();
    const remaining = remainingDeadlineMs(input.deadlineAt);
    if (remaining === 0) {
      return policyFallback(candidates, input.narrative, "商城导购达到本次请求时限，先按相关性搜索。", model);
    }
    const toolMode = configuredToolMode();
    const providerRequest = buildProviderRequest({
      endpoint,
      endpointIsBase: router.managed,
      apiKey,
      model,
      protocol,
      toolMode,
      candidates,
      systemPrompt: toolMode === "disabled"
        ? "你是商城 AI 导购。只能从候选 slug 中选择可能出售用户所需商品的店铺，不能创造 slug。返回 JSON：selectedSlugs(string[]), rationale(string), confidence(number 0..1)。如果没有合适候选，selectedSlugs 返回空数组。"
        : `你是商城 AI 导购。只能从候选 slug 中选择可能出售用户所需商品的店铺，不能创造 slug。优先调用 ${NATIVE_ROUTER_TOOL_NAME} 完成选择；不要调用未声明的工具。`,
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
    const reason = error instanceof Error ? error.message : "AI 导购服务不可用";
    return policyFallback(candidates, input.narrative, `AI 导购暂时降级：${reason.slice(0, 240)}`, model);
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

interface ConfiguredPlatformRouter {
  endpoint: string;
  apiKey: string;
  model: string;
  protocol: PlatformRouterProtocol;
  managed: boolean;
  assistantInstructions: string;
  assistantMaxOutputTokens: number;
  assistantTemperature: number;
  assistantMaxSteps: number;
  assistantTimeoutMs: number;
  assistantReasoningEffort: "low" | "medium" | "high";
}

function configuredPlatformRouter(): ConfiguredPlatformRouter | null {
  const managed = readManagedPlatformRouterConfig();
  if (managed?.enabled && isAllowedEndpoint(managed.endpoint)) {
    return { ...managed, managed: true };
  }
  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim();
  const apiKey = process.env.MATCHPLANE_ROUTER_AI_KEY?.trim();
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim();
  const rawProtocol = process.env.MATCHPLANE_ROUTER_AI_PROTOCOL?.trim().toLowerCase();
  if (rawProtocol && rawProtocol !== "openai-compatible" && rawProtocol !== "anthropic-messages" && rawProtocol !== "gemini-generate-content") return null;
  const protocol = rawProtocol === "anthropic-messages" || rawProtocol === "gemini-generate-content"
    ? rawProtocol
    : DEFAULT_ROUTER_PROTOCOL;
  if (!endpoint || !apiKey || !model || !isAllowedEndpoint(endpoint)) return null;
  return { endpoint, apiKey, model, protocol, managed: false, assistantInstructions: "", assistantMaxOutputTokens: 320, assistantTemperature: 0.2, assistantMaxSteps: 3, assistantTimeoutMs: 20_000, assistantReasoningEffort: "low" };
}

/** True when a server-side provider credential is present and the endpoint is allowed. */
export function isPlatformRouterConfigured(): boolean {
  return configuredPlatformRouter() !== null;
}

/**
 * Produce a bounded natural-language answer for the public shopping assistant. The model only
 * receives public store summaries; catalogue truth, price, contact, and ordering still remain in
 * their deterministic routes.
 */
export async function answerPlatformShoppingQuestion(input: {
  question: string;
  stores: PublicStore[];
  admitCall?: () => Promise<void>;
}): Promise<PlatformAssistantReply> {
  const router = configuredPlatformRouter();
  if (!router) throw new PlatformAssistantUnavailableError("商城 AI 导购尚未配置完整，请稍后再试。");
  const question = input.question.trim().slice(0, 2_000);
  if (!question) throw new PlatformAssistantUnavailableError("请告诉我你想了解什么。");
  if (router.protocol !== "openai-compatible") {
    throw new PlatformAssistantUnavailableError("当前导购 Agent 需要选择 OpenAI Compatible 协议。");
  }
  try {
    await input.admitCall?.();
    const provider = createOpenAICompatible({
      name: "matchplane",
      baseURL: `${router.endpoint.replace(/\/$/, "")}/v1`,
      apiKey: router.apiKey,
    });
    const visibleStores = input.stores.map((store) => ({
      id: store.id,
      name: store.displayName,
      description: store.description,
      path: store.path,
    }));
    const catalog = new Map<string, { id: string; name: string; store: string; description: string; price: string; path: string }>();
    let recommendations: RecommendedBackendListing[] = [];
    const result = await generateText({
      model: provider.chatModel(router.model),
      system: [
        router.assistantInstructions,
        "你是一个自然、可靠的商城助手。像正常人一样接住用户的话，不要反复自我介绍，也不要强行把闲聊带回购物。根据问题自行决定是否使用工具：查询店铺或商品时使用公开查询工具；比较时使用比较工具；算术或总价时使用计算工具。工具只提供帮助，不必向用户解释工具本身。店铺、商品、价格和库存只能依据工具结果陈述；绝不能编造这些信息，也不能透露联系方式、密钥或未审核内容。最终回答自然简洁，不使用 Markdown 标题或项目符号。",
      ].filter(Boolean).join("\n\n"),
      prompt: question,
      tools: {
        list_public_stores: tool({
          description: "读取当前商城中可公开浏览的店铺摘要。每次回答前先调用一次。",
          inputSchema: z.object({}),
          execute: async () => visibleStores.map(({ id: _id, ...store }) => store),
        }),
        search_public_products: tool({
          description: "从当前公开、已审核上架的商品中检索。只在用户提出具体购物需求时调用。",
          inputSchema: z.object({ query: z.string().min(1).max(2_000) }),
          execute: async ({ query }) => {
            const offers = await searchPublicStoreOffers({ stores: input.stores, narrative: query, limit: 6 });
            recommendations = offers;
            const result = offers.map((offer) => {
              const terms = offer.terms ?? {};
              const price = typeof terms.amount_minor === "string" && typeof terms.currency === "string"
                ? `${terms.currency} ${terms.amount_minor}`
                : "价格未公开";
              const item = {
                id: offer.offer_id ?? offer.listing_id ?? offer.display_name,
                name: offer.display_name,
                store: typeof offer.store_name === "string" && offer.store_name.trim() ? offer.store_name.trim() : "店铺",
                description: typeof offer.attributes?.description === "string" ? offer.attributes.description : "",
                price,
                path: offer.platform_path ?? "/",
              };
              catalog.set(item.id, item);
              return item;
            });
            return result;
          },
        }),
        compare_products: tool({
          description: "比较此前 search_public_products 返回的两到四件商品。",
          inputSchema: z.object({ productIds: z.array(z.string().min(1).max(128)).min(2).max(4) }),
          execute: async ({ productIds }) => productIds.flatMap((id) => catalog.has(id) ? [catalog.get(id)!] : []),
        }),
        calculate_total: tool({
          description: "计算公开价格的小计；金额以最小货币单位表示。",
          inputSchema: z.object({ amounts: z.array(z.number().int().nonnegative()).min(1).max(12), quantities: z.array(z.number().int().min(1).max(100)).min(1).max(12) }),
          execute: async ({ amounts, quantities }) => {
            if (amounts.length !== quantities.length) return { error: "amounts 与 quantities 长度必须一致" };
            const total = amounts.reduce((sum, amount, index) => sum + amount * quantities[index]!, 0);
            return { totalMinor: total, total };
          },
        }),
        calculate_numbers: tool({
          description: "计算两个数字的加、减、乘、除。用于非购物的简单算术。",
          inputSchema: z.object({
            left: z.number().finite(),
            right: z.number().finite(),
            operation: z.enum(["add", "subtract", "multiply", "divide"]),
          }),
          execute: async ({ left, right, operation }) => {
            if (operation === "divide" && right === 0) return { error: "不能除以零" };
            const result = operation === "add" ? left + right
              : operation === "subtract" ? left - right
                : operation === "multiply" ? left * right
                  : left / right;
            return { result };
          },
        }),
      },
      toolChoice: "auto",
      prepareStep: ({ stepNumber }) => {
        // Reserve the final step for prose. Without this, a tool-happy model can
        // spend the entire bounded loop calling tools and never return an answer.
        if (stepNumber >= router.assistantMaxSteps - 1) return { activeTools: [], toolChoice: "none" as const };
        // Several OpenAI-compatible gateways support tool calls but reject a forced
        // `tool_choice: required`. Limit the available tool for the early steps and
        // make the system instruction explicit; this keeps the loop agentic without
        // turning a provider-specific limitation into a user-visible failure.
        return { toolChoice: "auto" as const };
      },
      stopWhen: stepCountIs(router.assistantMaxSteps),
      maxOutputTokens: router.assistantMaxOutputTokens,
      temperature: router.assistantTemperature,
      timeout: router.assistantTimeoutMs,
      maxRetries: 0,
      providerOptions: { matchplane: { reasoningEffort: router.assistantReasoningEffort } },
    });
    const text = sanitizeAssistantReply(result.text);
    if (!text) throw new Error("模型没有返回最终回答");
    return {
      text,
      model: router.model,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? ((result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)),
      },
      recommendations,
    };
  } catch (error) {
    if (error instanceof PlatformRouterQuotaExceededError) throw error;
    const reason = error instanceof Error ? error.message.slice(0, 160) : "模型服务暂时不可用";
    throw new PlatformAssistantUnavailableError(`商城 AI 导购暂时不可用：${reason}`);
  }
}

export function configuredPlatformRouterProtocol(): PlatformRouterProtocol {
  return configuredPlatformRouter()?.protocol ?? DEFAULT_ROUTER_PROTOCOL;
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
  const router = configuredPlatformRouter();
  const endpoint = router?.endpoint;
  const apiKey = router?.apiKey;
  const model = router?.model ?? null;
  const protocol = router?.protocol ?? DEFAULT_ROUTER_PROTOCOL;
  const startedAt = Date.now();
  if (!router || !endpoint || !apiKey || !model) {
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
    const providerRequest = buildTextProviderRequest({
      endpoint,
      endpointIsBase: router.managed,
      apiKey,
      model,
      protocol,
      systemPrompt: "Respond with one short token.",
      userContent: "healthcheck",
      maxOutputTokens: 8,
      temperature: 0,
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
    function: routerSelectionFunction(candidates, NATIVE_ROUTER_TOOL_NAME),
  };
}

function routerSelectionFunction(
  candidates: PlatformRouteCandidate[],
  name = ROUTER_TOOL_NAME,
): Record<string, unknown> {
  return {
    name,
    description: "从商城已授权的候选店铺中选择可能有相关商品的店铺；不得创造候选之外的 slug。",
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

/** Plain text generation for the shopping-assistant conversation and connection probe. */
function buildTextProviderRequest(input: {
  endpoint: string;
  endpointIsBase: boolean;
  apiKey: string;
  model: string;
  protocol: PlatformRouterProtocol;
  systemPrompt: string;
  userContent: string;
  maxOutputTokens: number;
  temperature: number;
}): ProviderRequest {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (input.protocol === "anthropic-messages") {
    headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: input.endpointIsBase ? `${input.endpoint}/v1/messages` : input.endpoint,
      headers,
      body: {
        model: input.model,
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userContent }],
      },
    };
  }
  if (input.protocol === "gemini-generate-content") {
    headers["x-goog-api-key"] = input.apiKey;
    return {
      url: geminiEndpoint(input.endpoint, input.model, input.endpointIsBase),
      headers,
      body: {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: input.userContent }] }],
        generationConfig: { temperature: input.temperature, maxOutputTokens: input.maxOutputTokens },
      },
    };
  }
  headers.authorization = `Bearer ${input.apiKey}`;
  return {
    url: input.endpointIsBase ? `${input.endpoint}/v1/chat/completions` : input.endpoint,
    headers,
    body: {
      model: input.model,
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      // Reasoning-capable OpenAI-compatible gateways may otherwise spend the full small answer
      // budget on hidden reasoning and return an empty final content field.
      reasoning_effort: "low",
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userContent },
      ],
    },
  };
}

function buildProviderRequest(input: {
  endpoint: string;
  endpointIsBase: boolean;
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
        description: "从商城已授权的候选店铺中选择可能有相关商品的店铺；不得创造候选之外的 slug。",
        input_schema: routerSelectionParameters(input.candidates),
      }];
      if (input.toolMode === "required") body.tool_choice = { type: "tool", name: NATIVE_ROUTER_TOOL_NAME };
    }
    return { url: input.endpointIsBase ? `${input.endpoint}/v1/messages` : input.endpoint, headers, body };
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
    return { url: geminiEndpoint(input.endpoint, input.model, input.endpointIsBase), headers, body };
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
    if (input.toolMode === "required") body.tool_choice = { type: "function", function: { name: NATIVE_ROUTER_TOOL_NAME } };
  }
  return { url: input.endpointIsBase ? `${input.endpoint}/v1/chat/completions` : input.endpoint, headers, body };
}

function geminiRouterFunction(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  const fn = routerSelectionFunction(candidates);
  return {
    name: NATIVE_ROUTER_TOOL_NAME,
    description: fn.description,
    parameters: fn.parameters,
  };
}

function geminiEndpoint(endpoint: string, model: string, endpointIsBase: boolean): string {
  if (endpoint.includes(":generateContent")) return endpoint;
  const base = endpoint.replace(/\/$/, "");
  return endpointIsBase
    ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : `${base}/models/${encodeURIComponent(model)}:generateContent`;
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

function sanitizeAssistantReply(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[手机号]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
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
