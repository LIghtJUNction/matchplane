import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformDashboardModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock("./components/PlatformDashboard", async (importOriginal) => {
  platformDashboardModule.loads += 1;
  return importOriginal();
});

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
              slug: "store-a",
              path: "/store-a",
              displayName: "Store A",
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function openStoreAConversation(
  user: ReturnType<typeof userEvent.setup>,
) {
  window.history.replaceState(null, "", "/store-a");
  render(<App initialPath="/store-a" />);
  await user.click(await screen.findByRole("button", { name: "与店长对话" }));
  return screen.findByRole("textbox", {
    name: "告诉 MatchPlane 你的需求",
  });
}

describe("MatchPlane workspaces", () => {
  it("loads the platform dashboard only for the platform role across role round trips", async () => {
    const buyer = render(<App />);

    await screen.findByRole("heading", { name: "说说你想找什么。", level: 1 });
    expect(screen.queryByText("正在加载商城后台…")).not.toBeInTheDocument();
    expect(platformDashboardModule.loads).toBe(0);
    buyer.unmount();

    window.sessionStorage.setItem("matchplane.test-auth", "true");
    window.history.replaceState(null, "", "/?role=platform");
    const platform = render(<App />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "商城后台" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    expect(platformDashboardModule.loads).toBe(1);
    platform.unmount();

    window.history.replaceState(null, "", "/");
    const returnedBuyer = render(<App />);

    expect(
      await screen.findByRole("textbox", {
        name: "告诉 MatchPlane 你的需求",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("正在加载商城后台…")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "商城后台" }),
    ).not.toBeInTheDocument();
    returnedBuyer.unmount();

    window.history.replaceState(null, "", "/?role=platform");
    render(<App />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "商城后台" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
    expect(platformDashboardModule.loads).toBe(1);
  }, 30_000);

  it("keeps the root as browse plus one inline shopping conversation", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "说说你想找什么。", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "说需求" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "卖方供给" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "显示与语言" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("供给名称")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发布商品" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "List a product" }),
    ).not.toBeInTheDocument();
  });

  it("mounts the selected child adapter before exposing its conversation", async () => {
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
      await screen.findByTitle("Match Auto buyer 工作台"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "商城首页" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      await screen.findByRole("button", { name: "说需求" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("textbox", { name: "告诉 MatchPlane 你的需求" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("独立打开")).toBeInTheDocument();
  });

  it("keeps the server-resolved store identity when the client manifest is unavailable", async () => {
    window.history.replaceState(null, "", "/store-a");

    render(
      <App
        initialPath="/store-a"
        initialStoreName="星辰二手车行"
        initialStoreDescription="主营家用二手车与准新车。"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "星辰二手车行" }),
    ).toBeInTheDocument();
    expect(screen.getByText("主营家用二手车与准新车。")).toBeInTheDocument();
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/platform/manifest?path=%2Fstore-a",
        { headers: { accept: "application/json" } },
      ),
    );
    expect(
      screen.getByRole("heading", { name: "星辰二手车行" }),
    ).toBeInTheDocument();
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

  it("sanitizes legacy root publish URLs without opening seller controls", async () => {
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    window.history.replaceState(null, "", "/?publish=1");

    render(<App />);

    await screen.findByRole("button", { name: "账号菜单" });
    expect(window.location.search).not.toContain("publish");
    expect(
      screen.queryByRole("button", { name: "发布商品" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /^我的店铺|Store A/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps store opening behind the account's explicit My stores entry", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await openConsoleFromAccountMenu(user);
    expect(
      await screen.findByRole("dialog", { name: /^我的店铺/ }),
    ).toBeInTheDocument();
    // HostedStoreOnboarding is loaded through next/dynamic; give the chunk time
    // to resolve before asserting on store-card controls.
    const manageProducts = await screen.findByRole(
      "button",
      { name: "管理商品" },
      { timeout: 10_000 },
    );
    expect(screen.queryByLabelText("店铺名称")).not.toBeInTheDocument();
    await user.click(manageProducts);
    expect(
      await screen.findByRole("dialog", { name: "Store A" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(window.location.href).not.toContain("/login");
  }, 30_000);

  it("opens the product console over a fullscreen store from an explicit account link", async () => {
    window.history.replaceState(null, "", "/store-a?console=products");
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
            displayName: "Store A",
            assets: {
              hosted: {
                entry: "index.html",
                url: "/api/platform/plugin-assets/store-a/index.html?build=test",
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
                slug: "store-a",
                path: "/store-a",
                displayName: "Store A",
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

    render(<App initialPath="/store-a" />);

    expect(
      await screen.findByRole("dialog", { name: "Store A" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Store A" }),
    ).toBeInTheDocument();
    expect(window.location.search).not.toContain("console");
  });

  it("opens customer management from a store handoff link", async () => {
    window.history.replaceState(
      null,
      "",
      "/?storeConsole=33333333-3333-4333-8333-333333333333&storeConsoleSection=customers",
    );
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
            displayName: "Store A",
            assets: {
              hosted: {
                entry: "index.html",
                url: "/api/platform/plugin-assets/store-a/index.html?build=test",
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
                slug: "store-a",
                path: "/store-a",
                displayName: "Store A",
                description: "二手车",
                integrationKind: "package",
                status: "active",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url === "/api/stores/33333333-3333-4333-8333-333333333333/customers"
      ) {
        return new Response(JSON.stringify({ customers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: "test service unavailable" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    render(<App />);

    expect(
      await screen.findByRole("dialog", { name: "Store A" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "客户管理" }),
    ).toBeInTheDocument();
    expect(window.location.search).not.toContain("storeConsole");
  });

  it("does not expose store management from a copied product-console link", async () => {
    window.history.replaceState(null, "", "/store-a?console=products");
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
            displayName: "Store A",
            assets: {
              hosted: {
                entry: "index.html",
                url: "/api/platform/plugin-assets/store-a/index.html?build=test",
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

    render(<App initialPath="/store-a" />);

    expect(
      await screen.findByTitle("Store A buyer 工作台"),
    ).toBeInTheDocument();
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

  it("does not fake a saved payment mode when the live API is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_MATCHPLANE_LIVE_MODE", "false");
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

    expect(screen.getByText("测试模式")).toBeInTheDocument();
    expect(screen.queryByText("生产模式")).not.toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      "支付模式未保存：当前部署未启用平台 API。启用后刷新页面再重试。",
    );
    expect(notice).not.toHaveTextContent("支付系统已切换");
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input, init]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return url === "/api/admin/payment-mode" && init?.method === "POST";
      }),
    ).toBe(false);
  });

  it("blocks a payment switch until the current server version is verified", async () => {
    vi.stubEnv("NEXT_PUBLIC_MATCHPLANE_LIVE_MODE", "true");
    const fallbackFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    let resolveSetting!: (response: Response) => void;
    const pendingSetting = new Promise<Response>((resolve) => {
      resolveSetting = resolve;
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/admin/payment-mode")) return pendingSetting;
      return fallbackFetch(input, init);
    });
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await screen.findByRole("heading", { name: "商城后台" });
    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    await user.click(screen.getByRole("button", { name: "切换支付模式" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "支付模式正在读取，完成验证后再切换",
    );
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([input, request]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return url.startsWith("/api/admin/payment-mode") && request?.method === "POST";
      }),
    ).toBe(false);

    await act(async () => {
      resolveSetting(
        Response.json({
          tenant_id: "11111111-1111-4111-8111-111111111111",
          active_mode: "production",
          updated_by: "root-admin",
          version: 7,
          updated_at: "2026-08-26T00:00:00.000Z",
        }),
      );
      await pendingSetting;
    });
    expect(await screen.findByText("生产模式")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "切换支付模式" }));
    expect(
      screen.getByRole("alertdialog", { name: "切换到测试模式？" }),
    ).toBeInTheDocument();
  });

  it("persists a live payment switch with the server version and response-owned mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_MATCHPLANE_LIVE_MODE", "true");
    const fallbackFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
    const paymentPosts: RequestInit[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("/api/admin/payment-mode")) {
        if (init?.method === "POST") {
          paymentPosts.push(init);
          return new Response(
            JSON.stringify({
              tenant_id: "11111111-1111-4111-8111-111111111111",
              active_mode: "production",
              updated_by: "root-admin",
              version: 8,
              updated_at: "2026-08-26T00:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            tenant_id: "11111111-1111-4111-8111-111111111111",
            active_mode: "production",
            updated_by: "root-admin",
            version: 7,
            updated_at: "2026-08-26T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return fallbackFetch(input, init);
    });
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?role=platform");
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await screen.findByRole("heading", { name: "商城后台" });
    await user.click(screen.getByRole("tab", { name: "支付（可选）" }));
    expect(await screen.findByText("生产模式")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "切换支付模式" }));
    expect(
      screen.getByRole("alertdialog", { name: "切换到测试模式？" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认切换" }));

    await waitFor(() => expect(paymentPosts).toHaveLength(1));
    expect(paymentPosts[0]?.body).toEqual(expect.any(String));
    expect(JSON.parse(paymentPosts[0]!.body as string)).toMatchObject({
      mode: "test",
      expected_version: 7,
    });
    expect(screen.getByText("生产模式")).toBeInTheDocument();
    expect(screen.queryByText("测试模式")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "支付系统已切换为生产模式",
    );
  });

  it("sends the conversation directly after entering the selected child", async () => {
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
      "store-a",
      "buyer",
    );
    const input = await openStoreAConversation(user);
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

  it("submits with Enter while Shift+Enter keeps a multiline child-store draft", async () => {
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
      "store-a",
      "buyer",
    );
    const input = await openStoreAConversation(user);
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

  it("lets the user clear the visible child-store conversation without leaving the page", async () => {
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
      "store-a",
      "buyer",
    );
    const input = await openStoreAConversation(user);
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

    const shoppingInput = screen.getByRole("textbox", {
      name: "告诉 MatchPlane 你的需求",
    });
    await user.type(shoppingInput, "想找一台轻便的通勤电脑");
    expect(shoppingInput).toHaveValue("想找一台轻便的通勤电脑");
    expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled();
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

  it("passes English locale through overlays into the profile panel", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem("matchplane.test-auth", "true");
    render(<App />);

    await user.click(screen.getByRole("button", { name: "显示与语言" }));
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Profile" }));

    expect(
      await screen.findByRole("dialog", { name: "Profile" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Profile could not load",
    );
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
    expect(screen.getByRole("radio", { name: "苔绿，当前配色" })).toBeChecked();
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
