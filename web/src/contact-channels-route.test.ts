import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
}));

import { GET } from "../app/api/account/contact-channels/route";

describe("account contact channels route", () => {
  beforeEach(() => getSession.mockReset());

  it("returns only verified Better Auth email and phone bindings", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "user-1",
        email: "verified@example.com",
        emailVerified: true,
        phoneNumber: "+8613800000000",
        phoneNumberVerified: false,
        oauthSubject: "must-not-leak",
      },
    });

    const response = await GET(new Request("http://localhost/api/account/contact-channels"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [{ type: "email", value: "verified@example.com" }],
    });
  });

  it("requires an authenticated account", async () => {
    getSession.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/account/contact-channels"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "请先登录" });
  });
});
