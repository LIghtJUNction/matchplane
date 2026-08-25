import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getManagedPlatformRouterState } from "./platform-router-config";
import {
  PLATFORM_ROUTER_GENERATION_DIRECTORY,
  readCurrentSnapshot,
} from "./platform-router-config/transaction";
import { createTransactionalManagedPlatformRouterLifecycle } from "./platform-router-config/transactional-lifecycle";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_ROOT = path.join(WEB_ROOT, ".scratch", "platform-router-state-tests");
const ENVIRONMENT_KEYS = [
  "MATCHPLANE_ROUTER_AI_URL",
  "MATCHPLANE_ROUTER_AI_KEY",
  "MATCHPLANE_ROUTER_AI_MODEL",
  "MATCHPLANE_ROUTER_AI_PROTOCOL",
  "MATCHPLANE_ROUTER_AI_ALLOWED_ORIGINS",
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
);

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterEach(() => {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("managed platform router public state", () => {
  it("bounds a corrupt generation before exposing config or draft", async () => {
    const root = path.join(TEST_ROOT, "corrupt-generation");
    mkdirSync(root, { recursive: true, mode: 0o750 });
    const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
      transactionOptions: { root },
    });
    await lifecycle.stage(
      {
        endpoint: "https://tokenrhythm.studio",
        model: "deepseek-v4-flash-0731",
        protocol: "openai-compatible",
        enabled: true,
        apiKey: "state-test-secret",
      },
      { actor: "root@example.test", requestId: "stage-state" },
    );
    const probe = lifecycle.prepareDraftProbe();
    await lifecycle.markTested({
      actor: "root@example.test",
      requestId: "test-state",
      expectedGenerationId: probe.expectedGenerationId,
      expectedDraftDigest: probe.expectedDraftDigest,
      status: "ready",
    });
    await lifecycle.activate({
      actor: "root@example.test",
      requestId: "activate-state",
    });
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
    process.env.MATCHPLANE_ROUTER_AI_URL = "https://api.anthropic.com";
    process.env.MATCHPLANE_ROUTER_AI_KEY = "ready-environment-key";
    process.env.MATCHPLANE_ROUTER_AI_MODEL = "claude-sonnet-4-6";
    process.env.MATCHPLANE_ROUTER_AI_PROTOCOL = "anthropic-messages";

    const state = getManagedPlatformRouterState({ root });

    expect(state.config).toBeNull();
    expect(state.draft).toBeNull();
    expect(state.effective).toMatchObject({
      ready: false,
      preferredHttpStatus: 451,
      source: "managed",
      endpointOrigin: null,
      model: null,
      protocol: null,
      conflicts: { endpoint: null, model: null, protocol: null },
      originAllowlistApplied: false,
      issues: ["managed_configuration_unreadable"],
    });
    expect(JSON.stringify(state)).not.toContain("state-test-secret");
    expect(JSON.stringify(state)).not.toContain("ready-environment-key");
  });
});
