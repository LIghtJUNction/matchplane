export const MATCHPLANE_MCP_PROTOCOL = "2025-03-26" as const;
export const MATCHPLANE_AGENT_PROTOCOL = "matchplane.agent/v1" as const;

/** Deprecated vertical alias. New integrations should use AgentSide. */
export type AgentRole = "buyer" | "seller";
export type AgentSide = "demand" | "supply";
export type AgentStage = "platform" | "merchant" | "inventory";

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
  decide: (context: {
    request: AgentSkillRequest;
    history: readonly AgentSkillToolObservation[];
    remaining_steps: number;
  }) => Promise<AgentSkillDecision>;
  callTool: (context: {
    request: AgentSkillRequest;
    step: number;
    tool: string;
    arguments: Record<string, unknown>;
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
  const validationError = validateAgentSkillRequest(request, options.provider);
  if (validationError) return rejectedSkillResult(request, options.provider, validationError);

  const allowedTools = new Set(request.allowed_mcp_tools);
  const history: AgentSkillToolObservation[] = [];
  const steps: AgentSkillToolStep[] = [];
  const generatedAt = new Date().toISOString();

  for (let step = 1; step <= request.budget.max_steps; step += 1) {
    if (serializedBytes({ request, history }) > request.budget.max_input_characters) {
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "input_budget_exceeded");
    }

    let decision: AgentSkillDecision;
    try {
      decision = await options.decide({
        request,
        history,
        remaining_steps: request.budget.max_steps - step + 1,
      });
    } catch (error) {
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, errorMessage(error));
    }

    if (!isRecord(decision) || (decision.type !== "tool" && decision.type !== "complete" && decision.type !== "reject")) {
      return skillResult(request, options.provider, steps, [], "rejected", true, generatedAt, "Skill decision is invalid");
    }
    if (serializedBytes(decision) > request.budget.max_output_tokens * 4) {
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "output_budget_exceeded");
    }
    if (decision.type === "complete") {
      const selected = normalizeSelectedReferences(decision.selected);
      if (!selected) {
        return skillResult(request, options.provider, steps, [], "rejected", true, generatedAt, "selected references are invalid");
      }
      return skillResult(request, options.provider, steps, selected, "completed", false, generatedAt);
    }
    if (decision.type === "reject") {
      return skillResult(request, options.provider, steps, [], "rejected", true, generatedAt, boundedReason(decision.reason));
    }
    if (!allowedTools.has(decision.tool)) {
      return skillResult(request, options.provider, steps, [], "rejected", true, generatedAt, `tool_not_allowed:${decision.tool}`);
    }
    if (!isRecord(decision.arguments) || serializedBytes(decision.arguments) > request.budget.max_input_characters) {
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "tool_input_budget_exceeded");
    }

    let output: unknown;
    try {
      output = await options.callTool({
        request,
        step,
        tool: decision.tool,
        arguments: decision.arguments,
      });
    } catch (error) {
      const inputDigest = await digestJson(decision.arguments);
      steps.push({ step, tool: decision.tool, status: "failed", input_digest: inputDigest, output_digest: null, reason: boundedReason(errorMessage(error)) });
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "tool_failed");
    }
    if (serializedBytes(output) > request.budget.max_input_characters) {
      const inputDigest = await digestJson(decision.arguments);
      const outputDigest = await digestJson(output);
      steps.push({ step, tool: decision.tool, status: "failed", input_digest: inputDigest, output_digest: outputDigest, reason: "tool_output_budget_exceeded" });
      return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "tool_output_budget_exceeded");
    }

    const inputDigest = await digestJson(decision.arguments);
    const outputDigest = await digestJson(output);
    steps.push({ step, tool: decision.tool, status: "completed", input_digest: inputDigest, output_digest: outputDigest });
    history.push({ step, tool: decision.tool, arguments: decision.arguments, output });
  }

  return skillResult(request, options.provider, steps, [], "degraded", true, generatedAt, "step_budget_exceeded");
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

  async handoff(envelope: AgentHandoff): Promise<AgentHandoffResult> {
    assertCallerBudget(envelope.budget);
    return this.callTool("platform.agent.handoff", envelope) as Promise<AgentHandoffResult>;
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

function validateAgentSkillRequest(request: AgentSkillRequest, provider: AgentSkillProvider): string | null {
  if (request.protocol !== MATCHPLANE_AGENT_PROTOCOL) return "Skill protocol must be matchplane.agent/v1";
  if (!isUuid(request.request_id)) return "Skill request_id must be a UUID";
  if (!isAgentStage(request.stage)) return "Skill stage is invalid";
  if (!isPlatformPath(request.scope?.platform_path)) return "Skill platform_path is invalid";
  if (!request.intent || typeof request.intent.narrative !== "string" || !request.intent.narrative.trim()) {
    return "Skill intent narrative is required";
  }
  if (request.intent.narrative.length > 10_000 || !isRecord(request.intent.requirements)) {
    return "Skill intent is invalid";
  }
  if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(request.skill)) return "Skill name is invalid";
  if (!Array.isArray(request.allowed_mcp_tools) || request.allowed_mcp_tools.length > 64
    || request.allowed_mcp_tools.some((tool) => typeof tool !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(tool))) {
    return "Skill allowed_mcp_tools is invalid";
  }
  if (new Set(request.allowed_mcp_tools).size !== request.allowed_mcp_tools.length) return "Skill allowed_mcp_tools must be unique";
  const budget = request.budget;
  if (!budget || budget.cost_bearer !== "caller") return "Skill budget must be caller-funded";
  if (!Number.isSafeInteger(budget.max_steps) || budget.max_steps < 1 || budget.max_steps > 16
    || !Number.isSafeInteger(budget.max_input_characters) || budget.max_input_characters < 1 || budget.max_input_characters > 24_000
    || !Number.isSafeInteger(budget.max_output_tokens) || budget.max_output_tokens < 64 || budget.max_output_tokens > 2_048) {
    return "Skill budget is outside the bounded protocol limits";
  }
  if (!provider || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(provider.id)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(provider.version)) {
    return "Skill provider metadata is invalid";
  }
  for (const value of [provider.prompt_tokens, provider.completion_tokens, provider.total_tokens]) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      return "Skill provider token usage is invalid";
    }
  }
  return serializedBytes(request) > budget.max_input_characters ? "Skill request exceeds input budget" : null;
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
  request: AgentSkillRequest,
  provider: AgentSkillProvider,
  reason: string,
): AgentSkillResult {
  return skillResult(
    request,
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

function boundedReason(value: string): string {
  return value.trim().slice(0, 500) || "agent skill failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "agent skill callback failed";
}

function isAgentStage(value: unknown): value is AgentStage {
  return value === "platform" || value === "merchant" || value === "inventory";
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
