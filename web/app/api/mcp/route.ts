import { NextResponse } from "next/server";

import { POST as matchPlatform } from "../platform/match/route";

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
  if (!isRecord(params) || params.name !== "platform.match") {
    return rpcError(id, -32602, "tools/call requires the platform.match tool");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const forwarded = new Request(new URL("/api/platform/match", request.url), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      narrative: args.narrative,
      platformPath: args.platformPath,
    }),
  });
  const result = await matchPlatform(forwarded);
  const payload = await result.json().catch(() => ({ error: "platform match returned invalid JSON" }));
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
