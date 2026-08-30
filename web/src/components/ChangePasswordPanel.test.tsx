import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const changePassword = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth-client", () => ({
  authClient: { changePassword },
}));

import { ChangePasswordPanel } from "./ChangePasswordPanel";

beforeEach(() => {
  changePassword.mockReset();
  changePassword.mockResolvedValue({ data: {}, error: null });
});

describe("ChangePasswordPanel", () => {
  it("changes the password and revokes other sessions by default", async () => {
    const onNotice = vi.fn();
    render(
      <ChangePasswordPanel
        email="buyer@example.com"
        locale="zh"
        onNotice={onNotice}
      />,
    );

    expect(screen.getByRole("link", { name: "忘记密码？" })).toHaveAttribute(
      "href",
      "/login?reset=1&email=buyer%40example.com",
    );

    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "old-password" },
    });
    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: "old-password",
        newPassword: "new-password",
        revokeOtherSessions: true,
      }),
    );
    expect(onNotice).toHaveBeenCalledWith("密码已修改，其他设备已退出登录");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("密码已修改");
    expect(status).toHaveTextContent(
      "其他设备已退出登录。下次登录时请使用新密码。",
    );

    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "another-password" },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("blocks mismatched confirmation locally", () => {
    const onNotice = vi.fn();
    render(<ChangePasswordPanel locale="zh" onNotice={onNotice} />);
    fireEvent.change(screen.getByLabelText("当前密码"), {
      target: { value: "old-password" },
    });
    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("再次输入新密码"), {
      target: { value: "different-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(changePassword).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("两次输入的新密码不一致");
    expect(screen.getByRole("alert")).toHaveTextContent("两次密码不一致");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请在两个新密码输入框中填写相同内容，然后重试。",
    );

    fireEvent.change(screen.getByLabelText("再次输入新密码"), {
      target: { value: "new-password" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an English inline API error with a recovery step", async () => {
    const onNotice = vi.fn();
    changePassword.mockResolvedValueOnce({
      data: null,
      error: { message: "Current password is incorrect." },
    });
    render(<ChangePasswordPanel locale="en" onNotice={onNotice} />);

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Password not changed");
    expect(alert).toHaveTextContent(
      "Current password is incorrect. Check your current password and try again.",
    );
    expect(onNotice).toHaveBeenCalledWith("Current password is incorrect.");
  });
});
