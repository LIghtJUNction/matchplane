import { describe, expect, it } from "vitest";

import { pluginCapabilitiesForRole } from "./PluginHost";

describe("PluginHost role capabilities", () => {
  it("never grants listing submission to a buyer workspace", () => {
    expect(pluginCapabilitiesForRole("buyer", false)).toEqual([
      "chat.open",
      "match.results",
      "listing.open",
    ]);
    expect(pluginCapabilitiesForRole("buyer", true)).toEqual([
      "match.results",
      "listing.open",
    ]);
  });

  it("grants listing submission only to the seller workspace", () => {
    expect(pluginCapabilitiesForRole("seller", false)).toContain(
      "listing.submit",
    );
    expect(pluginCapabilitiesForRole("platform", false)).not.toContain(
      "listing.submit",
    );
  });
});
