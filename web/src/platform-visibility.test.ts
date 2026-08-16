import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({
  authDatabase: { query },
}));

import { isActivePlatformPathVisible } from "./platform-visibility";

describe("platform path visibility", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", "00000000-0000-4000-8000-000000000001");
    query.mockReset();
  });

  it("fails closed for an invite-only path without membership", async () => {
    query.mockResolvedValue({ rowCount: 0 });

    await expect(isActivePlatformPathVisible("/private-market")).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("membership_policy = 'public'"),
      ["00000000-0000-4000-8000-000000000001", "/private-market", null, null, false],
    );
  });

  it("allows the same path when the database confirms membership", async () => {
    query.mockResolvedValue({ rowCount: 1 });

    await expect(isActivePlatformPathVisible("/private-market", {
      authUserId: "00000000-0000-4000-8000-000000000002",
    })).resolves.toBe(true);
  });

  it("allows a root administrator to inspect a private descendant", async () => {
    query.mockResolvedValue({ rowCount: 1 });

    await expect(isActivePlatformPathVisible("/private-market", {
      isRootAdministrator: true,
    })).resolves.toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "/private-market",
      null,
      null,
      true,
    ]);
  });
});
