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

  it("serves a hosted store's display name in the development profile", async () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "development");
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: "00000000-0000-7000-8000-000000001104",
        organizationId: "00000000-0000-7000-8000-000000001103",
        tenantId: "00000000-0000-7000-8000-000000001100",
        domainId: "00000000-0000-7000-8000-000000001101",
        slug: "demo-car-shop",
        displayName: "星辰二手车行",
        description: "主营家用二手车与准新车。",
        status: "active",
        version: "1",
      }],
    });

    const manifest = await readActivePlatformManifest("/demo-car-shop");
    expect(manifest).not.toBeNull();
    expect(JSON.parse(String(manifest))).toMatchObject({
      slug: "demo-car-shop",
      displayName: "星辰二手车行",
      status: "active",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps the static package fallback for non-hosted paths in development", async () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "development");
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ integrationKind: "package" }],
      });

    await expect(readActivePlatformManifest("/local-package")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("registration.id = store.current_registration_id"))).toBe(false);
  });
});
