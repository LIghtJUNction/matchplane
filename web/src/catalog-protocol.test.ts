import { describe, expect, it } from "vitest";

import { parseCatalogSyncRequest } from "./catalog-protocol";

const common = {
  protocol: "matchplane.catalog/v1",
  request_id: "44444444-4444-4444-8444-444444444444",
  scope: {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    domain_id: "22222222-2222-4222-8222-222222222222",
    platform_path: "/store-a",
  },
  offer_id: "33333333-3333-4333-8333-333333333333",
};

describe("catalog sync protocol", () => {
  it("accepts the minimal canonical offer reference", () => {
    const result = parseCatalogSyncRequest(common);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.platformPath).toBe("/store-a");
  });

  it("rejects client-supplied catalog fields and root scope", () => {
    expect(parseCatalogSyncRequest({ ...common, attributes: {} }).ok).toBe(false);
    expect(parseCatalogSyncRequest({ ...common, scope: { ...common.scope, platform_path: "/" } }).ok).toBe(false);
  });
});
