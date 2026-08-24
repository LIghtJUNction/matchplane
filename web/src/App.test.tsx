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
            role:
              new URLSearchParams(window.location.search).get("role") ===
              "platform"
                ? "rootSuperAdmin"
                : undefined,
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

async function openConsoleFromAccountMenu(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "账号菜单" }));
  await user.click(await screen.findByRole("menuitem", { name: "我的店铺" }));
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.palette = "ink";
  document.documentElement.lang = "zh-CN";
  clearPartySessionCache();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "/api/mall/search") {
      return new Response(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          stores: [],
          recommendations: [],
          routing: {
            source: "policy_fallback",
            degraded: false,
            rationale: "no stores",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/mall/assistant") {
      return new Response(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          answer: "这是模型生成的购物导购回答。",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/stores") {
      return new Response(JSON.stringify({ stores: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/stores?mine=1") {
      return new Response(
        JSON.stringify({
          stores: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              slug: "used-car",
              path: "/used-car",
              displayName: "Matx Auto",
              description: "二手车",
              integrationKind: "package",
              status: "active",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "test service unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MatchPlane workspaces", () => {
  it("keeps the root entry focused on one public buyer chat and a visible sign-in entry", async () => {
    render(<App />);

    expect(screen.queryByRole("button", { name: "问选货员" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "想找什么？" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "从一句话开始。" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "卖方供给" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
    ).toBeInTheDocument();

    expect(screen.queryByText("其他入口")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "显示与语言" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("供给名称")).not.toBeInTheDocument();
  });

  it("opens a mounted child as a plain public store instead of dropping buyers into its app", async () => {
    window.history.replaceState(null, "", "/market/auto");
    vi.mocked(globalThis.fetch).mockImplementation(
      async () =>
        ({
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
        }) as Response,
    );

    render(<App initialPath="/market/auto" />);

    expect(
      await screen.findByRole("heading", { name: "Match Auto" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "商品" })).toBeInTheDocument();
    expect(
      screen.queryByTitle("Match Auto buyer 工作台"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回商城" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "想买什么，告诉我就行。" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("独立打开")).not.toBeInTheDocument();
  });

  it("treats a legacy seller URL as the public unified entry until the user signs in", async () => {
    window.history.replaceState(null, "", "/?role=seller");
    render(<App />);

    await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());
    expect(screen.queryByLabelText("供给名称")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
  });

  it("opens store creation when a signed-in seller has no store to publish into", async () => {
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "/api/stores?mine=1") {
        return new Response(JSON.stringify({ stores: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!defaultFetch) throw new Error("missing default fetch mock");
      return defaultFetch(input, init);
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "账号菜单" });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/stores?mine=1",
        expect.any(Object),
      ),
    );
    await user.click(screen.getAllByRole("button", { name: "发布商品" })[0]);

    expect(
      await screen.findByRole("dialog", { name: /^我的店铺/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开一家店" }),
    ).toBeInTheDocument();
  });

  it("resumes the publish action encoded by the login return URL", async () => {
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    window.history.replaceState(null, "", "/?publish=1");
    const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "/api/stores?mine=1") {
        return new Response(JSON.stringify({ stores: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!defaultFetch) throw new Error("missing default fetch mock");
      return defaultFetch(input, init);
    });

    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: /^我的店铺/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "你的店铺" }),
    ).toBeInTheDocument();
    expect(window.location.search).not.toContain("publish");
  });

  it("opens a single owned store in place instead of losing the session on a login redirect", async () => {
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    const defaultFetch = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "/api/stores?mine=1") {
        return new Response(
          JSON.stringify({
            stores: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                slug: "used-car",
                path: "/used-car",
                displayName: "Matx Auto",
                description: "二手车",
                integrationKind: "package",
                status: "active",
                membershipRole: "owner",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("/api/platform/manifest?path=")) {
        return new Response(JSON.stringify({ displayName: "Matx Auto" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!defaultFetch) throw new Error("missing default fetch mock");
      return defaultFetch(input, init);
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "账号菜单" });
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/stores?mine=1",
        expect.any(Object),
      ),
    );
    await user.click(screen.getAllByRole("button", { name: "发布商品" })[0]);

    expect(
      await screen.findByRole("dialog", { name: "Matx Auto" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(window.location.href).not.toContain("/login");
  });

  it("keeps store opening behind the account's explicit My stores entry", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await openConsoleFromAccountMenu(user);
    expect(
      await screen.findByRole("dialog", { name: /^我的店铺/ }),
    ).toBeInTheDocument();
    const manageProducts = await screen.findByRole("button", {
      name: "管理商品",
    });
    expect(screen.queryByLabelText("店铺名称")).not.toBeInTheDocument();
    await user.click(manageProducts);
    expect(
      await screen.findByRole("dialog", { name: "Matx Auto" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(window.location.href).not.toContain("/login");
  });

  it("opens the product console over a fullscreen store from an explicit account link", async () => {
    window.history.replaceState(null, "", "/used-car?console=products");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/platform/manifest?path=")) {
        return new Response(
          JSON.stringify({
            displayName: "Matx Auto",
            assets: {
              hosted: {
                entry: "index.html",
                url: "/api/platform/plugin-assets/used-car/index.html?build=test",
                digest: "a".repeat(64),
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/stores?mine=1") {
        return new Response(
          JSON.stringify({
            stores: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                slug: "used-car",
                path: "/used-car",
                displayName: "Matx Auto",
                description: "二手车",
                integrationKind: "package",
                status: "active",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "test service unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    render(<App initialPath="/used-car" />);

    expect(
      await screen.findByRole("dialog", { name: "Matx Auto" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Matx Auto" }),
    ).toBeInTheDocument();
    expect(window.location.search).not.toContain("console");
  });

  it("does not expose store management from a copied product-console link", async () => {
    window.history.replaceState(null, "", "/used-car?console=products");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/platform/manifest?path=")) {
        return new Response(
          JSON.stringify({
            displayName: "Matx Auto",
            assets: {
              hosted: {
                entry: "index.html",
                url: "/api/platform/plugin-assets/used-car/index.html?build=test",
                digest: "a".repeat(64),
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/stores?mine=1") {
        return new Response(JSON.stringify({ stores: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: "test service unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    render(<App initialPath="/used-car" />);

    expect(
      await screen.findByRole("heading", { name: "Matx Auto" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "商品" })).toBeInTheDocument();
    expect(
      screen.queryByTitle("Matx Auto buyer 工作台"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "只有店主或店铺运营人员可以管理这家店",
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "管理这家店" }),
    ).not.toBeInTheDocument();
  });

  it("does not flash a false login action while a successful sign-in propagates", async () => {
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    window.sessionStorage.setItem(
      "matchplane.auth.pending",
      String(Date.now()),
    );
    vi.mocked(authClient.getSession).mockResolvedValueOnce({
      data: null,
      error: null,
    });

    render(<App initialPath="/" />);

    expect(
      screen.queryByRole("button", { name: "登录" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "账号菜单" }),
    ).toBeInTheDocument();
    expect(
      vi.mocked(authClient.getSession).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reuses the signed-in administrator session after a transient check failure", async () => {
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    vi.mocked(authClient.getSession).mockResolvedValueOnce({
      data: null,
      error: { status: 429, message: "Too many requests" },
    } as never);

    render(<App />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "商城后台" },
        { timeout: 3_000 },
      ),
    ).toBeInTheDocument();
    expect(
      vi.mocked(authClient.getSession).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.queryByRole("heading", { name: "继续使用你的账号" }),
    ).not.toBeInTheDocument();
  });

  it("starts the mall backend with an actionable setup checklist", async () => {
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "/api/platform/setup") {
        return new Response(
          JSON.stringify({
            status: "ok",
            root: {
              tenantConfigured: true,
              tenantExists: true,
              tenantId: "11111111-1111-4111-8111-111111111111",
              tenant: { slug: "matchplane", name: "MatchPlane" },
              organization: null,
              rootAdminConfigured: true,
              identityAccounts: 1,
              rootAdminAccounts: 1,
            },
            domains: [],
            registrations: {},
            routing: { activeChildren: 0, ready: false },
            hostedAgent: { configured: false, status: "fallback" },
            builder: { configured: false, status: "unconfigured" },
            firstRun: { needsRootAccount: false, readyForAdmin: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/platform/domains")
        return new Response(JSON.stringify({ domains: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url === "/api/platform/ai/status")
        return new Response(
          JSON.stringify({
            router: {
              configured: false,
              protocol: "openai-compatible",
              model: null,
              endpointOrigin: null,
              toolMode: "auto",
              maxInputCharacters: 24000,
              maxOutputTokens: 320,
              totalTimeoutMs: 20000,
              maxSteps: 4,
              maxFanout: 4,
            },
            auth: {
              password: true,
              emailOtp: false,
              phoneOtp: false,
              magicLink: false,
              passkey: true,
              primary: [],
              fallback: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({ error: "test service unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "开始配置商城" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回商城" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByText("商城组织")).toBeInTheDocument();
    expect(screen.getAllByText("商城数据").length).toBeGreaterThan(0);
    expect(screen.getByText("第一家店铺")).toBeInTheDocument();
  });

  it("requires an explicit administrator confirmation before changing payment mode", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await screen.findByRole("heading", { name: "商城后台" });
    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    await user.click(screen.getByRole("button", { name: "切换支付模式" }));

    const dialog = screen.getByRole("alertdialog", {
      name: "切换到生产模式？",
    });
    expect(dialog).toHaveTextContent("未决订单检查");
    await user.click(screen.getByRole("button", { name: "确认切换" }));

    expect(screen.getByText("生产模式")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "支付系统已切换为生产模式",
    );
  });

  it("sends the conversation directly when the buyer is already signed in", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    savePartySession(
      {
        tenantId: crypto.randomUUID(),
        partyId: crypto.randomUUID(),
        role: "buyer",
        accessToken: "demo-session-token",
        accessTokenExpiresAt: new Date(
          Date.now() + 15 * 60 * 1000,
        ).toISOString(),
      },
      "root",
      "buyer",
    );
    render(<App />);

    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.type(input, "我有一个需要被认真匹配的问题");
    await user.click(screen.getByRole("button", { name: "发送需求" }));

    expect(
      await screen.findByText("这是模型生成的购物导购回答。", {
        selector: "p.match-chat-message",
      }),
    ).toBeVisible();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/mall/assistant",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits with Enter while Shift+Enter keeps a multiline draft", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    savePartySession(
      {
        tenantId: crypto.randomUUID(),
        partyId: crypto.randomUUID(),
        role: "buyer",
        accessToken: "demo-session-token",
        accessTokenExpiresAt: new Date(
          Date.now() + 15 * 60 * 1000,
        ).toISOString(),
      },
      "root",
      "buyer",
    );
    render(<App />);

    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.type(input, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "第二行");
    expect(input).toHaveValue("第一行\n第二行");
    await user.keyboard("{Enter}");

    expect(
      await screen.findByText("这是模型生成的购物导购回答。", {
        selector: "p.match-chat-message",
      }),
    ).toBeVisible();
  });

  it("lets the user clear the visible conversation without leaving the page", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    savePartySession(
      {
        tenantId: crypto.randomUUID(),
        partyId: crypto.randomUUID(),
        role: "buyer",
        accessToken: "demo-session-token",
        accessTokenExpiresAt: new Date(
          Date.now() + 15 * 60 * 1000,
        ).toISOString(),
      },
      "root",
      "buyer",
    );
    render(<App />);

    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.type(input, "把这段需求整理一下");
    await user.click(screen.getByRole("button", { name: "发送需求" }));
    await user.click(await screen.findByRole("button", { name: "对话选项" }));
    await user.click(await screen.findByRole("menuitem", { name: "清空" }));
    expect(
      screen.queryByRole("log", { name: "对话记录" }),
    ).not.toBeInTheDocument();
  });

  it("does not consume a pending chat while the user is still signed out", async () => {
    const pending = JSON.stringify({
      text: "保留这条需求",
      next: "/?role=buyer",
    });
    window.sessionStorage.setItem("matchplane.pending-chat", pending);
    render(<App />);

    await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());
    expect(window.sessionStorage.getItem("matchplane.pending-chat")).toBe(
      pending,
    );
    expect(screen.queryByText("保留这条需求")).not.toBeInTheDocument();
  });

  it("keeps visible controls actionable instead of leaving placeholder buttons", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await openConsoleFromAccountMenu(user);
    expect(
      screen.getByRole("dialog", { name: /^我的店铺/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭我的店铺" }));

    const input = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.click(input);
    expect(input).toHaveFocus();
  });

  it("keeps the platform console in the privileged account menu only", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    window.history.replaceState(null, "", "/?role=platform");
    render(<App />);

    expect(
      screen.queryByRole("link", { name: "商城控制台" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "账号菜单" }));
    const consoleItem = await screen.findByRole("menuitem", {
      name: "商城控制台",
    });
    expect(consoleItem).toHaveAttribute("href", "/?role=platform");
    expect(screen.getAllByText("商城控制台")).toHaveLength(1);
  });

  it("does not expose the platform console to an unprivileged account", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "账号菜单" }));
    expect(
      screen.queryByRole("menuitem", { name: "商城控制台" }),
    ).not.toBeInTheDocument();
  });

  it("keeps account controls out of settings and signs out through Better Auth", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "账号菜单" }));
    await user.click(await screen.findByRole("menuitem", { name: "账号" }));
    expect(
      await screen.findByRole("dialog", { name: "账号" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("已退出当前账号");
  });

  it("keeps theme and language controls near the shopping aid", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(screen.getByRole("button", { name: "显示与语言" }));
    await user.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(document.documentElement.lang).toBe("en");
    expect(
      screen.getByRole("button", { name: "Account menu" }),
    ).toBeInTheDocument();
  });

  it("applies and persists a curated palette", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "显示与语言" }));
    await user.click(screen.getByRole("radio", { name: "苔绿" }));

    await waitFor(() =>
      expect(document.documentElement.dataset.palette).toBe("moss"),
    );
    expect(window.localStorage.getItem("matchplane.palette")).toBe("moss");
    expect(
      screen.getByRole("radio", { name: "苔绿，当前配色" }),
    ).toBeChecked();
  });

  it("keeps a persisted dark preference during the initial hydration", async () => {
    window.localStorage.setItem("matchplane.theme", "dark");

    render(<App />);

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(window.localStorage.getItem("matchplane.theme")).toBe("dark");
  });

  it("passes the selected language into the chat-first buyer workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "显示与语言" }));
    await user.click(screen.getByRole("button", { name: "English" }));

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Products",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("More entry points")).not.toBeInTheDocument();
  });

  it("does not expose contact settings before a user signs in", async () => {
    render(<App />);

    expect(screen.queryByLabelText("手机号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("微信号")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
  });
});
