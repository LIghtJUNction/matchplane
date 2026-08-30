import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSubplatform, resolveSubplatform } from "./subplatform";
import { hasValidSubplatformBuilderToken } from "./subplatform-builder";

describe("nested subplatform paths", () => {
  it("keeps the complete canonical path while using the leaf slug for labels", () => {
    const config = resolveSubplatform("/market/auto");

    expect(config.slug).toBe("auto");
    expect(config.path).toBe("/market/auto");
    expect(config.manifestUrl).toBe(
      "/api/platform/manifest?path=%2Fmarket%2Fauto",
    );
  });

  it("keeps the deployment root as the shared root chat", () => {
    const config = resolveSubplatform("/");

    expect(config.path).toBe("/");
    expect(config.slug).toBe("root");
    expect(config.marketplaceContract).toBe("generic-v1");
    expect(config.manifestUrl).toBeUndefined();
    expect(config.ui).toBeUndefined();
  });

  it("uses the registry-backed manifest endpoint for a direct child", () => {
    const config = resolveSubplatform("/store-a");

    expect(config.path).toBe("/store-a");
    expect(config.manifestUrl).toBe("/api/platform/manifest?path=%2Fstore-a");
  });

  it("ignores query and hash values when resolving a return URL", () => {
    expect(resolveSubplatform("/?role=buyer#match-chat").slug).toBe("root");
    expect(resolveSubplatform("/store-a?role=seller").path).toBe("/store-a");
  });

  it("does not treat a child path ending in root as the deployment root", () => {
    expect(resolveSubplatform("/root").slug).toBe("root");
    expect(resolveSubplatform("/root").path).toBe("/root");
    expect(resolveSubplatform("/parent/root").path).toBe("/parent/root");
  });

  it("requires the dedicated builder token for digest callbacks", () => {
    expect(
      hasValidSubplatformBuilderToken("builder-secret", "builder-secret"),
    ).toBe(true);
    expect(
      hasValidSubplatformBuilderToken("builder-secret", "wrong-secret"),
    ).toBe(false);
    expect(hasValidSubplatformBuilderToken("builder-secret", null)).toBe(false);
  });
});

describe("subplatform product-template loading", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a valid top-level template catalog without inventing a default ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            displayName: "Camera house",
            productTemplates: [
              {
                id: "camera",
                label: "Camera",
                supplyFields: [{ key: "sensor", label: "Sensor" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const loaded = await loadSubplatform("/camera-house");

    expect(loaded.productTemplates).toEqual([
      expect.objectContaining({ id: "camera" }),
    ]);
    expect(loaded.defaultProductTemplateId).toBeUndefined();
    expect(loaded.ui?.supplyFields).toBeUndefined();
  });

  it("fails closed on ambiguous legacy and template declarations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            displayName: "Ambiguous",
            ui: { supplyFields: [{ key: "brand", label: "Brand" }] },
            productTemplates: [
              {
                id: "camera",
                label: "Camera",
                supplyFields: [{ key: "sensor", label: "Sensor" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const loaded = await loadSubplatform("/camera-house");

    expect(loaded.brandName).toBe("camera-house");
    expect(loaded.productTemplates).toBeUndefined();
    expect(loaded.ui).toBeUndefined();
  });
});
