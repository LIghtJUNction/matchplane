import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, handler, query } = vi.hoisted(() => ({
  getSession: vi.fn(),
  handler: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession }, handler },
  authDatabase: { query },
  rootPlatformReferenceId: () => "root-platform",
}));
vi.mock("./lib/internal-auth", () => ({
  loadInternalBearer: vi.fn(async () => "internal-test-token"),
}));
vi.mock("./platform-mount", () => ({
  isMountedPlatformPath: vi.fn(async () => true),
  readActivePlatformScope: vi.fn(async () => null),
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: vi.fn(() => true),
}));

import { POST } from "../app/api/marketplace/session/route";

const ids = {
  tenantId: "123e4567-e89b-12d3-a456-426614174000",
  domainId: "223e4567-e89b-12d3-a456-426614174000",
  userId: "323e4567-e89b-12d3-a456-426614174000",
  partyId: "423e4567-e89b-12d3-a456-426614174000",
};

function request(body: unknown): Request {
  return new Request("https://child.example.test/api/marketplace/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cross-origin marketplace capability exchange", () => {
  beforeEach(() => {
    getSession.mockReset();
    handler.mockReset();
    query.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires the OIDC client binding to match the active child registration", async () => {
    getSession.mockResolvedValue(null);
    handler.mockResolvedValue(Response.json({
      active: true,
      client_id: "child-client",
      sub: ids.userId,
      scope: "openid profile email",
    }));
    query.mockResolvedValue({ rowCount: 0, rows: [] });

    const response = await POST(request({
      ...ids,
      subplatform: "used-car",
      platformPath: "/used-car",
      role: "buyer",
      federated: {
        accessToken: "mp_at_test",
        clientId: "child-client",
        clientSecret: "secret-held-by-child-server",
      },
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "OIDC 客户端没有绑定当前 active 子平台" });
    expect(handler).toHaveBeenCalledOnce();
    const introspectionRequest = handler.mock.calls[0]?.[0] as Request;
    expect(introspectionRequest.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("child-client:secret-held-by-child-server").toString("base64")}`,
    );
    expect(await introspectionRequest.text()).toContain("token=mp_at_test");
    expect(query.mock.calls[0]?.[0]).toContain("matchplane_subplatform_registration_id");
  });

  it("does not mix a browser cookie with a server-side federation credential", async () => {
    getSession.mockResolvedValue({
      user: {
        id: ids.userId,
        name: "Demo",
        email: "demo@example.test",
      },
    });

    const response = await POST(request({
      tenantId: ids.tenantId,
      domainId: ids.domainId,
      subplatform: "used-car",
      role: "buyer",
      federated: {
        accessToken: "mp_at_test",
        clientId: "child-client",
        clientSecret: "secret",
      },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "同一个请求不能同时携带 Better Auth cookie 和跨域 OIDC 凭据" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not turn public browsing into permission to list in another merchant's store", async () => {
    getSession.mockResolvedValue({
      user: {
        id: ids.userId,
        name: "Shopper",
        email: "shopper@example.test",
        emailVerified: true,
      },
    });
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const response = await POST(request({
      tenantId: ids.tenantId,
      domainId: ids.domainId,
      subplatform: "someone-elses-store",
      platformPath: "/someone-elses-store",
      role: "seller",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "只有店主或店铺运营可以上架商品" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("issues a demand-only capability for an authenticated visitor to an active public store", async () => {
    getSession.mockResolvedValue({
      user: {
        id: ids.userId,
        name: "Shopper",
        email: "shopper@example.test",
        emailVerified: true,
      },
    });
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const gatewayFetch = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => Response.json({
      tenant_id: ids.tenantId,
      party_id: ids.partyId,
      role: "buyer",
      access_token: "mpc_test",
      access_token_expires_at: "2026-08-21T12:00:00Z",
    }));
    vi.stubGlobal("fetch", gatewayFetch);

    const response = await POST(request({
      tenantId: ids.tenantId,
      domainId: ids.domainId,
      subplatform: "public-store",
      platformPath: "/public-store",
      role: "buyer",
    }));

    expect(response.status).toBe(200);
    const gatewayRequest = gatewayFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(gatewayRequest.body))).toMatchObject({
      role: "buyer",
      marketplace_sides: ["demand"],
    });
    const projectionSql = query.mock.calls[4]?.[0] as string;
    expect(projectionSql).toContain("SET role = EXCLUDED.role");
    expect(projectionSql).not.toContain("WHEN marketplace_subplatform_memberships.role");
    expect(query.mock.calls[4]?.[1]?.[3]).toBe("buyer");
  });

  it("projects only supply when a current store operator requests a seller capability", async () => {
    getSession.mockResolvedValue({
      user: {
        id: ids.userId,
        name: "Operator",
        email: "operator@example.test",
        emailVerified: true,
      },
    });
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: "owner" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const gatewayFetch = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => Response.json({
      tenant_id: ids.tenantId,
      party_id: ids.partyId,
      role: "seller",
      access_token: "mpc_test",
      access_token_expires_at: "2026-08-21T12:00:00Z",
    }));
    vi.stubGlobal("fetch", gatewayFetch);

    const response = await POST(request({
      tenantId: ids.tenantId,
      domainId: ids.domainId,
      subplatform: "operator-store",
      platformPath: "/operator-store",
      role: "seller",
    }));

    expect(response.status).toBe(200);
    const gatewayRequest = gatewayFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(gatewayRequest.body))).toMatchObject({
      role: "seller",
      marketplace_sides: ["supply"],
    });
    expect(query.mock.calls[2]?.[1]?.[3]).toBe("seller");
  });
});
