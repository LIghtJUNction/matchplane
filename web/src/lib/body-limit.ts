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

/** Read a JSON request with a byte cap that also covers chunked transfer encoding. */
export async function readJsonBody<T>(request: Request, maximumBytes: number): Promise<T> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyTooLargeError(maximumBytes);
  }
  if (!request.body) throw new SyntaxError("empty request body");
  const bytes = await readBoundedBytes(request.body, maximumBytes, () => new RequestBodyTooLargeError(maximumBytes));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Read an upstream JSON response with a byte cap that also covers chunked transfer encoding. */
export async function readJsonResponseBody<T>(response: Response, maximumBytes: number): Promise<T> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declaredLength) && declaredLength > maximumBytes) {
    throw new ResponseBodyTooLargeError(maximumBytes);
  }
  if (!response.body) throw new SyntaxError("empty response body");
  const bytes = await readBoundedBytes(response.body, maximumBytes, () => new ResponseBodyTooLargeError(maximumBytes));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (error) {
      // Stop a chunked/slow stream as soon as its bounded budget is exceeded. Releasing the
      // reader alone leaves an unread stream attached to the request/response in some runtimes.
      await reader.cancel().catch(() => undefined);
      throw error;
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
  return bytes;
}
