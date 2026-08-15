import { describe, expect, it } from "bun:test";

import { MatchPlaneAgentClient, MatchPlaneMcpError } from "./index";

function fakeFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "tools/call" && body.params?.name === "marketplace.agent.session") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { structuredContent: { tenant_id: "t", domain_id: "d", party_id: "p", role: "buyer", access_token: "secret", cost_bearer: "caller" } },
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
      role: "buyer",
    });
    expect(capability.role).toBe("buyer");
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
});
