import { NextResponse } from "next/server";

import { POST as establishAgentSession } from "../marketplace/agent-session/route";
import { POST as matchPlatform } from "../platform/match/route";
import { POST as handoffAgent } from "../platform/agent/handoff/route";
import { hasTrustedBrowserOrigin } from "../../../src/lib/request-origin";
import { readJsonBody, RequestBodyTooLargeError } from "../../../src/lib/body-limit";

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
  const isHandoff = params.name === "platform.agent.handoff";
  if (params.name.startsWith("marketplace.")) return callMarketplaceTool(request, id, params.name, args);
  const forwarded = new Request(new URL(isHandoff ? "/api/platform/agent/handoff" : "/api/platform/match", request.url), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(isHandoff ? args : {
      narrative: args.narrative,
      platformPath: args.platformPath,
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
  } else if (name === "marketplace.introduction.create") {
    path = "/v1/marketplace/introductions";
    body = JSON.stringify(args);
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
    || name === "marketplace.agent.session"
    || name === "marketplace.intent.create"
    || name === "marketplace.offer.create"
    || name === "marketplace.offer.match"
    || name === "marketplace.introduction.create"
    || name === "marketplace.introductions.list";
}

function stringArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolList(): Record<string, unknown> {
  return {
    tools: [{
      name: "platform.match",
      description: "Submit a domain-neutral buyer or seller intent to the authenticated platform tree.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["narrative"],
        properties: {
          narrative: { type: "string", minLength: 1, maxLength: 10000 },
          platformPath: { type: "string", pattern: "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)?$", maxLength: 512 },
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
          stage: { type: "string", enum: ["platform", "merchant", "inventory"] },
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
      description: "Create a seller-owned draft offer; a platform moderator must activate it before matching.",
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
    }],
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
