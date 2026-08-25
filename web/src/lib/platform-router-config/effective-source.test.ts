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

  it("blocks ready environment fallback when a referenced credential is missing", async () => {
    const lifecycle = lifecycleFixture("missing-credential");
    await activateFixture(lifecycle);
    const snapshot = readCurrentSnapshot({
      root: path.join(TEST_ROOT, "missing-credential"),
    });
    unlinkSync(path.join(TEST_ROOT, "missing-credential", snapshot.active!.credentialFile));

    expectUnreadableManagedStatus(
      platformRouterEffectiveStatusFromReader(
        lifecycle.getActive,
        readyEnvironment(),
      ),
    );
  });

  it("blocks ready environment fallback when a referenced credential is corrupt", async () => {
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
      endpoint: "https://api.lmm.best/v1",
      model: "gpt-5.6-sol",
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
    endpointMatchesRequired: null,
    modelMatchesRequired: null,
    protocolMatchesRequired: null,
    issues: ["managed_configuration_unreadable"],
  });
}
