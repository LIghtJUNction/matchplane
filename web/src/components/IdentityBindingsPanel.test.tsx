import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  sendOtp: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    getSession: auth.getSession,
    phoneNumber: { sendOtp: auth.sendOtp, verify: auth.verify },
  },
  authFetchOptions: () => ({ headers: {} }),
}));

import { resolveSubplatform } from "../subplatform";
import { IdentityBindingsPanel } from "./IdentityBindingsPanel";

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
            JSON.stringify({ primary: [], social: [], phoneOtp: false }),
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

    await waitFor(() =>
      expect(screen.getAllByText("商城暂未接入")).toHaveLength(4),
    );
    expect(
      screen.queryByRole("button", { name: /绑定(?:网号|微信|支付宝)/ }),
    ).not.toBeInTheDocument();
  });
});
