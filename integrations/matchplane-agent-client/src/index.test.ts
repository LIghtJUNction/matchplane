import { describe, expect, it } from "bun:test";

import {
  MatchPlaneAgentClient,
  MatchPlaneMcpError,
  runBoundedAgentSkill,
  type AgentSkillRequest,
} from "./index";

function fakeFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "tools/call" && body.params?.name === "marketplace.agent.session") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { structuredContent: { tenant_id: "t", domain_id: "d", party_id: "p", side: "demand", role: "buyer", access_token: "secret", access_token_expires_at: "2099-01-01T00:00:00Z", cost_bearer: "caller" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { structuredContent: { ok: true } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("MatchPlane external Agent client", () => {
  it("uses one MCP client shape for buyer and seller capability exchange", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({ baseUrl: "https://matx.tech", apiKey: "mpk_test", fetchImpl: fake.fetchImpl });
    const capability = await client.openMarketplaceSession({
      tenant_id: "tenant",
      domain_id: "domain",
      platform_path: "/used-car",
      side: "demand",
    });
    expect(capability.role).toBe("buyer");
    expect(capability.access_token_expires_at).toBe("2099-01-01T00:00:00Z");
    expect(fake.calls[0]?.url).toBe("https://matx.tech/api/mcp");
    expect(new Headers(fake.calls[0]?.init?.headers).get("x-matchplane-api-key")).toBe("mpk_test");

    await client.createIntent(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      participant_id: "p",
      side: "demand",
      narrative: "找一个合适的供给",
      idempotency_key: "intent-1",
    });
    expect(new Headers(fake.calls[1]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const secondBody = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      params?: { arguments?: { platform_path?: string } };
    };
    expect(secondBody.params?.arguments?.platform_path).toBe("/used-car");

    await client.requestContact(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      introduction_id: "intro",
      participant_id: "p",
      idempotency_key: "contact-request-1",
    });
    const contactBody = JSON.parse(String(fake.calls[2]?.init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(contactBody.params?.name).toBe("marketplace.introduction.contact.request");
    expect(contactBody.params?.arguments?.platform_path).toBe("/used-car");

    await client.consentContact(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      introduction_id: "intro",
      participant_id: "p",
      idempotency_key: "contact-consent-1",
    });
    await client.releaseContact(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      introduction_id: "intro",
      participant_id: "p",
      idempotency_key: "contact-release-1",
    });
    expect(fake.calls).toHaveLength(5);
  });

  it("rejects platform-funded external handoffs before a network call", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({ baseUrl: "https://matx.tech", apiKey: "mpk_test", fetchImpl: fake.fetchImpl });
    await expect(client.handoff({
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "找供给", requirements: {} },
      agent: { id: "buyer.example", version: "1.0.0", capabilities: ["search"] },
      budget: { max_steps: 8, max_input_characters: 24_000, max_output_tokens: 512, cost_bearer: "platform" as unknown as "caller" },
    })).rejects.toThrow("caller-funded");
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces structured MCP tool failures", async () => {
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { isError: true, structuredContent: { error: "scope denied" } },
      }), { status: 200 }),
    });
    await expect(client.listTools()).rejects.toBeInstanceOf(MatchPlaneMcpError);
  });

  it("runs a caller-funded multi-step Skill only through its advertised MCP tools", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "inventory",
      scope: { platform_path: "/used-car" },
      intent: { narrative: "找符合约束的供给", requirements: { budget: 100000 } },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: { max_steps: 3, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    const calls: string[] = [];
    let decisionCount = 0;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "buyer.example", version: "1.0.0", model: "caller-model" },
      decide: async ({ history }) => {
        decisionCount += 1;
        if (!history.length) return { type: "tool", tool: "inventory.search", arguments: { budget: 100000 } };
        return { type: "complete", selected: [{ ref: "offer-1", score: 0.92, reasons: ["预算匹配"] }] };
      },
      callTool: async ({ tool }) => {
        calls.push(tool);
        return { refs: ["offer-1"] };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.degraded).toBe(false);
    expect(result.steps[0]?.status).toBe("completed");
    expect(result.steps[0]?.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.selected[0]?.ref).toBe("offer-1");
    expect(decisionCount).toBe(2);
    expect(calls).toEqual(["inventory.search"]);
  });

  it("rejects a tool outside the Skill allowlist before invoking the executor", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "merchant",
      scope: { platform_path: "/used-car" },
      intent: { narrative: "找供给方", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["merchant.search"],
      budget: { max_steps: 2, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    let called = false;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "seller.example", version: "1.0.0" },
      decide: async () => ({ type: "tool", tool: "payment.refund", arguments: {} }),
      callTool: async () => {
        called = true;
        return {};
      },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("tool_not_allowed:payment.refund");
    expect(called).toBe(false);
  });

  it("stops at the caller step budget and never exceeds the declared loop", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "选择平台", requirements: {} },
      skill: "matchplane.route.v1",
      allowed_mcp_tools: ["platform.search"],
      budget: { max_steps: 2, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    let calls = 0;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "router.example", version: "1.0.0" },
      decide: async () => ({ type: "tool", tool: "platform.search", arguments: { query: "供给" } }),
      callTool: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("step_budget_exceeded");
    expect(result.steps).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("keeps the verified budget and tool set stable when callbacks try to mutate them", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "inventory",
      scope: { platform_path: "/used-car" },
      intent: { narrative: "验证预算边界", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: { max_steps: 1, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    let calls = 0;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async ({ request: callbackRequest }) => {
        try {
          callbackRequest.budget.max_steps = 16;
          callbackRequest.allowed_mcp_tools.push("payment.refund");
        } catch {
          // The runner intentionally freezes the callback view.
        }
        return { type: "tool", tool: "inventory.search", arguments: {} };
      },
      callTool: async () => {
        calls += 1;
        return {};
      },
    });

    expect(result.reason).toBe("step_budget_exceeded");
    expect(result.budget.max_steps).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("returns bounded rejected results for malformed runtime inputs and reasons", async () => {
    const malformed = await runBoundedAgentSkill(
      null as unknown as AgentSkillRequest,
      null as unknown as Parameters<typeof runBoundedAgentSkill>[1],
    );
    expect(malformed.status).toBe("rejected");
    expect(malformed.request_id).toBe("00000000-0000-4000-8000-000000000000");

    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "验证错误原因", requirements: {} },
      skill: "matchplane.route.v1",
      allowed_mcp_tools: [],
      budget: { max_steps: 1, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    const rejected = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async () => ({ type: "reject", reason: 123 } as unknown as ReturnType<NonNullable<Parameters<typeof runBoundedAgentSkill>[1]["decide"]>>),
      callTool: async () => ({}),
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toBe("agent skill failed");
  });

  it("returns when the caller deadline aborts a hung model callback", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "验证超时", requirements: {} },
      skill: "matchplane.route.v1",
      allowed_mcp_tools: [],
      budget: { max_steps: 1, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      timeout_ms: 5,
      decide: async () => new Promise(() => {}),
      callTool: async () => ({}),
    });
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("skill_timeout");
  });

  it("treats an MCP isError result as a failed tool step", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "inventory",
      scope: { platform_path: "/used-car" },
      intent: { narrative: "验证 MCP 错误", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: { max_steps: 1, max_input_characters: 4000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async () => ({ type: "tool", tool: "inventory.search", arguments: {} }),
      callTool: async () => ({ isError: true, structuredContent: { error: "upstream unavailable" } }),
    });
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("tool_failed");
    expect(result.steps[0]?.status).toBe("failed");
  });
});
