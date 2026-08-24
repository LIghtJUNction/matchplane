import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlatformRouterEffectiveStatus: vi.fn(),
  readManagedPlatformRouterConfig: vi.fn(),
}));

vi.mock("./lib/platform-router-config", () => mocks);

import {
  isPlatformRouterConfigured,
  probePlatformRouter,
} from "./platform-router";

beforeEach(() => {
  mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
    source: "managed",
    ready: false,
  });
  mocks.readManagedPlatformRouterConfig.mockReturnValue(null);
});

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
    expect(mocks.readManagedPlatformRouterConfig).not.toHaveBeenCalled();
  });

  it("bounds a secret-read failure after a ready managed status", async () => {
    mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
      source: "managed",
      ready: true,
    });
    mocks.readManagedPlatformRouterConfig.mockImplementation(() => {
      throw new Error("managed credential is corrupt");
    });
    const fetcher = vi.fn<typeof fetch>();

    expect(isPlatformRouterConfigured()).toBe(false);
    const result = await probePlatformRouter({ fetcher });

    expect(result.outcome).toBe("unconfigured");
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.readManagedPlatformRouterConfig).toHaveBeenCalledTimes(2);
  });
});
