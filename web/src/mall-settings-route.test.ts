import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  databaseQuery,
  getSession,
  hasTrustedBrowserOrigin,
  release,
  transactionQuery,
} = vi.hoisted(() => ({
  connect: vi.fn(),
  databaseQuery: vi.fn(),
  getSession: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession } },
  authDatabase: { connect, query: databaseQuery },
}));
vi.mock("./lib/request-origin", () => ({ hasTrustedBrowserOrigin }));

import { GET, PATCH } from "../app/api/mall/settings/route";

const tenantId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const mallRow = {
  name: "MatchPlane",
  slug: "matchplane",
  version: "3",
  logoKey: null,
  placeholderPhrases: ["预算五万以内"],
  includeActiveProductTitles: true,
};

beforeEach(() => {
  process.env.MATCHPLANE_ROOT_TENANT_ID = tenantId;
  getSession.mockResolvedValue({
    user: { id: authUserId, role: "rootSuperAdmin" },
  });
  hasTrustedBrowserOrigin.mockReturnValue(true);
  release.mockReset();
  databaseQuery
    .mockResolvedValueOnce({ rows: [mallRow] })
    .mockResolvedValueOnce({
      rows: [{ title: "测试商品" }, { title: "预算五万以内" }],
    });
  transactionQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM tenants") && sql.includes("FOR UPDATE")) {
      return { rows: [mallRow] };
    }
    if (sql.includes("UPDATE tenants")) {
      return {
        rowCount: 1,
        rows: [
          {
            ...mallRow,
            version: "4",
            placeholderPhrases: ["自定义提示"],
            includeActiveProductTitles: false,
          },
        ],
      };
    }
    return { rowCount: 1, rows: [] };
  });
  connect.mockResolvedValue({ query: transactionQuery, release });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MATCHPLANE_ROOT_TENANT_ID;
});

describe("mall home prompt settings", () => {
  it("merges custom phrases with every active product title", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mall: {
        customPlaceholderPhrases: ["预算五万以内"],
        includeActiveProductTitles: true,
        activeProductTitleCount: 2,
        placeholderPhrases: ["预算五万以内", "测试商品"],
      },
    });
  });

  it("persists a bounded custom list and removes product titles", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/mall/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "MatchPlane",
          expectedVersion: 3,
          placeholderPhrases: ["自定义提示"],
          includeActiveProductTitles: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("home_placeholder_phrases = $4::jsonb"),
      [tenantId, "MatchPlane", 3, '["自定义提示"]', false],
    );
    await expect(response.json()).resolves.toMatchObject({
      mall: {
        version: 4,
        customPlaceholderPhrases: ["自定义提示"],
        includeActiveProductTitles: false,
        placeholderPhrases: ["自定义提示"],
      },
    });
  });
});
