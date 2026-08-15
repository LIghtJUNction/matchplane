export const MATCHPLANE_MCP_PROTOCOL = "2025-03-26" as const;
export const MATCHPLANE_AGENT_PROTOCOL = "matchplane.agent/v1" as const;

export type AgentRole = "buyer" | "seller";
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
  role: "buyer" | "seller" | "both";
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

export interface MarketplaceIntentInput {
  tenant_id: string;
  domain_id: string;
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
  intent_id: string;
  offer_id: string;
  participant_id: string;
  score: number;
  reasons?: string[];
  idempotency_key: string;
  expires_at: string;
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
    role: AgentRole;
    display_name?: string;
  }): Promise<PartyCapability> {
    const result = await this.callTool("marketplace.agent.session", input);
    return result as PartyCapability;
  }

  async createIntent(capability: PartyCapability, input: MarketplaceIntentInput): Promise<unknown> {
    return this.callTool("marketplace.intent.create", input, capability.access_token);
  }

  async createOffer(capability: PartyCapability, input: MarketplaceOfferInput): Promise<unknown> {
    return this.callTool("marketplace.offer.create", input, capability.access_token);
  }

  async matchOffers(capability: PartyCapability, input: {
    intent_id: string;
    tenant_id: string;
    domain_id: string;
    participant_id: string;
    limit?: number;
  }): Promise<unknown> {
    return this.callTool("marketplace.offer.match", input, capability.access_token);
  }

  async createIntroduction(capability: PartyCapability, input: MarketplaceIntroductionInput): Promise<unknown> {
    return this.callTool("marketplace.introduction.create", input, capability.access_token);
  }

  async listIntroductions(capability: PartyCapability, input: {
    tenant_id: string;
    domain_id: string;
    participant_id: string;
  }): Promise<unknown> {
    return this.callTool("marketplace.introductions.list", input, capability.access_token);
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
