import { describe, expect, it } from "vitest";

import { isProductionEnvironment, runtimeEnvironment } from "./runtime";

describe("runtime environment", () => {
  it("prefers the explicit MatchPlane profile over Next's build mode", () => {
    expect(runtimeEnvironment({ MATCHPLANE_ENVIRONMENT: "development", NODE_ENV: "production" })).toBe("development");
    expect(isProductionEnvironment({ MATCHPLANE_ENVIRONMENT: "development", NODE_ENV: "production" })).toBe(false);
  });

  it("recognizes an explicit production profile", () => {
    expect(isProductionEnvironment({ MATCHPLANE_ENVIRONMENT: "production", NODE_ENV: "development" })).toBe(true);
  });

  it("falls back to NODE_ENV for deployments without a MatchPlane profile", () => {
    expect(runtimeEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(isProductionEnvironment({ NODE_ENV: "production" })).toBe(true);
  });
});
