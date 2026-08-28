import { describe, expect, it } from "bun:test";

import {
  MatchPlaneAgentClient,
  MatchPlaneMcpError,
  routePlanPaths,
  runBoundedAgentSkill,
  terminalRoutePlanPaths,
  type AgentSkillRequest,
} from "./index";

function fakeFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (
      body.method === "tools/call" &&
      body.params?.name === "marketplace.agent.session"
    ) {
      const args = body.params.arguments ?? {};
      const side = args.side === "supply" ? "supply" : "demand";
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            structuredContent: {
              tenant_id: args.tenant_id,
              domain_id: args.domain_id,
              party_id: "p",
              side,
              role: side === "demand" ? "buyer" : "seller",
              access_token: "party-token-secret",
              access_token_expires_at: "2099-01-01T00:00:00Z",
              platform_path: args.platform_path,
              cost_bearer: "caller",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        result: { structuredContent: { ok: true } },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { fetchImpl, calls };
}

describe("MatchPlane external Agent client", () => {
  it("distinguishes the starting path from selected child paths", () => {
    const result = {
      requestId: "request",
      platformPath: "/",
      status: "delegated",
      routePlan: [
        { path: "/store-a" },
        { path: "/store-a/premium" },
        { path: "not-a-path" },
      ],
      routing: {},
    };
    expect(routePlanPaths(result)).toEqual(["/store-a", "/store-a/premium"]);
    expect(terminalRoutePlanPaths(result)).toEqual(["/store-a/premium"]);
  });

  it("routes a caller-funded narrative through the platform tree", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });

    const result = await client.routePlatformIntent({
      narrative: "帮我找到适合通勤的方案",
      platform_path: "/store-a",
      idempotency_key: "route-1",
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(String(fake.calls[0]?.init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(body.params?.name).toBe("platform.match");
    expect(body.params?.arguments?.narrative).toBe("帮我找到适合通勤的方案");
    expect(body.params?.arguments?.platformPath).toBe("/store-a");
    expect(body.params?.arguments?.idempotency_key).toBe("route-1");
  });

  it("rejects an empty platform route before contacting the gateway", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    await expect(
      client.routePlatformIntent({ narrative: "   " }),
    ).rejects.toThrow("narrative is required");
    expect(fake.calls).toHaveLength(0);
  });

  it("wraps child tools and parses the retrieval ABI without leaking provider details into the client", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const requestId = "123e4567-e89b-12d3-a456-426614174004";
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body)) as {
        scope?: { platform_path?: string };
        limit?: number;
        input?: { narrative?: string };
      };
      const retrieval = {
        protocol: "matchplane.retrieval/v1",
        request_id: requestId,
        provider: { id: "store-a.search", version: "2026.08", model: null },
        candidates: [
          {
            asset_id: "123e4567-e89b-12d3-a456-426614174002",
            offer_id: "123e4567-e89b-12d3-a456-426614174003",
            display_name: "通勤方案",
            score: 0.91,
            reasons: ["预算匹配"],
          },
        ],
        degraded: false,
      };
      expect(String(url)).toBe(
        "https://matx.tech/api/platform/retrieval/query",
      );
      expect(body.scope?.platform_path).toBe("/store-a");
      expect(body.input?.narrative).toBe("预算内的通勤方案");
      expect(body.limit).toBe(2);
      return new Response(JSON.stringify(retrieval), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl,
    });

    const result = await client.queryRetrieval({
      tenant_id: "123e4567-e89b-12d3-a456-426614174000",
      domain_id: "123e4567-e89b-12d3-a456-426614174001",
      platform_path: "/store-a",
      narrative: "预算内的通勤方案",
      requirements: { budget_max: 100000 },
      request_id: requestId,
      limit: 2,
    });

    expect(result.candidates[0]?.offer_id).toBe(
      "123e4567-e89b-12d3-a456-426614174003",
    );
    expect(
      new Headers(calls[0]?.init?.headers).get("x-matchplane-api-key"),
    ).toBe("mpk_test");
  });

  it("accepts generic offer-only retrieval candidates and preserves risks", async () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174004";
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          protocol: "matchplane.retrieval/v1",
          request_id: requestId,
          provider: { id: "service.search", version: "2026.08" },
          candidates: [
            {
              offer_id: "123e4567-e89b-12d3-a456-426614174003",
              score: 0.74,
              reasons: ["范围匹配"],
              risks: ["需确认档期"],
            },
          ],
          degraded: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl,
    });
    const result = await client.queryRetrieval({
      tenant_id: "123e4567-e89b-12d3-a456-426614174000",
      domain_id: "123e4567-e89b-12d3-a456-426614174001",
      platform_path: "/services",
      narrative: "找一个咨询服务",
      request_id: requestId,
      limit: 2,
    });
    expect(result.candidates[0]?.asset_id).toBeUndefined();
    expect(result.candidates[0]?.offer_id).toBe(
      "123e4567-e89b-12d3-a456-426614174003",
    );
    expect(result.candidates[0]?.risks).toEqual(["需确认档期"]);
  });

  it("upserts a generic child catalogue offer through the scoped MCP bridge", async () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174004";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init?.body)) as {
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      expect(body.params?.name).toBe("platform.child.tool");
      const argumentsValue = body.params?.arguments;
      expect(argumentsValue?.tool_name).toBe("catalog.upsert");
      const envelope = argumentsValue?.arguments as {
        protocol?: string;
        scope?: { platform_path?: string };
        offer?: { offer_id?: string };
      };
      expect(envelope.protocol).toBe("matchplane.catalog/v1");
      expect(envelope.scope?.platform_path).toBe("/services");
      expect(envelope.offer?.offer_id).toBe(
        "123e4567-e89b-12d3-a456-426614174003",
      );
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            structuredContent: {
              protocol: "matchplane.catalog/v1",
              request_id: requestId,
              scope: {
                tenant_id: "123e4567-e89b-12d3-a456-426614174000",
                domain_id: "123e4567-e89b-12d3-a456-426614174001",
                platform_path: "/services",
              },
              offer_id: "123e4567-e89b-12d3-a456-426614174003",
              status: "active",
              indexed: true,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl,
    });
    const result = await client.upsertCatalogOffer({
      tenant_id: "123e4567-e89b-12d3-a456-426614174000",
      domain_id: "123e4567-e89b-12d3-a456-426614174001",
      platform_path: "/services",
      request_id: requestId,
      offer: {
        offer_id: "123e4567-e89b-12d3-a456-426614174003",
        external_key: "service-1",
        display_name: "咨询服务",
        attributes: { mode: "online" },
        terms: { currency: "CNY" },
        status: "active",
      },
    });
    expect(result.indexed).toBe(true);
    expect(
      new Headers(calls[0]?.init?.headers).get("x-matchplane-api-key"),
    ).toBe("mpk_test");
  });

  it("uploads a bounded media attachment through the root facade", async () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174004";
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      expect(String(url)).toBe("https://matx.tech/api/platform/media/upload");
      const body = JSON.parse(String(init?.body)) as {
        protocol?: string;
        scope?: { platform_path?: string };
        attachment?: { size_bytes?: number; data_base64?: string };
      };
      expect(body.protocol).toBe("matchplane.media/v1");
      expect(body.scope?.platform_path).toBe("/services");
      expect(body.attachment?.size_bytes).toBe(5);
      expect(body.attachment?.data_base64).toBe("aGVsbG8=");
      return new Response(
        JSON.stringify({
          protocol: "matchplane.media/v1",
          request_id: requestId,
          attachment: {
            attachment_ref: "media://services/abc",
            kind: "document",
            file_name: "hello.txt",
            media_type: "text/plain",
            size_bytes: 5,
            sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl,
    });
    const result = await client.uploadMedia({
      tenant_id: "123e4567-e89b-12d3-a456-426614174000",
      domain_id: "123e4567-e89b-12d3-a456-426614174001",
      platform_path: "/services",
      request_id: requestId,
      kind: "document",
      file_name: "hello.txt",
      media_type: "text/plain",
      size_bytes: 5,
      data_base64: "aGVsbG8=",
    });
    expect(result.attachment.attachment_ref).toBe("media://services/abc");
    expect(result.attachment.sha256).toBe("a".repeat(64));
  });

  it("rejects invalid child retrieval scope before contacting the gateway", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    await expect(
      client.queryRetrieval({
        tenant_id: "not-a-uuid",
        domain_id: "123e4567-e89b-12d3-a456-426614174001",
        platform_path: "/",
        narrative: "找供给",
      }),
    ).rejects.toThrow("UUIDs");
    expect(fake.calls).toHaveLength(0);
  });

  it("exposes contact-free demand discovery to a supply Agent", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    const capability = await client.openMarketplaceSession({
      tenant_id: "tenant",
      domain_id: "domain",
      platform_path: "/store-a",
      side: "supply",
    });
    await client.matchDemands(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      participant_id: "p",
      offer_id: "123e4567-e89b-12d3-a456-426614174003",
      limit: 5,
    });
    const body = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(body.params?.name).toBe("marketplace.demand.match");
    expect(body.params?.arguments?.platform_path).toBe("/store-a");
    expect(body.params?.arguments?.offer_id).toBe(
      "123e4567-e89b-12d3-a456-426614174003",
    );

    await client.updateDemandDiscovery(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      participant_id: "p",
      intent_id: "123e4567-e89b-12d3-a456-426614174004",
      enabled: false,
    });
    const updateBody = JSON.parse(String(fake.calls[2]?.init?.body)) as {
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    expect(updateBody.params?.name).toBe("marketplace.intent.discovery.update");
    expect(updateBody.params?.arguments?.enabled).toBe(false);
  });

  it("uses one MCP client shape for buyer and seller capability exchange", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    const capability = await client.openMarketplaceSession({
      tenant_id: "tenant",
      domain_id: "domain",
      platform_path: "/store-a",
      side: "demand",
    });
    expect(capability.role).toBe("buyer");
    expect(capability.access_token_expires_at).toBe("2099-01-01T00:00:00Z");
    expect(fake.calls[0]?.url).toBe("https://matx.tech/api/mcp");
    expect(
      new Headers(fake.calls[0]?.init?.headers).get("x-matchplane-api-key"),
    ).toBe("mpk_test");

    await client.createIntent(capability, {
      tenant_id: "tenant",
      domain_id: "domain",
      participant_id: "p",
      side: "demand",
      narrative: "找一个合适的供给",
      idempotency_key: "intent-1",
    });
    const partyHeaders = new Headers(fake.calls[1]?.init?.headers);
    expect(partyHeaders.get("authorization")).toBe("Bearer party-token-secret");
    expect(partyHeaders.get("x-matchplane-api-key")).toBeNull();
    const secondBody = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      params?: { arguments?: { platform_path?: string } };
    };
    expect(secondBody.params?.arguments?.platform_path).toBe("/store-a");

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
    expect(contactBody.params?.name).toBe(
      "marketplace.introduction.contact.request",
    );
    expect(contactBody.params?.arguments?.platform_path).toBe("/store-a");

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

  it("rejects malformed or confused party capabilities instead of falling back to the API key", async () => {
    let calls = 0;
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as {
          params?: { arguments?: Record<string, unknown> };
        };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: {
              structuredContent: {
                ...body.params?.arguments,
                party_id: "p",
                side: "demand",
                role: "buyer",
                access_token_expires_at: "2099-01-01T00:00:00Z",
                cost_bearer: "caller",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(
      client.openMarketplaceSession({
        tenant_id: "tenant",
        domain_id: "domain",
        platform_path: "/store-a",
        side: "demand",
      }),
    ).rejects.toThrow("capability scope is invalid");
    expect(calls).toBe(1);

    const fake = fakeFetch();
    const scopedClient = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    const capability = await scopedClient.openMarketplaceSession({
      tenant_id: "tenant",
      domain_id: "domain",
      platform_path: "/store-a",
      side: "demand",
    });
    await expect(
      scopedClient.createIntent(capability, {
        tenant_id: "other-tenant",
        domain_id: "domain",
        participant_id: "p",
        side: "demand",
        narrative: "找一个合适的供给",
        idempotency_key: "intent-1",
      }),
    ).rejects.toThrow("tenant_id must match the party capability");
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects platform-funded external handoffs before a network call", async () => {
    const fake = fakeFetch();
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: fake.fetchImpl,
    });
    await expect(
      client.handoff({
        protocol: "matchplane.agent/v1",
        request_id: "123e4567-e89b-12d3-a456-426614174000",
        stage: "platform",
        scope: { platform_path: "/" },
        intent: { narrative: "找供给", requirements: {} },
        agent: {
          id: "buyer.example",
          version: "1.0.0",
          capabilities: ["search"],
        },
        budget: {
          max_steps: 8,
          max_input_characters: 24_000,
          max_output_tokens: 512,
          cost_bearer: "platform" as unknown as "caller",
        },
      }),
    ).rejects.toThrow("caller-funded");
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces structured MCP tool failures", async () => {
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            result: {
              isError: true,
              structuredContent: { error: "scope denied" },
            },
          }),
          { status: 200 },
        ),
    });
    await expect(client.listTools()).rejects.toBeInstanceOf(MatchPlaneMcpError);
  });

  it("bounds transport deadlines and rejects oversized gateway responses", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      requestTimeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response("x".repeat(256 * 1024 + 1), { status: 200 });
      },
    });

    await expect(client.listTools()).rejects.toBeInstanceOf(MatchPlaneMcpError);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed and cleartext remote base URLs while allowing local development", () => {
    expect(
      () =>
        new MatchPlaneAgentClient({
          baseUrl: "not a URL",
          apiKey: "mpk_test",
        }),
    ).toThrow("valid absolute URL");
    expect(
      () =>
        new MatchPlaneAgentClient({
          baseUrl: "ftp://localhost",
          apiKey: "mpk_test",
        }),
    ).toThrow("must use HTTP or HTTPS");
    expect(
      () =>
        new MatchPlaneAgentClient({
          baseUrl: "http://agent.example",
          apiKey: "mpk_test",
        }),
    ).toThrow("must use HTTPS outside loopback");
    expect(
      () =>
        new MatchPlaneAgentClient({
          baseUrl: "http://127.0.0.1:3000",
          apiKey: "mpk_test",
        }),
    ).not.toThrow();
  });

  it("rejects an unbounded external Agent request timeout", () => {
    expect(
      () =>
        new MatchPlaneAgentClient({
          baseUrl: "https://matx.tech",
          apiKey: "mpk_test",
          requestTimeoutMs: 120_001,
        }),
    ).toThrow("requestTimeoutMs");
  });

  it("normalizes a transport timeout to a typed MCP error", async () => {
    const client = new MatchPlaneAgentClient({
      baseUrl: "https://matx.tech",
      apiKey: "mpk_test",
      requestTimeoutMs: 5,
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing request signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    await expect(client.listTools()).rejects.toMatchObject({
      name: "MatchPlaneMcpError",
      code: 504,
    });
  });

  it("runs a caller-funded multi-step Skill only through its advertised MCP tools", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "inventory",
      scope: { platform_path: "/store-a" },
      intent: {
        narrative: "找符合约束的供给",
        requirements: { budget: 100000 },
      },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: {
        max_steps: 3,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    const calls: string[] = [];
    let decisionCount = 0;
    const result = await runBoundedAgentSkill(request, {
      provider: {
        id: "buyer.example",
        version: "1.0.0",
        model: "caller-model",
      },
      decide: async ({ history }) => {
        decisionCount += 1;
        if (!history.length)
          return {
            type: "tool",
            tool: "inventory.search",
            arguments: { budget: 100000 },
          };
        return {
          type: "complete",
          selected: [{ ref: "offer-1", score: 0.92, reasons: ["预算匹配"] }],
        };
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
      scope: { platform_path: "/store-a" },
      intent: { narrative: "找供给方", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["merchant.search"],
      budget: {
        max_steps: 2,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    let called = false;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "seller.example", version: "1.0.0" },
      decide: async () => ({
        type: "tool",
        tool: "payment.refund",
        arguments: {},
      }),
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
      budget: {
        max_steps: 2,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    let calls = 0;
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "router.example", version: "1.0.0" },
      decide: async () => ({
        type: "tool",
        tool: "platform.search",
        arguments: { query: "供给" },
      }),
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
      scope: { platform_path: "/store-a" },
      intent: { narrative: "验证预算边界", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: {
        max_steps: 1,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
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

  it("falls back safely when a tool output becomes unserializable during snapshotting", async () => {
    const request: AgentSkillRequest = {
      protocol: "matchplane.agent/v1",
      request_id: "123e4567-e89b-12d3-a456-426614174000",
      stage: "inventory",
      scope: { platform_path: "/store-a" },
      intent: { narrative: "验证快照降级", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: {
        max_steps: 2,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    let serializations = 0;
    let observedOutput: unknown;
    const unstableOutput = {
      toJSON() {
        serializations += 1;
        if (serializations >= 3) throw new Error("serialization changed");
        return { refs: ["offer-1"] };
      },
    };

    const result = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async ({ history }) => {
        if (!history.length)
          return { type: "tool", tool: "inventory.search", arguments: {} };
        observedOutput = history[0]?.output;
        return { type: "complete", selected: [] };
      },
      callTool: async () => unstableOutput,
    });

    expect(result.status).toBe("completed");
    expect(observedOutput).toBeNull();
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
      budget: {
        max_steps: 1,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    const rejected = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async () =>
        ({ type: "reject", reason: 123 }) as unknown as ReturnType<
          NonNullable<Parameters<typeof runBoundedAgentSkill>[1]["decide"]>
        >,
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
      budget: {
        max_steps: 1,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
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
      scope: { platform_path: "/store-a" },
      intent: { narrative: "验证 MCP 错误", requirements: {} },
      skill: "matchplane.matching.v1",
      allowed_mcp_tools: ["inventory.search"],
      budget: {
        max_steps: 1,
        max_input_characters: 4000,
        max_output_tokens: 512,
        cost_bearer: "caller",
      },
    };
    const result = await runBoundedAgentSkill(request, {
      provider: { id: "bounded.example", version: "1.0.0" },
      decide: async () => ({
        type: "tool",
        tool: "inventory.search",
        arguments: {},
      }),
      callTool: async () => ({
        isError: true,
        structuredContent: { error: "upstream unavailable" },
      }),
    });
    expect(result.status).toBe("degraded");
    expect(result.reason).toBe("tool_failed");
    expect(result.steps[0]?.status).toBe("failed");
  });
});
