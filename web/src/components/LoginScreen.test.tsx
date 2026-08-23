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
