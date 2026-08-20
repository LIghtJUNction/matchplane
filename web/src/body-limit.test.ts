import { describe, expect, it } from "vitest";

import {
  readJsonBody,
  readJsonResponseBody,
  readResponseTextBody,
  RequestBodyTooLargeError,
  ResponseBodyTooLargeError,
} from "./lib/body-limit";

describe("bounded JSON request bodies", () => {
  it("accepts a body within the configured limit", async () => {
    const request = new Request("https://matchplane.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    await expect(readJsonBody(request, 128)).resolves.toEqual({ ok: true });
  });

  it("rejects a chunked body after the stream crosses the limit", async () => {
    const request = new Request("https://matchplane.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"payload":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(256)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request, 128)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("accepts an upstream response within the configured limit", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });

    await expect(readJsonResponseBody(response, 128)).resolves.toEqual({ ok: true });
  });

  it("rejects a chunked upstream response after the stream crosses the limit", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(256)));
        controller.close();
      },
    }));

    await expect(readJsonResponseBody(response, 128)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it("reads a bounded upstream text response", async () => {
    const response = new Response("gateway error", { status: 502 });

    await expect(readResponseTextBody(response, 128)).resolves.toBe("gateway error");
  });
});
