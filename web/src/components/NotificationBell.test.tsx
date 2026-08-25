import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getUserNotifications: vi.fn(),
  markUserNotificationsRead: vi.fn(),
}));

vi.mock("../api", () => api);

import { NotificationBell } from "./NotificationBell";

beforeEach(() => {
  api.getUserNotifications.mockResolvedValue({
    unreadCount: 2,
    notifications: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "offer_liked",
        title: "商品收到新的赞",
        body: "测试商品",
        actionPath: "/store-a?console=products",
        createdAt: "2026-08-22T10:00:00.000Z",
        read: false,
      },
    ],
  });
  api.markUserNotificationsRead.mockResolvedValue(0);
});

describe("NotificationBell", () => {
  it("shows the unread count and marks every notification read", async () => {
    const user = userEvent.setup();
    render(
      <NotificationBell
        locale="zh"
        userId="22222222-2222-4222-8222-222222222222"
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "通知，2 条未读",
    });
    await user.click(trigger);
    expect(screen.getByText("商品收到新的赞")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "全部已读" }));

    expect(api.markUserNotificationsRead).toHaveBeenCalledWith({ all: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "通知" })).toBeInTheDocument(),
    );
  });

  it("keeps a failed feed retryable", async () => {
    api.getUserNotifications
      .mockRejectedValueOnce(new Error("暂时失败"))
      .mockRejectedValueOnce(new Error("暂时失败"))
      .mockResolvedValueOnce({ unreadCount: 0, notifications: [] });
    const user = userEvent.setup();
    render(
      <NotificationBell
        locale="zh"
        userId="22222222-2222-4222-8222-222222222222"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "通知" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时失败");
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("暂无通知")).toBeInTheDocument();
  });
});
