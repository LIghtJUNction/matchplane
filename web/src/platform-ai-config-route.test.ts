import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformRouterConfigValidationError } from "./lib/platform-router-config/contract";
import {
  PlatformRouterAuditPendingError,
  PlatformRouterConflictError,
  PlatformRouterLockTimeoutError,
} from "./lib/platform-router-config/transaction";
import {
  PlatformRouterStateIndeterminateError,
  PlatformRouterStorageUncertainError,
} from "./lib/platform-router-config/transactional-lifecycle";

const mocks = vi.hoisted(() => ({
  activateTransactionalManagedPlatformRouterDraft: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  getSession: vi.fn(),
  hasTrustedCookieOrigin: vi.fn(),
  stageTransactionalManagedPlatformRouterConfig: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedCookieOrigin: mocks.hasTrustedCookieOrigin,
}));
vi.mock("./lib/platform-router-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/platform-router-config")>()),
  activateTransactionalManagedPlatformRouterDraft:
    mocks.activateTransactionalManagedPlatformRouterDraft,
  getManagedPlatformRouterState: mocks.getManagedPlatformRouterState,
  stageTransactionalManagedPlatformRouterConfig:
    mocks.stageTransactionalManagedPlatformRouterConfig,
}));

import { GET, PATCH } from "../app/api/platform/ai/config/route";

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
const draft = {
  ...config,
  testedReady: false,
  testedAt: null,
  keyChanged: true,
};
const state = {
  config,
  draft,
  effective: {
    ready: true,
    code: "ready" as const,
    preferredHttpStatus: null,
    source: "managed" as const,
    managedOverridesEnvironment: true,
    conflicts: { endpoint: true, model: true, protocol: false },
    endpointOrigin: "https://tokenrhythm.studio",
    model: "deepseek-v4-flash-0731",
    protocol: "openai-compatible" as const,
    enabled: true,
    credentialConfigured: true,
    originAllowlistApplied: false,
    issues: [],
  },
};

function mutation(
  value: typeof config | typeof draft,
  pending: { auditPending?: boolean; maintenancePending?: boolean } = {},
) {
  return {
    value,
    state:
      "testedReady" in value
        ? { config, draft: value }
        : { config: value, draft: null },
    committed: true as const,
    auditPending: pending.auditPending ?? false,
    maintenancePending: pending.maintenancePending ?? false,
    generationId: "generation-2",
  };
}

function patch(body: unknown, requestId = "request-stage-1"): Promise<Response> {
  return PATCH(
    new Request("http://localhost/api/platform/ai/config", {
      method: "PATCH",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasTrustedCookieOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      role: "rootSuperAdmin",
    },
  });
  mocks.getManagedPlatformRouterState.mockReturnValue(state);
  mocks.stageTransactionalManagedPlatformRouterConfig.mockResolvedValue(
    mutation(draft),
  );
  mocks.activateTransactionalManagedPlatformRouterDraft.mockResolvedValue(
    mutation(config),
  );
});

describe("platform AI transactional config route", () => {
  it("keeps GET read-only, bounded, and credential-free", async () => {
    const response = await GET(
      new Request("http://localhost/api/platform/ai/config", {
        headers: {
          origin: "http://localhost",
          "x-request-id": "request-get-1",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('"source":"managed"');
    expect(text).toContain('"requestId":"request-get-1"');
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("fingerprint");
    expect(mocks.stageTransactionalManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(mocks.activateTransactionalManagedPlatformRouterDraft).not.toHaveBeenCalled();
  });

  it("stages once with actor/request identity and returns committed public state", async () => {
    const response = await patch({
      ...config,
      action: "stage",
      apiKey: "test-only-secret",
    });

    expect(response.status).toBe(200);
    expect(mocks.stageTransactionalManagedPlatformRouterConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "test-only-secret" }),
      {
        actor: "11111111-1111-4111-8111-111111111111",
        requestId: "request-stage-1",
      },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      config,
      draft,
      requestId: "request-stage-1",
      committed: true,
      auditPending: false,
      maintenancePending: false,
      generationId: "generation-2",
    });
    expect(JSON.stringify(body)).not.toContain("test-only-secret");
    expect(JSON.stringify(body)).not.toContain("credentialFile");
    expect(mocks.getManagedPlatformRouterState).not.toHaveBeenCalled();
  });

  it("activates without a post-commit reread and returns its exact committed public state", async () => {
    const response = await patch(
      { action: "activate" },
      "request-activate-1",
    );

    expect(response.status).toBe(200);
    expect(mocks.activateTransactionalManagedPlatformRouterDraft).toHaveBeenCalledWith({
      actor: "11111111-1111-4111-8111-111111111111",
      requestId: "request-activate-1",
    });
    expect(mocks.getManagedPlatformRouterState).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      config,
      draft: null,
      generationId: "generation-2",
    });
  });

  it.each([
    ["audit", { auditPending: true, maintenancePending: false }],
    ["maintenance", { auditPending: false, maintenancePending: true }],
  ])("returns committed 202 when %s finalization is pending", async (_name, pending) => {
    mocks.stageTransactionalManagedPlatformRouterConfig.mockResolvedValue(
      mutation(draft, pending),
    );

    const response = await patch({ ...config, action: "stage" });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      committed: true,
      auditPending: pending.auditPending ?? false,
      maintenancePending: pending.maintenancePending ?? false,
      generationId: "generation-2",
    });
  });

  it("maps lock and safe pre-commit audit-tail contention to retryable 503", async () => {
    for (const cause of [
      new PlatformRouterLockTimeoutError("raw lock detail"),
      new PlatformRouterAuditPendingError("raw audit tail detail"),
    ]) {
      mocks.stageTransactionalManagedPlatformRouterConfig.mockRejectedValueOnce(cause);
      const response = await patch({ ...config, action: "stage" });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).not.toContain(cause.message);
    }
  });

  it("maps conflicts and validation to action-specific bounded statuses", async () => {
    mocks.stageTransactionalManagedPlatformRouterConfig.mockRejectedValueOnce(
      new PlatformRouterConfigValidationError("raw invalid secret=value"),
    );
    expect((await patch({ ...config, action: "stage" })).status).toBe(400);

    mocks.activateTransactionalManagedPlatformRouterDraft.mockRejectedValueOnce(
      new PlatformRouterConfigValidationError("raw precondition"),
    );
    expect((await patch({ action: "activate" })).status).toBe(409);

    mocks.activateTransactionalManagedPlatformRouterDraft.mockRejectedValueOnce(
      new PlatformRouterConflictError("raw conflict"),
    );
    expect((await patch({ action: "activate" })).status).toBe(409);
  });

  it.each([
    new PlatformRouterStateIndeterminateError("raw secret state cause"),
    new PlatformRouterStorageUncertainError("raw secret storage cause"),
    Object.assign(new Error("raw filesystem secret cause"), { code: "EIO" }),
  ])("bounds indeterminate and I/O failures as 500", async (cause) => {
    mocks.stageTransactionalManagedPlatformRouterConfig.mockRejectedValueOnce(cause);
    const response = await patch({ ...config, action: "stage" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(cause.message);
    expect(text).not.toContain("secret");
  });

  it("keeps rootAdmin read-only and rejects untrusted writes before body or mutation", async () => {
    mocks.getSession.mockResolvedValue({
      user: {
        id: "22222222-2222-4222-8222-222222222222",
        role: "rootAdmin",
      },
    });
    expect(
      (
        await GET(
          new Request("http://localhost/api/platform/ai/config", {
            headers: { origin: "http://localhost" },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await patch({ action: "activate" })).status).toBe(403);

    mocks.hasTrustedCookieOrigin.mockReturnValue(false);
    expect((await patch({ action: "activate" })).status).toBe(403);
    expect(mocks.stageTransactionalManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(mocks.activateTransactionalManagedPlatformRouterDraft).not.toHaveBeenCalled();
  });

  it("includes a request id on authentication failures", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await patch({ action: "activate" }, "request-auth-1");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      requestId: "request-auth-1",
    });
  });

  it("retains bounded malformed and oversized request handling", async () => {
    const malformed = await PATCH(
      new Request("http://localhost/api/platform/ai/config", {
        method: "PATCH",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      requestId: expect.any(String),
    });

    const oversized = await patch({ payload: "x".repeat(33 * 1024) });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      requestId: "request-stage-1",
    });
    expect(mocks.stageTransactionalManagedPlatformRouterConfig).not.toHaveBeenCalled();
  });

  it("keeps both production mutation routes free of legacy producers", () => {
    const sources = [
      readFileSync(
        join(process.cwd(), "app/api/platform/ai/config/route.ts"),
        "utf8",
      ),
      readFileSync(
        join(process.cwd(), "app/api/platform/ai/test/route.ts"),
        "utf8",
      ),
    ].join("\n");
    const legacyIdentifiers = [
      "stage" + "ManagedPlatformRouterConfig",
      "activate" + "ManagedPlatformRouterDraft",
      "mark" + "ManagedPlatformRouterDraftTested",
      "append" + "PlatformRouterAudit",
    ];
    for (const identifier of legacyIdentifiers) {
      expect(sources).not.toContain(identifier);
    }
  });
});
