import { describe, expect, it } from "vitest";

import { validateMcpToolArguments } from "./mcp-contract";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const partyId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";

describe("HTTP MCP argument contract", () => {
  it("rejects malformed platform paths before they reach the gateway", () => {
    expect(validateMcpToolArguments("platform.match", {
      narrative: "找一个合适的供给",
      platformPath: "/used-car/../private",
    })).toContain("platformPath");
  });

  it("accepts a bounded retry key for platform routing", () => {
    expect(validateMcpToolArguments("platform.match", {
      narrative: "找一个合适的供给",
      platformPath: "/used-car",
      idempotency_key: "chat-123",
    })).toBeNull();
    expect(validateMcpToolArguments("platform.match", {
      narrative: "找一个合适的供给",
      idempotency_key: "x".repeat(241),
    })).toContain("idempotency_key");
  });

  it("requires the exact tenant/domain/path scope for marketplace tools", () => {
    expect(validateMcpToolArguments("marketplace.intent.create", {
      tenant_id: tenantId,
      domain_id: domainId,
      platform_path: "/used-car",
      participant_id: partyId,
      side: "demand",
      narrative: "寻找适合我的供给",
      idempotency_key: "intent-1",
    })).toBeNull();

    expect(validateMcpToolArguments("marketplace.intent.create", {
      tenant_id: tenantId,
      domain_id: domainId,
      participant_id: partyId,
      side: "demand",
      narrative: "寻找适合我的供给",
      idempotency_key: "intent-1",
    })).toContain("platform_path");
  });

  it("bounds Agent handoff budgets and keeps them caller-funded", () => {
    const valid = {
      protocol: "matchplane.agent/v1",
      request_id: intentId,
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "帮我找供给", requirements: {} },
      agent: { id: "buyer-agent", version: "1", capabilities: ["matching"] },
      budget: { max_steps: 4, max_input_characters: 8000, max_output_tokens: 512, cost_bearer: "caller" },
    };
    expect(validateMcpToolArguments("platform.agent.handoff", valid)).toBeNull();
    expect(validateMcpToolArguments("platform.agent.handoff", {
      ...valid,
      budget: { ...valid.budget, cost_bearer: "platform" },
    })).toContain("cost_bearer");
    expect(validateMcpToolArguments("platform.agent.handoff", {
      ...valid,
      budget: { ...valid.budget, max_steps: 17 },
    })).toContain("max_steps");
    expect(validateMcpToolArguments("platform.agent.handoff", {
      ...valid,
      stage: "profile.compatibility",
    })).toBeNull();
  });

  it("validates child MCP tool calls without accepting arbitrary endpoints", () => {
    expect(validateMcpToolArguments("platform.child.tool", {
      platform_path: "/used-car",
      tool_name: "inventory.search",
      arguments: { narrative: "适合城市通勤" },
    })).toBeNull();
    expect(validateMcpToolArguments("platform.child.tool", {
      platform_path: "/used-car",
      tool_name: "inventory/search",
      arguments: {},
    })).toContain("tool_name");
    expect(validateMcpToolArguments("platform.child.tool", {
      platform_path: "/used-car",
      tool_name: "inventory.search",
      endpoint: "https://attacker.example/mcp",
      arguments: {},
    })).toBeNull();
  });

  it("rejects invalid generic introduction payloads", () => {
    expect(validateMcpToolArguments("marketplace.introduction.create", {
      tenant_id: tenantId,
      domain_id: domainId,
      platform_path: "/used-car",
      intent_id: intentId,
      offer_id: "not-a-uuid",
      participant_id: partyId,
      score: 0.8,
      idempotency_key: "intro-1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })).toContain("offer_id");
  });
});
