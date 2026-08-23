import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, hasTrustedBrowserOrigin, query, readStoreAccess } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    hasTrustedBrowserOrigin: vi.fn(),
    query: vi.fn(),
    readStoreAccess: vi.fn(),
  }));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));
vi.mock("./lib/store-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/store-access")>();
  return { ...original, readStoreAccess };
});

import { POST } from "../app/api/stores/[storeId]/invites/route";

const storeId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";

function request(): Request {
  return new Request(`https://matchplane.test/api/stores/${storeId}/invites`, {
    method: "POST",
    headers: { origin: "https://matchplane.test" },
  });
}

const context = { params: Promise.resolve({ storeId }) };

describe("store collaborator invite links", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://matchplane.test");
    getSession.mockReset();
    hasTrustedBrowserOrigin.mockReset();
    query.mockReset();
    readStoreAccess.mockReset();
    hasTrustedBrowserOrigin.mockReturnValue(true);
    getSession.mockResolvedValue({ user: { id: userId } });
    readStoreAccess.mockResolvedValue({
      store: {
        id: storeId,
        slug: "store-a1b2c3d4e5f6",
        path: "/store-a1b2c3d4e5f6",
        displayName: "山里杂货铺",
        description: "手作与山货",
        integrationKind: "hosted",
        status: "active",
        version: 1,
        domainId: "44444444-4444-4444-8444-444444444444",
        organizationId,
        membershipRole: "owner",
      },
      canOperate: true,
      canManageStore: true,
    });
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: "invite-id" }] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores only a token digest and returns a one-time registration link", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      invite: { storeId: string; registrationUrl: string; expiresAt: string };
    };
    expect(body.invite.storeId).toBe(storeId);
    const url = new URL(body.invite.registrationUrl);
    const token = url.searchParams.get("token");
    expect(token).toMatch(/^mpa_[0-9a-f]{64}$/);
    expect(url.searchParams.get("next")).toBe(
      "/store-a1b2c3d4e5f6?console=products",
    );

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'subplatform_admin'");
    expect(sql).toContain("target_email");
    expect(parameters).not.toContain(token);
    expect(parameters[1]).toBe(
      createHash("sha256")
        .update(token ?? "")
        .digest("hex"),
    );
    expect(parameters[2]).toBe(organizationId);
    expect(parameters[3]).toBe(userId);
  });

  it("does not let a product collaborator invite more members", async () => {
    readStoreAccess.mockResolvedValue({
      store: {
        id: storeId,
        organizationId,
        path: "/store-a1b2c3d4e5f6",
      },
      canOperate: true,
      canManageStore: false,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "只有店主或商城后台可以邀请店铺协作者",
    });
    expect(query).not.toHaveBeenCalled();
  });
});
