import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decidePlatformRoutes,
  PlatformRouterQuotaExceededError,
  probePlatformRouter,
  type PlatformRouteCandidate,
} from "./platform-router";

const candidates: PlatformRouteCandidate[] = [
  {
    slug: "used-car",
    path: "/used-car",
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.MATCHPLANE_ROUTER_AI_URL;
  delete process.env.MATCHPLANE_ROUTER_AI_KEY;
  delete process.env.MATCHPLANE_ROUTER_AI_MODEL;
  delete process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS;
  delete process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE;
  delete process.env.MATCHPLANE_ENVIRONMENT;
});

describe("platform Agent router", () => {
  it("probes the configured provider with a fixed one-token request", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await probePlatformRouter({ fetcher: fetchMock as unknown as typeof fetch });

    expect(result).toMatchObject({ status: "ready", model: "router-test", responseStatus: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.max_tokens).toBe(1);
    expect(body.messages).toEqual([
      { role: "system", content: "Respond with one short token." },
      { role: "user", content: "healthcheck" },
    ]);
  });

  it("reports an unconfigured provider without making a network request", async () => {
    const fetchMock = vi.fn();
    const result = await probePlatformRouter({ fetcher: fetchMock as unknown as typeof fetch });

    expect(result.status).toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limits AI choices to the authorized child candidate set and records usage", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        selectedSlugs: ["electronics", "not-registered", "electronics"],
        rationale: "用户描述了电子设备需求",
        confidence: 0.82,
      }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decidePlatformRoutes({
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
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer server-only-key" }),
    }));
  });

  it("falls back explicitly when the provider is unavailable", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));

    const decision = await decidePlatformRoutes({
      platformPath: "/",
      narrative: "帮我找合适的供给",
      candidates,
    });

    expect(decision.selectedSlugs).toEqual(["used-car", "electronics"]);
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

    const decision = await decidePlatformRoutes({
      platformPath: "/",
      narrative: "帮我找合适的供给",
      candidates,
    });

    expect(decision.source).toBe("policy_fallback");
    expect(decision.degraded).toBe(true);
    expect(decision.rationale).toContain("AI 路由降级");
  });

  it("reserves a provider call before paying for it", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const admitCall = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ selectedSlugs: ["used-car"] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await decidePlatformRoutes({
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
      expect(body.tools?.[0]?.function?.name).toBe("matchplane.platform.select_children");
      expect(body.tools?.[0]?.function?.parameters?.properties?.selectedSlugs).toBeDefined();
      expect(body.response_format).toBeUndefined();
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "matchplane.platform.select_children",
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

    const decision = await decidePlatformRoutes({
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
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ selectedSlugs: ["used-car"] }) } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decidePlatformRoutes({
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

    await expect(decidePlatformRoutes({
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

    const decision = await decidePlatformRoutes({
      platformPath: "/",
      narrative: "找商品",
      candidates,
      deadlineAt: Date.now() - 1,
    });

    expect(decision.source).toBe("policy_fallback");
    expect(decision.rationale).toContain("总时限");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps each provider hop even when the recursive deadline has more time", async () => {
    process.env.MATCHPLANE_ROUTER_AI_URL = "http://127.0.0.1:9000/v1/chat/completions";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "server-only-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "router-test";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ selectedSlugs: ["used-car"] }) } }],
    }), { status: 200 })));

    const decision = await decidePlatformRoutes({
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

    const decision = await decidePlatformRoutes({
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
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          selectedSlugs: ["used-car"],
          rationale: "受控候选",
          confidence: 0.5,
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decidePlatformRoutes({
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
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ selectedSlugs: ["child-39"] }) } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const decision = await decidePlatformRoutes({
      platformPath: "/",
      narrative: "我想找摄影服务",
      candidates: manyCandidates,
    });

    expect(decision.selectedSlugs).toEqual(["child-39"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
