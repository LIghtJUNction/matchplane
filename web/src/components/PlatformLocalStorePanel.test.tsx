import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PlatformDomainRecord,
  SubplatformOrganizationRecord,
} from "../api";
import type { PlatformDomainsResourceState } from "../hooks/usePlatformBootstrapResources";
import type { PlatformLocalStoreController } from "../hooks/usePlatformLocalStoreResources";
import { PlatformLocalStorePanel } from "./PlatformLocalStorePanel";

const onNotice = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlatformLocalStorePanel", () => {
  it("distinguishes rejected loading from verified local-store emptiness", async () => {
    const user = userEvent.setup();
    const retryFailed = vi.fn(async () => undefined);
    const { rerender } = renderPanel(
      makeController({
        organizations: {
          status: "error",
          message: "本地店铺服务不可用",
        },
        retryFailed,
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("本地店铺服务不可用");
    expect(screen.queryByText("还没有本地店铺。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(retryFailed).toHaveBeenCalledOnce();

    rerender(panel(makeController()));
    expect(screen.getByText("还没有本地店铺。")).toBeInTheDocument();
  });

  it("shows stale rows read-only instead of reporting an empty store list", () => {
    renderPanel(
      makeController({
        organizations: {
          status: "error",
          message: "重新读取失败",
          previous: [activeStore()],
        },
      }),
    );

    expect(screen.getByText("Store")).toBeInTheDocument();
    expect(screen.getByText(/仅展示上次结果/)).toBeInTheDocument();
    expect(screen.queryByText("还没有本地店铺。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
  });

  it("uses conditional required controls and closes only after committed registration", async () => {
    const user = userEvent.setup();
    const refresh = deferred<void>();
    const commitRegistration = vi.fn(async () => true);
    const refreshOrganizations = vi.fn(() => refresh.promise);
    renderPanel(makeController({ commitRegistration, refreshOrganizations }));

    await user.click(screen.getByRole("button", { name: "接入本地店铺" }));
    const form = screen.getByRole("form", { name: "接入本地店铺" });
    const domainSelect = screen.getByLabelText("商城数据范围");
    const gitInput = screen.getByLabelText("Git HTTPS 地址（不含凭据）");
    expect(domainSelect).toBeRequired();
    expect(gitInput).toBeRequired();
    expect(screen.getByRole("button", { name: "Git 仓库" })).toHaveAttribute(
      "type",
      "button",
    );

    await user.click(screen.getByRole("button", { name: "上传压缩包" }));
    const fileInput = screen.getByLabelText("选择本地店铺压缩包");
    expect(fileInput).toBeRequired();
    await user.click(screen.getByRole("button", { name: "Git 仓库" }));
    await user.type(
      screen.getByLabelText("Git HTTPS 地址（不含凭据）"),
      "https://github.com/example/store.git",
    );
    await user.click(screen.getByRole("button", { name: "构建本地店铺" }));

    await waitFor(() => expect(form).not.toBeInTheDocument());
    expect(commitRegistration).toHaveBeenCalledOnce();
    expect(commitRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "git",
        domainId: "domain",
        sourceLocator: "https://github.com/example/store.git",
      }),
    );
    expect(refreshOrganizations).toHaveBeenCalledOnce();
    await act(async () => refresh.resolve());
  });

  it("disables mutable inputs during discovery and cancel stops the run", async () => {
    const user = userEvent.setup();
    const cancelRegistration = vi.fn(() => true);
    const { rerender } = renderPanel(makeController({ cancelRegistration }));
    await user.click(screen.getByRole("button", { name: "接入本地店铺" }));

    rerender(
      panel(
        makeController({
          mutation: "registration",
          operationPhase: "隔离构建器正在读取 manifest…",
          registrationCancellable: true,
          cancelRegistration,
        }),
      ),
    );

    expect(screen.getByLabelText("商城数据范围")).toBeDisabled();
    expect(screen.getByLabelText("Git HTTPS 地址（不含凭据）")).toBeDisabled();
    expect(
      screen.getByText("隔离构建器正在读取 manifest…"),
    ).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "接入本地店铺" });
    await user.click(within(form).getByRole("button", { name: "取消" }));
    expect(cancelRegistration).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("form", { name: "接入本地店铺" }),
    ).not.toBeInTheDocument();
  });

  it("blocks close and cancel controls after registration becomes irreversible", async () => {
    const user = userEvent.setup();
    const cancelRegistration = vi.fn(() => false);
    const { rerender } = renderPanel(makeController({ cancelRegistration }));
    await user.click(screen.getByRole("button", { name: "接入本地店铺" }));

    rerender(
      panel(
        makeController({
          mutation: "registration",
          operationPhase: "manifest 已验证，正在登记店铺…",
          registrationCancellable: false,
          cancelRegistration,
        }),
      ),
    );

    const locked = screen.getAllByRole("button", { name: "登记中…" });
    expect(locked).toHaveLength(2);
    for (const button of locked) expect(button).toBeDisabled();
    expect(cancelRegistration).not.toHaveBeenCalled();
    expect(
      screen.getByRole("form", { name: "接入本地店铺" }),
    ).toBeInTheDocument();
  });

  it("passes only the organization id to activation and refreshes after success", async () => {
    const user = userEvent.setup();
    const commitActivation = vi.fn(async () => true);
    const refreshOrganizations = vi.fn(async () => undefined);
    renderPanel(
      makeController({
        organizations: { status: "ready", data: [readyStore()] },
        commitActivation,
        refreshOrganizations,
      }),
    );

    await user.click(screen.getByRole("button", { name: "上线店铺" }));

    expect(commitActivation).toHaveBeenCalledWith("store");
    expect(refreshOrganizations).toHaveBeenCalledOnce();
  });
});

function renderPanel(controller: PlatformLocalStoreController) {
  return render(panel(controller));
}

function panel(controller: PlatformLocalStoreController) {
  return (
    <PlatformLocalStorePanel
      controller={controller}
      domainsResource={readyDomains}
      onNotice={onNotice}
    />
  );
}

function makeController(
  overrides: Partial<PlatformLocalStoreController> = {},
): PlatformLocalStoreController {
  return {
    organizations: { status: "ready", data: [] },
    mutation: null,
    operationPhase: "",
    registrationCancellable: false,
    writeBlockReason: null,
    retryAvailable: true,
    retryFailed: vi.fn(async () => undefined),
    refreshOrganizations: vi.fn(async () => undefined),
    cancelRegistration: vi.fn(() => true),
    commitRegistration: vi.fn(async () => true),
    commitActivation: vi.fn(async () => true),
    prepareUpdate: vi.fn(() => null),
    ...overrides,
  };
}

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

function readyStore(): SubplatformOrganizationRecord {
  return {
    id: "store",
    name: "Store",
    slug: "store",
    parentOrganizationId: "root",
    tenantId: "tenant",
    domainId: "domain",
    sourceRepository: "https://github.com/example/store.git",
    sourceKind: "git",
    sourceLocator: "https://github.com/example/store.git",
    createdAt: "2026-08-26T00:00:00.000Z",
    registrationId: "registration",
    registrationState: "ready",
    buildDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
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
