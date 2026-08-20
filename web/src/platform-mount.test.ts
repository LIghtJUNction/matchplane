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

  it("does not remount a suspended projected store through a legacy registration", async () => {
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
