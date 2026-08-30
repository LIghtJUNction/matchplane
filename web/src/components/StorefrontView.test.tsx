import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { resolveSubplatform } from "../subplatform";
import { StorefrontView } from "./StorefrontView";

const listing = {
  id: "offer-1",
  title: "通勤背包",
  subtitle: "轻便防水",
  description: "适合每天通勤",
  storeName: "山间小店",
  price: "CNY 399.00",
  accent: "cactus" as const,
  facts: [{ label: "容量", value: "20L" }],
};

describe("StorefrontView", () => {
  it("shows store identity and products with an accessible manager dialog", async () => {
    const user = userEvent.setup();
    const onOpenListing = vi.fn();
    const { container } = render(
      <StorefrontView
        catalogResolved
        listings={[listing]}
        locale="zh"
        onOpenListing={onOpenListing}
        subplatform={{
          ...resolveSubplatform("/stores/mountain"),
          brandName: "山间小店",
          label: "山间小店",
          description: "做耐用、清楚标价的日常用品。",
        }}
      />,
    );

    expect(container.firstElementChild).toHaveClass("root-storefront-page");
    expect(
      screen.getByRole("heading", { name: "山间小店" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("做耐用、清楚标价的日常用品。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "商品" })).toBeInTheDocument();
    expect(screen.getByText("通勤背包")).toBeInTheDocument();
    expect(
      screen.queryByText(/联系方式|经营管理|SMTP/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通勤背包" }));
    expect(onOpenListing).toHaveBeenCalledWith(listing);
    const managerTrigger = screen.getByRole("button", { name: "与店长对话" });
    await user.click(managerTrigger);
    expect(screen.getByRole("dialog", { name: "咨询山间小店" })).toBeVisible();
    expect(screen.getByText(/未经你确认，不会交换联系方式/)).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "咨询山间小店" }),
      ).not.toBeInTheDocument(),
    );
    expect(managerTrigger).toHaveFocus();
  });

  it("has a human empty state with a route back to the mall", () => {
    render(
      <StorefrontView
        catalogResolved
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        subplatform={{
          ...resolveSubplatform("/stores/empty"),
          brandName: "空店",
          label: "空店",
        }}
      />,
    );
    expect(screen.getByText("这家店暂时没有在售商品")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "咨询店长" })).toBeVisible();
    expect(screen.getByRole("link", { name: "浏览其他店铺" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("uses manifest copy for a manager's first-product action", async () => {
    const user = userEvent.setup();
    const onOpenStoreConsole = vi.fn();
    render(
      <StorefrontView
        catalogResolved
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        canManageStore
        onOpenStoreConsole={onOpenStoreConsole}
        subplatform={{
          ...resolveSubplatform("/store-a"),
          brandName: "Store A",
          label: "Store A",
          ui: {
            copy: {
              emptyManagerTitle: "还没有发布商品",
              emptyManagerAction: "发布第一个商品",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("还没有发布商品")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "发布第一个商品" }));
    expect(onOpenStoreConsole).toHaveBeenCalledTimes(1);
  });

  it("distinguishes catalog loading from a recoverable error", async () => {
    const user = userEvent.setup();
    const onRetryCatalog = vi.fn();
    const view = render(
      <StorefrontView
        catalogResolved={false}
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        subplatform={{
          ...resolveSubplatform("/stores/loading"),
          brandName: "读取中店铺",
          label: "读取中店铺",
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在读取商品");

    view.rerender(
      <StorefrontView
        catalogResolved={false}
        catalogError
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        onRetryCatalog={onRetryCatalog}
        subplatform={{
          ...resolveSubplatform("/stores/loading"),
          brandName: "读取中店铺",
          label: "读取中店铺",
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("商品暂时无法读取");
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  });

  it("renders a clear closed notice with a button to reopen for store managers", () => {
    const onOpenStoreConsole = vi.fn();
    render(
      <StorefrontView
        catalogResolved
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        canManageStore={true}
        onOpenStoreConsole={onOpenStoreConsole}
        subplatform={{
          ...resolveSubplatform("/stores/closed-store"),
          brandName: "打烊小店",
          label: "打烊小店",
          status: "closed",
        }}
      />,
    );

    expect(screen.getByText("该店铺已打烊 · 暂停营业")).toBeVisible();
    expect(screen.getByText(/店主已暂时暂停对外营业/)).toBeVisible();
    expect(screen.getByRole("link", { name: "返回商城首页" })).toHaveAttribute(
      "href",
      "/",
    );

    const reopenBtn = screen.getByRole("button", {
      name: "进入店铺工作台（恢复营业）",
    });
    expect(reopenBtn).toBeVisible();
    fireEvent.click(reopenBtn);
    expect(onOpenStoreConsole).toHaveBeenCalled();
  });

  it("renders a suspended notice when the store is suspended by the platform", () => {
    render(
      <StorefrontView
        catalogResolved
        listings={[]}
        locale="zh"
        onOpenListing={vi.fn()}
        subplatform={{
          ...resolveSubplatform("/stores/suspended-store"),
          brandName: "暂停小店",
          label: "暂停小店",
          status: "suspended",
        }}
      />,
    );

    expect(screen.getByText("该店铺已被平台暂停服务")).toBeVisible();
    expect(screen.getByText(/该店铺已被商城管理暂停营业/)).toBeVisible();
    expect(screen.getByRole("link", { name: "返回商城首页" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
