import { describe, expect, it } from "vitest";
import type { ManagedPlatformRouterConfig } from "./contract";
import {
  platformRouterEffectiveStatusFrom,
  readEnvironmentProviderStatus,
} from "./effective-source";

function managed(
  overrides: Partial<ManagedPlatformRouterConfig> = {},
): ManagedPlatformRouterConfig {
  return {
    endpoint: "https://api.lmm.best/v1",
    model: "gpt-5.6-sol",
    protocol: "openai-compatible",
    enabled: true,
    credentialConfigured: true,
    assistantInstructions: "",
    assistantMaxOutputTokens: 320,
    assistantTemperature: 0.2,
    assistantMaxSteps: 5,
    assistantTimeoutMs: 20_000,
    assistantReasoningEffort: "none",
    modelReasoningEfforts: [],
    ...overrides,
  };
}

function readyEnvironment() {
  return readEnvironmentProviderStatus({
    NODE_ENV: "test",
    MATCHPLANE_ROUTER_AI_URL: "https://api.lmm.best/v1",
    MATCHPLANE_ROUTER_AI_KEY: "environment-key",
    MATCHPLANE_ROUTER_AI_MODEL: "gpt-5.6-sol",
    MATCHPLANE_ROUTER_AI_PROTOCOL: "openai-compatible",
  });
}

describe("platform router effective source", () => {
  it("keeps a policy-blocked managed config ahead of a ready environment config", () => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ model: "deepseek-v4-flash-0731" }),
      readyEnvironment(),
    );

    expect(status.source).toBe("managed");
    expect(status.managedOverridesEnvironment).toBe(true);
    expect(status.model).toBe("deepseek-v4-flash-0731");
    expect(status.issues).toContain("model_mismatch");
    expect(status.ready).toBe(false);
  });

  it("does not implicitly fall back to env when managed is disabled or missing a credential", () => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ enabled: false, credentialConfigured: false }),
      readyEnvironment(),
    );

    expect(status.source).toBe("managed");
    expect(status.issues).toEqual(
      expect.arrayContaining([
        "provider_not_enabled",
        "credential_not_configured",
      ]),
    );
    expect(status.ready).toBe(false);
  });

  it("uses the environment only when no managed config exists", () => {
    const status = platformRouterEffectiveStatusFrom(null, readyEnvironment());

    expect(status.source).toBe("environment");
    expect(status.ready).toBe(true);
    expect(status.managedOverridesEnvironment).toBe(false);
  });
});
