import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({ authDatabase: { query } }));

import {
  MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
  readPublicStores,
} from "./store-directory";

const tenantId = "20000000-0000-4000-8000-000000000001";

describe("public store directory query budget", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("preserves the existing unbounded query when no option is supplied", async () => {
    await readPublicStores(tenantId);

    expect(query.mock.calls[0]?.[0]).not.toContain("LIMIT $2::integer");
    expect(query.mock.calls[0]?.[1]).toEqual([tenantId]);
  });

  it("binds the validated assistant overflow sentinel as a SQL LIMIT", async () => {
    await readPublicStores(tenantId, {
      limit: MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
    });

    expect(query.mock.calls[0]?.[0]).toContain("LIMIT $2::integer");
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId,
      MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
    ]);
  });

  it("binds current registration and federation scope in the directory SQL", async () => {
    await readPublicStores(tenantId, {
      limit: MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT,
    });

    const sql = String(query.mock.calls[0]?.[0]).replaceAll(/\s+/g, " ");
    expect(sql).toContain("store.status = 'active'");
    expect(sql).toContain("store.visibility = 'public'");
    expect(sql).toContain("domain.status = 'active'");
    expect(sql).toContain("registration.id = store.current_registration_id");
    expect(sql).toContain("registration.tenant_id = store.tenant_id");
    expect(sql).toContain("registration.domain_id = store.domain_id");
    expect(sql).toContain("registration.slug = store.slug");
    expect(sql).toContain("registration.state = 'active'");
    expect(sql).toContain("binding.id = store.federation_binding_id");
    expect(sql).toContain("binding.tenant_id = store.tenant_id");
    expect(sql).toContain("binding.domain_id = store.domain_id");
    expect(sql).toContain("binding.slug = store.slug");
    expect(sql).toContain("binding.organization_id = store.organization_id");
    expect(sql).toContain("binding.registration_id = registration.id");
    expect(sql).toContain("binding.status = 'active'");
    expect(sql).toContain(
      "store.integration_kind = 'hosted' OR registration.id IS NOT NULL",
    );
    expect(sql).toContain(
      "store.integration_kind <> 'external' OR binding.id IS NOT NULL",
    );
    expect(sql).toContain(
      "registration.source_kind <> 'remote' OR binding.id IS NOT NULL",
    );
  });

  it("pushes an exact path into SQL and caps that lookup at one row", async () => {
    await readPublicStores(tenantId, { path: "/camera-house" });

    expect(query.mock.calls[0]?.[0]).toContain("alias.path = $2::text");
    expect(query.mock.calls[0]?.[0]).toContain("LIMIT $3::integer");
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId,
      "/camera-house",
      1,
    ]);
  });

  it("rejects an invalid limit before querying PostgreSQL", async () => {
    await expect(
      readPublicStores(tenantId, {
        limit: MAX_PUBLIC_STORE_DIRECTORY_QUERY_LIMIT + 1,
      }),
    ).rejects.toThrow(/limit must be between/);
    expect(query).not.toHaveBeenCalled();
  });
});
