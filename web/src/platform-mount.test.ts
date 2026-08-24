import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({
  authDatabase: { query },
}));

import { isMountedPlatformPath, readActivePlatformScope } from "./platform-mount";

describe("flat store mount precedence", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", "00000000-0000-4000-8000-000000000001");
    query.mockReset();
  });

  it("mounts a closed or suspended store so its status page and workspace are accessible", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          organizationId: "11111111-1111-4111-8111-111111111111",
          tenantId: "00000000-0000-4000-8000-000000000001",
          domainId: "22222222-2222-4222-8222-222222222222",
          slug: "closed-store",
        },
      ],
    });

    await expect(isMountedPlatformPath("/closed-store")).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("store.status IN ('active', 'closed', 'suspended', 'pending')");
  });

  it("does not remount a missing projected store through a legacy registration", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] });

    await expect(isMountedPlatformPath("/suspended-store")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("FROM store_path_aliases alias");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH RECURSIVE platform_tree"))).toBe(false);
  });

  it("does not resolve a projected inactive store through a legacy registration", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] });

    await expect(readActivePlatformScope("/suspended-store")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy compatibility only when the path has no store projection", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] });

    await expect(isMountedPlatformPath("/legacy-store")).resolves.toBe(true);
    expect(query.mock.calls[2]?.[0]).toContain("WITH RECURSIVE platform_tree");
  });
});
