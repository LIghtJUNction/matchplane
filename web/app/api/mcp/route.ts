import { NextResponse } from "next/server";

import { POST as matchPlatform } from "../platform/match/route";
import { POST as handoffAgent } from "../platform/agent/handoff/route";

export const runtime = "nodejs";

/**
 * HTTP MCP facade for buyer/seller Agents. Authentication and platform-tree authorization remain
 * in the delegated platform match route; this handler only translates JSON-RPC tool calls.
 */
export async function POST(request: Request): Promise<Response> {
  let message: JsonRpcRequest;
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    message = value as JsonRpcRequest;
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON-RPC request" } }, { status: 400 });
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
  if (!isRecord(params) || (params.name !== "platform.match" && params.name !== "platform.agent.handoff")) {
    return rpcError(id, -32602, "tools/call requires a supported MatchPlane tool");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const isHandoff = params.name === "platform.agent.handoff";
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
    }],
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
