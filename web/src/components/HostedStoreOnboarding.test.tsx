import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createHostedStore: vi.fn(),
  createStoreCollaboratorInvite: vi.fn(),
  getOwnedStores: vi.fn(),
}));

vi.mock("../api", () => api);

import { HostedStoreOnboarding } from "./HostedStoreOnboarding";

const store = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "store-a1b2c3d4e5f6",
  path: "/store-a1b2c3d4e5f6",
  displayName: "山里杂货铺",
  description: "手作与山货",
  integrationKind: "hosted" as const,
  status: "active" as const,
  membershipRole: "owner" as const,
};

beforeEach(() => {
  api.createHostedStore.mockReset();
  api.createStoreCollaboratorInvite.mockReset();
  api.getOwnedStores.mockReset();
  api.getOwnedStores.mockResolvedValue([]);
  api.createHostedStore.mockResolvedValue(store);
  api.createStoreCollaboratorInvite.mockResolvedValue({
    storeId: store.id,
    registrationUrl:
      "https://matchplane.test/admin/register?token=mpa_token&next=%2Fstore-a1b2c3d4e5f6%3Fconsole%3Dproducts",
    expiresAt: "2026-08-28T12:00:00.000Z",
  });
});

describe("hosted store onboarding", () => {
  it("asks only for store details and lets the server assign the path", async () => {
    const user = userEvent.setup();
    render(<HostedStoreOnboarding locale="zh" onNotice={vi.fn()} />);

    await waitFor(() => expect(api.getOwnedStores).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "开一家店" }));

    expect(screen.getByLabelText("店铺名称")).toBeInTheDocument();
    expect(screen.getByLabelText("店铺简介（选填）")).toBeInTheDocument();
    expect(screen.queryByLabelText(/店铺地址/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("店铺名称"), "山里杂货铺");
    await user.type(screen.getByLabelText("店铺简介（选填）"), "手作与山货");
    await user.click(screen.getByRole("button", { name: "创建店铺" }));

    expect(api.createHostedStore).toHaveBeenCalledWith({
      name: "山里杂货铺",
      description: "手作与山货",
    });
    expect(await screen.findByText("店铺已经准备好了")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始添加商品" })).toHaveAttribute(
      "href",
      "/store-a1b2c3d4e5f6?console=products",
    );
  });

  it("shows active stores first and keeps inactive stores in a secondary disclosure", async () => {
    const user = userEvent.setup();
    const closedStore = {
      ...store,
      id: "22222222-2222-4222-8222-222222222222",
      path: "/archived-store",
      displayName: "已归档验证店",
      description: "automated production validation archive",
      status: "closed" as const,
    };
    const suspendedStore = {
      ...store,
      id: "33333333-3333-4333-8333-333333333333",
      path: "/paused-store",
      displayName: "暂停店铺",
      description: "dogfood internal test",
      status: "suspended" as const,
    };
    api.getOwnedStores.mockResolvedValue([closedStore, suspendedStore, store]);

    render(<HostedStoreOnboarding locale="zh" onNotice={vi.fn()} />);

    expect(await screen.findByText(store.displayName)).toBeVisible();
    const disclosure = screen.getByRole("button", {
      name: /其他状态的店铺2/,
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(closedStore.displayName)).not.toBeInTheDocument();
    expect(screen.queryByText(closedStore.description)).not.toBeInTheDocument();

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(closedStore.displayName)).toBeVisible();
    expect(screen.getByText(suspendedStore.displayName)).toBeVisible();
    expect(screen.getByText(/已暂停公开营业/)).toBeVisible();
    expect(screen.getByText(/已暂停公开展示/)).toBeVisible();
    expect(screen.queryByText("dogfood internal test")).not.toBeInTheDocument();
  });

  it("opens product management in place when the host provides a store callback", async () => {
    const user = userEvent.setup();
    const onManageStore = vi.fn();
    api.getOwnedStores.mockResolvedValue([store]);
    render(
      <HostedStoreOnboarding
        locale="zh"
        onNotice={vi.fn()}
        onManageStore={onManageStore}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "管理商品" }));
    expect(onManageStore).toHaveBeenCalledWith(store);
    expect(window.location.pathname).toBe("/");
  });

  it("creates a one-person collaborator link for a store owner", async () => {
    const user = userEvent.setup();
    api.getOwnedStores.mockResolvedValue([store]);
    render(<HostedStoreOnboarding locale="zh" onNotice={vi.fn()} />);

    const inviteButton = await screen.findByRole("button", {
      name: "邀请协作",
    });
    await user.click(inviteButton);

    expect(api.createStoreCollaboratorInvite).toHaveBeenCalledWith(store.id);
    const link = await screen.findByLabelText<HTMLInputElement>("协作邀请链接");
    expect(link.value).toContain("/admin/register?token=");
    expect(screen.getByText(/每条链接限一人于 7 天内使用/)).toBeInTheDocument();
    expect(inviteButton).toBeDisabled();
  });
});
