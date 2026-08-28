import { afterEach, describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
  fetchPinnedPublicText: vi.fn(),
}));

vi.mock("./lib/pinned-public-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/pinned-public-endpoint")>()),
  fetchPinnedPublicText: transportState.fetchPinnedPublicText,
}));

import {
  invokeSubplatformMcpTool,
  prepareSubplatformMcpEndpoint,
  probeSubplatformMcpEndpoint,
  readSubplatformMcpEndpoint,
  validateSubplatformMcpEndpointUrl,
} from "./platform-agent-tool";

describe("subplatform MCP endpoint boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("resolves an operator-configured endpoint without accepting direct secrets", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON: JSON.stringify({
        "store-a": {
          url: "https://agent.example/mcp",
          tokenEnv: "MATCHPLANE_STORE_A_MCP_TOKEN",
          token: "must-not-be-read",
        },
      }),
      MATCHPLANE_STORE_A_MCP_TOKEN: "server-secret",
    };
    expect(readSubplatformMcpEndpoint("store-a", environment)?.bearerToken).toBe("server-secret");
    expect(readSubplatformMcpEndpoint("missing", environment)).toBeNull();
  });

  it("rejects insecure production endpoints and private network URLs", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON: JSON.stringify({
        insecure: { url: "http://127.0.0.1:9000/mcp" },
        private: { url: "https://10.0.0.2/mcp" },
      }),
    };
    expect(readSubplatformMcpEndpoint("insecure", environment)).toBeNull();
    expect(readSubplatformMcpEndpoint("private", environment)).toBeNull();
  });

  it("keeps production restrictions when only the platform environment is set", () => {
    const environment = {
      MATCHPLANE_ENVIRONMENT: "production",
      MATCHPLANE_SUBPLATFORM_MCP_ENDPOINTS_JSON: JSON.stringify({
        insecure: { url: "http://127.0.0.1:9000/mcp" },
      }),
    } as unknown as NodeJS.ProcessEnv;
    expect(readSubplatformMcpEndpoint("insecure", environment)).toBeNull();
  });

  it("fails closed for private binding URLs before activation", async () => {
    await expect(validateSubplatformMcpEndpointUrl("https://169.254.169.254/mcp", { NODE_ENV: "production" })).resolves.toBe(false);
    await expect(validateSubplatformMcpEndpointUrl("http://127.0.0.1:9000/mcp", { NODE_ENV: "development" })).resolves.toBe(true);
  });

  it("bounds the response and does not forward caller credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe("Bearer child-secret");
      expect(headers.get("x-matchplane-platform-path")).toBe("/store-a");
      expect(headers.get("x-matchplane-agent-subject")).toBe("agent-subject");
      expect(headers.get("x-matchplane-api-key")).toBeNull();
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        result: { content: [{ type: "text", text: "ok" }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await invokeSubplatformMcpTool({
      endpoint: { serverKey: "store-a", url: "https://agent.example/mcp", bearerToken: "child-secret", timeoutMs: 1_000 },
      toolName: "inventory.search",
      arguments: { narrative: "通勤" },
      requestId: "request-1",
      platformPath: "/store-a",
      actorSubject: "agent-subject",
      fetcher,
    });
    expect(result.ok).toBe(true);
    expect(result.payload.result).toBeDefined();
  });

  it("uses the pinned bounded transport for production MCP calls", async () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    transportState.fetchPinnedPublicText.mockResolvedValue({
      response: new Response(null, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      text: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-pinned",
        result: { content: [] },
      }),
    });

    const result = await invokeSubplatformMcpTool({
      endpoint: {
        serverKey: "store-a",
        url: "https://agent.example/mcp",
        bearerToken: "child-secret",
        timeoutMs: 1_000,
      },
      toolName: "inventory.search",
      arguments: {},
      requestId: "request-pinned",
      platformPath: "/store-a",
      actorSubject: "agent-subject",
    });

    expect(result.ok).toBe(true);
    expect(transportState.fetchPinnedPublicText).toHaveBeenCalledWith(
      new URL("https://agent.example/mcp"),
      expect.objectContaining({
        method: "POST",
        responseLimitBytes: 256 * 1024,
        requestTimeoutMs: 1_000,
        responseBodyTimeoutMs: 1_000,
      }),
    );
  });

  it("rejects an injected test fetcher in production", async () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    const fetcher = vi.fn<typeof fetch>();
    const result = await invokeSubplatformMcpTool({
      endpoint: {
        serverKey: "store-a",
        url: "https://agent.example/mcp",
        bearerToken: "child-secret",
        timeoutMs: 1_000,
      },
      toolName: "inventory.search",
      arguments: {},
      requestId: "request-production",
      platformPath: "/store-a",
      actorSubject: "agent-subject",
      fetcher,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      payload: { error: "subplatform MCP endpoint is unavailable" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a bounded streamable-HTTP SSE response", async () => {
    const result = await invokeSubplatformMcpTool({
      endpoint: { serverKey: "store-a", url: "https://agent.example/mcp", bearerToken: null, timeoutMs: 1_000 },
      toolName: "catalog.explain",
      arguments: {},
      requestId: "request-2",
      platformPath: "/store-a",
      actorSubject: "agent-subject",
      fetcher: vi.fn<typeof fetch>(async () => new Response(
        "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"request-2\",\"result\":{\"content\":[]}}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )),
    });
    expect(result.ok).toBe(true);
    expect(result.payload.result).toBeDefined();
  });

  it("stops reading an oversized chunked MCP response at the byte cap", async () => {
    const oversized = new Uint8Array(256 * 1024 + 1);
    oversized.fill(65);
    const result = await invokeSubplatformMcpTool({
      endpoint: { serverKey: "store-a", url: "https://agent.example/mcp", bearerToken: null, timeoutMs: 1_000 },
      toolName: "catalog.explain",
      arguments: {},
      requestId: "request-oversized",
      platformPath: "/store-a",
      actorSubject: "agent-subject",
      fetcher: vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    expect(result.ok).toBe(false);
    expect(result.payload.error).toContain("exceeds 256 KiB");
  });

  it("probes MCP initialize without sending an agent subject", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe("Bearer child-secret");
      const request = JSON.parse(String(init?.body)) as { method?: string };
      expect(request.method).toBe("initialize");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "matchplane-health", result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(probeSubplatformMcpEndpoint({
      endpoint: { serverKey: "store-a", url: "https://agent.example/mcp", bearerToken: "child-secret", timeoutMs: 1_000 },
      fetcher,
    })).resolves.toMatchObject({ ok: true, status: 200 });
  });

  it("rejects an HTTP 200 response that is not an MCP initialize result", async () => {
    await expect(probeSubplatformMcpEndpoint({
      endpoint: { serverKey: "store-a", url: "https://agent.example/mcp", bearerToken: null, timeoutMs: 1_000 },
      fetcher: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "matchplane-health" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    })).resolves.toMatchObject({ ok: false, status: 200 });
  });

  it("prepares a pending binding endpoint using the candidate token environment", async () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      MATCHPLANE_REMOTE_MCP_TOKEN: "pending-secret",
    };
    await expect(prepareSubplatformMcpEndpoint({
      serverKey: "remote-market",
      url: "https://1.1.1.1/mcp",
      tokenEnv: "MATCHPLANE_REMOTE_MCP_TOKEN",
      environment,
    })).resolves.toMatchObject({ serverKey: "remote-market", bearerToken: "pending-secret" });
  });

  it("does not prepare a production binding without its injected token", async () => {
    await expect(prepareSubplatformMcpEndpoint({
      serverKey: "remote-market",
      url: "https://1.1.1.1/mcp",
      tokenEnv: "MATCHPLANE_REMOTE_MCP_TOKEN",
      environment: { NODE_ENV: "production" },
    })).resolves.toBeNull();
  });
});
