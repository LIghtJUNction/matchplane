import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SubplatformConfig } from "../../subplatform";

vi.mock("../NotificationBell", () => ({
  NotificationBell: () => <button type="button">通知</button>,
}));

vi.mock("../PlatformMenu", () => ({
  PlatformMenu: () => <span data-testid="platform-menu" />,
}));

import { PlatformHeader } from "./PlatformHeader";

const subplatform = {
  slug: "root",
  path: "/",
  label: "MatchPlane",
  brandName: "MatchPlane",
  ui: {},
} as SubplatformConfig;

const ui = {
  rootPlatform: "总平台",
  myStores: "我的店铺",
  openStore: "开设店铺",
  signIn: "登录",
  platformAdmin: "商城控制台",
  accountMenu: "账户菜单",
  user: "用户",
  unifiedIdentity: "统一身份",
  profile: "个人资料",
  account: "账号",
  signOut: "退出登录",
};

function renderHeader(
  authUser: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null,
) {
  const onOpenAccountSection = vi.fn();
  const onOpenStoreCenter = vi.fn();
  const view = render(
    <PlatformHeader
      subplatform={subplatform}
      role="buyer"
      theme="light"
      locale="zh"
      palette="ink"
      textSize="default"
      onThemeChange={vi.fn()}
      onLocaleChange={vi.fn()}
      onPaletteChange={vi.fn()}
      onTextSizeChange={vi.fn()}
      authUser={authUser}
      authResolved
      ownedStoresCount={3}
      ownedStoresError={null}
      ownedStoresResolved
      onOpenSignIn={vi.fn()}
      onOpenStoreCenter={onOpenStoreCenter}
      onOpenAccountSection={onOpenAccountSection}
      onSignOut={vi.fn()}
      ui={ui}
    />,
  );
  return { ...view, onOpenAccountSection, onOpenStoreCenter };
}

describe("PlatformHeader account actions", () => {
  it("keeps merchant and platform administration inside one avatar menu", async () => {
    const user = userEvent.setup();
    const { container, onOpenAccountSection } = renderHeader({
      id: "admin-1",
      name: "MatchPlane Administrator",
      email: "admin@example.test",
      role: "rootAdmin",
    });

    expect(container.querySelector(".header-store-action")).toBeNull();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("商城控制台")).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "账户菜单" });
    await user.click(trigger);

    const menu = await screen.findByRole("menu", { name: "账户菜单" });
    expect(
      within(menu).getByRole("menuitem", { name: /我的店铺/ }),
    ).toBeVisible();
    expect(
      within(menu).getByRole("menuitem", { name: "商城控制台" }),
    ).toHaveAttribute("href", "/?role=platform");
    expect(screen.getAllByText("商城控制台")).toHaveLength(1);

    await user.click(within(menu).getByRole("menuitem", { name: /我的店铺/ }));
    expect(onOpenAccountSection).toHaveBeenCalledWith("stores");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );

    await user.click(trigger);
    await screen.findByRole("menu", { name: "账户菜单" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("does not expose platform administration to an ordinary account", async () => {
    const user = userEvent.setup();
    renderHeader({
      id: "buyer-1",
      name: "Buyer",
      email: "buyer@example.test",
      role: "customer",
    });

    await user.click(screen.getByRole("button", { name: "账户菜单" }));
    const menu = await screen.findByRole("menu", { name: "账户菜单" });
    expect(
      within(menu).queryByRole("menuitem", { name: "商城控制台" }),
    ).not.toBeInTheDocument();
  });

  it("shows only public entry actions while signed out", async () => {
    const user = userEvent.setup();
    const { onOpenStoreCenter } = renderHeader(null);

    expect(
      screen.queryByRole("button", { name: "账户菜单" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("商城控制台")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "开设店铺" }));
    expect(onOpenStoreCenter).toHaveBeenCalledTimes(1);
  });
});
