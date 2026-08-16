import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({
  authDatabase: { query },
}));

import { readActiveDirectChildRoutes } from "./platform-child-routes";

describe("platform child route visibility", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({
      rows: [{
        slug: "used-car",
        path: "/used-car",
        displayName: "二手车平台",
        description: "车辆交易",
        tenantId: "00000000-0000-4000-8000-000000000001",
        domainId: "00000000-0000-4000-8000-000000000002",
        capabilities: ["demand", "supply"],
        agentStages: ["merchant", "inventory"],
        agentSkills: ["matchplane.matching.v1"],
        agentMcpTools: ["marketplace.match"],
      }],
    });
  });

  it("passes human and machine scope to the visibility query", async () => {
    const routes = await readActiveDirectChildRoutes(
      "/",
      "00000000-0000-4000-8000-000000000001",
      {
        authUserId: "00000000-0000-4000-8000-000000000003",
        organizationId: "00000000-0000-4000-8000-000000000004",
      },
    );

    expect(routes[0]?.slug).toBe("used-car");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("r.membership_policy = 'public'"),
      [
        null,
        "00000000-0000-4000-8000-000000000001",
        "/",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        false,
      ],
    );
  });

  it("does not pass a browser identity for machine-only routing", async () => {
    await readActiveDirectChildRoutes(
      "/used-car",
      "00000000-0000-4000-8000-000000000001",
      { organizationId: "00000000-0000-4000-8000-000000000004" },
    );

    expect(query.mock.calls[0]?.[1]).toEqual([
      "used-car",
      "00000000-0000-4000-8000-000000000001",
      "/used-car",
      null,
      "00000000-0000-4000-8000-000000000004",
      false,
    ]);
  });
});
