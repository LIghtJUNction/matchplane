import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { Agent, fetch as undiciFetch } from "undici";

import {
  isPrivateOrReservedIpLiteral,
  resolvePublicAddresses,
  type ResolveAddresses,
} from "./lib/public-endpoint";

export type ProviderProtocol =
  "openai-compatible" | "anthropic-messages" | "gemini-generate-content";

export interface ProviderFetchTelemetry {
  phase: string;
  firstByteAt?: number;
  responseStatus?: number;
}

export type ProviderAdapterErrorCode =
  | "MP_PROVIDER_INVALID_ENDPOINT"
  | "MP_PROVIDER_NETWORK_POLICY"
  | "MP_PROVIDER_REDIRECT"
  | "MP_PROVIDER_BODY_LIMIT";

/** Error with a fixed, credential-safe message and no request or response material. */
export class ProviderAdapterError extends Error {
  readonly code: ProviderAdapterErrorCode;
  readonly statusCode: number | undefined;

  constructor(code: ProviderAdapterErrorCode, statusCode?: number) {
    const messages: Record<ProviderAdapterErrorCode, string> = {
      MP_PROVIDER_INVALID_ENDPOINT: "Provider endpoint is invalid.",
      MP_PROVIDER_NETWORK_POLICY:
        "Provider endpoint is blocked by network policy.",
      MP_PROVIDER_REDIRECT: "Provider redirects are not allowed.",
      MP_PROVIDER_BODY_LIMIT: "Provider response exceeded the allowed size.",
    };
    super(messages[code]);
    this.name = "ProviderAdapterError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ProviderModelOptions {
  protocol: ProviderProtocol;
  endpoint: string;
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
  responseLimitBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  telemetry?: ProviderFetchTelemetry;
}

/** Normalize only documented provider roots and terminal text-completion routes. */
export function normalizeProviderBaseUrl(
  protocol: ProviderProtocol,
  endpoint: string,
): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }
  if (
    !isAllowedProviderTransport(url) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  let basePath: string;
  if (protocol === "openai-compatible") {
    if (path === "/" || path === "/v1") basePath = "/v1";
    else if (path === "/v1/chat/completions" || path === "/v1/responses")
      basePath = "/v1";
    else throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  } else if (protocol === "anthropic-messages") {
    if (path === "/" || path === "/v1") basePath = "/v1";
    else if (path === "/v1/messages") basePath = "/v1";
    else throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  } else {
    if (path === "/" || path === "/v1beta") basePath = "/v1beta";
    else if (/^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/.test(path))
      basePath = "/v1beta";
    else throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }

  return `${url.origin}${basePath}`;
}

/** Build an official SDK model while keeping transport policy provider-neutral. */
export function createProviderModel(
  options: ProviderModelOptions,
): LanguageModel {
  const baseURL = normalizeProviderBaseUrl(options.protocol, options.endpoint);
  const safeFetch = createSafeProviderFetch({ ...options, baseURL });
  if (options.protocol === "openai-compatible") {
    return createOpenAICompatible({
      name: "matchplane",
      baseURL,
      apiKey: options.apiKey,
      fetch: safeFetch,
    }).chatModel(options.model);
  }
  if (options.protocol === "anthropic-messages") {
    return createAnthropic({
      name: "matchplane",
      baseURL,
      apiKey: options.apiKey,
      fetch: safeFetch,
    })(options.model);
  }
  return createGoogleGenerativeAI({
    name: "matchplane",
    baseURL,
    apiKey: options.apiKey,
    fetch: safeFetch,
  })(options.model);
}

interface SafeFetchOptions extends ProviderModelOptions {
  baseURL: string;
}

function createSafeProviderFetch(options: SafeFetchOptions): typeof fetch {
  const telemetry = options.telemetry;
  return (async (resource: RequestInfo | URL, init?: RequestInit) => {
    telemetry && (telemetry.phase = "connect");
    if (telemetry) {
      telemetry.firstByteAt = undefined;
      telemetry.responseStatus = undefined;
    }
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => {
        timeoutController.abort(
          new DOMException("Provider deadline exceeded", "TimeoutError"),
        );
      },
      Math.max(1, Math.floor(options.timeoutMs)),
    );
    timer.unref?.();
    const signals = [
      options.signal,
      init?.signal,
      timeoutController.signal,
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let dispatcher: Agent | null = null;
    try {
      signal?.throwIfAborted();
      const url = finalProviderUrl(resource);
      validateFinalProviderUrl(url, options.protocol, options.baseURL);
      telemetry && (telemetry.phase = "first_byte");
      let response: Response;
      const requestInit = {
        ...init,
        signal,
        redirect: "manual" as const,
        cache: "no-store" as const,
      };
      if (options.fetcher) {
        // Dependency-injected transports are used by local tests. Production
        // call sites omit this seam and therefore cannot bypass the pinned
        // Undici connector below.
        await resolveValidatedProviderAddresses(
          url,
          options.resolveAddresses,
          signal,
        );
        response = await options.fetcher(url, requestInit);
      } else {
        dispatcher = createPinnedProviderDispatcher(
          url,
          options.resolveAddresses,
          signal,
        );
        response = (await undiciFetch(url, {
          ...requestInit,
          dispatcher,
        } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
      }
      if (telemetry) {
        telemetry.firstByteAt = Date.now();
        telemetry.responseStatus = response.status;
        telemetry.phase = "response";
      }
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderAdapterError("MP_PROVIDER_REDIRECT", response.status);
      }
      return await boundedResponse(
        response,
        options.responseLimitBytes,
        signal,
      );
    } finally {
      clearTimeout(timer);
      if (dispatcher) {
        if (signal?.aborted) {
          await dispatcher.destroy().catch(() => undefined);
        } else {
          await dispatcher.close().catch(async () => {
            await dispatcher?.destroy().catch(() => undefined);
          });
        }
      }
    }
  }) as typeof fetch;
}

function createPinnedProviderDispatcher(
  url: URL,
  resolver: ResolveAddresses | undefined,
  signal: AbortSignal | undefined,
): Agent {
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (
      !isDevelopmentLoopback(url) &&
      isPrivateOrReservedIpLiteral(hostname)
    ) {
      throw new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
    }
    return new Agent();
  }
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: createPinnedProviderLookup(url, resolver, signal),
    },
  });
}

export function createPinnedProviderLookup(
  url: URL,
  resolver: ResolveAddresses | undefined,
  signal: AbortSignal | undefined,
): LookupFunction {
  const expectedHostname = normalizedHostname(url.hostname);
  return (hostname, lookupOptions, callback) => {
    void (async () => {
      if (normalizedHostname(hostname) !== expectedHostname) {
        throw new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
      }
      const addresses = await resolveValidatedProviderAddresses(
        url,
        resolver,
        signal,
      );
      const records: LookupAddress[] = addresses.map((address) => ({
        address,
        family: isIP(address),
      }));
      if (lookupOptions.all) {
        callback(null, records);
      } else {
        const first = records[0];
        callback(null, first.address, first.family);
      }
    })().catch((error: unknown) => {
      const safeError =
        error instanceof ProviderAdapterError
          ? error
          : error instanceof DOMException &&
              (error.name === "AbortError" || error.name === "TimeoutError")
            ? Object.assign(new Error("Provider request interrupted"), {
                name: error.name,
                cause: error,
              })
            : new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
      callback(safeError, "", 0);
    });
  };
}

async function resolveValidatedProviderAddresses(
  url: URL,
  resolver: ResolveAddresses | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const hostname = normalizedHostname(url.hostname);
  let addresses: readonly string[];
  if (isDevelopmentLoopback(url)) {
    addresses =
      hostname === "localhost" ? ["127.0.0.1", "::1"] : [hostname];
  } else if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await awaitWithAbort(
        (resolver ?? resolvePublicAddresses)(hostname),
        signal,
      );
    } catch {
      signal?.throwIfAborted();
      throw new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
    }
  }
  const unique = [...new Set(addresses.map(normalizedHostname))];
  if (
    unique.length === 0 ||
    unique.some(
      (address) =>
        isIP(address) === 0 ||
        (!isDevelopmentLoopback(url) &&
          isPrivateOrReservedIpLiteral(address)),
    )
  ) {
    throw new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
  }
  return unique;
}

function normalizedHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function finalProviderUrl(resource: RequestInfo | URL): URL {
  try {
    const value = resource instanceof Request ? resource.url : resource;
    return new URL(value);
  } catch {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }
}

function validateFinalProviderUrl(
  url: URL,
  protocol: ProviderProtocol,
  baseURL: string,
): void {
  const base = new URL(baseURL);
  if (
    !isAllowedProviderTransport(url) ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }
  const basePath = base.pathname.replace(/\/$/, "");
  const expected =
    protocol === "openai-compatible"
      ? `${basePath}/chat/completions`
      : protocol === "anthropic-messages"
        ? `${basePath}/messages`
        : null;
  if (
    expected
      ? url.pathname !== expected
      : !isGeminiGenerateContentPath(url.pathname, basePath)
  ) {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }
}

function isGeminiGenerateContentPath(path: string, basePath: string): boolean {
  if (!path.startsWith(`${basePath}/`)) return false;
  const suffix = path.slice(basePath.length + 1);
  return /^models\/[A-Za-z0-9._-]+:generateContent$/.test(suffix);
}

async function boundedResponse(
  response: Response,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  const boundedLimit = Math.max(1, Math.floor(limitBytes));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > boundedLimit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderAdapterError("MP_PROVIDER_BODY_LIMIT", response.status);
  }
  if (!response.body) {
    return new Response(null, responseInit(response));
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > boundedLimit) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderAdapterError(
          "MP_PROVIDER_BODY_LIMIT",
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, responseInit(response));
}

function isAllowedProviderTransport(url: URL): boolean {
  return url.protocol === "https:" || isDevelopmentLoopback(url);
}

function isDevelopmentLoopback(url: URL): boolean {
  if (
    process.env.MATCHPLANE_ENVIRONMENT === "production" ||
    url.protocol !== "http:"
  ) {
    return false;
  }
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await operation;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

/** Normalize AI SDK v7 usage without retaining provider-specific raw usage. */
export function normalizeProviderUsage(
  usage:
    | Pick<LanguageModelUsage, "inputTokens" | "outputTokens" | "totalTokens">
    | null
    | undefined,
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | null {
  if (!usage) return null;
  const promptTokens = boundedUsageToken(usage.inputTokens);
  const completionTokens = boundedUsageToken(usage.outputTokens);
  const reportedTotal = boundedUsageToken(usage.totalTokens);
  if (promptTokens === null || completionTokens === null) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
  };
}

function boundedUsageToken(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
