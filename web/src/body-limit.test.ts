import { describe, expect, it, vi } from "vitest";

import {
  readJsonBody,
  readJsonResponseBody,
  readOptionalJsonBody,
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

  it("distinguishes absent and streamed zero-byte bodies from JSON null", async () => {
    const absent = new Request("https://matchplane.test/api", {
      method: "POST",
    });
    const streamedEmpty = new Request("https://matchplane.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const jsonNull = new Request("https://matchplane.test/api", {
      method: "POST",
      body: "null",
    });

    await expect(readOptionalJsonBody(absent, 128)).resolves.toBeUndefined();
    await expect(
      readOptionalJsonBody(streamedEmpty, 128),
    ).resolves.toBeUndefined();
    await expect(readOptionalJsonBody(jsonNull, 128)).resolves.toBeNull();
  });

  it("keeps strict JSON reads strict for streamed zero-byte bodies", async () => {
    const request = new Request("https://matchplane.test/api", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonBody(request, 128)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("retains declared size limits for optional JSON bodies", async () => {
    const request = new Request("https://matchplane.test/api", {
      method: "POST",
      headers: { "content-length": "129" },
      body: "{}",
    });

    await expect(readOptionalJsonBody(request, 128)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("rejects malformed request JSON as a syntax error", async () => {
    const request = new Request("https://matchplane.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    await expect(readJsonBody(request, 128)).rejects.toBeInstanceOf(
      SyntaxError,
    );
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

    await expect(readJsonBody(request, 128)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("accepts an upstream response within the configured limit", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });

    await expect(readJsonResponseBody(response, 128)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects malformed upstream JSON as a syntax error", async () => {
    const response = new Response("{", {
      headers: { "content-type": "application/json" },
    });

    await expect(readJsonResponseBody(response, 128)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("rejects a chunked upstream response after the stream crosses the limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"payload":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(256)));
          controller.close();
        },
      }),
    );

    await expect(readJsonResponseBody(response, 128)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("aborts a slow upstream response and cancels its reader", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined);
        },
        cancel(reason) {
          cancel(reason);
        },
      }),
    );
    const pending = readJsonResponseBody(response, 128, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("cancels an upstream response when the signal is already aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancel(reason);
        },
      }),
    );
    controller.abort();

    await expect(
      readJsonResponseBody(response, 128, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("tears down transport before detached cancellation and does not await a hung cancel", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          readStarted?.();
          return new Promise<void>(() => undefined);
        },
        cancel() {
          events.push("cancel");
          return new Promise<void>(() => undefined);
        },
      }),
    );
    const pending = readResponseTextBody(
      response,
      128,
      controller.signal,
      () => events.push("transport"),
    );
    await started;
    controller.abort();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error: Error) => error.name,
      ),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("hung"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(outcome).toBe("AbortError");
    expect(events).toEqual(["transport", "cancel"]);
  });

  it("reads a bounded upstream text response", async () => {
    const response = new Response("gateway error", { status: 502 });

    await expect(readResponseTextBody(response, 128)).resolves.toBe(
      "gateway error",
    );
  });
});
