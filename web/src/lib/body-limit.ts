export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maximumBytes: number) {
    super("request body exceeds the configured limit");
    this.name = "RequestBodyTooLargeError";
  }
}

export class ResponseBodyTooLargeError extends Error {
  constructor(public readonly maximumBytes: number) {
    super("response body exceeds the configured limit");
    this.name = "ResponseBodyTooLargeError";
  }
}

/** Read an optional JSON request with a byte cap; exactly zero bytes returns undefined. */
export async function readOptionalJsonBody<T>(
  request: Request,
  maximumBytes: number,
): Promise<T | undefined> {
  const declaredLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyTooLargeError(maximumBytes);
  }
  if (!request.body) return undefined;
  const bytes = await readBoundedBytes(
    request.body,
    maximumBytes,
    () => new RequestBodyTooLargeError(maximumBytes),
  );
  if (bytes.byteLength === 0) return undefined;
  return parseJson<T>(new TextDecoder().decode(bytes));
}

/** Read a JSON request with a byte cap that also covers chunked transfer encoding. */
export async function readJsonBody<T>(
  request: Request,
  maximumBytes: number,
): Promise<T> {
  const value = await readOptionalJsonBody<T>(request, maximumBytes);
  if (value === undefined) throw new SyntaxError("empty request body");
  return value;
}

/** Read an upstream JSON response with a byte cap that also covers chunked transfer encoding. */
export async function readJsonResponseBody<T>(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<T> {
  return parseJson<T>(
    await readResponseTextBody(response, maximumBytes, signal),
  );
}

/** Read an upstream response as text with a byte cap that also covers chunked transfer encoding. */
export async function readResponseTextBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
  beforeCancel?: () => void,
): Promise<string> {
  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes) {
    const error = new ResponseBodyTooLargeError(maximumBytes);
    try {
      beforeCancel?.();
    } catch {
      // Cleanup must not replace the body-limit failure.
    }
    try {
      void response.body?.cancel(error).catch(() => undefined);
    } catch {
      // Cancellation is best-effort and must remain bounded.
    }
    throw error;
  }
  if (!response.body) throw new SyntaxError("empty response body");
  const bytes = await readBoundedBytes(
    response.body,
    maximumBytes,
    () => new ResponseBodyTooLargeError(maximumBytes),
    signal,
    beforeCancel,
  );
  return new TextDecoder().decode(bytes);
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new SyntaxError("invalid JSON", { cause: error });
  }
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLarge: () => Error,
  signal?: AbortSignal,
  beforeCancel?: () => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  let onAbort: (() => void) | undefined;
  let cancelStarted = false;
  const cancelReader = (reason?: unknown) => {
    if (cancelStarted) return;
    cancelStarted = true;
    try {
      beforeCancel?.();
    } catch {
      // Cleanup must not replace the bounded read failure.
    }
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Some stream implementations can throw before returning a promise.
    }
  };

  try {
    const abortPromise = signal && !signal.aborted
      ? new Promise<never>((_, reject) => {
          rejectAbort = reject;
          onAbort = () => {
            // Reject before canceling so a cancel-induced `{ done: true }` read cannot win the
            // race. The transport hook runs before best-effort stream cancellation.
            rejectAbort?.(abortError(signal));
            cancelReader(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      : null;

    try {
      if (signal?.aborted) throw abortError(signal);
      while (true) {
        const pendingRead = reader.read();
        const { done, value } = abortPromise
          ? await Promise.race([pendingRead, abortPromise])
          : await pendingRead;
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (error) {
      // Cancellation is deliberately detached: a hostile or broken upstream
      // must not keep an aborted/over-limit request alive forever.
      cancelReader(error);
      throw error;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A hung cancellation can leave a read pending; preserving the original
      // failure is more important than synchronously releasing that lock.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}
