import type { LookupFunction } from "node:net";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { type Agent, fetch as undiciFetch } from "undici";

import {
  createPinnedPublicDispatcher,
  createPinnedPublicLookup,
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
  resolvePinnedPublicAddresses,
} from "./lib/pinned-public-endpoint";
import type { ResolveAddresses } from "./lib/public-endpoint";

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
  /** Test-only transport seam; rejected unless NODE_ENV is test and production mode is off. */
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

/**
 * Build an official SDK model while keeping transport policy provider-neutral.
 * Non-loopback production traffic uses a connector-pinned Undici Agent and rejects
 * environment proxy variables because that Agent cannot safely honor proxy routing
 * and DNS pinning together.
 */
export function createProviderModel(
  options: ProviderModelOptions,
): LanguageModel {
  if (options.fetcher && !isExplicitTestEnvironment()) {
    throw providerNetworkPolicyError();
  }
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
    let dispatcherDestroy: Promise<void> | undefined;
    const destroyTransport = () => {
      if (!dispatcher) return;
      dispatcherDestroy ??= dispatcher.destroy().catch(() => undefined);
    };
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
        if (!isExplicitTestEnvironment()) throw providerNetworkPolicyError();
        await resolveValidatedProviderAddresses(
          url,
          options.resolveAddresses,
          signal,
        );
        response = await options.fetcher(url, requestInit);
      } else {
        assertEnvironmentProxyUnsupported(url);
        dispatcher = createPinnedProviderDispatcher(
          url,
          options.resolveAddresses,
          signal,
        );
        // SAFETY: requestInit contains standard Fetch options and dispatcher is
        // the only Undici-specific field; Undici's response is Fetch-compatible.
        // These casts bridge package-local Undici types to the DOM types here.
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
        destroyTransport();
        cancelResponseBody(response);
        throw new ProviderAdapterError("MP_PROVIDER_REDIRECT", response.status);
      }
      return await boundedResponse(
        response,
        options.responseLimitBytes,
        signal,
        destroyTransport,
      );
    } catch (error) {
      destroyTransport();
      throw safeProviderFetchError(error, signal);
    } finally {
      clearTimeout(timer);
      if (dispatcher) {
        if (signal?.aborted || dispatcherDestroy) {
          destroyTransport();
        } else {
          await dispatcher.close().catch(() => {
            destroyTransport();
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
  return createPinnedPublicDispatcher(url, {
    resolveAddresses: resolver,
    signal,
    allowLoopback: isDevelopmentLoopback(url),
    createPolicyError: providerNetworkPolicyError,
    interruptedMessage: "Provider request interrupted",
  });
}

export function createPinnedProviderLookup(
  url: URL,
  resolver: ResolveAddresses | undefined,
  signal: AbortSignal | undefined,
): LookupFunction {
  return createPinnedPublicLookup(url, {
    resolveAddresses: resolver,
    signal,
    allowLoopback: isDevelopmentLoopback(url),
    createPolicyError: providerNetworkPolicyError,
    interruptedMessage: "Provider request interrupted",
  });
}

async function resolveValidatedProviderAddresses(
  url: URL,
  resolver: ResolveAddresses | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  return resolvePinnedPublicAddresses(url, {
    resolveAddresses: resolver,
    signal,
    allowLoopback: isDevelopmentLoopback(url),
    createPolicyError: providerNetworkPolicyError,
    interruptedMessage: "Provider request interrupted",
  });
}

function providerNetworkPolicyError(): ProviderAdapterError {
  return new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY");
}

function isExplicitTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    process.env.MATCHPLANE_ENVIRONMENT !== "production"
  );
}

/**
 * A connector-pinned Undici Agent cannot also honor environment proxy routing.
 * Fail closed instead of silently bypassing an operator-configured proxy.
 */
function assertEnvironmentProxyUnsupported(url: URL): void {
  if (isDevelopmentLoopback(url)) return;
  const proxyVariables = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;
  if (proxyVariables.some((name) => process.env[name]?.trim())) {
    throw providerNetworkPolicyError();
  }
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
  let base: URL;
  try {
    base = new URL(baseURL);
  } catch {
    throw new ProviderAdapterError("MP_PROVIDER_INVALID_ENDPOINT");
  }
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
  beforeCancel?: () => void,
): Promise<Response> {
  const boundedLimit = Math.max(1, Math.floor(limitBytes));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > boundedLimit) {
    beforeCancel?.();
    cancelResponseBody(response);
    throw new ProviderAdapterError("MP_PROVIDER_BODY_LIMIT", response.status);
  }
  if (!response.body) {
    return new Response(null, responseInit(response));
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelStarted = false;
  const cancelReader = (reason?: unknown) => {
    if (cancelStarted) return;
    cancelStarted = true;
    try {
      beforeCancel?.();
    } catch {
      // Cleanup must not replace the provider failure.
    }
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Cancellation is best-effort and must remain bounded.
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > boundedLimit) {
        throw new ProviderAdapterError(
          "MP_PROVIDER_BODY_LIMIT",
          response.status,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hung cancellation can leave a read pending; preserve the original error.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, responseInit(response));
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never mask the provider failure.
  }
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

const UNDICI_TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function safeProviderFetchError(
  error: unknown,
  signal?: AbortSignal,
): Error {
  if (signal?.aborted) return safeInterruptedError(signal.reason);
  const direct = safeKnownProviderError(error);
  if (direct) return direct;
  if (!(error instanceof TypeError)) return providerTransportFailure();

  const seen = new Set<unknown>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 6 && candidate !== undefined; depth += 1) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    const known = safeKnownProviderError(candidate);
    if (known) return known;
    candidate = safeErrorCause(candidate);
  }

  return providerTransportFailure();
}

function providerTransportFailure(): Error {
  const failure = new Error("Provider request failed.");
  failure.name = "ProviderTransportError";
  return failure;
}

function safeKnownProviderError(error: unknown): Error | undefined {
  if (error instanceof ProviderAdapterError) return error;
  if (error instanceof PinnedPublicEndpointError) {
    return providerNetworkPolicyError();
  }
  if (error instanceof PinnedPublicRedirectError) {
    return new ProviderAdapterError("MP_PROVIDER_REDIRECT", error.statusCode);
  }
  if (!(error instanceof Error)) return undefined;
  const code = safeErrorCode(error);
  if (error.name === "TimeoutError" || (code && UNDICI_TIMEOUT_CODES.has(code))) {
    return safeTimeoutError(code);
  }
  if (error.name === "AbortError" || code === "UND_ERR_ABORTED") {
    const aborted = new Error("Provider request was aborted.");
    aborted.name = "AbortError";
    if (code === "UND_ERR_ABORTED") Object.assign(aborted, { code });
    return aborted;
  }
  return undefined;
}

function safeInterruptedError(reason: unknown): Error {
  return safeKnownProviderError(reason) ?? safeAbortError();
}

function safeAbortError(): Error {
  const error = new Error("Provider request was aborted.");
  error.name = "AbortError";
  return error;
}

function safeTimeoutError(code?: string): Error {
  const error = new Error("Provider request timed out.");
  error.name = "TimeoutError";
  if (code && UNDICI_TIMEOUT_CODES.has(code)) Object.assign(error, { code });
  return error;
}

function safeErrorCode(error: Error): string | undefined {
  try {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorCause(error: unknown): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const cause = error.cause;
    return cause instanceof Error ? cause : undefined;
  } catch {
    return undefined;
  }
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
