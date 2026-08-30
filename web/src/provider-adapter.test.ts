import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  createPinnedProviderLookup,
  createProviderModel,
  normalizeProviderBaseUrl,
  normalizeProviderUsage,
  ProviderAdapterError,
  type ProviderFetchTelemetry,
  type ProviderProtocol,
} from "./provider-adapter";

const publicDns = async () => ["8.8.8.8"];
const secret = "provider-secret-value";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.MATCHPLANE_ENVIRONMENT;
});

function textResponse(protocol: ProviderProtocol): Record<string, unknown> {
  if (protocol === "anthropic-messages") {
    return {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 5 },
    };
  }
  if (protocol === "gemini-generate-content") {
    return {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 5,
        totalTokenCount: 16,
      },
      modelVersion: "test-model",
    };
  }
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  };
}

function toolResponse(protocol: ProviderProtocol): Record<string, unknown> {
  const input = {
    selectedSlugs: ["store-a"],
    rationale: "车辆",
    confidence: 0.9,
  };
  if (protocol === "anthropic-messages") {
    return {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "tool_use", id: "tool_1", name: "select", input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 3 },
    };
  }
  if (protocol === "gemini-generate-content") {
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "select", args: input } }],
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 3,
        totalTokenCount: 10,
      },
    };
  }
  return {
    id: "chatcmpl_tool",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tool_1",
              type: "function",
              function: { name: "select", arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
}

function endpoint(protocol: ProviderProtocol): string {
  if (protocol === "anthropic-messages")
    return "https://anthropic.example/v1/messages";
  if (protocol === "gemini-generate-content")
    return "https://gemini.example/v1beta/models/test-model:generateContent";
  return "https://tokenrhythm.example";
}

function expectedPath(protocol: ProviderProtocol): string {
  if (protocol === "anthropic-messages") return "/v1/messages";
  if (protocol === "gemini-generate-content")
    return "/v1beta/models/test-model:generateContent";
  return "/v1/chat/completions";
}

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let candidate = error;
  while (candidate instanceof Error && chain.length < 12) {
    if (seen.has(candidate)) break;
    seen.add(candidate);
    chain.push(candidate);
    candidate = candidate.cause;
  }
  return chain;
}

function modelWithFetch(protocol: ProviderProtocol, fetcher: typeof fetch) {
  return createProviderModel({
    protocol,
    endpoint: endpoint(protocol),
    apiKey: secret,
    model: "test-model",
    fetcher,
    resolveAddresses: publicDns,
    responseLimitBytes: 256 * 1024,
    timeoutMs: 2_000,
  });
}

describe("provider adapter official SDK models", () => {
  for (const protocol of [
    "openai-compatible",
    "anthropic-messages",
    "gemini-generate-content",
  ] as const) {
    it(`parses ${protocol} text, usage, path, and SDK auth`, async () => {
      const fetcher = vi.fn(
        async (resource: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(resource));
          const headers = new Headers(init?.headers);
          expect(url.pathname).toBe(expectedPath(protocol));
          expect(url.search).toBe("");
          expect(init?.redirect).toBe("manual");
          expect(init?.cache).toBe("no-store");
          if (protocol === "openai-compatible") {
            expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
          } else if (protocol === "anthropic-messages") {
            expect(headers.get("x-api-key")).toBe(secret);
            expect(headers.get("anthropic-version")).toBeTruthy();
          } else {
            expect(headers.get("x-goog-api-key")).toBe(secret);
            expect(url.searchParams.has("key")).toBe(false);
          }
          return new Response(JSON.stringify(textResponse(protocol)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      ) as typeof fetch;

      const result = await generateText({
        model: modelWithFetch(protocol, fetcher),
        prompt: "hello",
        maxRetries: 0,
      });

      expect(result.text).toBe("ok");
      expect(normalizeProviderUsage(result.usage)).toEqual({
        promptTokens: 11,
        completionTokens: 5,
        totalTokens: 16,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it(`normalizes ${protocol} tool calls through the SDK`, async () => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify(toolResponse(protocol)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as typeof fetch;
      const result = await generateText({
        model: modelWithFetch(protocol, fetcher),
        prompt: "route",
        tools: {
          select: tool({
            inputSchema: z.object({
              selectedSlugs: z.array(z.string()),
              rationale: z.string(),
              confidence: z.number(),
            }),
          }),
        },
        toolChoice: { type: "tool", toolName: "select" },
        stopWhen: stepCountIs(1),
        maxRetries: 0,
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        toolName: "select",
        input: {
          selectedSlugs: ["store-a"],
          rationale: "车辆",
          confidence: 0.9,
        },
      });
    });
  }

  it("does not fabricate token usage when an optional usage object is absent", async () => {
    const response = textResponse("openai-compatible");
    delete response.usage;
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await generateText({
      model: modelWithFetch("openai-compatible", fetcher),
      prompt: "hello",
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(normalizeProviderUsage(result.usage)).toBeNull();
  });
});

describe("provider adapter transport policy", () => {
  it("rejects the injected fetcher seam outside an explicit non-production test environment", () => {
    const fetcher = vi.fn(async () => new Response("{}")) as typeof fetch;
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");

    expect(() =>
      createProviderModel({
        protocol: "openai-compatible",
        endpoint: "https://provider.example",
        apiKey: secret,
        model: "test-model",
        fetcher,
        resolveAddresses: publicDns,
        responseLimitBytes: 8_192,
        timeoutMs: 2_000,
      }),
    ).toThrow(
      expect.objectContaining({ code: "MP_PROVIDER_NETWORK_POLICY" }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rechecks the test-only fetcher seam when the model is invoked", async () => {
    const fetcher = vi.fn(async () => new Response("{}")) as typeof fetch;
    const model = modelWithFetch("openai-compatible", fetcher);
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");

    const error = await generateText({ model, prompt: "hello", maxRetries: 0 })
      .then(() => null)
      .catch((caught) => caught);
    expect(
      errorChain(error).some(
        (candidate) =>
          candidate instanceof ProviderAdapterError &&
          candidate.code === "MP_PROVIDER_NETWORK_POLICY",
      ),
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when an environment proxy would be silently ignored by the pinned Agent", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    const model = createProviderModel({
      protocol: "openai-compatible",
      endpoint: "https://provider.example",
      apiKey: secret,
      model: "test-model",
      responseLimitBytes: 8_192,
      timeoutMs: 2_000,
    });

    const error = await generateText({ model, prompt: "hello", maxRetries: 0 })
      .then(() => null)
      .catch((caught) => caught);
    expect(
      errorChain(error).some(
        (candidate) =>
          candidate instanceof ProviderAdapterError &&
          candidate.code === "MP_PROVIDER_NETWORK_POLICY",
      ),
    ).toBe(true);
  });

  it("maps malformed provider endpoints to the stable adapter error code", () => {
    expect(() =>
      normalizeProviderBaseUrl("openai-compatible", "not-a-provider-url"),
    ).toThrow(
      expect.objectContaining({
        code: "MP_PROVIDER_INVALID_ENDPOINT",
      }),
    );
  });

  it("normalizes roots and only recognized terminal routes", () => {
    expect(
      normalizeProviderBaseUrl(
        "openai-compatible",
        "https://tokenrhythm.example",
      ),
    ).toBe("https://tokenrhythm.example/v1");
    expect(
      normalizeProviderBaseUrl(
        "openai-compatible",
        "https://tokenrhythm.example/v1/chat/completions",
      ),
    ).toBe("https://tokenrhythm.example/v1");
    expect(
      normalizeProviderBaseUrl(
        "anthropic-messages",
        "https://anthropic.example",
      ),
    ).toBe("https://anthropic.example/v1");
    expect(
      normalizeProviderBaseUrl(
        "gemini-generate-content",
        "https://gemini.example",
      ),
    ).toBe("https://gemini.example/v1beta");

    expect(
      normalizeProviderBaseUrl(
        "openai-compatible",
        "http://127.0.0.1:9000/v1/chat/completions",
      ),
    ).toBe("http://127.0.0.1:9000/v1");
    process.env.MATCHPLANE_ENVIRONMENT = "production";
    expect(() =>
      normalizeProviderBaseUrl(
        "openai-compatible",
        "http://127.0.0.1:9000/v1/chat/completions",
      ),
    ).toThrow(ProviderAdapterError);
    delete process.env.MATCHPLANE_ENVIRONMENT;

    for (const unsafe of [
      "http://provider.example",
      "https://user:pass@provider.example",
      "https://provider.example/v1?key=secret",
      "https://provider.example/v1#fragment",
      "https://provider.example/private/v1/chat/completions",
      "https://provider.example/v2",
    ]) {
      expect(() =>
        normalizeProviderBaseUrl("openai-compatible", unsafe),
      ).toThrow(ProviderAdapterError);
    }
  });

  it("pins connector lookups to each all-public answer set and rejects rebound answers", async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(["8.8.8.8", "2001:4860:4860::8888"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const lookup = createPinnedProviderLookup(
      new URL("https://router.example.com/v1/chat/completions"),
      resolver,
      undefined,
    );
    const invoke = () =>
      new Promise<readonly { address: string; family: number }[]>(
        (resolve, reject) => {
          lookup("router.example.com", { all: true }, (error, addresses) => {
            if (error) reject(error);
            else resolve(
              addresses as readonly { address: string; family: number }[],
            );
          });
        },
      );

    await expect(invoke()).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    await expect(invoke()).rejects.toBeInstanceOf(ProviderAdapterError);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("blocks special direct IPs without falling back to ordinary global fetch", async () => {
    const ordinaryFetch = vi.fn();
    vi.stubGlobal("fetch", ordinaryFetch);

    for (const endpointUrl of [
      "https://127.0.0.1",
      "https://240.0.0.1",
      "https://[64:ff9b::a9fe:a9fe]",
    ]) {
      const model = createProviderModel({
        protocol: "openai-compatible",
        endpoint: endpointUrl,
        apiKey: secret,
        model: "test-model",
        responseLimitBytes: 8_192,
        timeoutMs: 2_000,
      });

      await expect(
        generateText({ model, prompt: "hello", maxRetries: 0 }),
      ).rejects.toThrow();
    }
    expect(ordinaryFetch).not.toHaveBeenCalled();
  });

  it("fails closed on mixed public/private DNS before the secret-bearing fetch", async () => {
    const fetcher = vi.fn(async () => new Response("{}")) as typeof fetch;
    const model = createProviderModel({
      protocol: "openai-compatible",
      endpoint: "https://provider.example",
      apiKey: secret,
      model: "test-model",
      fetcher,
      resolveAddresses: async () => [
        "8.8.8.8",
        "64:ff9b::a9fe:a9fe",
      ],
      responseLimitBytes: 64 * 1024,
      timeoutMs: 2_000,
    });

    const error = await generateText({
      model,
      prompt: "secret prompt",
      maxRetries: 0,
    })
      .then(() => null)
      .catch((caught) => caught);
    expect(fetcher).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("secret prompt");
  });

  it("records a real Undici redirect without following it", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "/must-not-follow" });
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not bind a TCP port");
    }
    const telemetry: ProviderFetchTelemetry = { phase: "connect" };

    try {
      const model = createProviderModel({
        protocol: "openai-compatible",
        endpoint: `http://127.0.0.1:${address.port}`,
        apiKey: secret,
        model: "test-model",
        responseLimitBytes: 8_192,
        timeoutMs: 2_000,
        telemetry,
      });
      await expect(
        generateText({ model, prompt: "hello", maxRetries: 0 }),
      ).rejects.toThrow();

      expect(requests).toBe(1);
      expect(telemetry).toMatchObject({
        phase: "response",
        responseStatus: 302,
      });
      expect(telemetry.firstByteAt).toEqual(expect.any(Number));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects redirects and oversized bodies with bounded safe errors", async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example" },
      }),
      new Response("x".repeat(65 * 1024), { status: 200 }),
    ]) {
      const model = createProviderModel({
        protocol: "openai-compatible",
        endpoint: "https://provider.example",
        apiKey: secret,
        model: "test-model",
        fetcher: vi.fn(async () => response) as typeof fetch,
        resolveAddresses: publicDns,
        responseLimitBytes: 64 * 1024,
        timeoutMs: 2_000,
      });
      const error = await generateText({
        model,
        prompt: "hidden prompt",
        maxRetries: 0,
      })
        .then(() => null)
        .catch((caught) => caught);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("hidden prompt");
    }
  });

  it("maps a bounded nested Undici cause chain without losing safe policy, redirect, or timeout codes", async () => {
    const failures = [
      {
        expectedCode: "MP_PROVIDER_NETWORK_POLICY",
        leaf: new ProviderAdapterError("MP_PROVIDER_NETWORK_POLICY"),
      },
      {
        expectedCode: "MP_PROVIDER_REDIRECT",
        leaf: new ProviderAdapterError("MP_PROVIDER_REDIRECT", 307),
      },
      {
        expectedCode: "UND_ERR_HEADERS_TIMEOUT",
        leaf: Object.assign(new Error("unsafe upstream timeout detail"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      },
    ];

    for (const { expectedCode, leaf } of failures) {
      const fetcher = vi.fn(async () => {
        throw new TypeError("fetch failed", {
          cause: new TypeError("dispatcher failed", { cause: leaf }),
        });
      }) as typeof fetch;
      const model = modelWithFetch("openai-compatible", fetcher);
      const error = await generateText({
        model,
        prompt: "secret prompt",
        maxRetries: 0,
      })
        .then(() => null)
        .catch((caught) => caught);
      const chain = errorChain(error);
      expect(
        chain.some(
          (candidate) =>
            (candidate as Error & { code?: string }).code === expectedCode,
        ),
      ).toBe(true);
      expect(String(error)).not.toContain("unsafe upstream timeout detail");
      expect(String(error)).not.toContain("secret prompt");
    }
  });

  it("does not await a provider response body whose cancel hook hangs", async () => {
    const controller = new AbortController();
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              readStarted?.();
              return new Promise<void>(() => undefined);
            },
            cancel,
          }),
        ),
    ) as typeof fetch;
    const model = createProviderModel({
      protocol: "openai-compatible",
      endpoint: "https://provider.example",
      apiKey: secret,
      model: "test-model",
      fetcher,
      resolveAddresses: publicDns,
      responseLimitBytes: 64 * 1024,
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    const pending = generateText({ model, prompt: "hello", maxRetries: 0 });
    await started;
    controller.abort();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error: Error) => errorChain(error).map((item) => item.name),
      ),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("hung"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(outcome).not.toBe("hung");
    expect(outcome).toContain("AbortError");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("combines caller abort with the adapter deadline", async () => {
    const controller = new AbortController();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetcher = vi.fn(
      async (_resource: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          markFetchStarted?.();
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    ) as typeof fetch;
    const model = createProviderModel({
      protocol: "openai-compatible",
      endpoint: "https://provider.example",
      apiKey: secret,
      model: "test-model",
      fetcher,
      resolveAddresses: publicDns,
      responseLimitBytes: 64 * 1024,
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    const pending = generateText({ model, prompt: "hello", maxRetries: 0 });
    await fetchStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
