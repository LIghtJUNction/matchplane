import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getVerifiedContactChannels = vi.hoisted(() => vi.fn());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, getVerifiedContactChannels };
});

import { MarketplaceApiError } from "../api";
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows verified bindings as read-only values and waits for explicit agreement", async () => {
    const user = userEvent.setup();
    const onAgree = vi.fn(async () => undefined);
    const onRetrieve = vi.fn(async () => ({
      introduction: { introduction_id: "intro-1" },
      counterpart: {
        party_id: "seller-1",
        contact: { email: "seller@example.com" },
      },
    }));
    getVerifiedContactChannels.mockResolvedValue([
      { type: "email", value: "buyer@example.com" },
      { type: "phone", value: "+8613800000000" },
    ]);

    render(
      <StoreContactConsentCard
        action={action}
        locale="zh"
        onAgree={onAgree}
        onRetrieve={onRetrieve as never}
      />,
    );

    expect(await screen.findByText("buyer@example.com")).toBeVisible();
    expect(screen.getByText("+8613800000000")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onAgree).not.toHaveBeenCalled();
    expect(onRetrieve).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "同意并申请联系" }));
    await waitFor(() => expect(onAgree).toHaveBeenCalledWith(action));
    expect(screen.getByText("联系申请已发送")).toBeVisible();
    expect(onRetrieve).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "检查店员是否同意" }));
    await waitFor(() => expect(onRetrieve).toHaveBeenCalledWith(action));
    expect(screen.getByText("seller@example.com")).toBeVisible();
  });

  it("declines without calling the contact workflow", async () => {
    const user = userEvent.setup();
    const onAgree = vi.fn(async () => undefined);
    getVerifiedContactChannels.mockResolvedValue([
      { type: "email", value: "buyer@example.com" },
    ]);
    render(
      <StoreContactConsentCard action={action} locale="zh" onAgree={onAgree} />,
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
      "/?account=identity",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens the account bindings dialog in place when the app shell listens", async () => {
    const user = userEvent.setup();
    getVerifiedContactChannels.mockResolvedValue([]);
    const openedInApp = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("matchplane.account.bindings", openedInApp);
    try {
      render(<StoreContactConsentCard action={action} locale="zh" />);
      await user.click(
        await screen.findByRole("link", { name: "前往账号绑定" }),
      );
      expect(openedInApp).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("matchplane.account.bindings", openedInApp);
    }
  });

  it("re-checks bindings after the user verifies one, without losing the chat", async () => {
    const user = userEvent.setup();
    getVerifiedContactChannels
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { type: "email", value: "buyer@example.com" },
      ]);
    render(<StoreContactConsentCard action={action} locale="zh" />);

    await screen.findByText("没有已验证的邮箱或手机");
    await user.click(
      screen.getByRole("button", { name: "我已完成绑定，重新检测" }),
    );

    expect(await screen.findByText("buyer@example.com")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "同意并申请联系" }),
    ).toBeVisible();
  });

  it("offers a sign-in link instead of a useless retry when unauthenticated", async () => {
    getVerifiedContactChannels.mockRejectedValue(
      new MarketplaceApiError(401, "请先登录"),
    );
    render(<StoreContactConsentCard action={action} locale="zh" />);

    expect(await screen.findByText("请先登录")).toBeVisible();
    expect(screen.getByRole("link", { name: "前往登录" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent("/")}`,
    );
    expect(
      screen.queryByRole("button", { name: "重试" }),
    ).not.toBeInTheDocument();
  });
});
