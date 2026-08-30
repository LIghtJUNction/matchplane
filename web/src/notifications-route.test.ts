import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, hasTrustedBrowserOrigin, query } = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));

import { GET, PATCH } from "../app/api/account/notifications/route";

const authUserId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: authUserId } });
  hasTrustedBrowserOrigin.mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("user notifications route", () => {
  it("returns only the signed-in account feed and unread count", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: "offer_liked",
            title: "商品收到新的赞",
            body: "测试商品",
            actionPath: "/store-a?console=products",
            createdAt: "2026-08-22T10:00:00.000Z",
            read: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const response = await GET(
      new Request("http://localhost/api/account/notifications?limit=10"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      unreadCount: 1,
      notifications: [{ title: "商品收到新的赞", read: false }],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("recipient_auth_user_id = $1::uuid"),
      [authUserId, 10],
    );
  });

  it("marks every unread notification read for only the current account", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    const response = await PATCH(
      new Request("http://localhost/api/account/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("UPDATE user_notifications"),
      [authUserId],
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      unreadCount: 0,
    });
  });

  it("rejects unauthenticated reads and untrusted writes", async () => {
    getSession.mockResolvedValue(null);
    expect(
      (await GET(new Request("http://localhost/api/account/notifications")))
        .status,
    ).toBe(401);

    getSession.mockResolvedValue({ user: { id: authUserId } });
    hasTrustedBrowserOrigin.mockReturnValue(false);
    expect(
      (
        await PATCH(
          new Request("http://localhost/api/account/notifications", {
            method: "PATCH",
            body: JSON.stringify({ all: true }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
