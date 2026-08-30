import { authDatabase } from "./lib/auth";
import { fetchPinnedPublicText } from "./lib/pinned-public-endpoint";
import {
  hasOnlyPublicAddresses,
  isPrivateOrReservedIpLiteral,
} from "./lib/public-endpoint";
import { isProductionEnvironment, runtimeEnvironment } from "./lib/runtime";
import { isUuid } from "./lib/uuid";

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
 *   "store-a": {
 *     "url": "https://agent.example/mcp",
 *     "tokenEnv": "MATCHPLANE_STORE_A_MCP_TOKEN"
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
      const result = await authDatabase.query<{
        url: string;
        tokenEnv: string | null;
        status: string;
      }>(
        `SELECT endpoint AS url, token_env AS "tokenEnv", status
           FROM platform_federation_bindings
          WHERE tenant_id = $1::uuid AND mcp_server_key = $2
            AND ${allowNonActiveForHealth ? "status <> 'revoked'" : "status = 'active'"}
          LIMIT 1`,
        [rootTenantId, serverKey],
      );
      const binding = result.rows[0];
      if (binding) {
        if (!allowNonActiveForHealth && binding.status !== "active")
          return null;
        const endpoint = readEndpointEntry(
          serverKey,
          {
            url: binding.url,
            ...(binding.tokenEnv ? { tokenEnv: binding.tokenEnv } : {}),
          },
          environment,
        );
        return endpoint &&
          (await hasSafeResolvedAddresses(endpoint.url, environment))
          ? endpoint
          : null;
      }
    } catch {
      // Fresh installations may not have applied the federation migration yet. The explicit
      // operator environment map remains a safe compatibility path until then.
    }
  }
  const endpoint = readSubplatformMcpEndpoint(serverKey, environment);
  return endpoint && (await hasSafeResolvedAddresses(endpoint.url, environment))
    ? endpoint
    : null;
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
  const normalized = normalizeEndpointUrl(
    value,
    runtimeEnvironment(environment),
  );
  return normalized ? hasSafeResolvedAddresses(normalized, environment) : false;
}

/**
 * Build and validate an endpoint from a pending federation binding before its token_env has
 * been persisted. Activation uses this short-lived candidate to run the production MCP
 * initialize gate without first making an unprobed binding routable.
 */
export async function prepareSubplatformMcpEndpoint(input: {
  serverKey: string;
  url: string;
  tokenEnv?: string | null;
  environment?: NodeJS.ProcessEnv;
}): Promise<SubplatformMcpEndpoint | null> {
  const environment = input.environment ?? process.env;
  const endpoint = readEndpointEntry(
    input.serverKey,
    {
      url: input.url,
      ...(input.tokenEnv ? { tokenEnv: input.tokenEnv } : {}),
    },
    environment,
  );
  if (!endpoint || !(await hasSafeResolvedAddresses(endpoint.url, environment)))
    return null;
  return endpoint;
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
    if (
      typeof entry.tokenEnv !== "string" ||
      !ENV_NAME_PATTERN.test(entry.tokenEnv)
    )
      return null;
    const value = environment[entry.tokenEnv]?.trim();
    if (!value || value.length > 8_192) return null;
    bearerToken = value;
  }

  const timeoutMs = readTimeout(
    environment.MATCHPLANE_SUBPLATFORM_MCP_TIMEOUT_MS,
  );
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
  const fetcher = input.fetcher;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "x-matchplane-platform-path": input.platformPath,
    "x-matchplane-request-id": input.requestId,
    "x-matchplane-agent-subject": input.actorSubject,
  });
  if (input.endpoint.bearerToken)
    headers.set("authorization", `Bearer ${input.endpoint.bearerToken}`);

  let response: Response;
  let responseText: string | undefined;
  try {
    ({ response, text: responseText } = await postMcpRequest({
      endpoint: input.endpoint,
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.requestId,
        method: "tools/call",
        params: { name: input.toolName, arguments: input.arguments },
      }),
      fetcher,
    }));
  } catch (error) {
    return {
      ok: false,
      status: 502,
      payload: { error: safeTransportError(error) },
    };
  }

  const body = await readJsonResponse(response, responseText);
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
  const fetcher = input.fetcher;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (input.endpoint.bearerToken)
    headers.set("authorization", `Bearer ${input.endpoint.bearerToken}`);
  try {
    const { response, text } = await postMcpRequest({
      endpoint: input.endpoint,
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "matchplane-health",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "matchplane", version: "1" },
        },
      }),
      fetcher,
    });
    const body = await readJsonResponse(response, text);
    const result = body.payload.result;
    if (
      !response.ok ||
      !body.ok ||
      "error" in body.payload ||
      !isRecord(result) ||
      result.isError === true
    ) {
      return {
        ok: false,
        status: response.status,
        error: "远端 MCP initialize 未成功",
      };
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

function normalizeEndpointUrl(
  value: string,
  environment: string | undefined,
): string | null {
  if (value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return null;
    if (
      environment === "production" &&
      isPrivateOrReservedIpLiteral(url.hostname)
    )
      return null;
    if (environment === "production") {
      if (url.protocol !== "https:") return null;
    } else if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function hasSafeResolvedAddresses(
  value: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (
    runtimeEnvironment(environment) !== "production" ||
    hasOnlyPublicAddresses(value)
  );
}

function readTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, parsed))
    : DEFAULT_TIMEOUT_MS;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

async function postMcpRequest(input: {
  endpoint: SubplatformMcpEndpoint;
  headers: Headers;
  body: string;
  fetcher?: typeof fetch;
}): Promise<{ response: Response; text?: string }> {
  const deadline = AbortSignal.timeout(input.endpoint.timeoutMs);
  if (input.fetcher) {
    if (!isExplicitTestEnvironment()) {
      throw new Error("subplatform MCP test transport is disabled");
    }
    const response = await input.fetcher(input.endpoint.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: deadline,
      redirect: "error",
      cache: "no-store",
    });
    return { response };
  }

  let url: URL;
  try {
    url = new URL(input.endpoint.url);
  } catch {
    throw new Error("subplatform MCP endpoint is invalid");
  }
  return fetchPinnedPublicText(url, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    signal: deadline,
    requestTimeoutMs: input.endpoint.timeoutMs,
    responseBodyTimeoutMs: input.endpoint.timeoutMs,
    responseLimitBytes: MAX_RESPONSE_BYTES,
    allowLoopback:
      !isProductionEnvironment() && isLoopback(url.hostname.toLowerCase()),
  });
}

function isExplicitTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" && runtimeEnvironment() !== "production"
  );
}

async function readJsonResponse(
  response: Response,
  boundedText?: string,
): Promise<SubplatformMcpCallResult> {
  try {
    if (boundedText !== undefined) {
      return parseJsonResponseText(response, boundedText);
    }
    const declaredLength = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );
    if (
      Number.isSafeInteger(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
      return {
        ok: false,
        status: 502,
        payload: { error: "subplatform MCP response exceeds 256 KiB" },
      };
    }
    if (!response.body) {
      return {
        ok: false,
        status: 502,
        payload: { error: "subplatform MCP response has no body" },
      };
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
          return {
            ok: false,
            status: 502,
            payload: { error: "subplatform MCP response exceeds 256 KiB" },
          };
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
    return parseJsonResponseText(response, new TextDecoder().decode(bytes));
  } catch {
    return {
      ok: false,
      status: 502,
      payload: { error: "subplatform MCP response was not valid JSON" },
    };
  }
}

function parseJsonResponseText(
  response: Response,
  text: string,
): SubplatformMcpCallResult {
  const contentType =
    response.headers.get("content-type")?.toLowerCase() ?? "";
  const payloadText = contentType.includes("text/event-stream")
    ? lastSseData(text)
    : text;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText) as unknown;
  } catch {
    return {
      ok: false,
      status: 502,
      payload: { error: "subplatform MCP response was not valid JSON" },
    };
  }
  if (!isRecord(payload)) {
    return {
      ok: false,
      status: 502,
      payload: { error: "subplatform MCP response must be a JSON object" },
    };
  }
  return { ok: true, status: response.status, payload };
}

function lastSseData(value: string): string {
  const messages = value
    .split(/\r?\n\r?\n/)
    .flatMap((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()),
    )
    .filter((line) => line && line !== "[DONE]");
  return messages.at(-1) ?? "";
}

function safeTransportError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "subplatform MCP request timed out";
  if (error instanceof Error && error.name === "AbortError")
    return "subplatform MCP request timed out";
  return "subplatform MCP endpoint is unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
