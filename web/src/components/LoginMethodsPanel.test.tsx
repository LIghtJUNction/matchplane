import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginMethodsPanel } from "./LoginMethodsPanel";

const oauthCallbacks = {
  national_identity:
    "https://auth.matchplane.example/api/auth/callback/national_identity",
  wechat: "https://auth.matchplane.example/api/auth/callback/wechat",
  qq: "https://auth.matchplane.example/api/auth/callback/qq",
  alipay: "https://auth.matchplane.example/api/auth/callback/alipay",
  google: "https://auth.matchplane.example/api/auth/callback/google",
};

function providerBody(overrides: Record<string, unknown> = {}) {
  return {
    password: true,
    passkey: true,
    emailOtp: true,
    magicLink: true,
    phoneOtp: true,
    primary: ["national_identity"],
    social: ["wechat", "qq", "alipay", "google"],
    oauthCallbacks,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubProviders(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LoginMethodsPanel", () => {
  it("uses the shared provider endpoint and Appica status/refresh controls", async () => {
    const fetchMock = stubProviders(providerBody());
    const { container } = render(<LoginMethodsPanel />);

    await screen.findByLabelText("登录方式状态");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/providers", {
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(9);
    expect(container.querySelector('[data-slot="button"]')).toBe(
      screen.getByRole("button", { name: "重新检测" }),
    );
    expect(screen.getAllByText("已启用")).toHaveLength(9);
  });

  it("shows every server callback, including national identity", async () => {
    stubProviders(providerBody());
    render(<LoginMethodsPanel />);

    await screen.findByLabelText("登录方式状态");
    for (const callback of Object.values(oauthCallbacks)) {
      expect(screen.getByText(callback)).toBeInTheDocument();
    }
  });

  it("shows environment names only for disabled generic OAuth providers", async () => {
    stubProviders(
      providerBody({
        emailOtp: false,
        magicLink: false,
        phoneOtp: false,
        primary: [],
        social: ["qq"],
      }),
    );
    render(<LoginMethodsPanel />);

    await screen.findByLabelText("登录方式状态");
    expect(
      screen.queryByText("MATCHPLANE_QQ_OAUTH_CLIENT_ID"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("MATCHPLANE_GOOGLE_OAUTH_CLIENT_ID"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MATCHPLANE_ALIPAY_OAUTH_CLIENT_SECRET"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/MATCHPLANE_WECHAT_OAUTH_CLIENT_ID/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/MATCHPLANE_NATIONAL_IDENTITY_OAUTH_CLIENT_ID/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/MATCHPLANE_SMS_PROVIDER_URL/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/下方“账号邮件”面板/)).toBeInTheDocument();
    expect(screen.getByText(/下方“短信登录”面板/)).toBeInTheDocument();
    expect(screen.getByText(/下方微信扫码登录面板/)).toBeInTheDocument();
  });

  it("keeps an honest error state and succeeds when the operator retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse(providerBody()));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<LoginMethodsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录方式检测失败，请稍后重试。",
    );
    await user.click(screen.getByRole("button", { name: "重新检测" }));

    await screen.findByLabelText("登录方式状态");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
