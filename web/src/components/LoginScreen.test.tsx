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
});
