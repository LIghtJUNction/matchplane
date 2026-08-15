import { describe, expect, it } from "vitest";

import { resolveSubplatform } from "./subplatform";

describe("domain-neutral platform paths", () => {
  it("keeps the complete recursive path and addresses its manifest", () => {
    expect(resolveSubplatform("/market/auto")).toMatchObject({
      slug: "auto",
      path: "/market/auto",
      manifestUrl: "/api/platform/manifest?path=%2Fmarket%2Fauto",
    });
  });

  it("keeps the root node at the deployment root", () => {
    expect(resolveSubplatform("/")).toMatchObject({ slug: "root", path: "/" });
  });
});
