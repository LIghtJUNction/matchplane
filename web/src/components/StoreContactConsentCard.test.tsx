import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedContactChannels = vi.hoisted(() => vi.fn());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, getVerifiedContactChannels };
});

import { StoreContactConsentCard } from "./StoreContactConsentCard";

const action = {
  type: "contact_consent" as const,
  id: "contact-consent-1",
  reason: "店员需要确认交付时间。",
  productId: "offer-1",
};

describe("StoreContactConsentCard", () => {
  beforeEach(() => {
    getVerifiedContactChannels.mockReset();
  });

  it("shows verified bindings as read-only values and waits for explicit agreement", async () => {
    const user = userEvent.setup();
    const onAgree = vi.fn(async () => undefined);
    getVerifiedContactChannels.mockResolvedValue([
      { type: "email", value: "buyer@example.com" },
      { type: "phone", value: "+8613800000000" },
    ]);

    render(
      <StoreContactConsentCard
        action={action}
        locale="zh"
        onAgree={onAgree}
      />,
    );

    expect(await screen.findByText("buyer@example.com")).toBeVisible();
    expect(screen.getByText("+8613800000000")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onAgree).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "同意并申请联系" }));
    await waitFor(() => expect(onAgree).toHaveBeenCalledWith(action));
    expect(screen.getByText("联系申请已发送")).toBeVisible();
  });

  it("declines without calling the contact workflow", async () => {
    const user = userEvent.setup();
    const onAgree = vi.fn(async () => undefined);
    getVerifiedContactChannels.mockResolvedValue([
      { type: "email", value: "buyer@example.com" },
    ]);
    render(
      <StoreContactConsentCard
        action={action}
        locale="zh"
        onAgree={onAgree}
      />,
    );

    await screen.findByText("buyer@example.com");
    await user.click(screen.getByRole("button", { name: "拒绝" }));
    expect(onAgree).not.toHaveBeenCalled();
    expect(screen.getByText("已拒绝交换联系方式")).toBeVisible();
    expect(screen.getByText(/没有交换任何联系方式/)).toBeVisible();
  });

  it("requires an account binding instead of accepting manual contact text", async () => {
    getVerifiedContactChannels.mockResolvedValue([]);
    render(<StoreContactConsentCard action={action} locale="zh" />);

    expect(await screen.findByText("没有已验证的邮箱或手机")).toBeVisible();
    expect(screen.getByRole("link", { name: "前往账号绑定" })).toHaveAttribute(
      "href",
      "/?accountSection=account",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
