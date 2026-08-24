import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activateManagedPlatformRouterConfig,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
} from "./api";

const config = {
  endpoint: "https://api.lmm.best/v1",
  model: "gpt-5.6-sol",
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
const effective = {
  ready: true,
  code: "ready" as const,
  preferredHttpStatus: null,
  source: "managed" as const,
  managedOverridesEnvironment: false,
  conflicts: { endpoint: false, model: false, protocol: false },
  endpointOrigin: "https://api.lmm.best",
  model: "gpt-5.6-sol",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  endpointMatchesRequired: true,
  modelMatchesRequired: true,
  protocolMatchesRequired: true,
  requiredEndpoint: "https://api.lmm.best/v1",
  requiredModel: "gpt-5.6-sol",
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

  it("accepts a committed candidate-test 202 and preserves mutation metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            status: "ready",
            outcome: "ready",
            phase: "response",
            model: "gpt-5.6-sol",
            responseStatus: 200,
            latencyMs: 800,
            firstByteLatencyMs: 700,
            performanceBudgetMs: 4_000,
            hardTimeoutMs: 20_000,
            message: "模型网关连接正常。",
            requestId: "request-test",
            committed: true,
            auditPending: true,
            maintenancePending: false,
            generationId: "generation-test",
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
    });
  });
});
