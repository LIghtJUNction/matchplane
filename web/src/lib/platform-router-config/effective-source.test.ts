import {
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ManagedPlatformRouterConfig } from "./contract";
import {
  platformRouterEffectiveStatusFrom,
  platformRouterEffectiveStatusFromReader,
  platformRouterPolicyIssues,
  readEnvironmentProviderStatus,
} from "./effective-source";
import { createTransactionalManagedPlatformRouterLifecycle } from "./transactional-lifecycle";
import {
  PLATFORM_ROUTER_GENERATION_DIRECTORY,
  PLATFORM_ROUTER_POINTER_FILE,
  readCurrentSnapshot,
} from "./transaction";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TEST_ROOT = path.join(WEB_ROOT, ".scratch", "effective-source-b2a-tests");

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function managed(
  overrides: Partial<ManagedPlatformRouterConfig> = {},
): ManagedPlatformRouterConfig {
  return {
    endpoint: "https://tokenrhythm.studio",
    model: "deepseek-v4-flash-0731",
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

function readyEnvironment(
  overrides: Record<string, string | undefined> = {},
) {
  return readEnvironmentProviderStatus({
    NODE_ENV: "test",
    MATCHPLANE_ROUTER_AI_URL: "https://environment.example/v1",
    MATCHPLANE_ROUTER_AI_KEY: "environment-key",
    MATCHPLANE_ROUTER_AI_MODEL: "environment-model",
    MATCHPLANE_ROUTER_AI_PROTOCOL: "openai-compatible",
    ...overrides,
  });
}

const emptyEnvironment = () => readEnvironmentProviderStatus({});

describe("provider-neutral router policy", () => {
  it.each([
    ["openai-compatible", "https://tokenrhythm.studio", "deepseek-v4-flash-0731"],
    ["anthropic-messages", "https://api.anthropic.com", "claude-sonnet-4-6"],
    [
      "gemini-generate-content",
      "https://generativelanguage.googleapis.com",
      "gemini-2.5-flash",
    ],
  ] as const)("accepts %s with a bounded manual model", (protocol, endpoint, model) => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ protocol, endpoint, model }),
      emptyEnvironment(),
    );

    expect(status).toMatchObject({
      ready: true,
      protocol,
      endpointOrigin: new URL(endpoint).origin,
      model,
      originAllowlistApplied: false,
      issues: [],
    });
    expect(status).not.toHaveProperty("requiredEndpoint");
    expect(status).not.toHaveProperty("requiredModel");
    expect(status).not.toHaveProperty("endpointMatchesRequired");
  });

  it("rejects unknown protocols, invalid model bounds, and unsafe URLs", () => {
    expect(
      platformRouterPolicyIssues({
        endpoint: "https://provider.example",
        model: "model",
        protocol: "unknown" as ManagedPlatformRouterConfig["protocol"],
        enabled: true,
        credentialConfigured: true,
      }),
    ).toContain("protocol_invalid");
    expect(
      platformRouterPolicyIssues({
        endpoint: "https://provider.example",
        model: " ",
        protocol: "openai-compatible",
        enabled: true,
        credentialConfigured: true,
      }),
    ).toContain("model_invalid");
    for (const [model, protocol] of [
      ["x".repeat(257), "openai-compatible"],
      ["model with spaces", "openai-compatible"],
      ["model\nheader", "anthropic-messages"],
      ["models/gemini-2.5-flash", "gemini-generate-content"],
      ["gemini:latest", "gemini-generate-content"],
    ] as const) {
      expect(
        platformRouterPolicyIssues({
          endpoint: "https://provider.example",
          model,
          protocol,
          enabled: true,
          credentialConfigured: true,
        }),
      ).toContain("model_invalid");
    }
    for (const endpoint of [
      "http://provider.example",
      "https://user@provider.example",
      "https://provider.example/v1?secret=value",
      "https://provider.example/v1#fragment",
      "https://127.0.0.1/v1",
    ]) {
      expect(
        platformRouterPolicyIssues({
          endpoint,
          model: "model",
          protocol: "openai-compatible",
          enabled: true,
          credentialConfigured: true,
        }),
      ).toContain("endpoint_invalid");
    }
  });

  it("permits any safe HTTPS origin when the allowlist is unset", () => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ endpoint: "https://provider.example/custom/v1" }),
      readEnvironmentProviderStatus({}),
    );

    expect(status.ready).toBe(true);
    expect(status.originAllowlistApplied).toBe(false);
  });

  it("applies exact HTTPS origins to managed and environment providers", () => {
    const managedStatus = platformRouterEffectiveStatusFrom(
      managed({ endpoint: "https://allowed.example/custom/v1" }),
      readEnvironmentProviderStatus({
        MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS:
          "https://allowed.example, https://other.example/",
      }),
    );
    const environmentStatus = platformRouterEffectiveStatusFrom(
      null,
      readyEnvironment({
        MATCHPLANE_ROUTER_AI_URL: "https://allowed.example/v1",
        MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS: "https://allowed.example",
      }),
    );

    expect(managedStatus).toMatchObject({
      ready: true,
      originAllowlistApplied: true,
    });
    expect(environmentStatus).toMatchObject({
      ready: true,
      source: "environment",
      originAllowlistApplied: true,
    });
  });

  it.each([
    "https://allowed.example/path",
    "https://allowed.example?query=1",
    "https://user@allowed.example",
    "http://allowed.example",
    "https://allowed.example,,https://other.example",
  ])("fails closed for a malformed allowlist entry: %s", (allowlist) => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ endpoint: "https://allowed.example/v1" }),
      readEnvironmentProviderStatus({
        MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS: allowlist,
      }),
    );

    expect(status.ready).toBe(false);
    expect(status.originAllowlistApplied).toBe(true);
    expect(status.issues).toContain("origin_allowlist_invalid");
  });

  it("rejects an endpoint whose exact origin is absent from the allowlist", () => {
    const status = platformRouterEffectiveStatusFrom(
      managed({ endpoint: "https://blocked.example/v1" }),
      readEnvironmentProviderStatus({
        MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS: "https://allowed.example",
      }),
    );

    expect(status.ready).toBe(false);
    expect(status.issues).toContain("endpoint_origin_not_allowed");
  });
});

describe("platform router effective source", () => {
  it("keeps managed config authoritative and reports env conflicts informationally", () => {
    const status = platformRouterEffectiveStatusFrom(
      managed(),
      readyEnvironment(),
    );

    expect(status).toMatchObject({
      source: "managed",
      managedOverridesEnvironment: true,
      ready: true,
      conflicts: { endpoint: true, model: true, protocol: false },
    });
  });

  it("does not fall back to env when managed is disabled or missing a credential", () => {
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

  it("treats a protocol-only environment override as present and incomplete", () => {
    const status = platformRouterEffectiveStatusFrom(
      null,
      readEnvironmentProviderStatus({
        MATCHPLANE_ROUTER_AI_PROTOCOL: "unsupported",
      }),
    );

    expect(status.source).toBe("environment");
    expect(status.ready).toBe(false);
    expect(status.issues).toEqual(
      expect.arrayContaining([
        "credential_not_configured",
        "endpoint_invalid",
        "model_invalid",
        "protocol_invalid",
      ]),
    );
  });

  it("uses incomplete environment state truthfully when no managed config exists", () => {
    const status = platformRouterEffectiveStatusFrom(
      null,
      readEnvironmentProviderStatus({
        MATCHPLANE_ROUTER_AI_URL: "https://environment.example/v1",
        MATCHPLANE_ROUTER_AI_PROTOCOL: "unsupported",
      }),
    );

    expect(status.source).toBe("environment");
    expect(status.ready).toBe(false);
    expect(status.issues).toEqual(
      expect.arrayContaining([
        "credential_not_configured",
        "model_invalid",
        "protocol_invalid",
      ]),
    );
  });

  it("maps a real corrupt managed pointer to explicit bounded unavailability", () => {
    const lifecycle = lifecycleFixture("corrupt-pointer");
    writeFileSync(
      path.join(TEST_ROOT, "corrupt-pointer", PLATFORM_ROUTER_POINTER_FILE),
      "{}\n",
      { mode: 0o640 },
    );

    expectUnreadableManagedStatus(
      platformRouterEffectiveStatusFromReader(
        lifecycle.getActive,
        readyEnvironment(),
      ),
    );
  });

  it("maps a real corrupt managed generation to explicit bounded unavailability", async () => {
    const root = path.join(TEST_ROOT, "corrupt-generation");
    const lifecycle = lifecycleFixture("corrupt-generation");
    await activateFixture(lifecycle);
    const snapshot = readCurrentSnapshot({ root });
    writeFileSync(
      path.join(
        root,
        PLATFORM_ROUTER_GENERATION_DIRECTORY,
        `${snapshot.generationId}.json`,
      ),
      "{}\n",
      { mode: 0o640 },
    );

    expectUnreadableManagedStatus(
      platformRouterEffectiveStatusFromReader(
        lifecycle.getActive,
        readyEnvironment(),
      ),
    );
  });

  it("blocks env fallback when a referenced credential is missing", async () => {
    const lifecycle = lifecycleFixture("missing-credential");
    await activateFixture(lifecycle);
    const snapshot = readCurrentSnapshot({
      root: path.join(TEST_ROOT, "missing-credential"),
    });
    unlinkSync(
      path.join(
        TEST_ROOT,
        "missing-credential",
        snapshot.active!.credentialFile,
      ),
    );

    expectUnreadableManagedStatus(
      platformRouterEffectiveStatusFromReader(
        lifecycle.getActive,
        readyEnvironment(),
      ),
    );
  });

  it("blocks env fallback when a referenced credential is corrupt", async () => {
    const root = path.join(TEST_ROOT, "corrupt-credential");
    const lifecycle = lifecycleFixture("corrupt-credential");
    await activateFixture(lifecycle);
    const snapshot = readCurrentSnapshot({ root });
    const credentialPath = path.join(root, snapshot.active!.credentialFile);
    unlinkSync(credentialPath);
    symlinkSync("/etc/passwd", credentialPath);

    expectUnreadableManagedStatus(
      platformRouterEffectiveStatusFromReader(
        lifecycle.getActive,
        readyEnvironment(),
      ),
    );
  });
});

function lifecycleFixture(name: string) {
  const root = path.join(TEST_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o750 });
  return createTransactionalManagedPlatformRouterLifecycle({
    transactionOptions: { root },
  });
}

async function activateFixture(
  lifecycle: ReturnType<typeof createTransactionalManagedPlatformRouterLifecycle>,
): Promise<void> {
  await lifecycle.stage(
    {
      endpoint: "https://tokenrhythm.studio",
      model: "deepseek-v4-flash-0731",
      protocol: "openai-compatible",
      enabled: true,
      apiKey: "managed-key",
    },
    { actor: "test", requestId: "stage" },
  );
  const prepared = lifecycle.prepareDraftProbe();
  await lifecycle.markTested({
    actor: "test",
    requestId: "test",
    expectedGenerationId: prepared.expectedGenerationId,
    expectedDraftDigest: prepared.expectedDraftDigest,
  });
  await lifecycle.activate({ actor: "test", requestId: "activate" });
}

function expectUnreadableManagedStatus(
  status: ReturnType<typeof platformRouterEffectiveStatusFromReader>,
): void {
  expect(status).toMatchObject({
    ready: false,
    code: "upstream_configuration",
    preferredHttpStatus: 451,
    source: "managed",
    managedOverridesEnvironment: true,
    conflicts: { endpoint: null, model: null, protocol: null },
    endpointOrigin: null,
    model: null,
    protocol: null,
    enabled: false,
    credentialConfigured: false,
    originAllowlistApplied: false,
    issues: ["managed_configuration_unreadable"],
  });
  expect(status).not.toHaveProperty("requiredEndpoint");
}
