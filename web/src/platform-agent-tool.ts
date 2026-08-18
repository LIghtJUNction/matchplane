import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { authDatabase } from "./lib/auth";
import { runtimeEnvironment } from "./lib/runtime";

/**
 * Server-side configuration and transport for a subplatform-owned MCP server.
 *
 * A package may advertise tool names, but it never chooses the URL or a secret. Operators bind
 * the package's stable server key to an endpoint in the restricted web-service environment. This
 * keeps registration declarative while making the actual network trust boundary explicit.
 */

const SERVER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface SubplatformMcpEndpoint {
  serverKey: string;
  url: string;
  bearerToken: string | null;
  timeoutMs: number;
}

export interface SubplatformMcpCallResult {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

export interface SubplatformMcpProbeResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Resolve a server key from operator-owned JSON configuration.
 *
 * Supported shape:
 * {
 *   "used-car": {
 *     "url": "https://agent.example/mcp",
 *     "tokenEnv": "MATCHPLANE_USED_CAR_MCP_TOKEN"
 *   }
 * }
 *
 * A direct token is intentionally not accepted. Secret managers should populate the named
 * environment variable or replace this resolver at deployment time.
 */
export function readSubplatformMcpEndpoint(
  serverKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): SubplatformMcpEndpoint | null {
  if (!SERVER_KEY_PATTERN.test(serverKey)) return null;
  const raw = environment.MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON?.trim();
  if (!raw || raw.length > 256 * 1024) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const entry = parsed[serverKey];
  return readEndpointEntry(serverKey, entry, environment);
}

/**
 * Resolve a server endpoint from the durable federation binding first, then retain the explicit
 * environment map for package-local MCP services. A database failure never turns into an
 * arbitrary URL lookup: the environment fallback is still independently validated.
 */
export async function resolveSubplatformMcpEndpoint(
  serverKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SubplatformMcpEndpoint | null> {
  return resolveSubplatformMcpEndpointInternal(serverKey, environment, false);
}

/**
 * Resolve a non-revoked binding for an explicit health probe. This must never be used by the
 * routing/tool path: a pending or degraded node is intentionally not routable until health makes
 * it active again.
 */
export async function resolveSubplatformMcpEndpointForHealth(
  serverKey: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SubplatformMcpEndpoint | null> {
  return resolveSubplatformMcpEndpointInternal(serverKey, environment, true);
}

async function resolveSubplatformMcpEndpointInternal(
  serverKey: string,
  environment: NodeJS.ProcessEnv,
  allowNonActiveForHealth: boolean,
): Promise<SubplatformMcpEndpoint | null> {
  if (!SERVER_KEY_PATTERN.test(serverKey)) return null;
  const rootTenantId = environment.MATCHPLANE_ROOT_TENANT_ID?.trim();
  if (rootTenantId && isUuid(rootTenantId)) {
    try {
      const result = await authDatabase.query<{ url: string; tokenEnv: string | null; status: string }>(
        `SELECT endpoint AS url, token_env AS "tokenEnv", status
           FROM platform_federation_bindings
          WHERE tenant_id = $1::uuid AND mcp_server_key = $2
            AND ${allowNonActiveForHealth ? "status <> 'revoked'" : "status = 'active'"}
          LIMIT 1`,
        [rootTenantId, serverKey],
      );
      const binding = result.rows[0];
      if (binding) {
        if (!allowNonActiveForHealth && binding.status !== "active") return null;
        const endpoint = readEndpointEntry(serverKey, {
          url: binding.url,
          ...(binding.tokenEnv ? { tokenEnv: binding.tokenEnv } : {}),
        }, environment);
        return endpoint && await hasSafeResolvedAddresses(endpoint.url, environment) ? endpoint : null;
      }
    } catch {
      // Fresh installations may not have applied the federation migration yet. The explicit
      // operator environment map remains a safe compatibility path until then.
    }
  }
  const endpoint = readSubplatformMcpEndpoint(serverKey, environment);
  return endpoint && await hasSafeResolvedAddresses(endpoint.url, environment) ? endpoint : null;
}

/**
 * Validate a binding URL before it is marked active. Production DNS names are resolved and any
 * private/reserved answer fails closed. The network egress policy remains the final SSRF control;
 * this check prevents a normal public hostname from being accepted when it currently points at
 * loopback, RFC1918, link-local, metadata, multicast or other non-global space.
 */
export async function validateSubplatformMcpEndpointUrl(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const normalized = normalizeEndpointUrl(value, runtimeEnvironment(environment));
  return normalized ? hasSafeResolvedAddresses(normalized, environment) : false;
}

function readEndpointEntry(
  serverKey: string,
  entry: unknown,
  environment: NodeJS.ProcessEnv,
): SubplatformMcpEndpoint | null {
  if (!isRecord(entry) || typeof entry.url !== "string") return null;
  const url = normalizeEndpointUrl(entry.url, runtimeEnvironment(environment));
  if (!url) return null;

  let bearerToken: string | null = null;
  if (entry.tokenEnv !== undefined) {
    if (typeof entry.tokenEnv !== "string" || !ENV_NAME_PATTERN.test(entry.tokenEnv)) return null;
    const value = environment[entry.tokenEnv]?.trim();
    if (!value || value.length > 8_192) return null;
    bearerToken = value;
  }

  const timeoutMs = readTimeout(environment.MATCHPLANE_SUBPLATFORM_MCP_TIMEOUT_MS);
  return { serverKey, url, bearerToken, timeoutMs };
}

/** Invoke one remote MCP tool without forwarding caller credentials. */
export async function invokeSubplatformMcpTool(input: {
  endpoint: SubplatformMcpEndpoint;
  toolName: string;
  arguments: Record<string, unknown>;
  requestId: string;
  platformPath: string;
  actorSubject: string;
  fetcher?: typeof fetch;
}): Promise<SubplatformMcpCallResult> {
  const fetcher = input.fetcher ?? fetch;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "x-matchplane-platform-path": input.platformPath,
    "x-matchplane-request-id": input.requestId,
    "x-matchplane-agent-subject": input.actorSubject,
  });
  if (input.endpoint.bearerToken) headers.set("authorization", `Bearer ${input.endpoint.bearerToken}`);

  let response: Response;
  try {
    response = await fetcher(input.endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.requestId,
        method: "tools/call",
        params: { name: input.toolName, arguments: input.arguments },
      }),
      signal: AbortSignal.timeout(input.endpoint.timeoutMs),
      // The endpoint was validated before routing. Do not let a reachable public
      // endpoint redirect this server-side client into an unvalidated private host.
      redirect: "error",
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      payload: { error: safeTransportError(error) },
    };
  }

  const body = await readJsonResponse(response);
  if (!body.ok) return body;
  return {
    ok: response.ok && !hasMcpError(body.payload),
    status: response.status,
    payload: body.payload,
  };
}

/** Probe a remote MCP endpoint without invoking a domain tool or exposing caller identity. */
export async function probeSubplatformMcpEndpoint(input: {
  endpoint: SubplatformMcpEndpoint;
  fetcher?: typeof fetch;
}): Promise<SubplatformMcpProbeResult> {
  const fetcher = input.fetcher ?? fetch;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (input.endpoint.bearerToken) headers.set("authorization", `Bearer ${input.endpoint.bearerToken}`);
  try {
    const response = await fetcher(input.endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "matchplane-health",
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "matchplane", version: "1" } },
      }),
      signal: AbortSignal.timeout(input.endpoint.timeoutMs),
      redirect: "error",
      cache: "no-store",
    });
    const body = await readJsonResponse(response);
    if (!response.ok || !body.ok || "error" in body.payload) {
      return { ok: false, status: response.status, error: "远端 MCP initialize 未成功" };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: 502, error: safeTransportError(error) };
  }
}

function hasMcpError(payload: Record<string, unknown>): boolean {
  if ("error" in payload) return true;
  const result = payload.result;
  return isRecord(result) && result.isError === true;
}

function normalizeEndpointUrl(value: string, environment: string | undefined): string | null {
  if (value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (environment === "production" && isPrivateIpLiteral(url.hostname)) return null;
    if (environment === "production") {
      if (url.protocol !== "https:") return null;
    } else if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function hasSafeResolvedAddresses(value: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (runtimeEnvironment(environment) !== "production") return true;
  try {
    const hostname = new URL(value).hostname;
    if (isIP(hostname.replace(/^\[|\]$/g, ""))) return !isPrivateIpLiteral(hostname);
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.length > 0 && answers.every((answer) => !isPrivateIpLiteral(answer.address));
  } catch {
    return false;
  }
}

function readTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isSafeInteger(parsed) ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, parsed)) : DEFAULT_TIMEOUT_MS;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isPrivateIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const parts = normalized.split(".").map(Number);
    const [first, second, third] = parts;
    return first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 192 && second === 2)
      || (first === 192 && second === 88 && third === 99)
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51)
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  }
  if (version === 6) {
    if (normalized.startsWith("::ffff:")) return isPrivateIpLiteral(normalized.slice(7));
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized);
  }
  return false;
}

async function readJsonResponse(response: Response): Promise<SubplatformMcpCallResult> {
  try {
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return { ok: false, status: 502, payload: { error: "subplatform MCP response exceeds 256 KiB" } };
    }
    if (!response.body) {
      return { ok: false, status: 502, payload: { error: "subplatform MCP response has no body" } };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { ok: false, status: 502, payload: { error: "subplatform MCP response exceeds 256 KiB" } };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const payloadText = contentType.includes("text/event-stream") ? lastSseData(text) : text;
    const payload = JSON.parse(payloadText) as unknown;
    if (!isRecord(payload)) {
      return { ok: false, status: 502, payload: { error: "subplatform MCP response must be a JSON object" } };
    }
    return { ok: true, status: response.status, payload };
  } catch {
    return { ok: false, status: 502, payload: { error: "subplatform MCP response was not valid JSON" } };
  }
}

function lastSseData(value: string): string {
  const messages = value
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()))
    .filter((line) => line && line !== "[DONE]");
  return messages.at(-1) ?? "";
}

function safeTransportError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "subplatform MCP request timed out";
  if (error instanceof Error && error.name === "AbortError") return "subplatform MCP request timed out";
  return "subplatform MCP endpoint is unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
