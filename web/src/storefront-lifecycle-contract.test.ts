import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./lib/auth", () => ({ authDatabase: { query } }));

import type { PublicStore } from "./store-directory";
import {
  MAX_PUBLIC_OFFER_SEARCH_CANDIDATES,
  PublicOfferSearchBudgetExceededError,
  searchPublicStoreOffers,
} from "./storefront-search";

const store: PublicStore = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "camera-house",
  path: "/camera-house",
  displayName: "相机屋",
  description: "相机与镜头",
  integrationKind: "hosted",
  capabilities: [],
  agentStages: [],
  agentSkills: [],
  tenantId: "20000000-0000-4000-8000-000000000001",
  domainId: "30000000-0000-4000-8000-000000000001",
};

describe("public offer lifecycle SQL contract", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("binds live registration and federation scope in the offer query", async () => {
    await searchPublicStoreOffers({ stores: [store], narrative: "" });

    const sql = String(query.mock.calls[0]?.[0]).replaceAll(/\s+/g, " ");
    expect(sql).toContain("JOIN unnest($1::uuid[], $2::uuid[], $3::uuid[])");
    expect(sql).toContain("requested_store.tenant_id = offer.tenant_id");
    expect(sql).toContain("requested_store.domain_id = offer.domain_id");
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
    expect(sql).not.toContain("row_number");
    expect(sql).not.toContain("store_rank");
    expect(sql).not.toContain("ts_rank");
    expect(sql).toContain("LIMIT 2001");
  });

  it("rejects the candidate sentinel before Rust ranking", async () => {
    query.mockResolvedValue({
      rows: Array.from(
        { length: MAX_PUBLIC_OFFER_SEARCH_CANDIDATES + 1 },
        () => ({}),
      ),
    });

    await expect(
      searchPublicStoreOffers({ stores: [store], narrative: "相机" }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: PublicOfferSearchBudgetExceededError.name,
        code: "public_offer_search_budget_exceeded",
        budget: "candidates",
        actual: MAX_PUBLIC_OFFER_SEARCH_CANDIDATES + 1,
        maximum: MAX_PUBLIC_OFFER_SEARCH_CANDIDATES,
      }),
    );
  });
});
