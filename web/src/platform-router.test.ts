import { afterEach, describe, expect, it, vi } from "vitest";

import { decidePlatformRoutes, type PlatformRouteCandidate } from "./platform-router";

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
  delete process.env.MATCHPLANE_ROUTER_AI_URL;
  delete process.env.MATCHPLANE_ROUTER_AI_KEY;
  delete process.env.MATCHPLANE_ROUTER_AI_MODEL;
  delete process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS;
});

describe("platform Agent router", () => {
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
});
