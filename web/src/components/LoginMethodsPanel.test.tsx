import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginMethodsPanel } from "./LoginMethodsPanel";

function stubProviders(body: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LoginMethodsPanel", () => {
  it("lists the exact environment variables when WeChat and SMS are not configured", async () => {
    stubProviders({ passkey: true, social: [], primary: [] });
    render(<LoginMethodsPanel />);

    const rows = await screen.findByLabelText("登录方式状态");
    expect(rows).toBeInTheDocument();
    expect(screen.getAllByText("未启用")).toHaveLength(3);
    expect(
      screen.getByText("MATCHPLANE_WECHAT_OAUTH_CLIENT_ID"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MATCHPLANE_WECHAT_OAUTH_CLIENT_SECRET"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MATCHPLANE_SMS_PROVIDER_URL"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MATCHPLANE_SMS_PROVIDER_TOKEN"),
    ).toBeInTheDocument();
  });

  it("reports WeChat and phone codes as live without configuration hints", async () => {
    stubProviders({
      emailOtp: true,
      phoneOtp: true,
      magicLink: true,
      passkey: true,
      social: ["wechat", "google"],
      primary: [],
    });
    render(<LoginMethodsPanel />);

    await screen.findByLabelText("登录方式状态");
    expect(screen.queryByText("未启用")).not.toBeInTheDocument();
    expect(
      screen.queryByText("MATCHPLANE_WECHAT_OAUTH_CLIENT_ID"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("MATCHPLANE_SMS_PROVIDER_URL"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("google")).toBeInTheDocument();
  });

  it("re-checks the server when the operator asks for a fresh status", async () => {
    const fetchMock = stubProviders({ passkey: true, social: [], primary: [] });
    const user = userEvent.setup();
    render(<LoginMethodsPanel />);

    await screen.findByLabelText("登录方式状态");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "重新检测" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/providers",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
