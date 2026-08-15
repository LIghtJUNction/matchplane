import { describe, expect, it } from "vitest";

import { resolveSubplatform } from "./subplatform";

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
});
