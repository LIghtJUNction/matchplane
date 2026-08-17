export const MATCHPLANE_MCP_PROTOCOL = "2025-03-26" as const;
export const MATCHPLANE_AGENT_PROTOCOL = "matchplane.agent/v1" as const;

/** Deprecated vertical alias. New integrations should use AgentSide. */
export type AgentRole = "buyer" | "seller";
export type AgentSide = "demand" | "supply";
/** Stage names are owned by the mounted domain; the root treats them as opaque taxonomy keys. */
export type AgentStage = string;

export interface MatchPlaneAgentClientOptions {
  /** The public origin, for example `https://matx.tech`; never put this client in browser code. */
  baseUrl: string;
  /** A Better Auth organization API key. Keep it in the Agent's server-side secret store. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface PartyCapability {
  tenant_id: string;
  domain_id: string;
  party_id: string;
  /** Kernel capability side. Vertical labels are not required by the contract. */
  side: AgentSide;
  /** Deprecated compatibility projection returned by older gateways. */
  role?: "buyer" | "seller" | "both";
  access_token: string;
  access_token_expires_at: string;
  platform_path: string;
  cost_bearer: "caller";
}

export interface AgentHandoff {
  protocol: typeof MATCHPLANE_AGENT_PROTOCOL;
  request_id: string;
  stage: AgentStage;
  scope: { platform_path: string };
  intent: { narrative: string; requirements: Record<string, unknown> };
  agent: { id: string; version: string; capabilities: string[] };
  budget: {
    max_steps: number;
    max_input_characters: number;
    max_output_tokens: number;
    cost_bearer: "caller";
  };
  selected_refs?: string[];
}

export interface AgentHandoffResult {
  protocol: typeof MATCHPLANE_AGENT_PROTOCOL;
  requestId: string;
  stage: AgentStage;
  status: "accepted" | "completed" | "expired" | "rejected" | string;
  costBearer: "caller";
  platformPath: string;
  expiresAt: string;
  budget: AgentHandoff["budget"];
  next: {
    mcpPath: string;
    manifestPath: string;
    directChildren: Array<{
      slug: string;
      path: string;
      displayName: string;
      description: string;
      capabilities: string[];
      agentStages: string[];
      agentSkills: string[];
      mcpTools: string[];
    }>;
  };
}

/**
 * The caller-funded Skill envelope is intentionally provider-neutral.  A buyer or seller Agent
 * can use the same runner for every mounted platform; only the advertised Skill and MCP tool
 * names change.  The runner never receives a MatchPlane provider credential and never changes
 * the platform's authorization boundary.
 */
export interface AgentSkillRequest {
  protocol: typeof MATCHPLANE_AGENT_PROTOCOL;
  request_id: string;
  stage: AgentStage;
  scope: { platform_path: string };
  intent: { narrative: string; requirements: Record<string, unknown> };
  skill: string;
  allowed_mcp_tools: string[];
  budget: {
    max_steps: number;
    max_input_characters: number;
    max_output_tokens: number;
    cost_bearer: "caller";
  };
  trace_id?: string | null;
}

export interface AgentSkillProvider {
  id: string;
  version: string;
  model?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

export interface AgentSkillSelectedReference {
  ref: string;
  score: number;
  reasons: string[];
}

export interface AgentSkillToolStep {
  step: number;
  tool: string;
  status: "completed" | "skipped" | "failed";
  input_digest?: string | null;
  output_digest?: string | null;
  reason?: string | null;
}

export interface AgentSkillResult {
  protocol: typeof MATCHPLANE_AGENT_PROTOCOL;
  request_id: string;
  stage: AgentStage;
  status: "completed" | "degraded" | "rejected";
  steps: AgentSkillToolStep[];
  selected: AgentSkillSelectedReference[];
  provider: AgentSkillProvider;
  budget: AgentSkillRequest["budget"];
  degraded: boolean;
  generated_at: string;
  reason?: string;
}

export type AgentSkillDecision =
  | { type: "tool"; tool: string; arguments: Record<string, unknown> }
  | { type: "complete"; selected: AgentSkillSelectedReference[] }
  | { type: "reject"; reason: string };

export interface AgentSkillToolObservation {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  output: unknown;
}

export interface AgentSkillRunnerOptions {
  provider: AgentSkillProvider;
  /** Optional caller-controlled cancellation signal. */
  signal?: AbortSignal;
  /** Optional wall-clock deadline for the whole Skill, bounded to 5 minutes. */
  timeout_ms?: number;
  decide: (context: {
    request: AgentSkillRequest;
    history: readonly AgentSkillToolObservation[];
    remaining_steps: number;
    signal: AbortSignal;
  }) => Promise<AgentSkillDecision>;
  callTool: (context: {
    request: AgentSkillRequest;
    step: number;
    tool: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

/**
 * Execute a multi-step Skill locally under the caller's declared budget.
 *
 * This is deliberately a small orchestration primitive rather than an LLM client: the caller
 * supplies `decide` (its own model/provider) and `callTool` (its own MCP transport).  The helper
 * enforces the stable protocol, allowed-tool set, step limit, bounded serialized context and
 * caller-funded cost bearer before any tool is invoked.  It is therefore safe to use for both
 * demand and supply Agents without making the MatchPlane deployment pay for their tokens.
 */
export async function runBoundedAgentSkill(
  request: AgentSkillRequest,
  options: AgentSkillRunnerOptions,
): Promise<AgentSkillResult> {
  const rawRequest: unknown = request;
  const rawOptions: unknown = options;
  const rawProvider = isRecord(rawOptions) ? rawOptions.provider : undefined;
  const safeProvider = normalizeProvider(rawProvider);
  const validationError = validateAgentSkillRequest(rawRequest, rawProvider)
    ?? validateRunnerOptions(rawOptions);
  if (validationError) return rejectedSkillResult(rawRequest, safeProvider, validationError);

  const boundedRequest = snapshotAgentSkillRequest(rawRequest as AgentSkillRequest);
  const runnerOptions = rawOptions as AgentSkillRunnerOptions;
  const maxSteps = boundedRequest.budget.max_steps;
  const allowedTools = new Set(boundedRequest.allowed_mcp_tools);
  const history: AgentSkillToolObservation[] = [];
  const steps: AgentSkillToolStep[] = [];
  const generatedAt = new Date().toISOString();
  const deadline = createDeadlineSignal(runnerOptions.signal, runnerOptions.timeout_ms);

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      if (deadline.signal.aborted) {
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, deadline.reason());
      }
      if (serializedBytes({ request: boundedRequest, history }) > boundedRequest.budget.max_input_characters) {
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "input_budget_exceeded");
      }

      let decision: AgentSkillDecision;
      try {
        decision = await awaitWithSignal(runnerOptions.decide({
          request: boundedRequest,
          history: snapshotHistory(history),
          remaining_steps: maxSteps - step + 1,
          signal: deadline.signal,
        }), deadline.signal);
      } catch (error) {
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt,
          deadline.signal.aborted ? deadline.reason() : errorMessage(error));
      }

      if (!isRecord(decision) || (decision.type !== "tool" && decision.type !== "complete" && decision.type !== "reject")) {
        return skillResult(boundedRequest, safeProvider, steps, [], "rejected", true, generatedAt, "Skill decision is invalid");
      }
      if (serializedBytes(decision) > boundedRequest.budget.max_output_tokens * 4) {
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "output_budget_exceeded");
      }
      if (decision.type === "complete") {
        const selected = normalizeSelectedReferences(decision.selected);
        if (!selected) {
          return skillResult(boundedRequest, safeProvider, steps, [], "rejected", true, generatedAt, "selected references are invalid");
        }
        return skillResult(boundedRequest, safeProvider, steps, selected, "completed", false, generatedAt);
      }
      if (decision.type === "reject") {
        return skillResult(boundedRequest, safeProvider, steps, [], "rejected", true, generatedAt, boundedReason(decision.reason));
      }
      if (!allowedTools.has(decision.tool)) {
        return skillResult(boundedRequest, safeProvider, steps, [], "rejected", true, generatedAt, `tool_not_allowed:${decision.tool}`);
      }
      if (!isRecord(decision.arguments) || serializedBytes(decision.arguments) > boundedRequest.budget.max_input_characters) {
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "tool_input_budget_exceeded");
      }

      let output: unknown;
      try {
        output = await awaitWithSignal(runnerOptions.callTool({
          request: boundedRequest,
          step,
          tool: decision.tool,
          arguments: decision.arguments,
          signal: deadline.signal,
        }), deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) {
          return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, deadline.reason());
        }
        const inputDigest = await digestJson(decision.arguments);
        steps.push({ step, tool: decision.tool, status: "failed", input_digest: inputDigest, output_digest: null, reason: boundedReason(errorMessage(error)) });
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "tool_failed");
      }
      if (serializedBytes(output) > boundedRequest.budget.max_input_characters) {
        const inputDigest = await digestJson(decision.arguments);
        const outputDigest = await digestJson(output);
        steps.push({ step, tool: decision.tool, status: "failed", input_digest: inputDigest, output_digest: outputDigest, reason: "tool_output_budget_exceeded" });
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "tool_output_budget_exceeded");
      }
      if (isRecord(output) && output.isError === true) {
        const inputDigest = await digestJson(decision.arguments);
        const outputDigest = await digestJson(output);
        steps.push({ step, tool: decision.tool, status: "failed", input_digest: inputDigest, output_digest: outputDigest, reason: boundedReason(extractErrorMessage(output.structuredContent)) });
        return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "tool_failed");
      }

      const inputDigest = await digestJson(decision.arguments);
      const outputDigest = await digestJson(output);
      steps.push({ step, tool: decision.tool, status: "completed", input_digest: inputDigest, output_digest: outputDigest });
      history.push({ step, tool: decision.tool, arguments: snapshotRecord(decision.arguments), output: snapshotValue(output) });
    }
    return skillResult(boundedRequest, safeProvider, steps, [], "degraded", true, generatedAt, "step_budget_exceeded");
  } finally {
    deadline.dispose();
  }
}

export interface MarketplaceIntentInput {
  tenant_id: string;
  domain_id: string;
  /** Overwritten with the capability's path before the request is sent. */
  platform_path?: string;
  participant_id: string;
  side: "demand" | "supply";
  narrative: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  idempotency_key: string;
  expires_at?: string | null;
}

export interface MarketplaceOfferInput {
  tenant_id: string;
  domain_id: string;
  /** Overwritten with the capability's path before the request is sent. */
  platform_path?: string;
  supply_party_id: string;
  asset_id?: string | null;
  external_key: string;
  display_name: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  expires_at?: string | null;
}

export interface MarketplaceIntroductionInput {
  tenant_id: string;
  domain_id: string;
  /** Overwritten with the capability's path before the request is sent. */
  platform_path?: string;
  intent_id: string;
  offer_id: string;
  participant_id: string;
  score: number;
  reasons?: string[];
  idempotency_key: string;
  expires_at: string;
}

export interface MarketplaceContactActionInput {
  tenant_id: string;
  domain_id: string;
  platform_path?: string;
  introduction_id: string;
  participant_id: string;
  idempotency_key: string;
}

/** Input for the platform-tree router. The hosted routing model is paid by MatchPlane. */
export interface PlatformMatchInput {
  narrative: string;
  platform_path?: string;
  idempotency_key?: string;
}

/** Stable projection returned by the `platform.match` MCP tool. */
export interface PlatformMatchResult {
  requestId: string;
  platformPath: string;
  status: string;
  routePlan: unknown[];
  routing: unknown;
  [key: string]: unknown;
}

/**
 * Extract the authorized child paths returned by `platform.match`. `platformPath` is the node
 * where the request started (often `/`); callers must not mistake it for the selected child.
 */
export function routePlanPaths(result: PlatformMatchResult): string[] {
  if (!Array.isArray(result.routePlan)) return [];
  return result.routePlan.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string") return [];
    return isPlatformPath(item.path) ? [item.path] : [];
  });
}

/** Return only leaf paths from a recursive route plan; these are the nodes that own the next
 * marketplace/tool lookup. Multiple leaves are possible and should be queried independently. */
export function terminalRoutePlanPaths(result: PlatformMatchResult): string[] {
  const paths = routePlanPaths(result);
  return paths.filter((path) => !paths.some((other) => other !== path && other.startsWith(`${path}/`)));
}

export interface RetrievalQueryInput {
  tenant_id: string;
  domain_id: string;
  platform_path: string;
  narrative: string;
  requirements?: Record<string, unknown>;
  budget_min?: string | null;
  budget_max?: string | null;
  currency?: string | null;
  currency_scale?: number | null;
  limit?: number;
  request_id?: string;
  trace_id?: string | null;
}

export interface RetrievalCandidate {
  asset_id: string;
  offer_id?: string;
  display_name?: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  score: number;
  reasons: string[];
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  protocol: "matchplane.retrieval/v1";
  request_id: string;
  provider: {
    id: string;
    version: string;
    model?: string | null;
  };
  candidates: RetrievalCandidate[];
  degraded: boolean;
  generated_at?: string | null;
}

export class MatchPlaneMcpError extends Error {
  readonly code: number;
  readonly details: unknown;

  constructor(code: number, message: string, details?: unknown) {
    super(message);
    this.name = "MatchPlaneMcpError";
    this.code = code;
    this.details = details;
  }
}

export class MatchPlaneAgentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MatchPlaneAgentClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("MatchPlane API key is required");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async initialize(): Promise<Record<string, unknown>> {
    return this.callRpc("initialize", undefined, undefined) as Promise<Record<string, unknown>>;
  }

  async listTools(): Promise<Record<string, unknown>> {
    return this.callRpc("tools/list", undefined, undefined) as Promise<Record<string, unknown>>;
  }

  /** Route a natural-language request through the mounted platform tree. */
  async routePlatformIntent(input: PlatformMatchInput): Promise<PlatformMatchResult> {
    if (typeof input.narrative !== "string" || !input.narrative.trim()) {
      throw new Error("platform.match narrative is required");
    }
    return this.callTool("platform.match", {
      narrative: input.narrative,
      ...(input.platform_path ? { platformPath: input.platform_path } : {}),
      ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
    }) as Promise<PlatformMatchResult>;
  }

  async handoff(envelope: AgentHandoff): Promise<AgentHandoffResult> {
    assertCallerBudget(envelope.budget);
    return this.callTool("platform.agent.handoff", envelope) as Promise<AgentHandoffResult>;
  }

  /** Invoke one manifest-allowlisted tool owned by an active child platform. */
  async callChildTool(input: {
    platform_path: string;
    tool_name: string;
    arguments?: Record<string, unknown>;
    request_id?: string;
  }): Promise<unknown> {
    if (!isChildPlatformPath(input.platform_path)) {
      throw new Error("platform.child.tool platform_path must identify a child platform");
    }
    if (typeof input.tool_name !== "string" || !TOOL_NAME_PATTERN.test(input.tool_name)) {
      throw new Error("platform.child.tool tool_name is invalid");
    }
    if (input.arguments !== undefined && !isRecord(input.arguments)) {
      throw new Error("platform.child.tool arguments must be an object");
    }
    if (input.request_id !== undefined && !isBoundedString(input.request_id, 200)) {
      throw new Error("platform.child.tool request_id is invalid");
    }
    return this.callTool("platform.child.tool", {
      platform_path: input.platform_path,
      tool_name: input.tool_name,
      arguments: input.arguments ?? {},
      ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
    });
  }

  /** Query a child-owned retrieval adapter through the stable matchplane.retrieval/v1 envelope. */
  async queryRetrieval(input: RetrievalQueryInput): Promise<RetrievalResult> {
    const requestId = input.request_id ?? crypto.randomUUID();
    validateRetrievalQueryInput(input, requestId);
    const envelope = {
      protocol: "matchplane.retrieval/v1",
      request_id: requestId,
      scope: {
        tenant_id: input.tenant_id,
        domain_id: input.domain_id,
        platform_path: input.platform_path,
      },
      input: {
        narrative: input.narrative.trim(),
        requirements: input.requirements ?? {},
        ...(input.budget_min === undefined ? {} : { budget_min: input.budget_min }),
        ...(input.budget_max === undefined ? {} : { budget_max: input.budget_max }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(input.currency_scale === undefined ? {} : { currency_scale: input.currency_scale }),
      },
      limit: input.limit ?? 20,
      ...(input.trace_id === undefined ? {} : { trace_id: input.trace_id }),
    };
    const response = await this.fetchImpl(`${this.baseUrl}/api/platform/retrieval/query`, {
      method: "POST",
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "x-matchplane-api-key": this.apiKey,
      }),
      body: JSON.stringify(envelope),
    });
    const raw = await response.json().catch(() => null) as unknown;
    if (!response.ok || !isRecord(raw)) {
      throw new MatchPlaneMcpError(response.status || 502, "MatchPlane retrieval request failed", raw);
    }
    return parseRetrievalResult(raw, requestId, input.limit ?? 20);
  }

  async openMarketplaceSession(input: {
    tenant_id: string;
    domain_id: string;
    platform_path: string;
    /** Canonical kernel capability side. Required for new clients. */
    side: AgentSide;
    /** Deprecated compatibility alias; use side. */
    role?: AgentRole;
    display_name?: string;
  }): Promise<PartyCapability> {
    const side = input.side;
    if (input.role && ((input.role === "buyer" && side !== "demand") || (input.role === "seller" && side !== "supply"))) {
      throw new Error("MatchPlane marketplace session side and deprecated role disagree");
    }
    const result = await this.callTool("marketplace.agent.session", { ...input, side });
    const capability = result as Partial<PartyCapability>;
    return {
      ...capability,
      side,
      platform_path: typeof capability.platform_path === "string"
        ? capability.platform_path
        : input.platform_path,
    } as PartyCapability;
  }

  async createIntent(capability: PartyCapability, input: MarketplaceIntentInput): Promise<unknown> {
    return this.callTool("marketplace.intent.create", this.scope(capability, input), capability.access_token);
  }

  async createOffer(capability: PartyCapability, input: MarketplaceOfferInput): Promise<unknown> {
    return this.callTool("marketplace.offer.create", this.scope(capability, input), capability.access_token);
  }

  async matchOffers(capability: PartyCapability, input: {
    intent_id: string;
    tenant_id: string;
    domain_id: string;
    platform_path?: string;
    participant_id: string;
    limit?: number;
  }): Promise<unknown> {
    return this.callTool("marketplace.offer.match", this.scope(capability, input), capability.access_token);
  }

  async createIntroduction(capability: PartyCapability, input: MarketplaceIntroductionInput): Promise<unknown> {
    return this.callTool("marketplace.introduction.create", this.scope(capability, input), capability.access_token);
  }

  async listIntroductions(capability: PartyCapability, input: {
    tenant_id: string;
    domain_id: string;
    platform_path?: string;
    participant_id: string;
  }): Promise<unknown> {
    return this.callTool("marketplace.introductions.list", this.scope(capability, input), capability.access_token);
  }

  /** Open the explicit contact-consent step; this never returns contact values. */
  async requestContact(capability: PartyCapability, input: MarketplaceContactActionInput): Promise<unknown> {
    return this.callTool("marketplace.introduction.contact.request", this.scope(capability, input), capability.access_token);
  }

  /** Record the supply participant's explicit consent; this never returns contact values. */
  async consentContact(capability: PartyCapability, input: MarketplaceContactActionInput): Promise<unknown> {
    return this.callTool("marketplace.introduction.contact.consent", this.scope(capability, input), capability.access_token);
  }

  /** Retrieve the counterpart contact only after the platform consent policy allows release. */
  async releaseContact(capability: PartyCapability, input: MarketplaceContactActionInput): Promise<unknown> {
    return this.callTool("marketplace.introduction.contact.release", this.scope(capability, input), capability.access_token);
  }

  private scope<T extends { platform_path?: string }>(
    capability: PartyCapability,
    input: T,
  ): T & { platform_path: string } {
    return { ...input, platform_path: capability.platform_path };
  }

  private async callTool(name: string, args: unknown, partyToken?: string): Promise<unknown> {
    return this.callRpc("tools/call", { name, arguments: args }, partyToken);
  }

  private async callRpc(method: string, params: unknown, partyToken?: string): Promise<unknown> {
    const id = crypto.randomUUID();
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      "x-matchplane-api-key": this.apiKey,
    });
    if (partyToken) headers.set("authorization", `Bearer ${partyToken}`);
    const response = await this.fetchImpl(`${this.baseUrl}/api/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    });
    const payload = await response.json().catch(() => null) as JsonRpcResponse | null;
    if (!response.ok || !payload) {
      throw new MatchPlaneMcpError(response.status || 502, "MatchPlane MCP request failed", payload);
    }
    if (payload.error) throw new MatchPlaneMcpError(payload.error.code, payload.error.message, payload.error.data);
    const result = payload.result;
    if (!result || typeof result !== "object") {
      throw new MatchPlaneMcpError(-32000, "MatchPlane MCP returned no result", payload);
    }
    const record = result as Record<string, unknown>;
    if (record.isError === true) {
      const structured = record.structuredContent;
      throw new MatchPlaneMcpError(-32001, extractErrorMessage(structured), structured);
    }
    return record.structuredContent ?? result;
  }
}

function validateAgentSkillRequest(request: unknown, provider: unknown): string | null {
  if (!isRecord(request)) return "Skill request must be an object";
  if (request.protocol !== MATCHPLANE_AGENT_PROTOCOL) return "Skill protocol must be matchplane.agent/v1";
  if (!isUuid(request.request_id)) return "Skill request_id must be a UUID";
  if (!isAgentStage(request.stage)) return "Skill stage is invalid";
  if (!isRecord(request.scope) || !isPlatformPath(request.scope.platform_path)) return "Skill platform_path is invalid";
  if (!isRecord(request.intent) || typeof request.intent.narrative !== "string" || !request.intent.narrative.trim()) {
    return "Skill intent narrative is required";
  }
  if (request.intent.narrative.length > 10_000 || !isRecord(request.intent.requirements)) {
    return "Skill intent is invalid";
  }
  if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(String(request.skill))) return "Skill name is invalid";
  if (!Array.isArray(request.allowed_mcp_tools) || request.allowed_mcp_tools.length > 64
    || request.allowed_mcp_tools.some((tool) => typeof tool !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(tool))) {
    return "Skill allowed_mcp_tools is invalid";
  }
  if (new Set(request.allowed_mcp_tools).size !== request.allowed_mcp_tools.length) return "Skill allowed_mcp_tools must be unique";
  if (request.trace_id !== undefined && request.trace_id !== null
    && (typeof request.trace_id !== "string" || request.trace_id.length > 200)) {
    return "Skill trace_id is invalid";
  }
  const budget = request.budget;
  if (!isBoundedBudget(budget)) return "Skill budget must be caller-funded and bounded";
  if (!isRecord(provider) || typeof provider.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(provider.id)
    || typeof provider.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(provider.version)) {
    return "Skill provider metadata is invalid";
  }
  if (provider.model !== undefined && provider.model !== null
    && (typeof provider.model !== "string" || provider.model.length > 200)) {
    return "Skill provider model is invalid";
  }
  for (const value of [provider.prompt_tokens, provider.completion_tokens, provider.total_tokens]) {
    if (value !== undefined && value !== null && (!isSafeInteger(value) || value < 0)) {
      return "Skill provider token usage is invalid";
    }
  }
  return serializedBytes(request) > budget.max_input_characters ? "Skill request exceeds input budget" : null;
}

function validateRunnerOptions(options: unknown): string | null {
  if (!isRecord(options) || typeof options.decide !== "function" || typeof options.callTool !== "function") {
    return "Skill runner callbacks are required";
  }
  if (options.timeout_ms !== undefined
    && (!isSafeInteger(options.timeout_ms) || options.timeout_ms < 1 || options.timeout_ms > 300_000)) {
    return "Skill timeout_ms is outside the bounded limits";
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) return "Skill signal is invalid";
  return null;
}

function normalizeProvider(value: unknown): AgentSkillProvider {
  if (!isRecord(value)) return { id: "unknown", version: "0" };
  const id = typeof value.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.id)
    ? value.id.slice(0, 128)
    : "unknown";
  const version = typeof value.version === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(value.version)
    ? value.version.slice(0, 128)
    : "0";
  const promptTokens = isSafeInteger(value.prompt_tokens) && value.prompt_tokens >= 0 ? value.prompt_tokens : undefined;
  const completionTokens = isSafeInteger(value.completion_tokens) && value.completion_tokens >= 0 ? value.completion_tokens : undefined;
  const totalTokens = isSafeInteger(value.total_tokens) && value.total_tokens >= 0 ? value.total_tokens : undefined;
  return {
    id,
    version,
    ...(typeof value.model === "string" || value.model === null ? { model: typeof value.model === "string" ? value.model.slice(0, 200) : null } : {}),
    ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
    ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
    ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
  };
}

function isBoundedBudget(value: unknown): value is AgentSkillRequest["budget"] {
  if (!isRecord(value) || value.cost_bearer !== "caller") return false;
  return isSafeInteger(value.max_steps) && value.max_steps >= 1 && value.max_steps <= 16
    && isSafeInteger(value.max_input_characters) && value.max_input_characters >= 1 && value.max_input_characters <= 24_000
    && isSafeInteger(value.max_output_tokens) && value.max_output_tokens >= 64 && value.max_output_tokens <= 2_048;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function snapshotAgentSkillRequest(request: AgentSkillRequest): AgentSkillRequest {
  const snapshot: AgentSkillRequest = {
    protocol: MATCHPLANE_AGENT_PROTOCOL,
    request_id: request.request_id,
    stage: request.stage,
    scope: { platform_path: request.scope.platform_path },
    intent: {
      narrative: request.intent.narrative,
      requirements: snapshotRecord(request.intent.requirements),
    },
    skill: request.skill,
    allowed_mcp_tools: [...request.allowed_mcp_tools],
    budget: { ...request.budget },
    ...(request.trace_id === undefined ? {} : { trace_id: request.trace_id }),
  };
  return deepFreeze(snapshot);
}

function skillResult(
  request: AgentSkillRequest,
  provider: AgentSkillProvider,
  steps: AgentSkillToolStep[],
  selected: AgentSkillSelectedReference[],
  status: AgentSkillResult["status"],
  degraded: boolean,
  generatedAt: string,
  reason?: string,
): AgentSkillResult {
  return {
    protocol: MATCHPLANE_AGENT_PROTOCOL,
    request_id: request.request_id,
    stage: request.stage,
    status,
    steps,
    selected,
    provider,
    budget: request.budget,
    degraded,
    generated_at: generatedAt,
    ...(reason ? { reason: boundedReason(reason) } : {}),
  };
}

function rejectedSkillResult(
  request: unknown,
  provider: AgentSkillProvider,
  reason: string,
): AgentSkillResult {
  const record = isRecord(request) ? request : {};
  const requestId = isUuid(record.request_id) ? record.request_id : "00000000-0000-4000-8000-000000000000";
  const stage = isAgentStage(record.stage) ? record.stage : "platform";
  const budget = isBoundedBudget(record.budget)
    ? { ...record.budget }
    : { max_steps: 1, max_input_characters: 1, max_output_tokens: 64, cost_bearer: "caller" as const };
  return skillResult(
    { protocol: MATCHPLANE_AGENT_PROTOCOL, request_id: requestId, stage, scope: { platform_path: "/" }, intent: { narrative: "", requirements: {} }, skill: "invalid", allowed_mcp_tools: [], budget },
    provider,
    [],
    [],
    "rejected",
    true,
    new Date().toISOString(),
    reason,
  );
}

function normalizeSelectedReferences(value: unknown): AgentSkillSelectedReference[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const selected: AgentSkillSelectedReference[] = [];
  const refs = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.ref !== "string" || item.ref.length < 1 || item.ref.length > 256
      || refs.has(item.ref) || typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < -1 || item.score > 1
      || !Array.isArray(item.reasons) || item.reasons.length > 32
      || item.reasons.some((reason) => typeof reason !== "string" || !reason.trim() || reason.length > 500)) {
      return null;
    }
    refs.add(item.ref);
    selected.push({ ref: item.ref, score: item.score, reasons: [...item.reasons] as string[] });
  }
  return selected;
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return new TextEncoder().encode(serialized === undefined ? "null" : serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function digestJson(value: unknown): Promise<string | null> {
  try {
    const serialized = JSON.stringify(value);
    const bytes = new TextEncoder().encode(serialized === undefined ? "null" : serialized);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function boundedReason(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) || "agent skill failed" : "agent skill failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "agent skill callback failed";
}

function isAgentStage(value: unknown): value is AgentStage {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{1,127}$/.test(value);
}

const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;

function isChildPlatformPath(value: unknown): value is string {
  return isPlatformPath(value) && value !== "/";
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function validateRetrievalQueryInput(input: RetrievalQueryInput, requestId: string): void {
  if (!isUuid(input.tenant_id) || !isUuid(input.domain_id)) {
    throw new Error("retrieval scope tenant_id and domain_id must be UUIDs");
  }
  if (!isChildPlatformPath(input.platform_path)) {
    throw new Error("retrieval platform_path must identify a child platform");
  }
  if (!isUuid(requestId)) throw new Error("retrieval request_id must be a UUID");
  if (!isBoundedString(input.narrative, 10_000)) throw new Error("retrieval narrative is required");
  if (input.requirements !== undefined && !isRecord(input.requirements)) {
    throw new Error("retrieval requirements must be an object");
  }
  if (serializedBytes(input.requirements ?? {}) > 32 * 1024) {
    throw new Error("retrieval requirements exceed 32 KiB");
  }
  for (const [name, value] of [["budget_min", input.budget_min], ["budget_max", input.budget_max]] as const) {
    if (value !== undefined && value !== null && !isBoundedString(value, 200)) {
      throw new Error(`retrieval ${name} is invalid`);
    }
  }
  if (input.currency !== undefined && input.currency !== null && !/^[A-Z]{3}$/.test(input.currency)) {
    throw new Error("retrieval currency must be an ISO-4217 code");
  }
  if (input.currency_scale !== undefined && input.currency_scale !== null
    && (!isSafeInteger(input.currency_scale) || input.currency_scale < 0 || input.currency_scale > 18)) {
    throw new Error("retrieval currency_scale must be between 0 and 18");
  }
  const limit = input.limit ?? 20;
  if (!isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("retrieval limit must be between 1 and 100");
  if (input.trace_id !== undefined && input.trace_id !== null && !isBoundedString(input.trace_id, 200)) {
    throw new Error("retrieval trace_id is invalid");
  }
}

function parseRetrievalResult(raw: unknown, requestId: string, limit: number): RetrievalResult {
  const value = extractRetrievalPayload(raw);
  if (!isRecord(value) || value.protocol !== "matchplane.retrieval/v1" || value.request_id !== requestId) {
    throw new Error("retrieval provider returned an invalid protocol envelope");
  }
  const provider = value.provider;
  if (!isRecord(provider) || !isBoundedString(provider.id, 128) || !isBoundedString(provider.version, 128)) {
    throw new Error("retrieval provider metadata is invalid");
  }
  if (provider.model !== undefined && provider.model !== null && !isBoundedString(provider.model, 200)) {
    throw new Error("retrieval provider model is invalid");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > Math.min(100, limit)) {
    throw new Error("retrieval candidates exceed the requested limit");
  }
  const candidates = value.candidates.map((candidate, index) => parseRetrievalCandidate(candidate, index));
  if (typeof value.degraded !== "boolean") throw new Error("retrieval degraded must be boolean");
  if (value.generated_at !== undefined && value.generated_at !== null
    && (!isBoundedString(value.generated_at, 80) || !Number.isFinite(Date.parse(value.generated_at)))) {
    throw new Error("retrieval generated_at is invalid");
  }
  return {
    protocol: "matchplane.retrieval/v1",
    request_id: requestId,
    provider: {
      id: provider.id,
      version: provider.version,
      ...(provider.model === undefined ? {} : { model: provider.model as string | null }),
    },
    candidates,
    degraded: value.degraded,
    ...(value.generated_at === undefined ? {} : { generated_at: value.generated_at as string | null }),
  };
}

function parseRetrievalCandidate(value: unknown, index: number): RetrievalCandidate {
  if (!isRecord(value) || !isUuid(value.asset_id)) throw new Error(`retrieval candidate ${index} asset_id is invalid`);
  if (value.offer_id !== undefined && !isUuid(value.offer_id)) throw new Error(`retrieval candidate ${index} offer_id is invalid`);
  if (value.display_name !== undefined && !isBoundedString(value.display_name, 500)) throw new Error(`retrieval candidate ${index} display_name is invalid`);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < -1 || value.score > 1) throw new Error(`retrieval candidate ${index} score is invalid`);
  if (!Array.isArray(value.reasons) || value.reasons.length > 32
    || value.reasons.some((reason) => !isBoundedString(reason, 500) || !reason.trim())) throw new Error(`retrieval candidate ${index} reasons are invalid`);
  for (const field of ["attributes", "terms", "metadata"] as const) {
    if (value[field] !== undefined && (!isRecord(value[field]) || serializedBytes(value[field]) > 32 * 1024)) {
      throw new Error(`retrieval candidate ${index} ${field} is invalid`);
    }
  }
  const attributes = value.attributes === undefined ? undefined : value.attributes as Record<string, unknown>;
  const terms = value.terms === undefined ? undefined : value.terms as Record<string, unknown>;
  const metadata = value.metadata === undefined ? undefined : value.metadata as Record<string, unknown>;
  return {
    asset_id: value.asset_id,
    ...(value.offer_id === undefined ? {} : { offer_id: value.offer_id }),
    ...(value.display_name === undefined ? {} : { display_name: value.display_name }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(terms === undefined ? {} : { terms }),
    score: value.score,
    reasons: [...value.reasons] as string[],
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function extractRetrievalPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const result = isRecord(raw.result) ? raw.result : raw;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // Continue through human-readable MCP content blocks.
      }
    }
  }
  return raw;
}

function isPlatformPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512 && /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  dispose: () => void;
  reason: () => string;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(parent?.reason ?? new Error("skill_cancelled"));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("skill_timeout"));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    reason: () => timedOut ? "skill_timeout" : "skill_cancelled",
  };
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("skill_cancelled");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new Error("skill_cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function snapshotHistory(history: readonly AgentSkillToolObservation[]): readonly AgentSkillToolObservation[] {
  return deepFreeze(history.map((entry) => ({
    step: entry.step,
    tool: entry.tool,
    arguments: snapshotRecord(entry.arguments),
    output: snapshotValue(entry.output),
  })));
}

function snapshotRecord(value: Record<string, unknown>): Record<string, unknown> {
  return snapshotValue(value) as Record<string, unknown>;
}

function snapshotValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized === undefined ? "null" : serialized) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) throw new Error("MatchPlane baseUrl is required");
  const parsed = new URL(trimmed);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("MatchPlane baseUrl must be an origin without credentials or a path");
  }
  const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (runtimeProcess?.env?.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("MatchPlane baseUrl must use HTTPS in production");
  }
  return parsed.origin;
}

function assertCallerBudget(budget: AgentHandoff["budget"]): void {
  if (budget.cost_bearer !== "caller"
    || !Number.isSafeInteger(budget.max_steps) || budget.max_steps < 1 || budget.max_steps > 16
    || !Number.isSafeInteger(budget.max_input_characters) || budget.max_input_characters < 1 || budget.max_input_characters > 24_000
    || !Number.isSafeInteger(budget.max_output_tokens) || budget.max_output_tokens < 64 || budget.max_output_tokens > 2_048) {
    throw new Error("external Agent budget must be bounded and caller-funded");
  }
}

function extractErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return "MatchPlane MCP tool failed";
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
