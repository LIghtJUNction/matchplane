import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/");
});

describe("MatchPlane workspaces", () => {
  it("switches between buyer, seller, and platform priorities", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: /适合你的车/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "卖家经营" }));
    expect(await screen.findByRole("heading", { name: /真正需要这台车的人/ })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "平台管理" }));
    expect(await screen.findByRole("heading", { name: /解释收益从哪里来/ })).toBeInTheDocument();
    expect(screen.getByText("线下成交撮合费")).toBeInTheDocument();
  });

  it("opens a vehicle sheet and creates an offline viewing request", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText("查看 2023 极氪 001 WE"));
    const dialog = screen.getByRole("dialog", { name: "2023 极氪 001 WE" });
    expect(within(dialog).getByText("匹配后直接联系卖家")).toBeInTheDocument();
    expect(within(dialog).getByText("成交价的 1%，成交后收取")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "申请联系并看车" }));
    expect(screen.getByRole("status")).toHaveTextContent("联系与看车申请已提交");
  });

  it("requires an explicit administrator confirmation before changing payment mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("tab", { name: "平台管理" }));
    await screen.findByRole("heading", { name: /解释收益从哪里来/ });
    await user.click(screen.getByRole("button", { name: "切换" }));

    const dialog = screen.getByRole("dialog", { name: "切换到生产模式？" });
    expect(within(dialog).getByText("未决订单检查")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认切换" }));

    expect(screen.getByText("生产模式")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("支付系统已切换为生产模式");
  });

  it("filters recommendations without hiding the buyer's hard constraints", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByRole("searchbox", { name: "搜索推荐车辆" }), "不存在的品牌");
    expect(screen.getByRole("heading", { name: "没有命中这次搜索" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /预算 20–30 万/ })).toBeInTheDocument();
  });
});
