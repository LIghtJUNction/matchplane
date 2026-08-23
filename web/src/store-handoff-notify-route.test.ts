import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { query },
}));

import { POST } from "../app/api/mall/handoffs/notify/route";

function request(body: unknown) {
  return new Request("http://localhost/api/mall/handoffs/notify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    },
    body: JSON.stringify(body),
  });
}

describe("store AI handoff notification route", () => {
  beforeEach(() => {
    getSession.mockReset();
    query.mockReset();
    getSession.mockResolvedValue({
      user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  });

  it("notifies store operators only after proving the handoff belongs to the buyer", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            handoffId: "11111111-1111-4111-8111-111111111111",
            storeId: "22222222-2222-4222-8222-222222222222",
            storePath: "/test-store",
            storeName: "测试小店",
            organizationId: "org-1",
            summary: {
              analysis: "客户询问交付时间。",
              intent_strength: "high",
              product_ids: ["33333333-3333-4333-8333-333333333333"],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ userId: "staff-1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await POST(
      request({
        storePath: "/test-store",
        handoffId: "11111111-1111-4111-8111-111111111111",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: 1 });
    expect(query.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        "staff-1",
        "/test-store",
        "11111111-1111-4111-8111-111111111111",
        expect.stringContaining("测试小店"),
        "客户询问交付时间。",
        "/?storeConsole=22222222-2222-4222-8222-222222222222&storeConsoleSection=customers",
      ]),
    );
  });

  it("does not let one buyer notify staff for another buyer's handoff", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const response = await POST(
      request({
        storePath: "/test-store",
        handoffId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(response.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
