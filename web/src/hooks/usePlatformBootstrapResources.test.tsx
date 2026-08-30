import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createRootPlatformOrganization: vi.fn(),
  getPlatformSetupStatus: vi.fn(),
  getPlatformDomains: vi.fn(),
  getPlatformAiStatus: vi.fn(),
}));

vi.mock("../api", () => api);

import type {
  PlatformAiStatus,
  PlatformDomainRecord,
  PlatformSetupStatus,
} from "../api";
import { usePlatformBootstrapResources } from "./usePlatformBootstrapResources";

const setup = setupStatus();
const ai = aiStatus();
const domains: PlatformDomainRecord[] = [
  {
    id: "domain-1",
    slug: "market",
    name: "Market",
    status: "active",
    version: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  },
];

beforeEach(() => {
  api.createRootPlatformOrganization
    .mockReset()
    .mockResolvedValue({ name: "MatchPlane" });
  api.getPlatformSetupStatus.mockReset().mockResolvedValue(setup);
  api.getPlatformDomains.mockReset().mockResolvedValue(domains);
  api.getPlatformAiStatus.mockReset().mockResolvedValue(ai);
});

describe("usePlatformBootstrapResources", () => {
  it("preserves fulfilled siblings and retries only the failed resource", async () => {
    api.getPlatformDomains
      .mockRejectedValueOnce(new Error("数据范围服务暂时不可用"))
      .mockResolvedValueOnce([]);
    const { result } = renderResources();

    await waitFor(() => {
      expect(result.current.setup.status).toBe("ready");
      expect(result.current.ai.status).toBe("ready");
      expect(result.current.domains.status).toBe("error");
    });
    expect(result.current.setup).toMatchObject({ data: setup });
    expect(result.current.ai).toMatchObject({ data: ai });

    await act(async () => {
      await result.current.retryFailed();
    });

    expect(result.current.domains).toEqual({ status: "ready", data: [] });
    expect(api.getPlatformSetupStatus).toHaveBeenCalledTimes(1);
    expect(api.getPlatformAiStatus).toHaveBeenCalledTimes(1);
    expect(api.getPlatformDomains).toHaveBeenCalledTimes(2);
  });

  it("keeps previous setup stale after refresh failure and ignores a superseded completion", async () => {
    const { result } = renderResources();
    await waitFor(() => expect(result.current.setup.status).toBe("ready"));

    api.getPlatformSetupStatus.mockRejectedValueOnce(
      new Error("初始化状态重新验证失败"),
    );
    await act(async () => {
      await result.current.refreshSetupAndDomains();
    });
    expect(result.current.setup).toEqual({
      status: "error",
      message: "初始化状态重新验证失败",
      previous: setup,
    });

    const superseded = deferred<PlatformSetupStatus>();
    const newer = setupStatus({ status: "degraded" });
    api.getPlatformSetupStatus
      .mockReturnValueOnce(superseded.promise)
      .mockResolvedValueOnce(newer);
    let firstRefresh!: Promise<void>;
    await act(async () => {
      firstRefresh = result.current.refreshSetupAndDomains();
      await result.current.refreshSetupAndDomains();
    });
    expect(result.current.setup).toEqual({ status: "ready", data: newer });

    await act(async () => {
      superseded.resolve(setupStatus({ status: "ok" }));
      await firstRefresh;
    });
    expect(result.current.setup).toEqual({ status: "ready", data: newer });
  });

  it("keeps root POST success factual when both refreshes fail and never replays it", async () => {
    const onNotice = vi.fn();
    const { result } = renderResources(onNotice);
    await waitFor(() => expect(result.current.setup.status).toBe("ready"));
    api.getPlatformSetupStatus.mockRejectedValueOnce(
      new Error("初始化状态刷新失败"),
    );
    api.getPlatformDomains.mockRejectedValueOnce(new Error("数据范围刷新失败"));

    await act(async () => {
      await result.current.initializeRootOrganization();
    });

    expect(api.createRootPlatformOrganization).toHaveBeenCalledOnce();
    expect(onNotice).toHaveBeenCalledWith("商城组织“MatchPlane”已创建");
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(result.current.setup).toMatchObject({
      status: "error",
      previous: setup,
    });
    expect(result.current.domains).toMatchObject({
      status: "error",
      previous: domains,
    });

    await act(async () => {
      await result.current.initializeRootOrganization();
    });
    expect(onNotice).toHaveBeenCalledWith(
      "商城初始化状态尚未验证，请重新读取后再创建商城组织",
    );
    expect(api.createRootPlatformOrganization).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.retryFailed();
    });
    expect(api.createRootPlatformOrganization).toHaveBeenCalledOnce();
  });

  it("does not fetch bootstrap resources without manager authorization", () => {
    renderResources(vi.fn(), false);

    expect(api.getPlatformSetupStatus).not.toHaveBeenCalled();
    expect(api.getPlatformDomains).not.toHaveBeenCalled();
    expect(api.getPlatformAiStatus).not.toHaveBeenCalled();
  });
});

function renderResources(onNotice = vi.fn(), authorized = true) {
  return renderHook(() =>
    usePlatformBootstrapResources({
      authorized,
      rootRole: "rootSuperAdmin",
      onNotice,
    }),
  );
}

function setupStatus(
  overrides: Partial<PlatformSetupStatus> = {},
): PlatformSetupStatus {
  return {
    status: "ok",
    root: {
      tenantConfigured: true,
      tenantExists: true,
      tenantId: "tenant",
      tenant: { slug: "matchplane", name: "MatchPlane" },
      organization: null,
      rootAdminConfigured: true,
      identityAccounts: 1,
      rootAdminAccounts: 1,
    },
    domains: [],
    registrations: {},
    routing: { activeChildren: 0, ready: false },
    hostedAgent: { configured: false, status: "fallback" },
    builder: { configured: false, status: "unconfigured" },
    firstRun: { needsRootAccount: false, readyForAdmin: true },
    ...overrides,
  };
}

function aiStatus(): PlatformAiStatus {
  return {
    router: {
      configured: true,
      aiReady: true,
      protocol: "openai-compatible",
      model: "model",
      endpointOrigin: "https://router.example.com",
      source: "managed",
      managedOverridesEnvironment: false,
      conflicts: { endpoint: false, model: false, protocol: false },
      credentialConfigured: true,
      policyCode: "ready",
      policyIssues: [],
      originAllowlistApplied: true,
      toolMode: "auto",
      maxInputCharacters: 24_000,
      maxOutputTokens: 320,
      totalTimeoutMs: 20_000,
      maxSteps: 4,
      maxFanout: 4,
      requestsPerHour: 60,
      globalRequestsPerHour: 600,
    },
    auth: {
      primary: [],
      fallback: [],
      password: true,
      emailOtp: false,
      phoneOtp: false,
      magicLink: false,
      passkey: true,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
