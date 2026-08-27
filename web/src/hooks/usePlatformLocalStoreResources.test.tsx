import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateSubplatform: vi.fn(),
  discoverSubplatformSource: vi.fn(),
  getSubplatformOrganizations: vi.fn(),
  getSubplatformSourceIntake: vi.fn(),
  registerSubplatform: vi.fn(),
  uploadSubplatformArchive: vi.fn(),
}));

vi.mock("../api", () => api);

import type {
  PlatformDomainRecord,
  SubplatformOrganizationRecord,
  SubplatformSourceIntake,
} from "../api";
import type {
  PlatformDomainsResourceState,
  PlatformSetupResourceState,
} from "./usePlatformBootstrapResources";
import { usePlatformLocalStoreResources } from "./usePlatformLocalStoreResources";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getSubplatformOrganizations.mockResolvedValue([]);
  api.discoverSubplatformSource.mockResolvedValue({
    intakeId: "intake",
    state: "queued",
  });
  api.getSubplatformSourceIntake.mockResolvedValue(readyIntake());
  api.registerSubplatform.mockResolvedValue(registrationResult());
  api.activateSubplatform.mockResolvedValue({});
  api.uploadSubplatformArchive.mockResolvedValue({
    sourceKind: "archive",
    sourceLocator: "archive://uploaded",
    sourceDigest: "a".repeat(64),
    originalName: "store.tgz",
    size: 100,
  });
});

describe("usePlatformLocalStoreResources", () => {
  it("does not read before authorization and loads once when authorization is retained", async () => {
    const { rerender } = renderHook(
      ({ authorized }: { authorized: boolean }) =>
        usePlatformLocalStoreResources({
          authorized,
          apiAvailable: true,
          rootRole: "rootSuperAdmin",
          setup: readySetup,
          domains: readyDomains,
          onNotice,
        }),
      { initialProps: { authorized: false } },
    );

    expect(api.getSubplatformOrganizations).not.toHaveBeenCalled();

    rerender({ authorized: true });
    await waitFor(() =>
      expect(api.getSubplatformOrganizations).toHaveBeenCalledOnce(),
    );

    rerender({ authorized: true });
    expect(api.getSubplatformOrganizations).toHaveBeenCalledOnce();
  });

  it("distinguishes rejected organization loading from verified empty and retries GET only", async () => {
    api.getSubplatformOrganizations
      .mockRejectedValueOnce(new Error("本地店铺服务不可用"))
      .mockResolvedValueOnce([]);
    const { result } = renderResources();

    await waitFor(() =>
      expect(result.current.organizations).toMatchObject({
        status: "error",
        message: "本地店铺服务不可用",
      }),
    );
    await act(async () => result.current.retryFailed());

    expect(result.current.organizations).toEqual({ status: "ready", data: [] });
    expect(api.getSubplatformOrganizations).toHaveBeenCalledTimes(2);
    expect(api.registerSubplatform).not.toHaveBeenCalled();
    expect(api.activateSubplatform).not.toHaveBeenCalled();
  });

  it("blocks registration when setup or domain authority changes during discovery", async () => {
    const intake = deferred<SubplatformSourceIntake>();
    api.getSubplatformSourceIntake.mockReturnValueOnce(intake.promise);
    const { result, rerender } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    let registration!: Promise<boolean>;
    act(() => {
      registration = result.current.commitRegistration(gitDraft);
    });
    await waitFor(() =>
      expect(api.getSubplatformSourceIntake).toHaveBeenCalled(),
    );
    rerender({ setup: readySetup, domains: domainError });
    await act(async () => {
      intake.resolve(readyIntake());
      expect(await registration).toBe(false);
    });

    expect(api.registerSubplatform).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith("商城数据范围尚未验证");
  });

  it("does not transplant a discovered artifact across a changed tenant or root", async () => {
    const intake = deferred<SubplatformSourceIntake>();
    api.getSubplatformSourceIntake.mockReturnValueOnce(intake.promise);
    const { result, rerender } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    let registration!: Promise<boolean>;
    act(() => {
      registration = result.current.commitRegistration(gitDraft);
    });
    await waitFor(() =>
      expect(api.getSubplatformSourceIntake).toHaveBeenCalled(),
    );
    rerender({ setup: changedReadySetup, domains: readyDomains });
    await act(async () => {
      intake.resolve(readyIntake());
      expect(await registration).toBe(false);
    });

    expect(api.discoverSubplatformSource).toHaveBeenCalledWith(
      expect.objectContaining({ parentOrganizationId: "root" }),
    );
    expect(api.registerSubplatform).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith(
      "商城租户或根组织已变化，请重新读取后再接入店铺",
    );
  });

  it("preflight cancel releases the lock immediately and ignores the late run", async () => {
    const discovery = deferred<{ intakeId: string; state: string }>();
    api.discoverSubplatformSource.mockReturnValueOnce(discovery.promise);
    const { result } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    let registration!: Promise<boolean>;
    act(() => {
      registration = result.current.commitRegistration(gitDraft);
    });
    await waitFor(() =>
      expect(api.discoverSubplatformSource).toHaveBeenCalled(),
    );
    act(() => expect(result.current.cancelRegistration()).toBe(true));
    expect(result.current.mutation).toBeNull();
    expect(result.current.registrationCancellable).toBe(false);

    let replacement!: Promise<boolean>;
    act(() => {
      replacement = result.current.commitRegistration(gitDraft);
    });
    await act(async () => expect(await replacement).toBe(true));
    expect(api.registerSubplatform).toHaveBeenCalledOnce();

    await act(async () => {
      discovery.resolve({ intakeId: "late", state: "queued" });
      expect(await registration).toBe(false);
    });
    expect(api.registerSubplatform).toHaveBeenCalledOnce();
  });

  it("does not let cancel hide or replay an irreversible register POST", async () => {
    const serverCommit = deferred<ReturnType<typeof registrationResult>>();
    api.registerSubplatform.mockReturnValueOnce(serverCommit.promise);
    const { result } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    let registration!: Promise<boolean>;
    act(() => {
      registration = result.current.commitRegistration(gitDraft);
    });
    await waitFor(() => expect(api.registerSubplatform).toHaveBeenCalledOnce());
    expect(result.current.mutation).toBe("registration");
    expect(result.current.registrationCancellable).toBe(false);

    act(() => expect(result.current.cancelRegistration()).toBe(false));
    expect(result.current.mutation).toBe("registration");
    await act(async () =>
      expect(await result.current.commitRegistration(gitDraft)).toBe(false),
    );
    expect(api.registerSubplatform).toHaveBeenCalledOnce();

    await act(async () => {
      serverCommit.resolve(registrationResult());
      expect(await registration).toBe(true);
    });
    expect(onNotice).toHaveBeenLastCalledWith(
      "店铺 store 已登记，等待隔离构建器完成构建",
    );
    expect(api.registerSubplatform).toHaveBeenCalledOnce();
    expect(result.current.mutation).toBeNull();
  });

  it("unmount ignores a late intake response and never registers", async () => {
    const intake = deferred<SubplatformSourceIntake>();
    api.getSubplatformSourceIntake.mockReturnValueOnce(intake.promise);
    const { result, unmount } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    let registration!: Promise<boolean>;
    act(() => {
      registration = result.current.commitRegistration(gitDraft);
    });
    await waitFor(() =>
      expect(api.getSubplatformSourceIntake).toHaveBeenCalled(),
    );
    unmount();
    intake.resolve(readyIntake());

    expect(await registration).toBe(false);
    expect(api.registerSubplatform).not.toHaveBeenCalled();
  });

  it("keeps register success through failed refresh and never replays POST", async () => {
    const { result } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    await act(async () =>
      expect(await result.current.commitRegistration(gitDraft)).toBe(true),
    );
    expect(api.registerSubplatform).toHaveBeenCalledOnce();
    expect(api.registerSubplatform).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant",
        domainId: "domain",
        parentOrganizationId: "root",
      }),
    );
    expect(onNotice).toHaveBeenLastCalledWith(
      "店铺 store 已登记，等待隔离构建器完成构建",
    );

    api.getSubplatformOrganizations.mockRejectedValueOnce(
      new Error("登记后读取失败"),
    );
    await act(async () => result.current.refreshOrganizations());
    expect(result.current.organizations).toMatchObject({
      status: "error",
      previous: [],
    });
    expect(onNotice).toHaveBeenLastCalledWith(
      "店铺 store 已登记，等待隔离构建器完成构建",
    );

    api.getSubplatformOrganizations.mockResolvedValueOnce([activeStore()]);
    await act(async () => result.current.retryFailed());
    expect(api.registerSubplatform).toHaveBeenCalledOnce();
  });

  it("keeps activation success through failed refresh and never replays POST", async () => {
    api.getSubplatformOrganizations.mockResolvedValueOnce([readyStore()]);
    const { result } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    await act(async () =>
      expect(await result.current.commitActivation("store")).toBe(true),
    );
    expect(api.activateSubplatform).toHaveBeenCalledOnce();
    expect(onNotice).toHaveBeenLastCalledWith("Store 已激活并加入平台路由");

    api.getSubplatformOrganizations.mockRejectedValueOnce(
      new Error("激活后读取失败"),
    );
    await act(async () => result.current.refreshOrganizations());
    expect(result.current.organizations.status).toBe("error");
    api.getSubplatformOrganizations.mockResolvedValueOnce([activeStore()]);
    await act(async () => result.current.retryFailed());
    expect(api.activateSubplatform).toHaveBeenCalledOnce();
  });

  it("blocks writes when every verified domain is disabled", async () => {
    const disabledDomains: PlatformDomainsResourceState = {
      status: "ready",
      data: [{ ...domain, status: "disabled" }],
    };
    const { result } = renderResources({
      setup: readySetup,
      domains: disabledDomains,
    });
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );

    expect(result.current.writeBlockReason).toBe("商城数据尚未准备好");
    await act(async () =>
      expect(await result.current.commitRegistration(gitDraft)).toBe(false),
    );
    expect(api.discoverSubplatformSource).not.toHaveBeenCalled();
    expect(api.registerSubplatform).not.toHaveBeenCalled();
  });

  it("re-finds an activation row and blocks changed state or digest", async () => {
    api.getSubplatformOrganizations
      .mockResolvedValueOnce([readyStore()])
      .mockResolvedValueOnce([
        { ...readyStore(), registrationState: "building", buildDigest: null },
      ]);
    const { result } = renderResources();
    await waitFor(() =>
      expect(result.current.organizations.status).toBe("ready"),
    );
    await act(async () => result.current.refreshOrganizations());

    await act(async () =>
      expect(await result.current.commitActivation("store")).toBe(false),
    );
    expect(api.activateSubplatform).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenLastCalledWith(
      "店铺登记状态、构建凭据、来源或数据范围已变化，请重新读取",
    );
  });
});

function renderResources(
  initial: {
    setup: PlatformSetupResourceState;
    domains: PlatformDomainsResourceState;
  } = { setup: readySetup, domains: readyDomains },
) {
  return renderHook(
    ({
      setup,
      domains,
    }: {
      setup: PlatformSetupResourceState;
      domains: PlatformDomainsResourceState;
    }) =>
      usePlatformLocalStoreResources({
        authorized: true,
        apiAvailable: true,
        rootRole: "rootSuperAdmin",
        setup,
        domains,
        onNotice,
      }),
    { initialProps: initial },
  );
}

const gitDraft = {
  sourceKind: "git" as const,
  domainId: "domain",
  sourceLocator: "https://github.com/example/store.git",
  archive: null,
  membershipPolicy: "public" as const,
};

const readySetup: PlatformSetupResourceState = {
  status: "ready",
  data: {
    status: "ok",
    root: {
      tenantConfigured: true,
      tenantExists: true,
      tenantId: "tenant",
      tenant: { slug: "matchplane", name: "MatchPlane" },
      organization: {
        id: "root",
        slug: "root",
        name: "Root",
        tenantId: "tenant",
        domainId: null,
      },
      rootAdminConfigured: true,
      identityAccounts: 1,
      rootAdminAccounts: 1,
    },
    domains: [],
    registrations: {},
    routing: { activeChildren: 0, ready: false },
    hostedAgent: { configured: false, status: "fallback" },
    builder: { configured: true, status: "ready" },
    firstRun: { needsRootAccount: false, readyForAdmin: true },
  },
};
const changedReadySetup: PlatformSetupResourceState = {
  status: "ready",
  data: {
    ...readySetup.data,
    root: {
      ...readySetup.data.root,
      tenantId: "tenant-changed",
      tenant: { slug: "changed", name: "Changed" },
      organization: {
        ...readySetup.data.root.organization!,
        id: "root-changed",
        tenantId: "tenant-changed",
      },
    },
  },
};

const domain: PlatformDomainRecord = {
  id: "domain",
  slug: "market",
  name: "Market",
  status: "active",
  version: 1,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};
const readyDomains: PlatformDomainsResourceState = {
  status: "ready",
  data: [domain],
};
const domainError: PlatformDomainsResourceState = {
  status: "error",
  message: "domain failure",
  previous: [domain],
};

function registrationResult() {
  return {
    registrationId: "registration",
    organizationId: "store",
    slug: "store",
    state: "validated",
    manifestDigest: "c".repeat(64),
    sourceDigest: "a".repeat(64),
    next: "build",
  };
}

function readyIntake(): SubplatformSourceIntake {
  return {
    intakeId: "intake",
    state: "ready",
    sourceKind: "git",
    sourceLocator: gitDraft.sourceLocator,
    sourceDigest: "a".repeat(64),
    pinnedRevision: "b".repeat(40),
    manifest: { id: "pkg", slug: "store" },
    packageId: "pkg",
    slug: "store",
  };
}

function readyStore(): SubplatformOrganizationRecord {
  return {
    id: "store",
    name: "Store",
    slug: "store",
    parentOrganizationId: "root",
    tenantId: "tenant",
    domainId: "domain",
    sourceRepository: gitDraft.sourceLocator,
    sourceKind: "git",
    sourceLocator: gitDraft.sourceLocator,
    createdAt: "2026-08-26T00:00:00.000Z",
    registrationId: "registration",
    registrationState: "ready",
    buildDigest: "c".repeat(64),
    manifestDigest: "d".repeat(64),
  };
}

function activeStore(): SubplatformOrganizationRecord {
  return { ...readyStore(), registrationState: "active" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
