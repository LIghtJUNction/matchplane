import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    signOut: vi.fn(async () => ({ data: null, error: null })),
  },
  authFetchOptions: (subplatform: string) => ({
    headers: { "x-matchplane-subplatform": subplatform },
    credentials: "include",
  }),
}));

import { App } from "./App";
import { clearPartySessionCache, savePartySession } from "./api";
import { authClient } from "./lib/auth-client";

async function openSettingsFromAccountMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "账号菜单" }));
  await user.click(await screen.findByRole("menuitem", { name: "设置" }));
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.lang = "zh-CN";
  clearPartySessionCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MatchPlane workspaces", () => {
  it("keeps the root entry focused on one public buyer chat and a visible sign-in entry", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "先说说你想解决什么。" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "从一句话开始。" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "卖方供给" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" })).toBeInTheDocument();

    expect(screen.queryByText("其他入口")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换到暗色" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("供给名称")).not.toBeInTheDocument();
  });

  it("lets a mounted child platform own the viewport with only a parent back control", async () => {
    window.history.replaceState(null, "", "/market/auto");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        displayName: "Match Auto",
        assets: {
          hosted: {
            entry: "index.html",
            url: "/api/platform/plugin-assets/market/auto/index.html?build=review",
            digest: "a".repeat(64),
          },
        },
      }),
    }) as Response);

    render(<App initialPath="/market/auto" />);

    expect(await screen.findByTitle("Match Auto buyer 工作台")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回上一级平台" })).toHaveAttribute("href", "/market");
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "先说说你想解决什么。" })).not.toBeInTheDocument();
    expect(screen.queryByText("独立打开")).not.toBeInTheDocument();
  });

  it("never renders the seller workspace or settings for an anonymous seller route", async () => {
    window.history.replaceState(null, "", "/?role=seller");
    render(<App />);

    await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());
    expect(screen.queryByLabelText("供给名称")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("does not fabricate a seller submission when the marketplace API is disabled", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=seller");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await openSettingsFromAccountMenu(user);
    await user.type(await screen.findByLabelText("供给名称"), "由卖家提交的资料");
    await user.type(screen.getByLabelText("内部编号"), "seller-item");
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    expect(screen.getByRole("status")).toHaveTextContent("没有写入系统");
    expect(screen.queryByText("由卖家提交的资料")).not.toBeInTheDocument();
  });

  it("requires an explicit administrator confirmation before changing payment mode", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await screen.findByRole("heading", { name: "平台管理" });
    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    await user.click(screen.getByRole("button", { name: "切换支付模式" }));

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

    expect(await screen.findByRole("status")).toHaveTextContent(/未连接真实撮合 API/);
  });

  it("submits with Enter while Shift+Enter keeps a multiline draft", async () => {
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
    await user.type(input, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "第二行");
    expect(input).toHaveValue("第一行\n第二行");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("status")).toHaveTextContent(/未连接真实撮合 API/);
  });

  it("lets the user clear the visible conversation without leaving the page", async () => {
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
    await user.type(input, "把这段需求整理一下");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    await screen.findByRole("button", { name: "清空" });

    await user.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.queryByRole("log", { name: "对话记录" })).not.toBeInTheDocument();
  });

  it("does not consume a pending chat while the user is still signed out", async () => {
    const pending = JSON.stringify({ text: "保留这条需求", next: "/?role=buyer" });
    window.sessionStorage.setItem("matchplane.pending-chat", pending);
    render(<App />);

    await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());
    expect(window.sessionStorage.getItem("matchplane.pending-chat")).toBe(pending);
    expect(screen.queryByText("保留这条需求")).not.toBeInTheDocument();
  });

  it("keeps visible controls actionable instead of leaving placeholder buttons", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await openSettingsFromAccountMenu(user);
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭设置" }));

    const input = screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" });
    await user.click(input);
    expect(input).toHaveFocus();
  });

  it("keeps account controls out of settings and signs out through Better Auth", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "账号菜单" }));
    await user.click(await screen.findByRole("menuitem", { name: "账号" }));
    expect(await screen.findByRole("dialog", { name: "账号" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("已退出当前账号");
  });

  it("keeps theme and language controls in the header", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(screen.getByRole("button", { name: "切换到暗色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: "EN" }));
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });

  it("keeps a persisted dark preference during the initial hydration", async () => {
    window.localStorage.setItem("matchplane.theme", "dark");

    render(<App />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(window.localStorage.getItem("matchplane.theme")).toBe("dark");
  });

  it("passes the selected language into the chat-first buyer workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getByRole("heading", { name: "Tell us what you want to solve." })).toBeInTheDocument();
    expect(screen.queryByText("More entry points")).not.toBeInTheDocument();
  });

  it("does not expose contact settings before a user signs in", async () => {
    render(<App />);

    expect(screen.queryByLabelText("手机号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("微信号")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
  });
});
