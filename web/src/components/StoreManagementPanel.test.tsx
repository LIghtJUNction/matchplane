import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getStoreManagement = vi.hoisted(() => vi.fn());
const updateStoreManagement = vi.hoisted(() => vi.fn());
const updateStoreLifecycle = vi.hoisted(() => vi.fn());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getStoreManagement,
    updateStoreManagement,
    updateStoreLifecycle,
  };
});

import { StoreManagementPanel } from "./StoreManagementPanel";
import type { StoreSummary } from "../api";

const activeStore: StoreSummary = {
  id: "store-123",
  slug: "test-store",
  path: "/test-store",
  displayName: "测试自营店",
  description: "优质车源与手作好物",
  integrationKind: "hosted",
  status: "active",
  version: 1,
};

const closedStore: StoreSummary = {
  ...activeStore,
  status: "closed",
  version: 2,
};

describe("StoreManagementPanel", () => {
  beforeEach(() => {
    getStoreManagement.mockReset();
    updateStoreManagement.mockReset();
    updateStoreLifecycle.mockReset();
  });

  it("renders operating status and allows store owner to pause (close) store", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const onUpdated = vi.fn();

    getStoreManagement.mockResolvedValue({
      store: activeStore,
      canManageStore: true,
    });
    updateStoreLifecycle.mockResolvedValue({
      ...activeStore,
      status: "closed",
      version: 2,
    });

    render(
      <StoreManagementPanel
        store={activeStore}
        canManageStore={true}
        onNotice={onNotice}
        onUpdated={onUpdated}
        locale="zh"
      />,
    );

    expect(await screen.findByText("正常营业中")).toBeVisible();
    const closeBtn = screen.getByRole("button", { name: /暂停营业（关闭店铺）/ });
    expect(closeBtn).toBeVisible();

    await user.click(closeBtn);

    expect(
      screen.getByText(/确定要暂停营业（关闭店铺）吗？/),
    ).toBeVisible();

    const confirmBtn = screen.getByRole("button", { name: "确认暂停营业" });
    await user.click(confirmBtn);

    await waitFor(() =>
      expect(updateStoreLifecycle).toHaveBeenCalledWith({
        storeId: "store-123",
        action: "close",
        expectedVersion: 1,
      }),
    );

    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "closed", version: 2 }),
    );
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("店铺已暂停营业"),
    );
  });

  it("allows store owner to reopen a closed store", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const onUpdated = vi.fn();

    getStoreManagement.mockResolvedValue({
      store: closedStore,
      canManageStore: true,
    });
    updateStoreLifecycle.mockResolvedValue({
      ...closedStore,
      status: "active",
      version: 3,
    });

    render(
      <StoreManagementPanel
        store={closedStore}
        canManageStore={true}
        onNotice={onNotice}
        onUpdated={onUpdated}
        locale="zh"
      />,
    );

    expect(await screen.findByText("已打烊 · 暂停营业")).toBeVisible();
    const reopenBtn = screen.getByRole("button", { name: /恢复营业（重新开店）/ });
    expect(reopenBtn).toBeVisible();

    await user.click(reopenBtn);

    await waitFor(() =>
      expect(updateStoreLifecycle).toHaveBeenCalledWith({
        storeId: "store-123",
        action: "reopen",
        expectedVersion: 2,
      }),
    );

    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", version: 3 }),
    );
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("店铺已恢复营业"),
    );
  });

  it("allows saving store profile name and description", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const onUpdated = vi.fn();

    getStoreManagement.mockResolvedValue({
      store: activeStore,
      canManageStore: true,
    });
    updateStoreManagement.mockResolvedValue({
      ...activeStore,
      displayName: "新店名",
      description: "新简介",
      version: 2,
    });

    render(
      <StoreManagementPanel
        store={activeStore}
        canManageStore={true}
        onNotice={onNotice}
        onUpdated={onUpdated}
        locale="zh"
      />,
    );

    const nameInput = await screen.findByDisplayValue("测试自营店");
    await user.clear(nameInput);
    await user.type(nameInput, "新店名");

    await user.click(screen.getByRole("button", { name: "保存店铺资料" }));

    await waitFor(() =>
      expect(updateStoreManagement).toHaveBeenCalledWith({
        storeId: "store-123",
        displayName: "新店名",
        description: "优质车源与手作好物",
        expectedVersion: 1,
      }),
    );
    expect(onNotice).toHaveBeenCalledWith("店铺资料已保存");
  });
});
