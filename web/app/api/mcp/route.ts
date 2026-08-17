import { NextResponse } from "next/server";

import { POST as establishAgentSession } from "../marketplace/agent-session/route";
import { POST as matchPlatform } from "../platform/match/route";
import { POST as handoffAgent } from "../platform/agent/handoff/route";
import { hasTrustedBrowserOrigin } from "../../../src/lib/request-origin";
import { readJsonBody, RequestBodyTooLargeError } from "../../../src/lib/body-limit";
import { validateMcpToolArguments } from "../../../src/mcp-contract";
import { executeAuthenticatedChildTool } from "../../../src/platform-child-tool";

export const runtime = "nodejs";

/**
 * HTTP MCP facade for buyer/seller Agents. Authentication and platform-tree authorization remain
 * in the delegated platform match route; this handler only translates JSON-RPC tool calls.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "请求来源未被平台信任" } }, { status: 403 });
  }
  let message: JsonRpcRequest;
  try {
    const value = await readJsonBody<unknown>(request, 256 * 1024);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    message = value as JsonRpcRequest;
  } catch (error) {
    const tooLarge = error instanceof RequestBodyTooLargeError;
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: tooLarge ? -32013 : -32700, message: tooLarge ? "JSON-RPC request exceeds 256 KiB" : "invalid JSON-RPC request" } }, { status: tooLarge ? 413 : 400 });
  }

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.method) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "invalid JSON-RPC request" } },
      { status: 400 },
    );
  }

  if (message.id === undefined) return new Response(null, { status: 202 });
  switch (message.method) {
    case "initialize":
      return rpcSuccess(message.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "matchplane-platform", version: "v1" },
      });
    case "tools/list":
      return rpcSuccess(message.id, toolList());
    case "tools/call":
      return callTool(request, message.id, message.params);
    default:
      return rpcError(message.id, -32601, `method not found: ${message.method}`);
  }
}

async function callTool(request: Request, id: JsonRpcId, params: unknown): Promise<Response> {
  if (!isRecord(params) || !supportedTool(params.name)) {
    return rpcError(id, -32602, "tools/call requires a supported MatchPlane tool");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const argumentError = validateMcpToolArguments(params.name, args);
  if (argumentError) return rpcError(id, -32602, argumentError);
  const isHandoff = params.name === "platform.agent.handoff";
  if (params.name === "platform.child.tool") return callChildTool(request, id, args);
  if (params.name.startsWith("marketplace.")) return callMarketplaceTool(request, id, params.name, args);
  const forwarded = new Request(new URL(isHandoff ? "/api/platform/agent/handoff" : "/api/platform/match", request.url), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(isHandoff ? args : {
      narrative: args.narrative,
      platformPath: args.platformPath,
      idempotencyKey: args.idempotency_key,
    }),
  });
  const result = await (isHandoff ? handoffAgent(forwarded) : matchPlatform(forwarded));
  const payload = await result.json().catch(() => ({ error: "platform tool returned invalid JSON" }));
  const content = [{ type: "text", text: JSON.stringify(payload) }];
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result: {
      content,
      isError: !result.ok,
      structuredContent: payload,
    },
  }, { status: 200, headers: { "cache-control": "no-store" } });
}

/**
 * Invoke a tool owned by one active child node. The root only performs authorization, allowlist
 * checking and bounded transport; the child MCP server owns retrieval/catalog semantics.
 */
async function callChildTool(
  request: Request,
  id: JsonRpcId,
  args: Record<string, unknown>,
): Promise<Response> {
  const platformPath = typeof args.platform_path === "string" ? args.platform_path : "";
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  const toolArguments = isRecord(args.arguments) ? args.arguments : {};
  const result = await executeAuthenticatedChildTool({
    request,
    platformPath,
    toolName,
    arguments: toolArguments,
    requestId: typeof args.request_id === "string" ? args.request_id : undefined,
    allowSession: false,
  });
  if (result.status === 401) {
    const message = typeof result.payload.error === "string"
      ? result.payload.error
      : "Better Auth session or agent:tool API key is required";
    return rpcError(id, -32002, message);
  }
  return rpcToolResponse(id, result.payload, !result.ok, result.status);
}

/**
 * Forward the domain-neutral Rust marketplace contract without making the web layer own a
 * vertical schema.  The caller supplies the short-lived party capability in Authorization;
 * the gateway remains the authority for tenant scope, role checks, idempotency and consent.
 */
async function callMarketplaceTool(
  request: Request,
  id: JsonRpcId,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const gateway = (process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  let path: string;
  let method = "POST";
  let body: string | undefined;
  if (name === "marketplace.agent.session") {
    path = "/api/marketplace/agent-session";
    body = JSON.stringify({
      tenantId: args.tenant_id,
      domainId: args.domain_id,
      platformPath: args.platform_path,
      side: args.side,
      role: args.role,
      displayName: args.display_name,
    });
  } else if (name === "marketplace.intent.create") {
    path = "/v1/marketplace/intents";
    body = JSON.stringify(args);
  } else if (name === "marketplace.offer.create") {
    path = "/v1/marketplace/offers";
    body = JSON.stringify(args);
  } else if (name === "marketplace.offer.match") {
    const intentId = stringArgument(args, "intent_id");
    if (!intentId) return rpcError(id, -32602, "marketplace.offer.match requires intent_id");
    path = `/v1/marketplace/intents/${encodeURIComponent(intentId)}/matches`;
    body = JSON.stringify(args);
  } else if (name === "marketplace.demand.match") {
    const offerId = stringArgument(args, "offer_id");
    if (!offerId) return rpcError(id, -32602, "marketplace.demand.match requires offer_id");
    path = `/v1/marketplace/offers/${encodeURIComponent(offerId)}/demand-matches`;
    body = JSON.stringify(args);
  } else if (name === "marketplace.intent.discovery.update") {
    const intentId = stringArgument(args, "intent_id");
    if (!intentId) return rpcError(id, -32602, "marketplace.intent.discovery.update requires intent_id");
    method = "PATCH";
    path = `/v1/marketplace/intents/${encodeURIComponent(intentId)}/discovery`;
    body = JSON.stringify(args);
  } else if (name === "marketplace.introduction.create") {
    path = "/v1/marketplace/introductions";
    body = JSON.stringify(args);
  } else if (name === "marketplace.introduction.contact.request" || name === "marketplace.introduction.contact.consent") {
    const introductionId = stringArgument(args, "introduction_id");
    const tenantId = stringArgument(args, "tenant_id");
    const domainId = stringArgument(args, "domain_id");
    const participantId = stringArgument(args, "participant_id");
    const idempotencyKey = stringArgument(args, "idempotency_key");
    if (!introductionId || !tenantId || !domainId || !participantId || !idempotencyKey) {
      return rpcError(id, -32602, `${name} requires introduction_id, tenant_id, domain_id, participant_id, and idempotency_key`);
    }
    path = `/v1/marketplace/introductions/${encodeURIComponent(introductionId)}/${name.endsWith("request") ? "contact/request" : "contact/consent"}`;
    body = JSON.stringify({ tenant_id: tenantId, domain_id: domainId, participant_id: participantId, idempotency_key: idempotencyKey });
  } else if (name === "marketplace.introduction.contact.release") {
    const introductionId = stringArgument(args, "introduction_id");
    const tenantId = stringArgument(args, "tenant_id");
    const domainId = stringArgument(args, "domain_id");
    const participantId = stringArgument(args, "participant_id");
    const idempotencyKey = stringArgument(args, "idempotency_key");
    if (!introductionId || !tenantId || !domainId || !participantId || !idempotencyKey) {
      return rpcError(id, -32602, `${name} requires introduction_id, tenant_id, domain_id, participant_id, and idempotency_key`);
    }
    method = "POST";
    path = `/v1/marketplace/introductions/${encodeURIComponent(introductionId)}/contact`;
    body = JSON.stringify({ tenant_id: tenantId, domain_id: domainId, participant_id: participantId, idempotency_key: idempotencyKey });
  } else {
    method = "GET";
    const tenantId = stringArgument(args, "tenant_id");
    const domainId = stringArgument(args, "domain_id");
    const participantId = stringArgument(args, "participant_id");
    if (!tenantId || !domainId || !participantId) {
      return rpcError(id, -32602, "marketplace.introductions.list requires tenant_id, domain_id, and participant_id");
    }
    path = `/v1/marketplace/introductions?tenant_id=${encodeURIComponent(tenantId)}&domain_id=${encodeURIComponent(domainId)}&participant_id=${encodeURIComponent(participantId)}`;
  }
  const platformPath = stringArgument(args, "platform_path");
  if (!platformPath) {
    return rpcError(id, -32602, `${name} requires platform_path so the capability stays node-scoped`);
  }

  const headers = new Headers({ accept: "application/json" });
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  for (const key of ["x-matchplane-api-key", "x-api-key"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const requestId = request.headers.get("x-request-id");
  if (requestId) headers.set("x-request-id", requestId);
  headers.set("x-matchplane-platform-path", platformPath);
  if (body) headers.set("content-type", "application/json");
  let result: Response;
  try {
    if (name === "marketplace.agent.session") {
      result = await establishAgentSession(new Request(new URL(path, request.url), {
        method,
        headers,
        body,
      }));
    } else {
      result = await fetch(`${gateway}${path}`, { method, headers, body, cache: "no-store" });
    }
  } catch {
    return rpcError(id, -32003, "marketplace gateway is unavailable");
  }
  const payload = await result.json().catch(() => ({ error: "marketplace tool returned invalid JSON" }));
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: !result.ok,
      structuredContent: payload,
    },
  }, { status: 200, headers: { "cache-control": "no-store" } });
}

function supportedTool(name: unknown): name is string {
  return name === "platform.match"
    || name === "platform.agent.handoff"
    || name === "platform.child.tool"
    || name === "marketplace.agent.session"
    || name === "marketplace.intent.create"
    || name === "marketplace.offer.create"
    || name === "marketplace.offer.match"
    || name === "marketplace.demand.match"
    || name === "marketplace.intent.discovery.update"
    || name === "marketplace.introduction.create"
    || name === "marketplace.introductions.list"
    || name === "marketplace.introduction.contact.request"
    || name === "marketplace.introduction.contact.consent"
    || name === "marketplace.introduction.contact.release";
}

function stringArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rpcToolResponse(
  id: JsonRpcId,
  payload: Record<string, unknown>,
  isError: boolean,
  status = 200,
): Response {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError,
      structuredContent: payload,
    },
  }, { status: 200, headers: { "cache-control": "no-store", "x-matchplane-upstream-status": String(status) } });
}

function rpcToolError(id: JsonRpcId, status: number, message: string): Response {
  return rpcToolResponse(id, { error: message }, true, status);
}

function toolList(): Record<string, unknown> {
  return {
    tools: [{
      name: "platform.match",
      description: "Submit a domain-neutral demand or supply intent to the authenticated platform tree.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["narrative"],
        properties: {
          narrative: { type: "string", minLength: 1, maxLength: 10000 },
          platformPath: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          idempotency_key: { type: "string", minLength: 1, maxLength: 240, description: "Optional retry key; replays return the original routing result without another hosted model call." },
        },
      },
    }, {
      name: "platform.agent.handoff",
      description: "Register a bounded caller-funded Agent handoff without invoking the platform model.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["protocol", "request_id", "stage", "scope", "intent", "agent", "budget"],
        properties: {
          protocol: { const: "matchplane.agent/v1" },
          request_id: { type: "string", format: "uuid" },
          stage: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]{1,127}$", description: "Domain-owned stage taxonomy key." },
          scope: {
            type: "object",
            additionalProperties: false,
            required: ["platform_path"],
            properties: {
              platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
            },
          },
          intent: {
            type: "object",
            additionalProperties: false,
            required: ["narrative", "requirements"],
            properties: {
              narrative: { type: "string", minLength: 1, maxLength: 10000 },
              requirements: { type: "object" },
            },
          },
          agent: {
            type: "object",
            additionalProperties: false,
            required: ["id", "version", "capabilities"],
            properties: {
              id: { type: "string", maxLength: 128 },
              version: { type: "string", maxLength: 128 },
              capabilities: { type: "array", maxItems: 64, items: { type: "string" } },
            },
          },
          budget: {
            type: "object",
            additionalProperties: false,
            required: ["max_steps", "max_input_characters", "max_output_tokens", "cost_bearer"],
            properties: {
              max_steps: { type: "integer", minimum: 1, maximum: 16 },
              max_input_characters: { type: "integer", minimum: 1, maximum: 24000 },
              max_output_tokens: { type: "integer", minimum: 64, maximum: 2048 },
              cost_bearer: { const: "caller" },
            },
          },
          selected_refs: { type: "array", maxItems: 100, items: { type: "string", maxLength: 256 } },
        },
      },
    }, {
      name: "platform.child.tool",
      description: "Call one MCP tool declared by an active child platform through its operator-configured endpoint.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["platform_path", "tool_name", "arguments"],
        properties: {
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)$", maxLength: 512 },
          tool_name: { type: "string", pattern: "^[a-z0-9][a-z0-9._:-]{1,127}$", maxLength: 128 },
          arguments: { type: "object", maxProperties: 256 },
          request_id: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    }, {
      name: "marketplace.agent.session",
      description: "Exchange a scoped Better Auth organization API key for a caller-funded demand/supply marketplace capability.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "domain_id", "platform_path", "side"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          side: { type: "string", enum: ["demand", "supply"] },
          role: { type: "string", enum: ["buyer", "seller"], description: "Deprecated compatibility alias; use side." },
          display_name: { type: "string", maxLength: 200 },
        },
      },
    }, {
      name: "marketplace.intent.create",
      description: "Create a domain-neutral demand or supply intent using the caller's party capability.",
      inputSchema: marketplaceIntentSchema(),
    }, {
      name: "marketplace.offer.create",
      description: "Create a supply-owned draft offer; a platform moderator must activate it before matching.",
      inputSchema: marketplaceOfferSchema(),
    }, {
      name: "marketplace.offer.match",
      description: "Match an authenticated demand intent against active offers using the subplatform's canonical attributes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intent_id", "tenant_id", "domain_id", "platform_path", "participant_id"],
        properties: {
          intent_id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          participant_id: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    }, {
      name: "marketplace.demand.match",
      description: "Rank demand summaries that explicitly opted into supply discovery against one active supply offer. Results never include participant IDs or contact values.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["offer_id", "tenant_id", "domain_id", "platform_path", "participant_id"],
        properties: {
          offer_id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          participant_id: { type: "string", format: "uuid" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    }, {
      name: "marketplace.intent.discovery.update",
      description: "Enable or revoke anonymous supply-side discovery for a demand intent owned by the caller.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intent_id", "tenant_id", "domain_id", "platform_path", "participant_id", "enabled"],
        properties: {
          intent_id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          participant_id: { type: "string", format: "uuid" },
          enabled: { type: "boolean" },
          expires_at: { type: ["string", "null"], format: "date-time" },
        },
      },
    }, {
      name: "marketplace.introduction.create",
      description: "Create a consent-gated introduction from one demand intent to one selected offer; no contact is released.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "domain_id", "platform_path", "intent_id", "offer_id", "participant_id", "score", "idempotency_key", "expires_at"],
        properties: {
          introduction_id: { type: "string", format: "uuid" },
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          intent_id: { type: "string", format: "uuid" },
          offer_id: { type: "string", format: "uuid" },
          participant_id: { type: "string", format: "uuid" },
          score: { type: "number", minimum: 0, maximum: 1 },
          reasons: { type: "array", maxItems: 24, items: { type: "string", maxLength: 500 } },
          idempotency_key: { type: "string", minLength: 1, maxLength: 240 },
          expires_at: { type: "string", format: "date-time" },
        },
      },
    }, {
      name: "marketplace.introductions.list",
      description: "List introductions visible to the authenticated demand or supply party without exposing contact values.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenant_id", "domain_id", "platform_path", "participant_id"],
        properties: {
          tenant_id: { type: "string", format: "uuid" },
          domain_id: { type: "string", format: "uuid" },
          platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
          participant_id: { type: "string", format: "uuid" },
        },
      },
    }, {
      name: "marketplace.introduction.contact.request",
      description: "Open the explicit contact-consent step for a matched demand participant without returning contact values.",
      inputSchema: contactActionSchema(),
    }, {
      name: "marketplace.introduction.contact.consent",
      description: "Record supply consent for a matched introduction without returning contact values.",
      inputSchema: contactActionSchema(),
    }, {
      name: "marketplace.introduction.contact.release",
      description: "Return the counterpart's protected contact only after the consent policy permits release.",
      inputSchema: contactActionSchema(),
    }],
  };
}

function contactActionSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tenant_id", "domain_id", "platform_path", "participant_id", "introduction_id", "idempotency_key"],
    properties: {
      tenant_id: { type: "string", format: "uuid" },
      domain_id: { type: "string", format: "uuid" },
      platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
      participant_id: { type: "string", format: "uuid" },
      introduction_id: { type: "string", format: "uuid" },
      idempotency_key: { type: "string", minLength: 1, maxLength: 240 },
    },
  };
}

function marketplaceIntentSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tenant_id", "domain_id", "platform_path", "participant_id", "side", "narrative", "idempotency_key"],
    properties: {
      intent_id: { type: "string", format: "uuid" },
      tenant_id: { type: "string", format: "uuid" },
      domain_id: { type: "string", format: "uuid" },
      platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
      participant_id: { type: "string", format: "uuid" },
      side: { type: "string", enum: ["demand", "supply"] },
      narrative: { type: "string", minLength: 1, maxLength: 10000 },
      attributes: { type: "object" },
      terms: { type: "object" },
      supply_discovery_enabled: { type: "boolean", description: "Explicitly allow a contact-free summary of this demand to be ranked by supply Agents." },
      supply_discovery_expires_at: { type: ["string", "null"], format: "date-time" },
      idempotency_key: { type: "string", minLength: 1, maxLength: 240 },
      expires_at: { type: ["string", "null"], format: "date-time" },
    },
  };
}

function marketplaceOfferSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tenant_id", "domain_id", "platform_path", "supply_party_id", "external_key", "display_name"],
    properties: {
      offer_id: { type: "string", format: "uuid" },
      tenant_id: { type: "string", format: "uuid" },
      domain_id: { type: "string", format: "uuid" },
      platform_path: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
      supply_party_id: { type: "string", format: "uuid" },
      asset_id: { type: ["string", "null"], format: "uuid" },
      external_key: { type: "string", minLength: 1, maxLength: 256 },
      display_name: { type: "string", minLength: 1, maxLength: 500 },
      attributes: { type: "object" },
      terms: { type: "object" },
      expires_at: { type: ["string", "null"], format: "date-time" },
    },
  };
}

function rpcSuccess(id: JsonRpcId, result: unknown): Response {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: 200 });
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
