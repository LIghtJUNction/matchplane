import { describe, expect, it } from "vitest";

import {
  createProductTemplateCatalog,
  parseProductTemplateSettingsUpdate,
  resolveProductTemplateSettings,
  storedProductTemplateSettings,
  synthesizeHostedStoreManifest,
  validateProductTemplateSettingsCatalog,
} from "./store-product-template-settings";

const templates = [
  { id: "standard", label: "标准商品" },
  { id: "made.to-order", label: "定制商品" },
];
const catalog = createProductTemplateCatalog(
  { productTemplates: templates, defaultProductTemplateId: "standard" },
  "11111111-1111-4111-8111-111111111111",
  templates,
  "standard",
);

describe("store product template settings", () => {
  it("uses a canonical manifest digest for catalog revisions", () => {
    const first = createProductTemplateCatalog(
      { z: 1, nested: { b: true, a: false } },
      null,
      [],
      null,
    );
    const reordered = createProductTemplateCatalog(
      { nested: { a: false, b: true }, z: 1 },
      null,
      [],
      null,
    );
    const changed = createProductTemplateCatalog(
      { nested: { a: false, b: false }, z: 1 },
      null,
      [],
      null,
    );

    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });

  it("synthesizes a stable hosted manifest instead of a random revision", () => {
    const store = {
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: "33333333-3333-4333-8333-333333333333",
      slug: "mountain-shop",
      path: "/mountain-shop",
      displayName: "山里杂货铺",
      description: "手作与山货",
      status: "active" as const,
      version: 3,
      domainId: "44444444-4444-4444-8444-444444444444",
      organizationId: "55555555-5555-4555-8555-555555555555",
    };

    const first = synthesizeHostedStoreManifest(store);
    const second = synthesizeHostedStoreManifest(store);
    expect(createProductTemplateCatalog(first, null, [], null).revision).toBe(
      createProductTemplateCatalog(second, null, [], null).revision,
    );
    expect(first).toMatchObject({
      id: `hosted.${store.id}`,
      routes: [store.path],
      version: 3,
    });
  });

  it("enables the complete catalog by default and keeps an empty catalog empty", () => {
    expect(resolveProductTemplateSettings({}, catalog)).toEqual({
      enabledTemplateIds: ["standard", "made.to-order"],
      defaultTemplateId: "standard",
    });
    expect(
      resolveProductTemplateSettings(
        {},
        { templates: [], defaultTemplateId: null },
      ),
    ).toEqual({ enabledTemplateIds: [], defaultTemplateId: null });
  });

  it("reads versioned private settings and fails closed on stale defaults", () => {
    expect(
      resolveProductTemplateSettings(
        {
          product_templates: {
            schema_version: 1,
            enabled_template_ids: ["made.to-order"],
            default_template_id: "made.to-order",
          },
        },
        catalog,
      ),
    ).toEqual({
      enabledTemplateIds: ["made.to-order"],
      defaultTemplateId: "made.to-order",
    });
    expect(
      resolveProductTemplateSettings(
        {
          product_templates: {
            schema_version: 1,
            enabled_template_ids: ["standard"],
            default_template_id: "removed",
          },
        },
        catalog,
      ),
    ).toEqual({ enabledTemplateIds: [], defaultTemplateId: null });
  });

  it("validates empty, default and catalog membership invariants", () => {
    const revision = catalog.revision;
    expect(
      parseProductTemplateSettingsUpdate({
        enabledTemplateIds: [],
        defaultTemplateId: null,
        expectedStoreVersion: 4,
        expectedCatalogRevision: revision,
      }),
    ).toEqual({
      ok: true,
      value: {
        enabledTemplateIds: [],
        defaultTemplateId: null,
        expectedStoreVersion: 4,
        expectedCatalogRevision: revision,
      },
    });
    expect(
      parseProductTemplateSettingsUpdate({
        enabledTemplateIds: [],
        defaultTemplateId: "standard",
        expectedStoreVersion: 4,
        expectedCatalogRevision: revision,
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      parseProductTemplateSettingsUpdate({
        enabledTemplateIds: ["standard"],
        defaultTemplateId: null,
        expectedStoreVersion: 4,
        expectedCatalogRevision: revision,
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      validateProductTemplateSettingsCatalog(
        { enabledTemplateIds: ["unknown"], defaultTemplateId: "unknown" },
        catalog,
      ),
    ).toContain("不存在");
  });

  it("serializes only the bounded schema-v1 settings record", () => {
    expect(
      storedProductTemplateSettings({
        enabledTemplateIds: ["standard"],
        defaultTemplateId: "standard",
      }),
    ).toEqual({
      schema_version: 1,
      enabled_template_ids: ["standard"],
      default_template_id: "standard",
    });
  });
});
