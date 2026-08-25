import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformRouterConfigValidationError } from "./lib/platform-router-config/contract";
import { PlatformRouterConflictError } from "./lib/platform-router-config/transaction";

const mocks = vi.hoisted(() => ({
  getPlatformRouterEffectiveStatus: vi.fn(),
  getSession: vi.fn(),
  hasTrustedCookieOrigin: vi.fn(),
  markTransactionalManagedPlatformRouterDraftTested: vi.fn(),
  platformRouterPolicyIssues: vi.fn(),
  prepareTransactionalManagedPlatformRouterDraftProbe: vi.fn(),
  probePlatformRouter: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedCookieOrigin: mocks.hasTrustedCookieOrigin,
}));
vi.mock("./platform-router", () => ({
  probePlatformRouter: mocks.probePlatformRouter,
}));
vi.mock("./lib/platform-router-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/platform-router-config")>()),
  getPlatformRouterEffectiveStatus: mocks.getPlatformRouterEffectiveStatus,
  markTransactionalManagedPlatformRouterDraftTested:
    mocks.markTransactionalManagedPlatformRouterDraftTested,
  platformRouterPolicyIssues: mocks.platformRouterPolicyIssues,
  prepareTransactionalManagedPlatformRouterDraftProbe:
    mocks.prepareTransactionalManagedPlatformRouterDraftProbe,
}));

import { POST } from "../app/api/platform/ai/test/route";

const draft = {
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
  testedReady: false,
  testedAt: null,
  keyChanged: true,
};
const prepared = {
  draft,
  secret: {
    ...draft,
    apiKey: "test-only-secret",
    credentialFile: "platform-router-key-test.key",
  },
  expectedGenerationId: "generation-before-probe",
  expectedDraftDigest: "a".repeat(64),
};
const readyProbe = {
  status: "ready" as const,
  outcome: "ready" as const,
  phase: "response" as const,
  model: "deepseek-v4-flash-0731",
  responseStatus: 200,
  latencyMs: 800,
  firstByteLatencyMs: 700,
  performanceBudgetMs: 4_000,
  hardTimeoutMs: 20_000,
  message: "模型网关连接正常。",
};

function candidateRequest(): Request {
  return new Request("http://localhost/api/platform/ai/test", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "x-request-id": "request-test-1",
    },
    body: JSON.stringify({ candidate: true }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedCookieOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      role: "rootAdmin",
    },
  });
  mocks.platformRouterPolicyIssues.mockReturnValue([]);
  mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
    ready: true,
    issues: [],
  });
  mocks.prepareTransactionalManagedPlatformRouterDraftProbe.mockReturnValue(
    prepared,
  );
  mocks.probePlatformRouter.mockResolvedValue(readyProbe);
  mocks.markTransactionalManagedPlatformRouterDraftTested.mockResolvedValue({
    value: { ...draft, testedReady: true },
    state: {
      config: null,
      draft: { ...draft, testedReady: true },
    },
    committed: true,
    auditPending: false,
    maintenancePending: false,
    generationId: "generation-after-probe",
  });
});

describe("platform AI transactional probe route", () => {
  it("keeps active rootAdmin probes read-only and reports slow as reachable", async () => {
    mocks.probePlatformRouter.mockResolvedValue({
      ...readyProbe,
      status: "slow",
      outcome: "slow",
      phase: "first_byte",
      latencyMs: 9_200,
      firstByteLatencyMs: 9_100,
      message: "模型网关可达，但响应较慢。",
    });
    const request = new Request("http://localhost/api/platform/ai/test", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "slow",
      requestId: expect.any(String),
    });
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).not.toHaveBeenCalled();
  });

  it("prepares once, probes the opaque snapshot, and transactionally records ready", async () => {
    mocks.getSession.mockResolvedValue({
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        role: "rootSuperAdmin",
      },
    });

    const response = await POST(candidateRequest());

    expect(response.status).toBe(200);
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).toHaveBeenCalledTimes(1);
    expect(mocks.probePlatformRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-test-1",
        configuration: expect.objectContaining({ apiKey: "test-only-secret" }),
      }),
    );
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).toHaveBeenCalledWith({
      actor: "11111111-1111-4111-8111-111111111111",
      requestId: "request-test-1",
      expectedGenerationId: "generation-before-probe",
      expectedDraftDigest: "a".repeat(64),
      status: "ready",
    });
    const text = await response.text();
    expect(text).toContain('"committed":true');
    expect(text).not.toContain("test-only-secret");
    expect(text).not.toContain("expectedDraftDigest");
    expect(text).not.toContain("credentialFile");
    expect(text).toContain('"draft"');
    expect(text).toContain('"testedReady":true');
  });

  it("returns committed 202 metadata when ready attestation finalization is pending", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "super", role: "rootSuperAdmin" },
    });
    mocks.markTransactionalManagedPlatformRouterDraftTested.mockResolvedValue({
      value: { ...draft, testedReady: true },
      state: {
        config: null,
        draft: { ...draft, testedReady: true },
      },
      committed: true,
      auditPending: true,
      maintenancePending: true,
      generationId: "generation-after-probe",
    });

    const response = await POST(candidateRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      committed: true,
      auditPending: true,
      maintenancePending: true,
      generationId: "generation-after-probe",
    });
  });

  it("makes no mutation when a candidate provider probe is not ready", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "super", role: "rootSuperAdmin" },
    });
    mocks.probePlatformRouter.mockResolvedValue({
      ...readyProbe,
      status: "failed",
      outcome: "upstream_http",
      responseStatus: 503,
      message: "安全状态说明",
    });

    const response = await POST(candidateRequest());

    expect(response.status).toBe(451);
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).not.toHaveBeenCalled();
    const text = await response.text();
    expect(text).not.toContain("test-only-secret");
  });

  it("maps a concurrent restage during probe to 409 with no stale attestation", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "super", role: "rootSuperAdmin" },
    });
    mocks.markTransactionalManagedPlatformRouterDraftTested.mockRejectedValue(
      new PlatformRouterConflictError("raw stale digest"),
    );

    const response = await POST(candidateRequest());

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain("raw stale digest");
    expect(text).not.toContain("a".repeat(64));
  });

  it("maps missing candidate to 409 and policy-invalid candidate to bounded 451", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "super", role: "rootSuperAdmin" },
    });
    mocks.prepareTransactionalManagedPlatformRouterDraftProbe.mockImplementationOnce(
      () => {
        throw new PlatformRouterConfigValidationError("raw missing candidate");
      },
    );
    expect((await POST(candidateRequest())).status).toBe(409);
    expect(mocks.probePlatformRouter).not.toHaveBeenCalled();

    mocks.platformRouterPolicyIssues.mockReturnValue(["model_invalid"]);
    const invalid = await POST(candidateRequest());
    expect(invalid.status).toBe(451);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "upstream_configuration",
      issues: ["model_invalid"],
    });
    expect(mocks.probePlatformRouter).not.toHaveBeenCalled();
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).not.toHaveBeenCalled();
  });

  it("preserves active policy blocking without touching candidate state", async () => {
    mocks.getPlatformRouterEffectiveStatus.mockReturnValue({
      ready: false,
      issues: ["model_invalid"],
    });
    const response = await POST(
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    );
    expect(response.status).toBe(451);
    expect(mocks.probePlatformRouter).not.toHaveBeenCalled();
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, primitive, and unsupported candidate bodies before probing", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "super", role: "rootSuperAdmin" },
    });
    const cases = [
      { body: "{", status: 400 },
      { body: "   ", status: 400 },
      { body: "null", status: 400 },
      { body: "true", status: 400 },
      { body: "[]", status: 400 },
      { body: JSON.stringify({ candidate: "true" }), status: 400 },
      { body: JSON.stringify({ unknown: true }), status: 400 },
      {
        body: JSON.stringify({ candidate: true, extra: true }),
        status: 400,
      },
      {
        body: JSON.stringify({ payload: "x".repeat(4 * 1024) }),
        status: 413,
      },
    ];

    for (const testCase of cases) {
      const response = await POST(
        new Request("http://localhost/api/platform/ai/test", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            "content-type": "application/json",
            "x-request-id": "request-invalid-body",
          },
          body: testCase.body,
        }),
      );
      expect(response.status).toBe(testCase.status);
      await expect(response.json()).resolves.toMatchObject({
        requestId: "request-invalid-body",
      });
    }
    expect(mocks.probePlatformRouter).not.toHaveBeenCalled();
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).not.toHaveBeenCalled();
  });

  it("accepts null and non-null zero-byte bodies, an empty object, or candidate false as active probes", async () => {
    const requests = [
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
        body: "",
      }),
      new Request("http://localhost/api/platform/ai/test", {
        method: "POST",
        headers: { origin: "http://localhost" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      ...["{}", '{"candidate":false}'].map(
        (body) =>
          new Request("http://localhost/api/platform/ai/test", {
            method: "POST",
            headers: { origin: "http://localhost" },
            body,
          }),
      ),
    ];

    for (const request of requests) {
      expect((await POST(request)).status).toBe(200);
    }
    expect(mocks.probePlatformRouter).toHaveBeenCalledTimes(5);
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();
    expect(mocks.markTransactionalManagedPlatformRouterDraftTested).not.toHaveBeenCalled();
  });

  it("keeps candidate role and trusted-origin boundaries before preparation", async () => {
    const roleDenied = await POST(candidateRequest());
    expect(roleDenied.status).toBe(403);
    await expect(roleDenied.json()).resolves.toMatchObject({
      requestId: "request-test-1",
    });
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();

    mocks.hasTrustedCookieOrigin.mockReturnValue(false);
    const originDenied = await POST(candidateRequest());
    expect(originDenied.status).toBe(403);
    await expect(originDenied.json()).resolves.toMatchObject({
      requestId: "request-test-1",
    });
    expect(mocks.prepareTransactionalManagedPlatformRouterDraftProbe).not.toHaveBeenCalled();
  });
});
