import { describe, expect, it } from "vitest";

import { resolveSubplatform } from "./subplatform";
import { hasValidSubplatformBuilderToken } from "./subplatform-builder";

describe("nested subplatform paths", () => {
  it("keeps the complete canonical path while using the leaf slug for labels", () => {
    const config = resolveSubplatform("/market/auto");

    expect(config.slug).toBe("auto");
    expect(config.path).toBe("/market/auto");
    expect(config.manifestUrl).toBe("/api/platform/manifest?path=%2Fmarket%2Fauto");
  });

  it("keeps the deployment root as the shared root chat", () => {
    const config = resolveSubplatform("/");

    expect(config.path).toBe("/");
    expect(config.slug).toBe("root");
    expect(config.manifestUrl).toBeUndefined();
  });

  it("uses the registry-backed manifest endpoint for a direct child", () => {
    const config = resolveSubplatform("/used-car");

    expect(config.path).toBe("/used-car");
    expect(config.manifestUrl).toBe("/api/platform/manifest?path=%2Fused-car");
  });

  it("ignores query and hash values when resolving a return URL", () => {
    expect(resolveSubplatform("/?role=buyer#match-chat").slug).toBe("root");
    expect(resolveSubplatform("/used-car?role=seller").path).toBe("/used-car");
  });

  it("does not treat a child path ending in root as the deployment root", () => {
    expect(resolveSubplatform("/root").slug).toBe("root");
    expect(resolveSubplatform("/root").path).toBe("/root");
    expect(resolveSubplatform("/parent/root").path).toBe("/parent/root");
  });

  it("requires the dedicated builder token for digest callbacks", () => {
    expect(hasValidSubplatformBuilderToken("builder-secret", "builder-secret")).toBe(true);
    expect(hasValidSubplatformBuilderToken("builder-secret", "wrong-secret")).toBe(false);
    expect(hasValidSubplatformBuilderToken("builder-secret", null)).toBe(false);
  });
});
