import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  authDatabase: { query: mocks.query },
}));
vi.mock("./platform-child-tool", () => ({
  executeAuthenticatedChildTool: mocks.execute,
}));

import type { CatalogProjectionArguments } from "./catalog-projection";
import { syncCanonicalMarketplaceOffer } from "./catalog-sync";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";

function canonicalRow(productTemplateId: string | null) {
  return {
    offer_id: offerId,
    tenant_id: tenantId,
    domain_id: domainId,
    supply_party_id: "44444444-4444-4444-8444-444444444444",
    external_key: "sync-offer",
    display_name: "Sync offer",
    product_template_id: productTemplateId,
    attributes: { material: "paper" },
    terms: {},
    status: "active",
    canonical_version: "7",
    platform_path: "/auto",
    integration_kind: "package",
    owner: true,
  };
}

describe("canonical catalog sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: {
        id: "55555555-5555-4555-8555-555555555555",
        role: "rootAdmin",
      },
    });
  });

  it.each([
    { kind: "templated", productTemplateId: "camera" },
    { kind: "legacy", productTemplateId: null },
  ])("reads and sends product_template_id for $kind offers", async ({
    productTemplateId,
  }) => {
    mocks.query.mockResolvedValue({
      rows: [canonicalRow(productTemplateId)],
    });
    mocks.execute.mockImplementation(
      async (input: { arguments: CatalogProjectionArguments }) => {
        const projection = input.arguments;
        return {
          ok: true,
          status: 200,
          payload: {
            result: {
              structuredContent: {
                protocol: projection.protocol,
                request_id: projection.request_id,
                scope: projection.scope,
                offer_id: projection.offer.offer_id,
                canonical_version: projection.canonical_version,
                applied_version: projection.canonical_version,
                projection_digest: projection.projection_digest,
                status: projection.offer.status,
                indexed: true,
                applied: true,
              },
            },
          },
        };
      },
    );

    await expect(
      syncCanonicalMarketplaceOffer({
        request: new Request("http://localhost/api/platform/catalog/sync"),
        offerId,
        tenantId,
      }),
    ).resolves.toMatchObject({ ok: true, synced: true, status: 200 });

    expect(String(mocks.query.mock.calls[0]?.[0])).toContain(
      "offer.product_template_id",
    );
    const projection = mocks.execute.mock.calls[0]?.[0]
      ?.arguments as CatalogProjectionArguments;
    expect(projection.offer).toHaveProperty(
      "product_template_id",
      productTemplateId,
    );
  });
});
