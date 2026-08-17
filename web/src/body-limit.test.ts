import { describe, expect, it } from "vitest";

import { readJsonBody, RequestBodyTooLargeError } from "./lib/body-limit";

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
});
