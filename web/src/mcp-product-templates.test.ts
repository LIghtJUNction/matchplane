import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/api/marketplace/agent-session/route", () => ({
  POST: vi.fn(),
}));
vi.mock("../app/api/platform/match/route", () => ({ POST: vi.fn() }));
vi.mock("../app/api/platform/agent/handoff/route", () => ({
  POST: vi.fn(),
}));
vi.mock("../app/api/platform/retrieval/query/route", () => ({
  POST: vi.fn(),
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: vi.fn(() => true),
}));
vi.mock("./platform-child-tool", () => ({
  executeAuthenticatedChildTool: vi.fn(),
}));

import { POST } from "../app/api/mcp/route";

const ids = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "22222222-2222-4222-8222-222222222222",
  partyId: "33333333-3333-4333-8333-333333333333",
  offerId: "44444444-4444-4444-8444-444444444444",
};

function rpcRequest(method: string, params?: unknown): Request {
  return new Request("https://matchplane.test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "contract-1", method, params }),
  });
}

describe("Marketplace MCP product-template contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("documents productTemplateId as optional on create and update", async () => {
    const response = await POST(rpcRequest("tools/list"));
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: {
            required: string[];
            properties: Record<string, Record<string, unknown>>;
          };
        }>;
      };
    };

    for (const name of [
      "marketplace.offer.create",
      "marketplace.offer.update",
    ]) {
      const tool = body.result.tools.find(
        (candidate) => candidate.name === name,
      );
      expect(tool?.inputSchema.properties.productTemplateId).toEqual({
        type: "string",
        pattern: "^[a-z][a-z0-9._-]{0,63}$",
      });
      expect(tool?.inputSchema.required).not.toContain("productTemplateId");
    }
  });

  it("maps only the known offer's top-level field and preserves opaque nested keys", async () => {
    const opaqueAttributes = {
      product_template_id: "package-owned-snake",
      productTemplateId: "package-owned-camel",
    };
    const opaqueTerms = {
      productTemplateId: "terms-owned-camel",
      product_template_id: "terms-owned-snake",
    };
    const upstream = {
      offer: {
        offer_id: ids.offerId,
        product_template_id: "book.v2",
        attributes: opaqueAttributes,
        terms: opaqueTerms,
      },
      duplicate: false,
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(upstream),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MATCHPLANE_GATEWAY_INTERNAL_URL", "https://gateway.test");

    const response = await POST(
      rpcRequest("tools/call", {
        name: "marketplace.offer.create",
        arguments: {
          tenant_id: ids.tenantId,
          domain_id: ids.domainId,
          platform_path: "/store-a",
          supply_party_id: ids.partyId,
          external_key: "inventory-1",
          display_name: "城市通勤方案",
          productTemplateId: "book.v2",
          attributes: opaqueAttributes,
          terms: opaqueTerms,
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      product_template_id: "book.v2",
      attributes: opaqueAttributes,
      terms: opaqueTerms,
    });
    expect(JSON.parse(String(request.body))).not.toHaveProperty(
      "productTemplateId",
    );

    const body = (await response.json()) as {
      result: {
        structuredContent: {
          offer: Record<string, unknown>;
          duplicate: boolean;
        };
      };
    };
    expect(body.result.structuredContent.duplicate).toBe(false);
    expect(body.result.structuredContent.offer.productTemplateId).toBe(
      "book.v2",
    );
    expect(body.result.structuredContent.offer).not.toHaveProperty(
      "product_template_id",
    );
    expect(body.result.structuredContent.offer.attributes).toEqual(
      opaqueAttributes,
    );
    expect(body.result.structuredContent.offer.terms).toEqual(opaqueTerms);
  });
});
