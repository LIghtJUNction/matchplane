import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { readResponseTextBody } from "./body-limit";
import {
  isPrivateOrReservedIpLiteral,
  resolvePublicAddresses,
  type ResolveAddresses,
} from "./public-endpoint";

export class PinnedPublicEndpointError extends Error {
  constructor() {
    super("outbound endpoint is blocked by network policy");
    this.name = "PinnedPublicEndpointError";
  }
}

export class PinnedPublicRedirectError extends Error {
  constructor(public readonly statusCode: number) {
    super("outbound redirects are not allowed");
    this.name = "PinnedPublicRedirectError";
  }
}

interface PinnedPublicAddressOptions {
  resolveAddresses?: ResolveAddresses;
  signal?: AbortSignal;
  allowLoopback?: boolean;
  createPolicyError?: () => Error;
  interruptedMessage?: string;
}

export interface PinnedPublicTextRequestOptions {
  requestTimeoutMs: number;
  responseBodyTimeoutMs: number;
  responseLimitBytes: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: BodyInit;
  resolveAddresses?: ResolveAddresses;
  allowLoopback?: boolean;
}

export interface PinnedPublicTextResponse {
  response: Response;
  text: string;
}

/**
 * Resolve through the connector itself and return only the validated address set.
 * The request URL keeps the original hostname, so Undici preserves its Host header
 * and TLS servername while the socket connects only to an address returned here.
 */
export function createPinnedPublicLookup(
  url: URL,
  options: PinnedPublicAddressOptions = {},
): LookupFunction {
  const expectedHostname = normalizedHostname(url.hostname);
  return (hostname, lookupOptions, callback) => {
    void (async () => {
      if (normalizedHostname(hostname) !== expectedHostname) {
        throw policyError(options);
      }
      const addresses = await resolvePinnedPublicAddresses(url, options);
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
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
          ? Object.assign(
              new Error(
                options.interruptedMessage ?? "Outbound request interrupted",
              ),
              { name: error.name, cause: error },
            )
          : error instanceof Error
            ? error
            : policyError(options);
      callback(safeError, "", 0);
    });
  };
}

export function createPinnedPublicDispatcher(
  url: URL,
  options: PinnedPublicAddressOptions = {},
): Agent {
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (
      isPrivateOrReservedIpLiteral(hostname) &&
      !(options.allowLoopback && isLoopbackHostname(hostname))
    ) {
      throw policyError(options);
    }
    return new Agent();
  }
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: createPinnedPublicLookup(url, options),
    },
  });
}

export async function resolvePinnedPublicAddresses(
  url: URL,
  options: PinnedPublicAddressOptions = {},
): Promise<string[]> {
  const hostname = normalizedHostname(url.hostname);
  let addresses: readonly string[];
  if (options.allowLoopback && isLoopbackHostname(hostname)) {
    addresses = hostname === "localhost" ? ["127.0.0.1", "::1"] : [hostname];
  } else if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await awaitWithAbort(
        (options.resolveAddresses ?? resolvePublicAddresses)(hostname),
        options.signal,
      );
    } catch {
      options.signal?.throwIfAborted();
      throw policyError(options);
    }
  }

  const unique = [...new Set(addresses.map(normalizedHostname))];
  if (
    unique.length === 0 ||
    unique.some(
      (address) =>
        isIP(address) === 0 ||
        (isPrivateOrReservedIpLiteral(address) &&
          !(
            options.allowLoopback &&
            isLoopbackHostname(hostname) &&
            isLoopbackHostname(address)
          )),
    )
  ) {
    throw policyError(options);
  }
  return unique;
}

/** Fetch and fully consume one HTTPS response while the pinned dispatcher is alive. */
export async function fetchPinnedPublicText(
  url: URL,
  options: PinnedPublicTextRequestOptions,
): Promise<PinnedPublicTextResponse> {
  if (
    (url.protocol !== "https:" &&
      !(options.allowLoopback && isLoopbackHttpUrl(url))) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new PinnedPublicEndpointError();
  }

  const requestTimeout = timeoutController(
    options.requestTimeoutMs,
    "Outbound request timed out",
  );
  const requestSignal = combineSignals(options.signal, requestTimeout.signal);
  let bodyTimeout: ReturnType<typeof timeoutController> | undefined;
  let dispatcher: Agent | undefined;
  let dispatcherDestroy: Promise<void> | undefined;
  let response: Response | undefined;
  const destroyTransport = () => {
    if (!dispatcher) return;
    dispatcherDestroy ??= dispatcher.destroy().catch(() => undefined);
  };

  try {
    requestSignal.throwIfAborted();
    dispatcher = createPinnedPublicDispatcher(url, {
      signal: requestSignal,
      resolveAddresses: options.resolveAddresses,
      allowLoopback: options.allowLoopback,
    });
    // SAFETY: Undici's Response implements the same Fetch response contract;
    // this bridges package-local Undici types to the DOM type used by body-limit.
    const requestInit: RequestInit & { dispatcher: Agent } = {
      method: options.method ?? "GET",
      headers: options.headers ?? { accept: "application/json" },
      signal: requestSignal,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      dispatcher,
    };
    if (options.body !== undefined) requestInit.body = options.body;
    const undiciResponse = await undiciFetch(
      url,
      // SAFETY: requestInit adds only Undici's dispatcher to standard Fetch fields.
      requestInit as unknown as Parameters<typeof undiciFetch>[1],
    );
    // SAFETY: Undici's response implements the DOM Fetch response contract.
    response = undiciResponse as unknown as Response;
    requestTimeout.clear();

    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      destroyTransport();
      cancelResponseBody(response);
      throw new PinnedPublicRedirectError(response.status);
    }

    bodyTimeout = timeoutController(
      options.responseBodyTimeoutMs,
      "Outbound response body timed out",
    );
    const bodySignal = combineSignals(options.signal, bodyTimeout.signal);
    let text: string;
    try {
      text = await readResponseTextBody(
        response,
        options.responseLimitBytes,
        bodySignal,
        destroyTransport,
      );
    } catch (error) {
      bodySignal.throwIfAborted();
      throw error;
    }
    return { response, text };
  } finally {
    requestTimeout.clear();
    bodyTimeout?.clear();
    if (dispatcher) {
      const interrupted =
        requestTimeout.signal.aborted ||
        bodyTimeout?.signal.aborted ||
        options.signal?.aborted;
      if (interrupted || dispatcherDestroy) {
        destroyTransport();
      } else {
        await dispatcher.close().catch(() => {
          destroyTransport();
        });
      }
    }
  }
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never mask the transport failure.
  }
}

function policyError(options: PinnedPublicAddressOptions): Error {
  return options.createPolicyError?.() ?? new PinnedPublicEndpointError();
}

function normalizedHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    isLoopbackHostname(normalizedHostname(url.hostname))
  );
}

function timeoutController(timeoutMs: number, message: string): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(message, "TimeoutError")),
    Math.max(1, Math.floor(timeoutMs)),
  );
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  return external ? AbortSignal.any([external, internal]) : internal;
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
