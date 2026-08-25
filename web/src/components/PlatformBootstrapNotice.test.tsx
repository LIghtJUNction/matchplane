import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlatformBootstrapNotice } from "./PlatformBootstrapNotice";

describe("PlatformBootstrapNotice", () => {
  it("owns consolidated failure copy and one failed-resource retry", async () => {
    const onRetryFailed = vi.fn();
    const user = userEvent.setup();
    render(
      <PlatformBootstrapNotice
        authorized
        setup={{ status: "error", message: "初始化状态服务不可用" }}
        domains={{ status: "ready", data: [] }}
        ai={{ status: "loading" }}
        onRetryFailed={onRetryFailed}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("初始化状态服务不可用");
    expect(screen.getByRole("status")).toHaveTextContent("正在读取AI 状态");
    expect(screen.queryByText(/商城数据范围：/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新读取失败项" }));
    expect(onRetryFailed).toHaveBeenCalledOnce();
  });
});
