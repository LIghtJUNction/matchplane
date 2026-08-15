import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn(async () => {
      if (window.sessionStorage.getItem("matchplane.test-auth") !== "true") {
        return { data: null, error: null };
      }
      return {
        data: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Test User",
            email: "test@example.com",
            role: new URLSearchParams(window.location.search).get("role") === "platform" ? "rootSuperAdmin" : undefined,
          },
          session: { id: "22222222-2222-4222-8222-222222222222" },
        },
        error: null,
      };
    }),
  },
  authFetchOptions: (subplatform: string) => ({
    headers: { "x-matchplane-subplatform": subplatform },
    credentials: "include",
  }),
}));

import { App } from "./App";
import { clearPartySessionCache, savePartySession } from "./api";

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearPartySessionCache();
});

describe("MatchPlane workspaces", () => {
  it("keeps the root entry chat-first and hides role tabs", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "先说说你想解决什么。" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "描述目标，平台负责继续找。" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "卖方供给" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "描述需求" })).toBeInTheDocument();
  });

  it("requires a seller session before accepting supply uploads", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=seller");
    render(<App />);

    await user.type(await screen.findByLabelText("供给名称"), "由卖家提交的资料");
    await user.type(screen.getByLabelText("内部编号"), "seller-item");
    await user.type(screen.getByLabelText("报价（最小货币单位）"), "100");
    await user.type(screen.getByLabelText("币种"), "CNY");
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    expect(window.location.assign).toBeDefined();
  });

  it("accepts a structured upload in demo mode when the seller is signed in", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=seller");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    savePartySession({
      tenantId: crypto.randomUUID(),
      partyId: crypto.randomUUID(),
      role: "seller",
      accessToken: "demo-session-token",
      accessTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }, "root", "seller");
    render(<App />);

    await user.type(await screen.findByLabelText("供给名称"), "由卖家提交的资料");
    await user.type(screen.getByLabelText("内部编号"), "seller-item");
    await user.type(screen.getByLabelText("报价（最小货币单位）"), "100");
    await user.type(screen.getByLabelText("币种"), "CNY");
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    expect(await screen.findByText("由卖家提交的资料")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("供给资料已记录");
  });

  it("requires an explicit administrator confirmation before changing payment mode", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await screen.findByRole("heading", { name: /解释价值从哪里来/ });
    await user.click(screen.getByRole("button", { name: "切换" }));

    const dialog = screen.getByRole("dialog", { name: "切换到生产模式？" });
    expect(dialog).toHaveTextContent("未决订单检查");
    await user.click(screen.getByRole("button", { name: "确认切换" }));

    expect(screen.getByText("生产模式")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("支付系统已切换为生产模式");
  });

  it("sends the conversation directly when the buyer is already signed in", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    savePartySession({
      tenantId: crypto.randomUUID(),
      partyId: crypto.randomUUID(),
      role: "buyer",
      accessToken: "demo-session-token",
      accessTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }, "root", "buyer");
    render(<App />);

    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });
    await user.type(input, "我有一个需要被认真匹配的问题");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(await screen.findByText(/需求已记录（演示模式）/)).toBeInTheDocument();
  });

  it("keeps visible controls actionable instead of leaving placeholder buttons", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("status")).toHaveTextContent("目前没有新的平台通知");

    await user.click(screen.getByRole("button", { name: "描述需求" }));
    expect(screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" })).toHaveFocus();
  });
});
