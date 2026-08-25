import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, query } = vi.hoisted(() => ({
  getSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));

import { GET, POST } from "../app/api/platform/domains/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const cookie = "better-auth.session_token=opaque";
const domainRow = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "store-a",
  name: "Store A",
  status: "active",
  version: 1,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", tenantId);
  vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", "https://mall.example");
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BETTER_AUTH_URL", "");
  getSession.mockReset();
  query.mockReset();
  getSession.mockResolvedValue({
    user: {
      id: "33333333-3333-4333-8333-333333333333",
      role: "rootSuperAdmin",
    },
  });
  query.mockResolvedValue({ rows: [domainRow], rowCount: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared root-manager browser-origin boundary", () => {
  it("keeps an authenticated GET readable without an Origin header", async () => {
    const response = await GET(domainRequest("GET"));

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    ["untrusted", "https://evil.example"],
  ])("rejects a POST with %s Origin before session or database work", async (_label, origin) => {
    const response = await POST(domainRequest("POST", origin));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "请求来源未被平台信任",
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("lets a trusted-origin POST continue through authorization", async () => {
    const response = await POST(domainRequest("POST", "https://mall.example"));

    expect(response.status).toBe(201);
    expect(getSession).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });
});

function domainRequest(method: "GET" | "POST", origin?: string): Request {
  return new Request("https://mall.example/api/platform/domains", {
    method,
    headers: {
      cookie,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(method === "POST"
      ? { body: JSON.stringify({ slug: "store-a", name: "Store A" }) }
      : {}),
  });
}
