import { describe, expect, it } from "vitest";

import { validateMcpToolArguments } from "./mcp-contract";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const partyId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";

describe("HTTP MCP argument contract", () => {
  it("rejects malformed platform paths before they reach the gateway", () => {
    expect(
      validateMcpToolArguments("platform.match", {
        narrative: "找一个合适的供给",
        platformPath: "/store-a/../private",
      }),
    ).toContain("platformPath");
  });

  it("accepts a bounded retry key for platform routing", () => {
    expect(
      validateMcpToolArguments("platform.match", {
        narrative: "找一个合适的供给",
        platformPath: "/store-a",
        idempotency_key: "chat-123",
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("platform.match", {
        narrative: "找一个合适的供给",
        idempotency_key: "x".repeat(241),
      }),
    ).toContain("idempotency_key");
  });

  it("requires the exact tenant/domain/path scope for marketplace tools", () => {
    expect(
      validateMcpToolArguments("marketplace.intent.create", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        participant_id: partyId,
        side: "demand",
        narrative: "寻找适合我的供给",
        idempotency_key: "intent-1",
      }),
    ).toBeNull();

    expect(
      validateMcpToolArguments("marketplace.intent.create", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        participant_id: partyId,
        side: "demand",
        narrative: "寻找适合我的供给",
        supply_discovery_enabled: true,
        supply_discovery_expires_at: new Date(
          Date.now() + 60_000,
        ).toISOString(),
        idempotency_key: "intent-discoverable",
      }),
    ).toBeNull();

    expect(
      validateMcpToolArguments("marketplace.demand.match", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        participant_id: partyId,
        offer_id: intentId,
        limit: 10,
      }),
    ).toBeNull();

    expect(
      validateMcpToolArguments("marketplace.intent.discovery.update", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        participant_id: partyId,
        intent_id: intentId,
        enabled: false,
      }),
    ).toBeNull();

    expect(
      validateMcpToolArguments("marketplace.intent.create", {
        tenant_id: tenantId,
        domain_id: domainId,
        participant_id: partyId,
        side: "demand",
        narrative: "寻找适合我的供给",
        idempotency_key: "intent-1",
      }),
    ).toContain("platform_path");

    expect(
      validateMcpToolArguments("marketplace.intent.create", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        participant_id: partyId,
        side: "demand",
        narrative: "寻找适合我的供给",
        supply_discovery_enabled: "yes",
        idempotency_key: "intent-invalid-discovery",
      }),
    ).toContain("supply_discovery_enabled");
  });

  it("bounds Agent handoff budgets and keeps them caller-funded", () => {
    const valid = {
      protocol: "matchplane.agent/v1",
      request_id: intentId,
      stage: "platform",
      scope: { platform_path: "/" },
      intent: { narrative: "帮我找供给", requirements: {} },
      agent: { id: "buyer-agent", version: "1", capabilities: ["matching"] },
      budget: {
        max_steps: 4,
        max_input_characters: 8000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    expect(
      validateMcpToolArguments("platform.agent.handoff", valid),
    ).toBeNull();
    expect(
      validateMcpToolArguments("platform.agent.handoff", {
        ...valid,
        budget: { ...valid.budget, cost_bearer: "platform" },
      }),
    ).toContain("cost_bearer");
    expect(
      validateMcpToolArguments("platform.agent.handoff", {
        ...valid,
        budget: { ...valid.budget, max_steps: 17 },
      }),
    ).toContain("max_steps");
    expect(
      validateMcpToolArguments("platform.agent.handoff", {
        ...valid,
        stage: "profile.compatibility",
      }),
    ).toBeNull();
  });

  it("validates child MCP tool calls without accepting arbitrary endpoints", () => {
    expect(
      validateMcpToolArguments("platform.child.tool", {
        platform_path: "/store-a",
        tool_name: "inventory.search",
        arguments: { narrative: "适合城市通勤" },
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("platform.child.tool", {
        platform_path: "/store-a",
        tool_name: "inventory/search",
        arguments: {},
      }),
    ).toContain("tool_name");
    expect(
      validateMcpToolArguments("platform.child.tool", {
        platform_path: "/store-a",
        tool_name: "inventory.search",
        endpoint: "https://attacker.example/mcp",
        arguments: {},
      }),
    ).toBeNull();
  });

  it("validates the first-class retrieval MCP envelope and keeps it child-scoped", () => {
    const query = {
      protocol: "matchplane.retrieval/v1",
      request_id: intentId,
      scope: {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
      },
      input: {
        narrative: "预算内、适合通勤的方案",
        requirements: { energy: "hybrid" },
      },
      limit: 10,
    };
    expect(
      validateMcpToolArguments("platform.retrieval.query", query),
    ).toBeNull();
    expect(
      validateMcpToolArguments("platform.retrieval.query", {
        ...query,
        scope: { ...query.scope, platform_path: "/" },
      }),
    ).toContain("active child");
    expect(
      validateMcpToolArguments("platform.retrieval.query", {
        ...query,
        endpoint: "https://attacker.example/mcp",
      }),
    ).toContain("unsupported field");
    expect(
      validateMcpToolArguments("platform.retrieval.query", {
        ...query,
        protocol: "matchplane.retrieval/v2",
      }),
    ).toContain("matchplane.retrieval/v1");
  });

  it("rejects invalid generic introduction payloads", () => {
    expect(
      validateMcpToolArguments("marketplace.introduction.create", {
        tenant_id: tenantId,
        domain_id: domainId,
        platform_path: "/store-a",
        intent_id: intentId,
        offer_id: "not-a-uuid",
        participant_id: partyId,
        score: 0.8,
        idempotency_key: "intro-1",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toContain("offer_id");
  });

  it("requires optimistic versions for offer updates and withdrawals", () => {
    const common = {
      tenant_id: tenantId,
      domain_id: domainId,
      platform_path: "/store-a",
      supply_party_id: partyId,
      offer_id: intentId,
      expected_version: 3,
    };
    expect(
      validateMcpToolArguments("marketplace.offer.update", {
        ...common,
        display_name: "城市通勤方案",
        attributes: { category: "transport" },
        terms: { amount_minor: "1234", currency: "CNY" },
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.offer.withdraw", common),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.offer.withdraw", {
        ...common,
        expected_version: 0,
      }),
    ).toContain("expected_version");
    expect(
      validateMcpToolArguments("marketplace.offer.update", {
        ...common,
        display_name: "城市通勤方案",
        attributes: [],
        terms: {},
      }),
    ).toContain("attributes");
  });

  it("validates the V1 profile, evidence, preference, and handoff tools", () => {
    const common = {
      tenant_id: tenantId,
      domain_id: domainId,
      platform_path: "/store-a",
      participant_id: partyId,
    };
    expect(
      validateMcpToolArguments("marketplace.intent.update", {
        ...common,
        intent_id: intentId,
        narrative: "补充一个不能妥协的条件",
        expected_version: 2,
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.profile.upsert", {
        ...common,
        profile: { goals: ["fit"] },
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.behavior.record", {
        ...common,
        offer_id: intentId,
        event_type: "offer.dismiss",
        reason: "not_a_fit",
        metadata: {},
        idempotency_key: "event-1",
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.preference.set", {
        ...common,
        offer_id: intentId,
        state: "saved",
      }),
    ).toBeNull();
    expect(
      validateMcpToolArguments("marketplace.sales.handoff", {
        ...common,
        summary: { selected: intentId },
        idempotency_key: "handoff-1",
      }),
    ).toBeNull();
  });
});
