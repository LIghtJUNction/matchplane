import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({
  authDatabase: { query },
}));

import { readActivePlatformManifest } from "./platform-manifest";

describe("flat store manifest precedence", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", "00000000-0000-4000-8000-000000000001");
    query.mockReset();
  });

  it("does not serve a suspended hosted store from a legacy registration", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ integrationKind: "hosted" }],
      });

    await expect(readActivePlatformManifest("/suspended-store")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH RECURSIVE platform_tree"))).toBe(false);
  });

  it("requires a projected package store's exact current release to be active", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ integrationKind: "package" }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(readActivePlatformManifest("/paused-package")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain("registration.id = store.current_registration_id");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH RECURSIVE platform_tree"))).toBe(false);
  });
});
