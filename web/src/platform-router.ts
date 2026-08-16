/**
 * Provider-neutral AI router for the platform tree.
 *
 * The model is only allowed to choose from the already-authorized candidate
 * set supplied by PostgreSQL. It never receives credentials, organization IDs,
 * or a tool that can call an arbitrary path. If the provider is unavailable,
 * the caller gets an explicit policy-fallback result so the event is auditable.
 */

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
const MAX_ROUTER_INPUT_CHARACTERS = 24_000;
const ROUTER_TOOL_NAME = "matchplane.platform.select_children";

type RouterToolMode = "auto" | "required" | "disabled";

export async function decidePlatformRoutes(input: {
  platformPath: string;
  narrative: string;
  candidates: PlatformRouteCandidate[];
  /** Atomically reserve one provider call immediately before it is made. */
  admitCall?: () => Promise<void>;
}): Promise<PlatformRouteDecision> {
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
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
  if (!endpoint || !apiKey || !model || !isAllowedEndpoint(endpoint)) {
    return policyFallback(candidates, "AI 路由服务未配置，使用受控候选广播降级。", null);
  }

  try {
    await input.admitCall?.();
    const toolMode = configuredToolMode();
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0,
      max_tokens: configuredMaxTokens(),
      messages: [
        {
          role: "system",
          content:
            toolMode === "disabled"
              ? "你是 MatchPlane 平台路由器。只能从候选 slug 中选择与用户目标相关的子平台，不能创造 slug。返回 JSON：selectedSlugs(string[]), rationale(string), confidence(number 0..1)。如果没有合适候选，selectedSlugs 返回空数组。"
              : `你是 MatchPlane 平台路由器。只能从候选 slug 中选择与用户目标相关的子平台，不能创造 slug。优先调用 ${ROUTER_TOOL_NAME} 完成选择；不要调用未声明的工具。`,
        },
        {
          role: "user",
          // Candidate metadata is public routing context, but it is still
          // bounded before it reaches the provider so a tenant cannot make
          // the platform pay for an unbounded prompt.
          content: boundedProviderIntent(input, candidates),
        },
      ],
    };
    if (toolMode === "disabled") {
      requestBody.response_format = { type: "json_object" };
    } else {
      requestBody.tools = [routerSelectionTool(candidates)];
      if (toolMode === "required") {
        requestBody.tool_choice = {
          type: "function",
          function: { name: ROUTER_TOOL_NAME },
        };
      }
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`router provider returned ${response.status}`);
    const payload = await response.json() as unknown;
    const providerDecision = readProviderDecision(payload, candidates);
    return {
      ...providerDecision.decision,
      source: "ai",
      routeMechanism: providerDecision.routeMechanism,
      model,
      degraded: false,
      costBearer: "platform",
      budget: currentBudget(),
      usage: readUsage(payload),
    };
  } catch (error) {
    if (error instanceof PlatformRouterQuotaExceededError) throw error;
    const reason = error instanceof Error ? error.message : "AI 路由服务不可用";
    return policyFallback(candidates, `AI 路由降级：${reason.slice(0, 240)}`, model);
  }
}

/** True when a server-side provider credential is present and the endpoint is allowed. */
export function isPlatformRouterConfigured(): boolean {
  const endpoint = process.env.MATCHPLANE_ROUTER_AI_URL?.trim();
  const apiKey = process.env.MATCHPLANE_ROUTER_AI_KEY?.trim();
  const model = process.env.MATCHPLANE_ROUTER_AI_MODEL?.trim();
  return Boolean(endpoint && apiKey && model && isAllowedEndpoint(endpoint));
}

function policyFallback(
  candidates: PlatformRouteCandidate[],
  rationale: string,
  model: string | null,
): PlatformRouteDecision {
  return {
    selectedSlugs: candidates.map((candidate) => candidate.slug),
    source: "policy_fallback",
    routeMechanism: "policy_fallback",
    model,
    rationale: rationale.slice(0, MAX_RATIONALE_LENGTH),
    confidence: null,
    degraded: true,
    costBearer: "platform",
    budget: currentBudget(),
    usage: null,
  };
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

function readUsage(value: unknown): PlatformRouteUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const promptTokens = finiteNonNegativeInteger(record.prompt_tokens);
  const completionTokens = finiteNonNegativeInteger(record.completion_tokens);
  const totalTokens = finiteNonNegativeInteger(record.total_tokens);
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

function configuredToolMode(): RouterToolMode {
  const value = process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE?.trim().toLowerCase();
  return value === "required" || value === "disabled" ? value : "auto";
}

function routerSelectionTool(candidates: PlatformRouteCandidate[]): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: ROUTER_TOOL_NAME,
      description: "从当前节点已授权的候选子平台中选择下一跳；不得创造候选之外的 slug。",
      strict: true,
      parameters: {
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
      },
    },
  };
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
): {
  decision: Omit<PlatformRouteDecision, "source" | "model" | "degraded" | "costBearer" | "budget" | "usage">;
  routeMechanism: "mcp_tool" | "structured_json";
} {
  const message = readProviderMessage(value);
  const toolCall = readRouterToolCall(message);
  if (toolCall) {
    return {
      decision: normalizeDecision(JSON.parse(toolCall), candidates),
      routeMechanism: "mcp_tool",
    };
  }
  return {
    decision: normalizeDecision(JSON.parse(readProviderContent(value)), candidates),
    routeMechanism: "structured_json",
  };
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
      && (fn as { name?: unknown }).name === ROUTER_TOOL_NAME);
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
    if (url.username || url.password || url.hash) return false;
    if (process.env.NODE_ENV === "production") return url.protocol === "https:";
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}
