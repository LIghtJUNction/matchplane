import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateManagedPlatformRouterConfig,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
} from "./api";

const config = {
  endpoint: "https://tokenrhythm.studio",
  model: "deepseek-v4-flash-0731",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  assistantInstructions: "",
  assistantMaxOutputTokens: 320,
  assistantTemperature: 0.2,
  assistantMaxSteps: 3,
  assistantTimeoutMs: 20_000,
  assistantReasoningEffort: "none",
  modelReasoningEfforts: [],
};
const testedDraft = {
  ...config,
  testedReady: true,
  testedAt: "2026-08-25T00:00:00.000Z",
  keyChanged: true,
};
const effective = {
  ready: true,
  code: "ready" as const,
  preferredHttpStatus: null,
  source: "managed" as const,
  managedOverridesEnvironment: false,
  conflicts: { endpoint: false, model: false, protocol: false },
  endpointOrigin: "https://tokenrhythm.studio",
  model: "deepseek-v4-flash-0731",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  originAllowlistApplied: false,
  issues: [],
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platform AI mutation client", () => {
  it("accepts committed stage and activate 202 responses and preserves pending flags", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            config,
            draft: {
              ...config,
              testedReady: false,
              testedAt: null,
              keyChanged: true,
            },
            effective,
            requestId: "request-stage",
            committed: true,
            auditPending: true,
            maintenancePending: false,
            generationId: "generation-stage",
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            config,
            draft: null,
            effective,
            requestId: "request-activate",
            committed: true,
            auditPending: false,
            maintenancePending: true,
            generationId: "generation-activate",
          },
          202,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const staged = await saveManagedPlatformRouterConfig({
      ...config,
      apiKey: "write-only-test-key",
    });
    const activated = await activateManagedPlatformRouterConfig();

    expect(staged).toMatchObject({ committed: true, auditPending: true });
    expect(activated).toMatchObject({
      committed: true,
      maintenancePending: true,
    });
  });

  const readyProbe = {
    status: "ready",
    outcome: "ready",
    phase: "response",
    model: "deepseek-v4-flash-0731",
    responseStatus: 200,
    latencyMs: 800,
    firstByteLatencyMs: 700,
    performanceBudgetMs: 4_000,
    hardTimeoutMs: 20_000,
    message: "模型网关连接正常。",
    requestId: "request-test",
  };

  it("accepts a committed candidate-test 202 with exact state and pending metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ...readyProbe,
            committed: true,
            auditPending: true,
            maintenancePending: false,
            generationId: "generation-test",
            config,
            draft: testedDraft,
            effective,
          },
          202,
        ),
      ),
    );

    await expect(testPlatformAi({ candidate: true })).resolves.toMatchObject({
      status: "ready",
      committed: true,
      auditPending: true,
      generationId: "generation-test",
      config,
      draft: testedDraft,
      effective,
    });
  });

  it("rejects candidate responses shaped as active probes or missing committed state", async () => {
    const invalidCandidates = [
      readyProbe,
      {
        ...readyProbe,
        committed: true,
        config,
        draft: testedDraft,
        effective,
      },
      {
        ...readyProbe,
        committed: true,
        generationId: "generation-test",
      },
      {
        ...readyProbe,
        committed: true,
        generationId: "generation-test",
        config,
        draft: { ...testedDraft, testedReady: false },
        effective,
      },
    ];

    for (const body of invalidCandidates) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 200)));
      await expect(testPlatformAi({ candidate: true })).rejects.toThrow();
    }
  });

  it("continues to accept active probes without mutation fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(readyProbe, 200))
        .mockResolvedValueOnce(jsonResponse(readyProbe, 200)),
    );

    await expect(testPlatformAi()).resolves.toMatchObject({ status: "ready" });
    await expect(testPlatformAi({ candidate: false })).resolves.toMatchObject({
      status: "ready",
    });
  });
});
