import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlatformRouterEffectiveStatus: vi.fn(() => ({ source: "managed" })),
  readManagedPlatformRouterConfig: vi.fn(() => null),
}));

vi.mock("./lib/platform-router-config", () => mocks);

import { probePlatformRouter } from "./platform-router";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed platform router precedence", () => {
  it("does not call a ready env provider when managed configuration is blocked", async () => {
    vi.stubEnv("MATCHPLANE_ROUTER_AI_URL", "https://api.lmm.best/v1");
    vi.stubEnv("MATCHPLANE_ROUTER_AI_KEY", "environment-key");
    vi.stubEnv("MATCHPLANE_ROUTER_AI_MODEL", "gpt-5.6-sol");
    vi.stubEnv("MATCHPLANE_ROUTER_AI_PROTOCOL", "openai-compatible");
    const fetcher = vi.fn<typeof fetch>();

    const result = await probePlatformRouter({ fetcher });

    expect(result.outcome).toBe("unconfigured");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
