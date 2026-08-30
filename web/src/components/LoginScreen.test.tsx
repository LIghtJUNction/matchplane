import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  clearPartySessionCache: vi.fn(),
  establishMarketplaceSession: vi.fn(),
  getMallLegalDocuments: vi.fn(async () => ({
    mallName: "MatchPlane",
    documents: {
      terms: {
        content: "协议",
        version: 7,
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
      privacy: {
        content: "隐私",
        version: 9,
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
    },
  })),
  isLiveMarketplaceEnabled: vi.fn(() => false),
  redeemPlatformAdminInvite: vi.fn(),
}));

vi.mock("../api", () => api);
vi.mock("../lib/auth-client", () => ({
  authClient: { getSession: vi.fn(async () => ({ data: null, error: null })) },
  authFetchOptions: () => ({ credentials: "include", headers: {} }),
}));
vi.mock("../subplatform", () => ({
  resolveSubplatform: () => ({
    slug: "root",
    path: "/",
    brandName: "MatchPlane",
    label: "",
    description: "",
  }),
  loadSubplatform: async () => ({
    slug: "root",
    path: "/",
    brandName: "MatchPlane",
    label: "",
    description: "",
  }),
}));

import { LoginScreen } from "./LoginScreen";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ passkey: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  window.history.replaceState(null, "", "/register");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LoginScreen", () => {
  it("shows only the password form when no code delivery is configured", async () => {
    window.history.replaceState(null, "", "/login");
    render(<LoginScreen intent="sign-in" />);

    expect(
      await screen.findByRole("heading", { name: "继续使用你的账号" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toHaveAttribute(
      "placeholder",
      "name@example.com",
    );
  });

  it("offers code and magic-link sign-in once the server reports them configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              emailOtp: true,
              phoneOtp: true,
              magicLink: true,
              passkey: true,
              social: ["wechat"],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    window.history.replaceState(null, "", "/login");
    render(<LoginScreen intent="sign-in" />);

    const tabs = await screen.findByRole("tablist", { name: "登录方式" });
    expect(tabs).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "验证码" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "免密链接" })).toBeInTheDocument();
    expect(screen.getByLabelText("邮箱或手机号")).toHaveAttribute(
      "placeholder",
      "name@example.com 或 138…",
    );
    expect(screen.getByRole("button", { name: "微信" })).toBeInTheDocument();
  });

  it("keeps registration on the email flow even when other methods exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              emailOtp: true,
              phoneOtp: true,
              magicLink: true,
              passkey: true,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    render(<LoginScreen intent="sign-up" />);

    expect(
      await screen.findByRole("heading", { name: "创建你的账号" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
  });

  it("keeps every compact authentication action addressable by its polish selector", async () => {
    window.history.replaceState(null, "", "/login");
    render(<LoginScreen intent="sign-in" />);

    expect(await screen.findByRole("button", { name: "显示密码" })).toHaveClass(
      "login-password-visibility",
    );
    expect(
      (await screen.findByRole("button", { name: "使用 Passkey" }))
        .parentElement,
    ).toHaveClass("login-passkey-action");
    expect(screen.getByRole("link", { name: "返回" })).toHaveClass(
      "login-back",
    );
    expect(
      screen.getByRole("link", { name: "注册" }).parentElement,
    ).toHaveClass("login-registration-link");
    expect(screen.getByRole("button", { name: "忘记密码？" })).toHaveClass(
      "login-link-button",
    );
  });

  it("supports arrow, Home, and End navigation for authentication tabs", async () => {
    window.history.replaceState(null, "", "/login");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ emailOtp: true, magicLink: true, passkey: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const user = userEvent.setup();
    render(<LoginScreen intent="sign-in" />);

    const password = await screen.findByRole("tab", { name: "密码" });
    const emailOtp = screen.getByRole("tab", { name: "验证码" });
    const magicLink = screen.getByRole("tab", { name: "免密链接" });
    expect(password).toHaveAttribute("tabindex", "0");
    expect(emailOtp).toHaveAttribute("tabindex", "-1");

    password.focus();
    await user.keyboard("{ArrowRight}");
    expect(emailOtp).toHaveFocus();
    expect(emailOtp).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(magicLink).toHaveFocus();
    await user.keyboard("{Home}");
    expect(password).toHaveFocus();
  });

  it("opens the password reset flow directly from account settings", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?reset=1&email=buyer%40example.com",
    );
    render(<LoginScreen intent="sign-in" />);

    expect(
      await screen.findByRole("heading", { name: "重置密码" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("buyer@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "发送重置验证码" }),
    ).toBeInTheDocument();
  });

  it("requires an explicit agreement before a new account can be submitted", async () => {
    const user = userEvent.setup();
    render(<LoginScreen intent="sign-up" />);

    const consent = await screen.findByRole("checkbox", {
      name: /用户协议.*隐私政策/,
    });
    const submit = screen.getByRole("button", { name: "发送验证码" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("link", { name: "用户协议" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy",
    );

    await user.click(consent);
    expect(submit).toBeEnabled();
  });

  it("explains a legal document failure and retries without clearing the form", async () => {
    api.getMallLegalDocuments.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<LoginScreen intent="sign-up" />);

    const email = screen.getByRole("textbox", { name: "邮箱" });
    await user.type(email, "buyer@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法读取用户协议和隐私政策，因此不能继续注册。",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "重新读取" }));

    expect(
      await screen.findByRole("checkbox", {
        name: /用户协议.*隐私政策/,
      }),
    ).toBeInTheDocument();
    expect(email).toHaveValue("buyer@example.com");
    expect(api.getMallLegalDocuments).toHaveBeenCalledTimes(2);
  });
});
