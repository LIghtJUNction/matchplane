import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decidePlatformRoutes,
  PlatformRouterQuotaExceededError,
  probePlatformRouter,
  type PlatformRouteCandidate,
} from "./platform-router";

function openAiTextCompletion(
  content: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
) {
  return {
    id: "chatcmpl_router_fixture",
    object: "chat.completion",
    created: 1,
    model: "router-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

const publicDns = async () => ["8.8.8.8"] as const;

function decideRoutes(
  input: Parameters<typeof decidePlatformRoutes>[0],
) {
  return decidePlatformRoutes({
    ...input,
    fetcher: globalThis.fetch,
    resolveAddresses: publicDns,
  });
}

function probeRouter(
  options: NonNullable<Parameters<typeof probePlatformRouter>[0]> = {},
) {
  return probePlatformRouter({
    ...options,
    resolveAddresses: publicDns,
  });
}

const candidates: PlatformRouteCandidate[] = [
  {
    slug: "store-a",
    path: "/store-a",
    displayName: "二手车商城",
    description: "车辆交易",
    capabilities: ["demand", "supply"],
    agentStages: ["merchant", "inventory"],
    agentSkills: ["matchplane.matching.v1"],
    depth: 1,
  },
  {
    slug: "electronics",
    path: "/electronics",
    displayName: "电子产品商城",
    description: "消费电子",
    capabilities: ["demand", "supply"],
    agentStages: ["merchant", "inventory"],
    agentSkills: ["matchplane.matching.v1"],
    depth: 1,
  },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.MATCHPLANE_ROUTER_AI_URL;
  delete process.env.MATCHPLANE_ROUTER_AI_KEY;
  delete process.env.MATCHPLANE_ROUTER_AI_MODEL;
  delete process.env.MATCHPLANE_ROUTER_AI_PROTOCOL;
  delete process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS;
  delete process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE;
  delete process.env.MATCHPLANE_ENVIRONMENT;
});

describe("platform Agent router", () => {
  it("probes the configured provider with a compact plain-text request", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await probeRouter({ fetcher: fetchMock as unknown as typeof fetch });

    expect(result).toMatchObject({ status: "ready", model: "router-test", responseStatus: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(8);
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "Respond with one short token." },
      { role: "user", content: "healthcheck" },
    ]);
  });

  it("reports a provider that responds beyond the performance budget as slow, not unreachable", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fetchMock = vi.fn(async () => {
      now.mockReturnValue(5_000);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
      performanceBudgetMs: 4_000,
      timeoutMs: 20_000,
      requestId: "probe-slow",
    });

    expect(result).toMatchObject({
      status: "slow",
      outcome: "slow",
      firstByteLatencyMs: 5_000,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
    });
  });

  it("reports an unreachable provider separately from a slow response", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND private.internal");
    });

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      outcome: "unreachable",
      phase: "connect",
    });
    expect(result.message).not.toContain("private.internal");
  });

  it("classifies an ambiguous SDK base path as a network-policy failure", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/private/provider";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn();

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      outcome: "network_policy",
      phase: "connect",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a denied redirect as a response-phase network policy failure", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/secret" },
        }),
    );

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      outcome: "network_policy",
      phase: "response",
      responseStatus: 302,
    });
    expect(result.firstByteLatencyMs).not.toBeNull();
  });

  it("classifies an SDK-wrapped response limit without retaining the body", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(
      async () =>
        new Response("x".repeat(70 * 1024), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      outcome: "malformed_response",
      phase: "response",
      responseStatus: 200,
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(128));
  });

  it("classifies a hard deadline before provider headers as a first-byte timeout", async () => {
    vi.useFakeTimers();
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
      timeoutMs: 1_000,
      performanceBudgetMs: 500,
    });
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;

    expect(result).toMatchObject({
      status: "failed",
      outcome: "first_byte_timeout",
      phase: "first_byte",
      hardTimeoutMs: 1_000,
    });
  });

  it.each([200, 429, 503])(
    "classifies a deadline while reading an HTTP %i body as a total timeout",
    async (responseStatus) => {
      vi.useFakeTimers();
      process.env.MATCHPLANE_ROUTER_AI_URL =
        "https://router.example.com/v1/chat/completions";
      process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
      process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: responseStatus,
          headers: { "content-type": "application/json" },
        });
      });

      const pending = probeRouter({
        fetcher: fetchMock as unknown as typeof fetch,
        timeoutMs: 1_000,
        performanceBudgetMs: 500,
      });
      await vi.advanceTimersByTimeAsync(1_001);
      const result = await pending;

      expect(result).toMatchObject({
        status: "failed",
        outcome: "total_timeout",
        phase: "total",
        responseStatus,
      });
    },
  );

  it("classifies Undici's headers timeout as a first-byte timeout", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error("unsafe upstream detail"), {
        code: "UND_ERR_HEADERS_TIMEOUT",
      });
    });

    const result = await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "failed",
      outcome: "first_byte_timeout",
      phase: "first_byte",
      responseStatus: null,
    });
    expect(result.message).not.toContain("unsafe upstream detail");
  });

  it("logs only bounded provider metadata", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL =
      "https://router.example.com/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await probeRouter({
      fetcher: fetchMock as unknown as typeof fetch,
      requestId: "safe-request-id",
    });

    const logged = stderr.mock.calls.flat().join(" ");
    expect(logged).toContain('"origin":"https://router.example.com"');
    expect(logged).toContain('"requestId":"safe-request-id"');
    expect(logged).not.toContain("server-only-key");
    expect(logged).not.toContain("/v1/chat/completions");
    expect(logged).not.toContain("choices");
  });

  it("uses the Anthropic Messages protocol without exposing a bearer credential", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "https://api.anthropic.com/v1/messages";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "claude-test";
    process.env.MATCHPLANE_ROUTER_AI_PROTOCOL = "anthropic-messages";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key"), "anthropic api key").toBe(
        "server-only-key",
      );
      expect(headers.get("anthropic-version"), "anthropic version").toBe(
        "2023-06-01",
      );
      expect(headers.get("authorization"), "anthropic bearer absence").toBeNull();
      expect(body.model, "anthropic model").toBe("claude-test");
      expect(
        typeof body.system === "string" || Array.isArray(body.system),
        "anthropic system shape",
      ).toBe(true);
      expect(body.messages, "anthropic messages").toEqual([
        expect.objectContaining({ role: "user" }),
      ]);
      expect(body.tools, "anthropic tools").toEqual([
        expect.objectContaining({
          name: "matchplane_platform_select_children",
        }),
      ]);
      return new Response(
        JSON.stringify({
          id: "msg_router_fixture",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [
            {
              type: "tool_use",
              id: "tool_router_fixture",
              name: "matchplane_platform_select_children",
              input: {
                selectedSlugs: ["electronics"],
                rationale: "消费电子",
                confidence: 0.9,
              },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "我想买一台轻薄笔记本",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["electronics"]);
    expect(decision.routeMechanism).toBe("mcp_tool");
    expect(decision.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("uses the Gemini GenerateContent protocol and model-scoped endpoint", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "https://generativelanguage.googleapis.com/v1beta";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "gemini-2.0-flash";
    process.env.MATCHPLANE_ROUTER_AI_PROTOCOL = "gemini-generate-content";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url), "gemini request target").toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key"), "gemini api key").toBe(
        "server-only-key",
      );
      expect(headers.get("authorization"), "gemini bearer absence").toBeNull();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.contents, "gemini contents").toEqual([
        expect.objectContaining({ role: "user" }),
      ]);
      expect(body.tools, "gemini tools").toEqual([
        expect.objectContaining({ functionDeclarations: expect.any(Array) }),
      ]);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "matchplane_platform_select_children",
                      args: {
                        selectedSlugs: ["store-a"],
                        rationale: "车辆",
                        confidence: 0.86,
                      },
                    },
                  },
                ],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 6,
            totalTokenCount: 17,
          },
          modelVersion: "gemini-2.0-flash",
          responseId: "gemini_router_fixture",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "我想找一台二手车",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["store-a"]);
    expect(decision.routeMechanism).toBe("mcp_tool");
    expect(decision.usage).toEqual({ promptTokens: 11, completionTokens: 6, totalTokens: 17 });
  });

  it("reports an unconfigured provider without making a network request", async () => {
    const fetchMock = vi.fn();
    const result = await probeRouter({ fetcher: fetchMock as unknown as typeof fetch });

    expect(result.status).toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported provider protocol", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    process.env.MATCHPLANE_ROUTER_AI_PROTOCOL = "made-up-protocol";
    const fetchMock = vi.fn();

    const result = await probeRouter({ fetcher: fetchMock as unknown as typeof fetch });

    expect(result.status).toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits AI choices to the authorized child candidate set and records usage", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(
      async (_resource: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            openAiTextCompletion(
              JSON.stringify({
                selectedSlugs: [
                  "electronics",
                  "not-registered",
                  "electronics",
                ],
                rationale: "用户描述了电子设备需求",
                confidence: 0.82,
              }),
              {
                prompt_tokens: 40,
                completion_tokens: 12,
                total_tokens: 52,
              },
            ),
          ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "我需要一台轻薄的笔记本电脑",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["electronics"]);
    expect(decision.source).toBe("ai");
    expect(decision.routeMechanism).toBe("structured_json");
    expect(decision.costBearer).toBe("platform");
    expect(decision.usage?.totalTokens).toBe(52);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "http://127.0.0.1:9000/v1/chat/completions",
    );
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer server-only-key",
    );
  });

  it("falls back explicitly when the provider is unavailable", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "帮我找合适的供给",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["store-a", "electronics"]);
    expect(decision.source).toBe("policy_fallback");
    expect(decision.degraded).toBe(true);
    expect(decision.costBearer).toBe("platform");
  });

  it("fails closed when a provider response exceeds the bounded response budget", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ payload: "x".repeat(300 * 1024) }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "帮我找合适的供给",
      candidates,
    });

    expect(decision.source).toBe("policy_fallback");
    expect(decision.degraded).toBe(true);
    expect(decision.rationale).toContain("搜索暂时降级");
  });

  it("reserves a provider call before paying for it", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const admitCall = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ selectedSlugs: ["store-a"] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await decideRoutes({
      platformPath: "/",
      narrative: "找商品",
      candidates,
      admitCall,
    });

    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the bounded MCP-compatible selection tool and still filters its arguments", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>;
        response_format?: unknown;
      };
      expect(body.tools?.[0]?.function?.name).toBe("matchplane_platform_select_children");
      expect(body.tools?.[0]?.function?.parameters?.properties?.selectedSlugs).toBeDefined();
      expect(body.response_format).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "matchplane_platform_select_children",
                arguments: JSON.stringify({
                  selectedSlugs: ["electronics", "not-registered"],
                  rationale: "需求更接近消费电子",
                  confidence: 0.91,
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 48, completion_tokens: 18, total_tokens: 66 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "我想买一台轻薄笔记本",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["electronics"]);
    expect(decision.routeMechanism).toBe("mcp_tool");
    expect(decision.usage?.totalTokens).toBe(66);
  });

  it("can disable tool calls for providers that only support JSON mode", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE = "disabled";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; response_format?: unknown };
      expect(body.tools).toBeUndefined();
      expect(body.response_format).toEqual({ type: "json_object" });
      return new Response(
        JSON.stringify(
          openAiTextCompletion(
            JSON.stringify({ selectedSlugs: ["store-a"] }),
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "找一台车",
      candidates,
    });

    expect(decision.routeMechanism).toBe("structured_json");
  });

  it("does not turn an exhausted platform budget into a provider call", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(decideRoutes({
      platformPath: "/",
      narrative: "找商品",
      candidates,
      admitCall: async () => { throw new PlatformRouterQuotaExceededError(); },
    })).rejects.toBeInstanceOf(PlatformRouterQuotaExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the shared request deadline before admitting another provider call", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "找商品",
      candidates,
      deadlineAt: Date.now() - 1,
    });

    expect(decision.source).toBe("policy_fallback");
    expect(decision.rationale).toContain("请求时限");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps each provider hop even when the recursive deadline has more time", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            openAiTextCompletion(
              JSON.stringify({ selectedSlugs: ["store-a"] }),
            ),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "找一台车",
      candidates,
      deadlineAt: Date.now() + 20_000,
    });

    expect(decision.source).toBe("ai");
    expect(timeoutSpy).toHaveBeenCalledWith(4_000);
  });

  it("does not call an insecure provider endpoint in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://router.internal/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "找商品",
      candidates,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(decision.source).toBe("policy_fallback");
    expect(decision.degraded).toBe(true);
  });

  it("bounds provider input while keeping the platform cost budget explicit", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS = "4096";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content?: unknown }>;
        max_tokens: number;
      };
      const userContent = body.messages[1]?.content;
      expect(typeof userContent).toBe("string");
      expect(String(userContent).length).toBeLessThanOrEqual(24_000);
      expect(() => JSON.parse(String(userContent))).not.toThrow();
      expect(body.max_tokens).toBe(2_048);
      return new Response(
        JSON.stringify(
          openAiTextCompletion(
            JSON.stringify({
              selectedSlugs: ["store-a"],
              rationale: "受控候选",
              confidence: 0.5,
            }),
            {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "x".repeat(10_000),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        description: "很长的候选描述".repeat(10_000),
        capabilities: ["capability".repeat(100)],
      })),
    });

    expect(decision.costBearer).toBe("platform");
    expect(decision.budget.maxInputCharacters).toBe(24_000);
    expect(decision.budget.maxOutputTokens).toBe(2_048);
    expect(decision.usage?.totalTokens).toBe(120);
  });

  it("does not starve children after the provider window when a later child is relevant", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const manyCandidates = Array.from({ length: 40 }, (_, index): PlatformRouteCandidate => ({
      slug: `child-${index}`,
      path: `/child-${index}`,
      displayName: index === 39 ? "摄影平台" : `平台 ${index}`,
      description: index === 39 ? "摄影器材与服务" : "通用供给",
      capabilities: ["demand", "supply"],
      agentStages: ["participant", "offering"],
      agentSkills: ["matchplane.matching.v1"],
      depth: 1,
    }));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: unknown }> };
      const content = JSON.parse(String(body.messages[1]?.content)) as { candidates?: Array<{ slug?: string }> };
      expect(content.candidates?.some((candidate) => candidate.slug === "child-39")).toBe(true);
      return new Response(
        JSON.stringify(
          openAiTextCompletion(
            JSON.stringify({ selectedSlugs: ["child-39"] }),
          ),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decideRoutes({
      platformPath: "/",
      narrative: "我想找摄影服务",
      candidates: manyCandidates,
    });

    expect(decision.selectedSlugs).toEqual(["child-39"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
