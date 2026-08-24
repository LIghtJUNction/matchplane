import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  sendOtp: vi.fn(),
  verify: vi.fn(),
  sendVerificationOtp: vi.fn(),
  verifyEmail: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    getSession: auth.getSession,
    phoneNumber: { sendOtp: auth.sendOtp, verify: auth.verify },
    emailOtp: {
      sendVerificationOtp: auth.sendVerificationOtp,
      verifyEmail: auth.verifyEmail,
    },
  },
  authFetchOptions: () => ({ headers: {} }),
}));

import { resolveSubplatform } from "../subplatform";
import { IdentityBindingsPanel } from "./IdentityBindingsPanel";

function stubProviderFetch(providers: {
  primary?: string[];
  social?: string[];
  phoneOtp?: boolean;
  emailOtp?: boolean;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("list-accounts"))
        return new Response(JSON.stringify([{ providerId: "credential" }]), {
          status: 200,
        });
      if (url.includes("auth/providers"))
        return new Response(
          JSON.stringify({
            primary: providers.primary ?? [],
            social: providers.social ?? [],
            phoneOtp: providers.phoneOtp ?? false,
            emailOtp: providers.emailOtp ?? false,
          }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({
    data: {
      user: {
        email: "buyer@example.com",
        emailVerified: true,
        phoneNumber: null,
        phoneNumberVerified: false,
      },
    },
  });
});

describe("IdentityBindingsPanel", () => {
  it("shows national identity, WeChat, and Alipay with real availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("list-accounts"))
          return new Response(
            JSON.stringify([
              { providerId: "credential" },
              { providerId: "wechat" },
            ]),
            { status: 200 },
          );
        if (url.includes("auth/providers"))
          return new Response(
            JSON.stringify({
              primary: ["national_identity"],
              social: ["alipay"],
              phoneOtp: false,
            }),
            { status: 200 },
          );
        return new Response("{}", { status: 404 });
      }),
    );

    render(
      <IdentityBindingsPanel
        locale="zh"
        subplatform={resolveSubplatform("/")}
        onNotice={vi.fn()}
      />,
    );

    expect(await screen.findByText("网号")).toBeInTheDocument();
    expect(screen.getByText("国家网络身份认证")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "绑定网号" }),
    ).toBeInTheDocument();
    expect(screen.getByText("微信")).toBeInTheDocument();
    expect(screen.getAllByText("已绑定").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "绑定支付宝" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Google")).not.toBeInTheDocument();
  });

  it("does not offer a fake bind action before the mall configures a provider", async () => {
    stubProviderFetch({});

    render(
      <IdentityBindingsPanel
        locale="zh"
        subplatform={resolveSubplatform("/")}
        onNotice={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getAllByText("商城暂未接入")).toHaveLength(4),
    );
    expect(
      screen.queryByRole("button", { name: /绑定(?:网号|微信|支付宝)/ }),
    ).not.toBeInTheDocument();
  });

  it("verifies an unverified email with a one-time code", async () => {
    const user = userEvent.setup();
    auth.getSession
      .mockResolvedValueOnce({
        data: {
          user: {
            email: "buyer@example.com",
            emailVerified: false,
            phoneNumber: null,
            phoneNumberVerified: false,
          },
        },
      })
      .mockResolvedValue({
        data: {
          user: {
            email: "buyer@example.com",
            emailVerified: true,
            phoneNumber: null,
            phoneNumberVerified: false,
          },
        },
      });
    auth.sendVerificationOtp.mockResolvedValue({});
    auth.verifyEmail.mockResolvedValue({});
    stubProviderFetch({ emailOtp: true });
    const onNotice = vi.fn();

    render(
      <IdentityBindingsPanel
        locale="zh"
        subplatform={resolveSubplatform("/")}
        onNotice={onNotice}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "验证邮箱" }));
    await waitFor(() =>
      expect(auth.sendVerificationOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "buyer@example.com",
          type: "email-verification",
        }),
      ),
    );
    expect(onNotice).toHaveBeenCalledWith("验证码已发送到该邮箱。");

    await user.type(screen.getByLabelText("验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "确认验证" }));

    await waitFor(() =>
      expect(auth.verifyEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "buyer@example.com",
          otp: "123456",
        }),
      ),
    );
    expect(onNotice).toHaveBeenCalledWith("邮箱已验证，可用于联系交换。");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "验证邮箱" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("lets the user re-enter a mistyped phone number after a code was sent", async () => {
    const user = userEvent.setup();
    auth.sendOtp.mockResolvedValue({});
    stubProviderFetch({ phoneOtp: true });

    render(
      <IdentityBindingsPanel
        locale="zh"
        subplatform={resolveSubplatform("/")}
        onNotice={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "绑定手机号" }),
    );
    const phoneInput = screen.getByLabelText("手机号");
    await user.type(phoneInput, "13800000000");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));

    await screen.findByLabelText("验证码");
    expect(phoneInput).toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "换个手机号" }));
    expect(screen.queryByLabelText("验证码")).not.toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).not.toHaveAttribute("readonly");
  });
});
