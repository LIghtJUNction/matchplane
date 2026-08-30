import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

const undiciState = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: undiciState.fetch,
}));

import { ResponseBodyTooLargeError } from "./body-limit";
import {
  createPinnedPublicLookup,
  fetchPinnedPublicText,
  PinnedPublicEndpointError,
  PinnedPublicRedirectError,
} from "./pinned-public-endpoint";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("pinned public endpoint transport", () => {
  it("pins connector DNS answers and rejects a private rebinding answer", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(["8.8.8.8", "2001:4860:4860::8888"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const lookup = createPinnedPublicLookup(
      new URL("https://api.weixin.qq.com/sns/oauth2/access_token"),
      { resolveAddresses: resolver },
    );
    const invoke = () =>
      new Promise<readonly { address: string; family: number }[]>(
        (resolve, reject) => {
          lookup("api.weixin.qq.com", { all: true }, (error, addresses) => {
            if (error) reject(error);
            else {
              resolve(
                addresses as readonly { address: string; family: number }[],
              );
            }
          });
        },
      );

    await expect(invoke()).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    await expect(invoke()).rejects.toBeInstanceOf(PinnedPublicEndpointError);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("keeps the HTTPS hostname while forcing a pinned dispatcher and no credentials or redirects", async () => {
    undiciState.fetch.mockResolvedValue(
      new Response('{"openid":"OPENID"}', { status: 200 }),
    );
    const url = new URL("https://api.weixin.qq.com/sns/userinfo");

    await expect(
      fetchPinnedPublicText(url, {
        requestTimeoutMs: 1_000,
        responseBodyTimeoutMs: 1_000,
        responseLimitBytes: 1_024,
      }),
    ).resolves.toMatchObject({ text: '{"openid":"OPENID"}' });

    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
    const [requested, init] = undiciState.fetch.mock.calls[0] as [
      URL,
      { dispatcher: unknown; credentials: string; redirect: string },
    ];
    expect(requested.protocol).toBe("https:");
    expect(requested.hostname).toBe("api.weixin.qq.com");
    expect(init.dispatcher).toBeInstanceOf(Agent);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("manual");
  });

  it("preserves a bounded POST while still forcing manual redirects and pinned DNS", async () => {
    undiciState.fetch.mockResolvedValue(new Response("{}", { status: 202 }));
    const headers = new Headers({
      authorization: "Bearer secret",
      "content-type": "application/json",
    });

    await expect(
      fetchPinnedPublicText(new URL("https://sms.example.test/send"), {
        method: "POST",
        headers,
        body: '{"code":"123456"}',
        resolveAddresses: vi.fn().mockResolvedValue(["8.8.8.8"]),
        requestTimeoutMs: 1_000,
        responseBodyTimeoutMs: 1_000,
        responseLimitBytes: 1_024,
      }),
    ).resolves.toMatchObject({ text: "{}" });

    const [, init] = undiciState.fetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers; body: string; redirect: string },
    ];
    expect(init.method).toBe("POST");
    expect(init.headers.get("authorization")).toBe("Bearer secret");
    expect(init.body).toBe('{"code":"123456"}');
    expect(init.redirect).toBe("manual");
  });

  it("does not let loopback mode admit a private answer for a public hostname", async () => {
    const lookup = createPinnedPublicLookup(
      new URL("https://sms.example.test/send"),
      {
        allowLoopback: true,
        resolveAddresses: vi.fn().mockResolvedValue(["10.0.0.2"]),
      },
    );
    const result = new Promise((resolve, reject) => {
      lookup("sms.example.test", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    await expect(result).rejects.toBeInstanceOf(PinnedPublicEndpointError);
  });

  it("times out a request that never produces response headers", async () => {
    vi.useFakeTimers();
    undiciState.fetch.mockImplementation(
      (_url: URL, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    const pending = fetchPinnedPublicText(
      new URL("https://api.weixin.qq.com/sns/userinfo"),
      {
        requestTimeoutMs: 20,
        responseBodyTimeoutMs: 1_000,
        responseLimitBytes: 1_024,
      },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });

  it("times out and cancels a slow response body", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        canceled = true;
      },
    });
    undiciState.fetch.mockResolvedValue(new Response(body, { status: 200 }));
    const pending = fetchPinnedPublicText(
      new URL("https://api.weixin.qq.com/sns/userinfo"),
      {
        requestTimeoutMs: 1_000,
        responseBodyTimeoutMs: 20,
        responseLimitBytes: 1_024,
      },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(canceled).toBe(true);
  });

  it("destroys the dispatcher before a hung body cancellation", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    vi.spyOn(Agent.prototype, "destroy").mockImplementation(async () => {
      events.push("destroy");
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        events.push("cancel");
        return new Promise<void>(() => undefined);
      },
    });
    undiciState.fetch.mockResolvedValue(new Response(body, { status: 200 }));
    const pending = fetchPinnedPublicText(
      new URL("https://api.weixin.qq.com/sns/userinfo"),
      {
        requestTimeoutMs: 1_000,
        responseBodyTimeoutMs: 20,
        responseLimitBytes: 1_024,
      },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(events).toEqual(["destroy", "cancel"]);
  });

  it("rejects an oversized response body through the shared body-limit reader", async () => {
    undiciState.fetch.mockResolvedValue(
      new Response("x".repeat(1_025), { status: 200 }),
    );

    await expect(
      fetchPinnedPublicText(
        new URL("https://api.weixin.qq.com/sns/userinfo"),
        {
          requestTimeoutMs: 1_000,
          responseBodyTimeoutMs: 1_000,
          responseLimitBytes: 1_024,
        },
      ),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it("returns a redirect error without following the location", async () => {
    undiciState.fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
    );

    await expect(
      fetchPinnedPublicText(
        new URL("https://api.weixin.qq.com/sns/userinfo"),
        {
          requestTimeoutMs: 1_000,
          responseBodyTimeoutMs: 1_000,
          responseLimitBytes: 1_024,
        },
      ),
    ).rejects.toBeInstanceOf(PinnedPublicRedirectError);
    expect(undiciState.fetch).toHaveBeenCalledTimes(1);
  });
});
